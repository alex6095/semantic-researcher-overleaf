import * as crypto from 'crypto';
import {constants as nodeFsConstants} from 'fs';
import * as nodeFs from 'fs/promises';
import * as os from 'os';
import * as nodePath from 'path';
import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import {
    RemoteDocumentMergeConflictError,
    RemoteDocumentWriteAmbiguousError,
    VirtualFileSystem,
    parseUri,
    vfsProjectKey,
} from '../core/remoteFileSystemProvider';
import { normalizeReplicaPath } from '../agentReview/types';
import {
    getActiveReplicaRoot,
    isLocalReplicaMetadataUri,
    localUriToPath,
    normalizeLocalReplicaRelPath,
    pathToLocalUri,
    readReplicaSettings,
    readReplicaSettingsSnapshot,
} from '../utils/localReplicaWorkspace';
import {
    LEGACY_REPLICA_SETTINGS_BACKUP_FILE,
    LEGACY_REPLICA_SETTINGS_DIR,
    LEGACY_REPLICA_SETTINGS_FILE,
    REPLICA_SETTINGS_DIR,
    REPLICA_SETTINGS_FILE,
} from '../consts';
import { stringifyOverleafUri } from '../utils/overleafUri';
import { EventBus, Events } from '../utils/eventBus';
import { formatUnknownError } from '../utils/errorMessage';
import { PROTECTED_LOCAL_REPLICA_IGNORE_PATTERNS, getAgentReviewManager } from '../agentReview';
import { decodeUtf8Text, mergeUtf8Text } from '../utils/threeWayMerge';

const IGNORE_SETTING_KEY = 'ignore-patterns';
const ECHO_WINDOW_MS = 500;
const REMOTE_DELETE_MTIME_SLOP_MS = 2_000;
const SYNC_MANIFEST_FILE = `${REPLICA_SETTINGS_DIR}/sync-manifest.json`;

// Single shared output channel for Local Replica sync diagnostics. Lazy-created.
let sharedOutput: vscode.OutputChannel | undefined;
function getOutputChannel() {
    if (!sharedOutput) {
        sharedOutput = vscode.window.createOutputChannel('Semantic Researcher Overleaf');
    }
    return sharedOutput;
}

// De-dupe warning notifications: remember the last error signature we surfaced.
const lastWarnByRel = new Map<string, {signature: string, at: number}>();
function maybeWarnSyncFailure(relPath: string, error: unknown) {
    const signature = formatUnknownError(error);
    const key = relPath;
    const previous = lastWarnByRel.get(key);
    const now = Date.now();
    // One toast per (file × message) in any 60s window — stops spam on disconnected sockets.
    if (previous && previous.signature===signature && now-previous.at<60_000) { return; }
    lastWarnByRel.set(key, {signature, at: now});
    vscode.window.showWarningMessage(
        vscode.l10n.t('Overleaf sync failed for {relPath}: {message}', {relPath, message: signature}),
        vscode.l10n.t('Show Output'),
    ).then((choice) => {
        if (choice==='Show Output') { getOutputChannel().show(true); }
    });
}

async function deleteWithTrashFallback(uri: vscode.Uri, options?: {recursive?: boolean}) {
    try {
        await vscode.workspace.fs.delete(uri, {...options, useTrash: true});
    } catch (error) {
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [delete trash fallback] ${uri.toString()}: ${formatUnknownError(error)}`,
        );
        await vscode.workspace.fs.delete(uri, options);
    }
}

type FileCache = {date:number, hash:string};

const DELETE_DIGEST = '\0';

interface SyncManifestEntry {
    remoteFingerprint: string;
    localSize: number;
    localMtime: number;
    localDigest: string;
    baseContentBase64?: string;
    updatedAt: string;
}

interface SyncManifestDirectoryEntry {
    updatedAt: string;
}

interface SyncManifestConflictEntry {
    reason: string;
    localDigest: string;
    updatedAt: string;
}

interface SyncManifest {
    version: 2;
    projectUri: string;
    baselineComplete: boolean;
    files: Record<string, SyncManifestEntry>;
    directories: Record<string, SyncManifestDirectoryEntry>;
    conflicts: Record<string, SyncManifestConflictEntry>;
}

type SyncManifestBaselineMode = 'trusted' | 'fresh-replica' | 'unavailable';

interface LocalReplicaSnapshot {
    files: Set<string>;
    directories: Set<string>;
}

interface PathRevision {
    kind: 'missing' | 'file' | 'directory' | 'other';
    revision: string;
    content?: Uint8Array;
}

interface LocalReplicaOperationRecord {
    version: 1;
    id: string;
    kind: 'write' | 'delete';
    relPath: string;
    entityKind: PathRevision['kind'];
    expectedRevision: string;
    installedRevision?: string;
    stageName?: string;
    backupName: string;
    guardName: string;
    createdAt: string;
}

interface RemoteDeleteOperationRecord {
    version: 1;
    id: string;
    relPath: string;
    stagingRelPath: string;
    expectedRevision: string;
    createdAt: string;
}

interface PendingEvent {
    timer: ReturnType<typeof setTimeout>;
    firstEventAt: number;
    latestType: 'update' | 'delete';
    latestUri: vscode.Uri;
}

interface RemoteDeleteTombstone {
    digest: string;
    staleLocalMtime?: number;
}

interface InitializeLocalReplicaOptions {
    preserveExistingLocalFiles?: boolean;
    resetLocalFilesToRemote?: boolean;
}

interface ValidateExactBaseUriOptions {
    beforeEmpty?: (baseUri: vscode.Uri) => void | Promise<void>;
    projectUri?: vscode.Uri;
}

interface ApplySyncOptions {
    forcePush?: boolean;
    reason?: string;
    resolveConflict?: boolean;
    deferConflictResolution?: boolean;
}

export interface LocalReplicaPrecompileFlushResult {
    pendingCount: number;
    divergedCount: number;
    openDocCount: number;
    sourceScanCount: number;
    sourceScanDeleteCount: number;
    attemptedCount: number;
    failedCount: number;
    blockedCount: number;
    suppressedCount: number;
    paths: string[];
    failures: string[];
}

type ProtectedExactBaseUriReasonCode =
    | 'filesystem-root'
    | 'home-directory'
    | 'workspace-root'
    | 'mount-root'
    | 'windows-user-profile-root'
    | 'git-repository-root';

class LocalReplicaFolderSelectionCancelledError extends Error {}
class LocalReplicaFolderSelectionRejectedError extends Error {}
class ConcurrentReplicaChangeError extends Error {}

function definedInitializationOptions(options?: InitializeLocalReplicaOptions): InitializeLocalReplicaOptions {
    return Object.fromEntries(
        Object.entries(options ?? {}).filter(([_key, value]) => value!==undefined),
    ) as InitializeLocalReplicaOptions;
}

// Byte-true digest used to detect echoes in the bypass cache. The previous
// implementation went through TextDecoder which mangles arbitrary byte
// sequences into U+FFFD and was lossy for binaries (different PDFs could
// collapse to the same 32-bit hash, defeating echo suppression for media
// files). sha1 over raw bytes is collision-safe and matches the form
// already used by proposalStore for content addressing.
function contentDigest(content?: Uint8Array): string {
    if (content===undefined) { return DELETE_DIGEST; }
    return crypto.createHash('sha1').update(content).digest('hex');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a === b) { return true; }
    if (a.length !== b.length) { return false; }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { return false; }
    }
    return true;
}

function normalizeMtimeMs(mtime: number): number {
    return mtime<10_000_000_000 ? mtime*1000 : mtime;
}

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private bypassCache: Map<string, [FileCache,FileCache]> = new Map();
    private baseCache: {[key:string]: Uint8Array} = {};
    private syncManifest?: SyncManifest;
    private syncManifestBaselineMode: SyncManifestBaselineMode = 'unavailable';
    private settingsExistedBeforeInitialization = false;
    private syncManifestDirty = false;
    private syncManifestRevision = 0;
    private syncManifestPersistQueue: Promise<void> = Promise.resolve();
    // Files we have written locally at least once. A push-delete arriving for a
    // relPath that isn't in here AND isn't in baseCache is treated as an echo,
    // not a user-driven delete, and is refused in the delete-guard layer.
    private seenLocalEntities: Set<string> = new Set();
    // Files whose initial pull failed even after Layer 1 retries. These are
    // present on the remote but never landed locally, so a watcher event for
    // them must NEVER propagate to the remote. Cleared by retryFailedInitialPulls
    // or by ignoreFailedInitialPulls.
    private failedInitialPulls: Set<string> = new Set();
    // Last synced bytes for paths that were deleted from the remote. If a local
    // create/update for the exact same bytes arrives after the delete, it is a
    // stale watcher echo rather than a new user edit and must not recreate the
    // remote file.
    private remoteDeleteTombstones: Map<string, RemoteDeleteTombstone> = new Map();
    private initialPullStatus: 'pending' | 'complete' | 'partial' = 'pending';
    private partialPullToastGeneration?: number;
    private syncQueues: Map<string, Promise<unknown>> = new Map();
    private locallyDivergedPaths: Set<string> = new Set();
    private syncConflicts: Map<string, string> = new Map();
    private conflictLocalDigests: Map<string, string> = new Map();
    private localReplicaSettings?: {
        uri: string,
        serverName: string,
        enableCompileNPreview: boolean,
        projectName: string,
    };
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
    private localWatcherProbe?: {
        generation: number;
        uri: string;
        timeout?: ReturnType<typeof setTimeout>;
        resolve: () => void;
    };
    private localWatcherHealthTimer?: ReturnType<typeof setTimeout>;
    private localWatcherHealthState: 'unknown' | 'healthy' | 'degraded' = 'unknown';
    private localWatcherWarningShown = false;
    private fallbackScanTimer?: ReturnType<typeof setTimeout>;
    private fallbackScanRunningGeneration?: number;
    private fallbackScanGeneration?: number;
    // Lazily-armable trigger for the local-watcher subscriptions. When the
    // initial pull is partial we never invoke this, so the push direction is
    // physically impossible until retryFailedInitialPulls / ignoreFailedInitialPulls
    // recovers cleanly.
    private armLocalWatcher?: () => void;
    private dynamicLocalDisposables: vscode.Disposable[] = [];
    // Per-path event coalescers. The VFS fires Change events for every
    // compile-cycle touch (often 4× the same .tex file in a 30s span with
    // identical content). Debouncing per-path collapses these into a single
    // applySync call; MAX_WAIT_MS caps the worst case so a continuous stream
    // can't starve the path indefinitely.
    private pendingVfsEvents: Map<string, PendingEvent> = new Map();
    private pendingLocalEvents: Map<string, PendingEvent> = new Map();
    private inFlightSessionIO = new Set<Promise<unknown>>();
    private localGuardCleanupPromises = new Map<string, Promise<void>>();
    private syncGeneration = 0;
    private syncSessionActive = false;
    private static readonly eventCoalesceMs = 250;
    private static readonly eventMaxWaitMs = 2000;
    private static readonly watcherProbeTimeoutMs = 750;
    private static readonly watcherHealthIntervalMs = 1000;
    private static readonly fallbackScanIntervalMs = 750;
    private static readonly maxMergeBaselineBytes = 5 * 1024 * 1024;
    private initializationOptions: InitializeLocalReplicaOptions = {};
    private ignorePatterns: string[] = [
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/__latexindent*',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
        '**/main.pdf',
        '**/output.pdf',
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    private async runSessionIO<T>(
        generation: number,
        task: () => Thenable<T> | Promise<T>,
    ): Promise<T> {
        this.requireSyncSession(generation);
        const operation = Promise.resolve().then(task);
        this.inFlightSessionIO.add(operation);
        try {
            return await operation;
        } finally {
            this.inFlightSessionIO.delete(operation);
        }
    }

    private async drainInFlightSessionIO() {
        while (this.inFlightSessionIO.size>0) {
            await Promise.allSettled([...this.inFlightSessionIO]);
        }
    }

    private async beginSyncSession() {
        if (this.syncSessionActive) {
            this.deactivateSyncSession();
        }
        const generation = ++this.syncGeneration;
        this.syncSessionActive = false;
        this.partialPullToastGeneration = undefined;
        await this.drainInFlightSessionIO();
        if (generation===this.syncGeneration) {
            this.syncSessionActive = true;
        }
        return generation;
    }

    private isSyncSessionActive(generation = this.syncGeneration) {
        return this.syncSessionActive && generation===this.syncGeneration;
    }

    private requireSyncSession(generation = this.syncGeneration) {
        if (!this.isSyncSessionActive(generation)) {
            throw new Error('Local Replica sync session is no longer active.');
        }
    }

    private deactivateSyncSession(generation?: number) {
        if (generation!==undefined && generation!==this.syncGeneration) { return; }
        this.syncSessionActive = false;
        this.syncGeneration += 1;
        this.partialPullToastGeneration = undefined;
        this.vfsWatcher?.dispose();
        this.vfsWatcher = undefined;
        for (const disposable of this.dynamicLocalDisposables) {
            disposable.dispose();
        }
        this.dynamicLocalDisposables = [];
        this.localWatcher = undefined;
        this.armLocalWatcher = undefined;
        const localWatcherProbe = this.localWatcherProbe;
        this.localWatcherProbe = undefined;
        if (localWatcherProbe) {
            if (localWatcherProbe.timeout) {
                clearTimeout(localWatcherProbe.timeout);
                localWatcherProbe.timeout = undefined;
            }
            localWatcherProbe.resolve();
        }
        if (this.localWatcherHealthTimer) {
            clearTimeout(this.localWatcherHealthTimer);
            this.localWatcherHealthTimer = undefined;
        }
        this.localWatcherHealthState = 'unknown';
        this.localWatcherWarningShown = false;
        if (this.fallbackScanTimer) {
            clearTimeout(this.fallbackScanTimer);
            this.fallbackScanTimer = undefined;
        }
        this.fallbackScanRunningGeneration = undefined;
        this.fallbackScanGeneration = undefined;
        for (const pending of this.pendingVfsEvents.values()) {
            clearTimeout(pending.timer);
        }
        this.pendingVfsEvents.clear();
        for (const pending of this.pendingLocalEvents.values()) {
            clearTimeout(pending.timer);
        }
        this.pendingLocalEvents.clear();
    }

    public deactivate() {
        this.deactivateSyncSession();
    }

    public static sanitizeProjectFolderName(projectName: string): string {
        let sanitized = projectName;
        if (process.platform==='win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        } else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }

    private static async pathExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return false;
            }
            throw error;
        }
    }

    private static isFileNotFoundError(error: unknown): boolean {
        const code = typeof error==='object' && error!==null && 'code' in error
            ? String((error as {code?: unknown}).code)
            : '';
        const message = formatUnknownError(error);
        return code==='FileNotFound'
            || code==='ENOENT'
            || /EntryNotFound|FileNotFound|ENOENT|not found/i.test(message);
    }

    private static comparableFsPath(fsPath: string): string {
        const normalized = nodePath.normalize(fsPath);
        return process.platform==='win32' ? normalized.toLowerCase() : normalized;
    }

    private static async resolvedFsPath(uri: vscode.Uri): Promise<string> {
        const resolvedPath = nodePath.resolve(uri.fsPath);
        try {
            return LocalReplicaSCMProvider.comparableFsPath(await nodeFs.realpath(resolvedPath));
        } catch {
            return LocalReplicaSCMProvider.comparableFsPath(resolvedPath);
        }
    }

    private static async isGitRepositoryRoot(uri: vscode.Uri): Promise<boolean> {
        return LocalReplicaSCMProvider.pathExists(vscode.Uri.joinPath(uri, '.git'));
    }

    private static isMountRoot(resolvedPath: string): boolean {
        if (process.platform==='win32') { return false; }
        const normalized = resolvedPath.replace(/\/+$/, '') || '/';
        return normalized==='/mnt'
            || /^\/mnt\/[^/]+$/i.test(normalized);
    }

    private static isWindowsUserProfileRoot(resolvedPath: string): boolean {
        if (process.platform==='win32') {
            return LocalReplicaSCMProvider.isNativeWindowsUserProfileRoot(resolvedPath);
        }
        const normalized = resolvedPath.replace(/\/+$/, '');
        return /^\/mnt\/[^/]+\/Users$/i.test(normalized)
            || /^\/mnt\/[^/]+\/Users\/[^/]+$/i.test(normalized);
    }

    private static isNativeWindowsUserProfileRoot(resolvedPath: string): boolean {
        const normalized = nodePath.win32.normalize(resolvedPath).replace(/[\\/]+$/, '');
        const parts = normalized.split(/[\\/]+/).filter(Boolean);
        return /^[a-z]:$/i.test(parts[0] ?? '')
            && parts[1]?.toLowerCase()==='users'
            && (parts.length===2 || parts.length===3);
    }

    private static protectedExactBaseUriReasonMessage(reason: ProtectedExactBaseUriReasonCode): string {
        switch (reason) {
            case 'filesystem-root': return vscode.l10n.t('filesystem root');
            case 'home-directory': return vscode.l10n.t('home directory');
            case 'workspace-root': return vscode.l10n.t('workspace root');
            case 'mount-root': return vscode.l10n.t('mount root');
            case 'windows-user-profile-root': return vscode.l10n.t('Windows user profile root');
            case 'git-repository-root': return vscode.l10n.t('Git repository root');
        }
    }

    private static async getProtectedExactBaseUriReasonCode(baseUri: vscode.Uri): Promise<ProtectedExactBaseUriReasonCode | undefined> {
        if (baseUri.scheme!=='file') {
            return undefined;
        }

        const resolvedPath = await LocalReplicaSCMProvider.resolvedFsPath(baseUri);
        const parsed = nodePath.parse(resolvedPath);
        const homePath = await LocalReplicaSCMProvider.resolvedFsPath(vscode.Uri.file(os.homedir()));
        const workspaceRoots = await Promise.all(
            (vscode.workspace.workspaceFolders ?? [])
                .filter(folder => folder.uri.scheme==='file')
                .map(folder => LocalReplicaSCMProvider.resolvedFsPath(folder.uri)),
        );

        if (resolvedPath===nodePath.resolve(parsed.root)) {
            return 'filesystem-root';
        } else if (resolvedPath===homePath) {
            return 'home-directory';
        } else if (LocalReplicaSCMProvider.isMountRoot(resolvedPath)) {
            return 'mount-root';
        } else if (LocalReplicaSCMProvider.isWindowsUserProfileRoot(resolvedPath)) {
            return 'windows-user-profile-root';
        } else if (await LocalReplicaSCMProvider.isGitRepositoryRoot(baseUri)) {
            return 'git-repository-root';
        } else if (workspaceRoots.includes(resolvedPath)) {
            return 'workspace-root';
        }

        return undefined;
    }

    private static async getProtectedExactBaseUriReason(baseUri: vscode.Uri): Promise<string | undefined> {
        const reason = await LocalReplicaSCMProvider.getProtectedExactBaseUriReasonCode(baseUri);
        return reason ? LocalReplicaSCMProvider.protectedExactBaseUriReasonMessage(reason) : undefined;
    }

    private static async rejectDangerousExactBaseUri(baseUri: vscode.Uri): Promise<void> {
        if (baseUri.scheme!=='file') {
            const message = vscode.l10n.t('Local Replica folder must be a local file-system path.');
            getOutputChannel().appendLine(`${new Date().toISOString()} [exact folder rejected] ${baseUri.toString()}: non-local path`);
            vscode.window.showErrorMessage(message);
            throw new LocalReplicaFolderSelectionRejectedError('Local Replica folder must be a file URI.');
        }

        const reasonCode = await LocalReplicaSCMProvider.getProtectedExactBaseUriReasonCode(baseUri);
        if (reasonCode) {
            const reason = LocalReplicaSCMProvider.protectedExactBaseUriReasonMessage(reasonCode);
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [exact folder rejected] ${baseUri.fsPath || baseUri.toString()}: ${reason}`,
            );
            vscode.window.showErrorMessage(
                vscode.l10n.t(
                    'Refusing to use {path} as a Local Replica folder because it is a protected {reason}. Select a dedicated project folder instead.',
                    {path: baseUri.fsPath || baseUri.toString(), reason},
                ),
            );
            throw new LocalReplicaFolderSelectionRejectedError(`Protected Local Replica folder: ${reason}`);
        }
    }

    private static async validateExistingExactReplicaSettings(
        baseUri: vscode.Uri,
        expectedProjectUri?: vscode.Uri,
    ): Promise<'same-project' | 'different-project' | 'none'> {
        const settings = await readReplicaSettingsSnapshot(baseUri);
        if (!settings?.uri) {
            return 'none';
        }
        if (!expectedProjectUri) {
            return 'different-project';
        }
        try {
            const existingProjectUri = vscode.Uri.parse(settings.uri);
            return vfsProjectKey(existingProjectUri)===vfsProjectKey(expectedProjectUri)
                ? 'same-project'
                : 'different-project';
        } catch {
            return 'different-project';
        }
    }

    public setInitializationOptions(options?: InitializeLocalReplicaOptions) {
        this.initializationOptions = {
            ...this.initializationOptions,
            ...definedInitializationOptions(options),
        };
        return this;
    }

    private get settingsUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, REPLICA_SETTINGS_FILE);
    }

    private get syncManifestUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, SYNC_MANIFEST_FILE);
    }

    private get legacySettingsUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, LEGACY_REPLICA_SETTINGS_FILE);
    }

    private get settingsDirectoryUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, REPLICA_SETTINGS_DIR);
    }

    private get localOperationsDirectoryPath(): string {
        return nodePath.join(this.settingsDirectoryUri.fsPath, 'operations');
    }

    private get remoteDeleteOperationsDirectoryPath(): string {
        return nodePath.join(this.settingsDirectoryUri.fsPath, 'remote-delete-operations');
    }

    private localOperationRecordPath(id: string): string {
        return nodePath.join(this.localOperationsDirectoryPath, `${id}.json`);
    }

    private localOperationCommitPath(id: string): string {
        return nodePath.join(this.localOperationsDirectoryPath, `${id}.committed`);
    }

    private localOperationGuardPath(record: LocalReplicaOperationRecord): string {
        return nodePath.join(this.localOperationsDirectoryPath, record.guardName);
    }

    private async syncDirectoryBestEffort(directoryPath: string): Promise<void> {
        let handle: nodeFs.FileHandle | undefined;
        try {
            handle = await nodeFs.open(directoryPath, 'r');
            await handle.sync();
        } catch {
            // Directory fsync is unavailable on some Windows/network filesystems.
        } finally {
            await handle?.close().catch(() => undefined);
        }
    }

    private async renameDurably(sourcePath: string, targetPath: string): Promise<void> {
        await nodeFs.rename(sourcePath, targetPath);
        const sourceDirectory = nodePath.dirname(sourcePath);
        const targetDirectory = nodePath.dirname(targetPath);
        await this.syncDirectoryBestEffort(sourceDirectory);
        if (targetDirectory!==sourceDirectory) {
            await this.syncDirectoryBestEffort(targetDirectory);
        }
    }

    private async writeDurableOperationFile(
        targetPath: string,
        content: Uint8Array,
    ): Promise<void> {
        await nodeFs.mkdir(nodePath.dirname(targetPath), {recursive: true});
        const temporaryPath = `${targetPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        let handle: nodeFs.FileHandle | undefined;
        try {
            handle = await nodeFs.open(temporaryPath, 'wx', 0o600);
            await handle.writeFile(content);
            await handle.sync();
            await handle.close();
            handle = undefined;
            await nodeFs.rename(temporaryPath, targetPath);
            await this.syncDirectoryBestEffort(nodePath.dirname(targetPath));
        } catch (error) {
            await handle?.close().catch(() => undefined);
            await nodeFs.unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    }

    private async createLocalOperationRecord(
        record: LocalReplicaOperationRecord,
    ): Promise<void> {
        await this.writeDurableOperationFile(
            this.localOperationRecordPath(record.id),
            Buffer.from(JSON.stringify(record)),
        );
    }

    private async markLocalOperationCommitted(id: string): Promise<void> {
        if (await this.localPathExists(this.localOperationCommitPath(id))) {
            return;
        }
        await this.writeDurableOperationFile(
            this.localOperationCommitPath(id),
            Buffer.from('committed\n'),
        );
    }

    private async removeLocalOperationRecord(id: string): Promise<void> {
        await nodeFs.unlink(this.localOperationCommitPath(id)).catch(error => {
            if (!this.isNodeErrorCode(error, 'ENOENT')) { throw error; }
        });
        await nodeFs.unlink(this.localOperationRecordPath(id)).catch(error => {
            if (!this.isNodeErrorCode(error, 'ENOENT')) { throw error; }
        });
        await this.syncDirectoryBestEffort(this.localOperationsDirectoryPath);
    }

    private async retainGuardOrRemoveLocalOperation(
        record: LocalReplicaOperationRecord,
    ): Promise<boolean> {
        if (await this.localPathExists(this.localOperationGuardPath(record))) {
            await this.markLocalOperationCommitted(record.id);
            return true;
        }
        await this.removeLocalOperationRecord(record.id);
        return false;
    }

    private remoteDeleteOperationRecordPath(id: string): string {
        return nodePath.join(this.remoteDeleteOperationsDirectoryPath, `${id}.json`);
    }

    private isValidRecordedPathRevision(value: unknown): value is string {
        return typeof value==='string'
            && value.length<=16_384
            && (
                value===DELETE_DIGEST
                || /^[a-f0-9]{40}$/.test(value)
                || /^directory:[a-f0-9]{40}$/.test(value)
                || value.startsWith('other:')
                || value.startsWith('unreadable:')
            );
    }

    private isValidRemoteDeleteOperationRecord(
        value: unknown,
    ): value is RemoteDeleteOperationRecord {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const record = value as Partial<RemoteDeleteOperationRecord>;
        return record.version===1
            && typeof record.id==='string'
            && record.id.length<=128
            && /^[a-f0-9]{24}$/.test(record.id)
            && typeof record.relPath==='string'
            && this.isCanonicalReplicaRelPath(record.relPath)
            && typeof record.stagingRelPath==='string'
            && this.isCanonicalReplicaRelPath(record.stagingRelPath)
            && nodePath.posix.basename(record.stagingRelPath).startsWith('.sr-overleaf-delete-')
            && nodePath.posix.basename(record.stagingRelPath)===`.sr-overleaf-delete-${record.id}`
            && nodePath.posix.dirname(record.stagingRelPath)===nodePath.posix.dirname(record.relPath)
            && this.isValidRecordedPathRevision(record.expectedRevision)
            && typeof record.createdAt==='string'
            && Number.isFinite(Date.parse(record.createdAt));
    }

    private async createRemoteDeleteOperationRecord(
        record: RemoteDeleteOperationRecord,
    ): Promise<void> {
        const recordPath = this.remoteDeleteOperationRecordPath(record.id);
        try {
            const existing: unknown = JSON.parse(await nodeFs.readFile(recordPath, 'utf8'));
            if (
                this.isValidRemoteDeleteOperationRecord(existing)
                && existing.relPath===record.relPath
                && existing.stagingRelPath===record.stagingRelPath
                && existing.expectedRevision===record.expectedRevision
            ) {
                return;
            }
            throw new Error(`Conflicting remote delete journal at ${recordPath}`);
        } catch (error) {
            if (!this.isNodeErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
        await this.writeDurableOperationFile(
            recordPath,
            Buffer.from(JSON.stringify(record)),
        );
    }

    private async removeRemoteDeleteOperationRecord(id: string): Promise<void> {
        await nodeFs.unlink(this.remoteDeleteOperationRecordPath(id)).catch(error => {
            if (!this.isNodeErrorCode(error, 'ENOENT')) { throw error; }
        });
        await this.syncDirectoryBestEffort(this.remoteDeleteOperationsDirectoryPath);
    }

    private async listRemoteDeleteOperationRecords(): Promise<RemoteDeleteOperationRecord[]> {
        let entries: string[];
        try {
            entries = await nodeFs.readdir(this.remoteDeleteOperationsDirectoryPath);
        } catch (error) {
            if (this.isNodeErrorCode(error, 'ENOENT')) {
                return [];
            }
            throw error;
        }
        const records: RemoteDeleteOperationRecord[] = [];
        for (const name of entries.filter(entry => entry.endsWith('.json')).sort()) {
            const recordPath = nodePath.join(this.remoteDeleteOperationsDirectoryPath, name);
            try {
                const parsed: unknown = JSON.parse(await nodeFs.readFile(recordPath, 'utf8'));
                if (!this.isValidRemoteDeleteOperationRecord(parsed)) {
                    throw new Error('invalid remote delete operation record shape');
                }
                records.push(parsed);
            } catch (error) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [remote delete journal retained] ${recordPath}: ` +
                    formatUnknownError(error),
                );
                throw new Error(
                    `Cannot safely resume remote deletes because ${recordPath} is invalid: ` +
                    formatUnknownError(error),
                );
            }
        }
        return records;
    }

    private isValidLocalOperationRecord(
        value: unknown,
    ): value is LocalReplicaOperationRecord {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const record = value as Partial<LocalReplicaOperationRecord>;
        const validName = (name: unknown, suffix: string) =>
            typeof name==='string'
            && nodePath.basename(name)===name
            && name.startsWith('.sr-overleaf-')
            && name.endsWith(suffix);
        return record.version===1
            && typeof record.id==='string'
            && record.id.length<=128
            && /^[a-f0-9-]+$/.test(record.id)
            && (record.kind==='write' || record.kind==='delete')
            && typeof record.relPath==='string'
            && this.isCanonicalReplicaRelPath(record.relPath)
            && (
                record.entityKind==='missing'
                || record.entityKind==='file'
                || record.entityKind==='directory'
                || record.entityKind==='other'
            )
            && this.isValidRecordedPathRevision(record.expectedRevision)
            && (
                record.kind==='write'
                    ? (
                        typeof record.installedRevision==='string'
                        && /^[a-f0-9]{40}$/.test(record.installedRevision)
                        && validName(record.stageName, '.new')
                    )
                    : (
                        record.installedRevision===undefined
                        && record.stageName===undefined
                    )
            )
            && validName(record.backupName, record.kind==='write' ? '.old' : '.deleted')
            && validName(record.guardName, '.guard')
            && typeof record.createdAt==='string'
            && Number.isFinite(Date.parse(record.createdAt));
    }

    private async localPathExists(localPath: string): Promise<boolean> {
        try {
            await nodeFs.lstat(localPath);
            return true;
        } catch (error) {
            if (this.isNodeErrorCode(error, 'ENOENT')) {
                return false;
            }
            throw error;
        }
    }

    private async collectLocalInodeKeys(
        localPath: string,
        result = new Set<string>(),
    ): Promise<Set<string>> {
        const stat = await nodeFs.lstat(localPath, {bigint: true});
        result.add(`${stat.dev}:${stat.ino}`);
        if (!stat.isDirectory()) {
            return result;
        }
        for (const entry of await nodeFs.readdir(localPath)) {
            await this.collectLocalInodeKeys(nodePath.join(localPath, entry), result);
        }
        return result;
    }

    private async retainedPathHasOpenFileDescriptor(
        localPath: string,
    ): Promise<boolean | undefined> {
        if (process.platform!=='linux') {
            return undefined;
        }
        let inodeKeys: Set<string>;
        let processEntries: string[];
        try {
            inodeKeys = await this.collectLocalInodeKeys(localPath);
            processEntries = await nodeFs.readdir('/proc');
        } catch {
            return undefined;
        }
        const currentUid = process.getuid?.();
        let inspectionIncomplete = false;
        for (const pid of processEntries.filter(entry => /^\d+$/.test(entry))) {
            const processRoot = `/proc/${pid}`;
            if (currentUid!==undefined && currentUid!==0) {
                try {
                    const status = await nodeFs.readFile(
                        nodePath.join(processRoot, 'status'),
                        'utf8',
                    );
                    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
                    if (uid===undefined || Number(uid)!==currentUid) {
                        continue;
                    }
                } catch (error) {
                    if (this.isNodeErrorCode(error, 'ENOENT')) {
                        continue;
                    }
                    inspectionIncomplete = true;
                    continue;
                }
            }
            const fileDescriptorDirectory = nodePath.join(processRoot, 'fd');
            let descriptors: string[];
            try {
                descriptors = await nodeFs.readdir(fileDescriptorDirectory);
            } catch (error) {
                if (this.isNodeErrorCode(error, 'ENOENT')) {
                    continue;
                }
                inspectionIncomplete = true;
                continue;
            }
            for (const descriptor of descriptors) {
                try {
                    const stat = await nodeFs.stat(
                        nodePath.join(fileDescriptorDirectory, descriptor),
                        {bigint: true},
                    );
                    if (inodeKeys.has(`${stat.dev}:${stat.ino}`)) {
                        return true;
                    }
                } catch (error) {
                    if (this.isNodeErrorCode(error, 'ENOENT')) {
                        continue;
                    }
                    inspectionIncomplete = true;
                }
            }
        }
        return inspectionIncomplete ? undefined : false;
    }

    private scheduleUnreferencedLocalGuardCleanup(
        record: LocalReplicaOperationRecord,
        generation: number,
    ): void {
        if (
            process.platform!=='linux'
            || this.localGuardCleanupPromises.has(record.id)
        ) {
            return;
        }
        const cleanup = Promise.resolve().then(async () => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const guardPath = this.localOperationGuardPath(record);
            const before = await this.captureLocalUriRevision(
                vscode.Uri.file(guardPath),
                record.relPath,
                generation,
            );
            if (before.revision!==record.expectedRevision) { return; }
            const hasOpenDescriptor = await this.retainedPathHasOpenFileDescriptor(guardPath);
            if (hasOpenDescriptor!==false || !this.isSyncSessionActive(generation)) {
                return;
            }
            const after = await this.captureLocalUriRevision(
                vscode.Uri.file(guardPath),
                record.relPath,
                generation,
            );
            if (after.revision!==record.expectedRevision) { return; }
            await this.runSessionIO(generation, async () => {
                await nodeFs.rm(guardPath, {recursive: true, force: true});
                await this.removeLocalOperationRecord(record.id);
            });
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [local inode guard released] ${record.relPath}: ` +
                'no open file descriptor references the retained inode',
            );
        }).catch(error => {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [local inode guard cleanup deferred] ${record.relPath}: ` +
                formatUnknownError(error),
            );
        }).finally(() => {
            if (this.localGuardCleanupPromises.get(record.id)===cleanup) {
                this.localGuardCleanupPromises.delete(record.id);
            }
        });
        this.localGuardCleanupPromises.set(record.id, cleanup);
    }

    private async listLocalOperationRecords(): Promise<Array<{
        record: LocalReplicaOperationRecord;
        committed: boolean;
    }>> {
        let entries: string[];
        try {
            entries = await nodeFs.readdir(this.localOperationsDirectoryPath);
        } catch (error) {
            if (this.isNodeErrorCode(error, 'ENOENT')) {
                return [];
            }
            throw error;
        }
        const records: Array<{
            record: LocalReplicaOperationRecord;
            committed: boolean;
        }> = [];
        for (const name of entries.filter(entry => entry.endsWith('.json')).sort()) {
            const recordPath = nodePath.join(this.localOperationsDirectoryPath, name);
            try {
                const parsed: unknown = JSON.parse(await nodeFs.readFile(recordPath, 'utf8'));
                if (!this.isValidLocalOperationRecord(parsed)) {
                    throw new Error('invalid operation record shape');
                }
                records.push({
                    record: parsed,
                    committed: await this.localPathExists(
                        this.localOperationCommitPath(parsed.id),
                    ),
                });
            } catch (error) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local operation journal retained] ${recordPath}: ` +
                    formatUnknownError(error),
                );
                throw new Error(
                    `Cannot safely resume Local Replica operations because ${recordPath} is invalid: ` +
                    formatUnknownError(error),
                );
            }
        }
        return records;
    }

    private localOperationSiblingPath(
        record: LocalReplicaOperationRecord,
        name: string,
    ): string {
        return nodePath.join(
            nodePath.dirname(this.localUri(record.relPath).fsPath),
            name,
        );
    }

    private async restoreOperationGuardToVisiblePath(
        record: LocalReplicaOperationRecord,
        guardPath: string,
        generation: number,
    ): Promise<void> {
        const targetPath = this.localUri(record.relPath).fsPath;
        const targetExists = await this.localPathExists(targetPath);
        if (!targetExists) {
            await this.restoreStagedPathWithoutOverwrite(
                guardPath,
                targetPath,
                record.relPath,
                record.entityKind,
                'recovering a changed inode retained by an interrupted Local Replica operation',
                this.localOperationGuardPath(record),
            );
            return;
        }

        if (record.entityKind==='file') {
            await this.restoreChangedBackupAfterInstall(
                guardPath,
                targetPath,
                record.relPath,
                record.kind==='write' ? record.installedRevision : undefined,
                this.localOperationGuardPath(record),
            );
            return;
        }

        await this.preserveConcurrentStagingPath(
            targetPath,
            record.relPath,
            'the visible path was displaced while a changed directory inode was recovered',
        );
        await this.renameDurably(guardPath, targetPath);
    }

    private async cleanupLocalOperationStage(
        record: LocalReplicaOperationRecord,
    ): Promise<void> {
        if (!record.stageName) { return; }
        const stagePath = this.localOperationSiblingPath(record, record.stageName);
        await nodeFs.rm(stagePath, {recursive: true, force: true});
    }

    private async recoverInterruptedLocalOperations(
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        for (const {record, committed} of await this.listLocalOperationRecords()) {
            this.requireSyncSession(generation);
            const targetPath = this.localUri(record.relPath).fsPath;
            const backupPath = this.localOperationSiblingPath(record, record.backupName);
            const guardPath = this.localOperationGuardPath(record);
            const backupExists = await this.localPathExists(backupPath);
            const guardExists = await this.localPathExists(guardPath);
            const sourcePath = guardExists ? guardPath : (backupExists ? backupPath : undefined);

            if (committed) {
                if (sourcePath) {
                    const sourceRevision = await this.captureLocalUriRevision(
                        vscode.Uri.file(sourcePath),
                        record.relPath,
                        generation,
                    );
                    const targetExists = await this.localPathExists(targetPath);
                    if (
                        sourceRevision.revision!==record.expectedRevision
                        || (record.kind==='write' && !targetExists)
                    ) {
                        await this.restoreOperationGuardToVisiblePath(
                            record,
                            sourcePath,
                            generation,
                        );
                        if (sourceRevision.revision!==record.expectedRevision) {
                            const latestLocal = await this.captureLocalPathRevision(
                                record.relPath,
                                generation,
                            );
                            await this.markSyncConflict(
                                record.relPath,
                                'A process continued writing through an older local file handle while Local Replica was inactive',
                                latestLocal.kind==='file' ? latestLocal.content : undefined,
                                generation,
                            );
                        }
                        await this.retainGuardOrRemoveLocalOperation(record);
                    } else if (sourcePath!==guardPath) {
                        await this.renameDurably(sourcePath, guardPath);
                    }
                } else {
                    await this.removeLocalOperationRecord(record.id);
                }
                await this.cleanupLocalOperationStage(record);
                continue;
            }

            if (sourcePath) {
                const sourceRevision = await this.captureLocalUriRevision(
                    vscode.Uri.file(sourcePath),
                    record.relPath,
                    generation,
                );
                const targetExists = await this.localPathExists(targetPath);
                if (
                    record.kind==='write'
                    && targetExists
                    && sourceRevision.revision===record.expectedRevision
                ) {
                    const targetRevision = await this.captureLocalPathRevision(
                        record.relPath,
                        generation,
                    );
                    if (
                        record.installedRevision!==undefined
                        && targetRevision.revision===record.installedRevision
                    ) {
                        if (sourcePath!==guardPath) {
                            await this.renameDurably(sourcePath, guardPath);
                        }
                        await this.markLocalOperationCommitted(record.id);
                        await this.cleanupLocalOperationStage(record);
                        continue;
                    }
                }
                if (
                    record.kind==='delete'
                    && !targetExists
                    && sourceRevision.revision===record.expectedRevision
                ) {
                    if (sourcePath!==guardPath) {
                        await this.renameDurably(sourcePath, guardPath);
                    }
                    await this.markLocalOperationCommitted(record.id);
                    await this.cleanupLocalOperationStage(record);
                    continue;
                }
                await this.restoreOperationGuardToVisiblePath(
                    record,
                    sourcePath,
                    generation,
                );
                const latestLocal = await this.captureLocalPathRevision(
                    record.relPath,
                    generation,
                );
                await this.markSyncConflict(
                    record.relPath,
                    'An interrupted Local Replica operation encountered concurrent local changes during recovery',
                    latestLocal.kind==='file' ? latestLocal.content : undefined,
                    generation,
                );
                await this.retainGuardOrRemoveLocalOperation(record);
            }
            await this.cleanupLocalOperationStage(record);
            if (!sourcePath) {
                await this.removeLocalOperationRecord(record.id);
            }
        }
    }

    private async recoverChangedCommittedLocalOperations(
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        await Promise.all([...this.localGuardCleanupPromises.values()]);
        this.requireSyncSession(generation);
        for (const {record, committed} of await this.listLocalOperationRecords()) {
            if (!committed) { continue; }
            const guardPath = this.localOperationGuardPath(record);
            if (!await this.localPathExists(guardPath)) {
                await this.removeLocalOperationRecord(record.id);
                continue;
            }
            const guardRevision = await this.captureLocalUriRevision(
                vscode.Uri.file(guardPath),
                record.relPath,
                generation,
            );
            if (guardRevision.revision===record.expectedRevision) {
                this.scheduleUnreferencedLocalGuardCleanup(record, generation);
                continue;
            }
            await this.restoreOperationGuardToVisiblePath(
                record,
                guardPath,
                generation,
            );
            const latestLocal = await this.captureLocalPathRevision(record.relPath, generation);
            await this.markSyncConflict(
                record.relPath,
                'A process continued writing through an older local file handle after an Overleaf operation',
                latestLocal.kind==='file' ? latestLocal.content : undefined,
                generation,
            );
            await this.retainGuardOrRemoveLocalOperation(record);
        }
    }

    private async backupLegacySettings(generation = this.syncGeneration) {
        this.requireSyncSession(generation);
        if (!await LocalReplicaSCMProvider.pathExists(this.legacySettingsUri)) {
            return;
        }
        this.requireSyncSession(generation);
        try {
            await this.runSessionIO(
                generation,
                () => vscode.workspace.fs.rename(
                    this.legacySettingsUri,
                    vscode.Uri.joinPath(this.baseUri, LEGACY_REPLICA_SETTINGS_BACKUP_FILE),
                    {overwrite: false},
                ),
            );
        } catch {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            try {
                await this.runSessionIO(
                    generation,
                    () => vscode.workspace.fs.rename(
                        this.legacySettingsUri,
                        vscode.Uri.joinPath(this.baseUri, LEGACY_REPLICA_SETTINGS_DIR, `settings.${timestamp}.overleaf-workshop.json`),
                        {overwrite: false},
                    ),
                );
            } catch (error) {
                console.warn(`Could not back up legacy local replica settings under ${this.baseUri.toString()}:`, error);
            }
        }
    }

    private async pathExistsInSession(
        uri: vscode.Uri,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        try {
            await this.runSessionIO(generation, () => vscode.workspace.fs.stat(uri));
            this.requireSyncSession(generation);
            return true;
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                this.requireSyncSession(generation);
                return false;
            }
            throw error;
        }
    }

    private async ensureLocalReplicaSettings(generation = this.syncGeneration) {
        this.requireSyncSession(generation);
        const canonicalSettingsExisted = await this.pathExistsInSession(this.settingsUri, generation);
        const legacySettingsExisted = await this.pathExistsInSession(this.legacySettingsUri, generation);
        this.settingsExistedBeforeInitialization = canonicalSettingsExisted || legacySettingsExisted;
        const canonicalSettings = {
            'uri': stringifyOverleafUri(this.vfs.origin),
            'serverName': this.vfs.serverName,
            'enableCompileNPreview': true,
            'projectName': this.vfs.projectName,
        };
        let shouldPersist = false;
        try {
            const content = await this.runSessionIO(
                generation,
                () => vscode.workspace.fs.readFile(this.settingsUri),
            );
            this.requireSyncSession(generation);
            const storedSettings = JSON.parse(new TextDecoder().decode(content));
            const {enableAgentReview: _legacyEnableAgentReview, ...storedWithoutLegacyAgentReview} = storedSettings;
            this.localReplicaSettings = {
                ...canonicalSettings,
            };
            shouldPersist = JSON.stringify(storedWithoutLegacyAgentReview)!==JSON.stringify(this.localReplicaSettings);
        } catch (error) {
            if (!this.isSyncSessionActive(generation)) {
                throw error;
            }
            this.localReplicaSettings = canonicalSettings;
            shouldPersist = true;
        }
        if (shouldPersist) {
            await this.persistLocalReplicaSettings(generation);
        }
        await this.backupLegacySettings(generation);
        return this.localReplicaSettings;
    }

    private async hasLocalReplicaSettings() {
        try {
            await vscode.workspace.fs.stat(this.settingsUri);
            return true;
        } catch {
            return LocalReplicaSCMProvider.pathExists(this.legacySettingsUri);
        }
    }

    private async persistLocalReplicaSettings(generation = this.syncGeneration) {
        this.requireSyncSession(generation);
        if (this.localReplicaSettings===undefined) { return; }
        await this.runSessionIO(
            generation,
            () => vscode.workspace.fs.createDirectory(this.settingsDirectoryUri),
        );
        await this.runSessionIO(
            generation,
            () => vscode.workspace.fs.writeFile(
                this.settingsUri,
                Buffer.from(JSON.stringify(this.localReplicaSettings, null, 4)),
            ),
        );
    }

    private emptySyncManifest(baselineComplete = true): SyncManifest {
        return {
            version: 2,
            projectUri: stringifyOverleafUri(this.vfs.origin),
            baselineComplete,
            files: {},
            directories: {},
            conflicts: {},
        };
    }

    private markSyncManifestDirty() {
        this.syncManifestDirty = true;
        this.syncManifestRevision += 1;
    }

    private isValidSyncManifestEntry(value: unknown): value is SyncManifestEntry {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const entry = value as Partial<SyncManifestEntry>;
        const validBaseContent = entry.baseContentBase64===undefined
            || (
                typeof entry.baseContentBase64==='string'
                &&
                entry.baseContentBase64.length<=Math.ceil(
                    LocalReplicaSCMProvider.maxMergeBaselineBytes*4/3,
                )+4
                && entry.baseContentBase64.length%4===0
                && /^[A-Za-z0-9+/]*={0,2}$/.test(entry.baseContentBase64)
                && Buffer.from(entry.baseContentBase64, 'base64').toString('base64')
                    ===entry.baseContentBase64
                && contentDigest(Buffer.from(entry.baseContentBase64, 'base64'))
                    ===entry.localDigest
            );
        return typeof entry.remoteFingerprint==='string'
            && entry.remoteFingerprint.length>0
            && entry.remoteFingerprint.length<=4096
            && typeof entry.localSize==='number'
            && Number.isSafeInteger(entry.localSize)
            && entry.localSize>=0
            && typeof entry.localMtime==='number'
            && Number.isFinite(entry.localMtime)
            && entry.localMtime>=0
            && typeof entry.localDigest==='string'
            && /^[a-f0-9]{40}$/.test(entry.localDigest)
            && (
                entry.baseContentBase64===undefined
                || typeof entry.baseContentBase64==='string'
            )
            && validBaseContent
            && (
                !entry.remoteFingerprint.startsWith('content:')
                || entry.remoteFingerprint===`content:${entry.localDigest}`
            )
            && typeof entry.updatedAt==='string'
            && Number.isFinite(Date.parse(entry.updatedAt));
    }

    private isValidSyncManifestDirectoryEntry(
        value: unknown,
    ): value is SyncManifestDirectoryEntry {
        return !!value
            && typeof value==='object'
            && !Array.isArray(value)
            && typeof (value as Partial<SyncManifestDirectoryEntry>).updatedAt==='string'
            && Number.isFinite(Date.parse(
                (value as Partial<SyncManifestDirectoryEntry>).updatedAt!,
            ));
    }

    private isValidSyncManifestConflictEntry(
        value: unknown,
    ): value is SyncManifestConflictEntry {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const entry = value as Partial<SyncManifestConflictEntry>;
        return typeof entry.reason==='string'
            && entry.reason.length>0
            && entry.reason.length<=16_384
            && this.isValidRecordedPathRevision(entry.localDigest)
            && typeof entry.updatedAt==='string'
            && Number.isFinite(Date.parse(entry.updatedAt));
    }

    private isCanonicalReplicaRelPath(relPath: string): boolean {
        return relPath.length>1
            && relPath.startsWith('/')
            && !relPath.endsWith('/')
            && !relPath.includes('\\')
            && !relPath.includes('\0')
            && nodePath.posix.normalize(relPath)===relPath
            && !relPath.split('/').some(segment => segment==='.' || segment==='..');
    }

    private isValidSyncManifestRecord<T>(
        value: unknown,
        entryValidator: (entry: unknown) => entry is T,
    ): value is Record<string, T> {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        return Object.entries(value).every(([relPath, entry]) => {
            return this.isCanonicalReplicaRelPath(relPath)
                && entryValidator(entry);
        });
    }

    private hasValidSyncManifestTree(
        files: Record<string, SyncManifestEntry>,
        directories: Record<string, SyncManifestDirectoryEntry>,
    ): boolean {
        const filePaths = new Set(Object.keys(files));
        const directoryPaths = new Set(Object.keys(directories));
        if ([...filePaths].some(relPath => directoryPaths.has(relPath))) {
            return false;
        }
        for (const relPath of [...filePaths, ...directoryPaths]) {
            let parent = nodePath.posix.dirname(relPath);
            while (parent!=='/') {
                if (filePaths.has(parent)) {
                    return false;
                }
                parent = nodePath.posix.dirname(parent);
            }
        }
        return true;
    }

    private readSyncManifestFile(): Thenable<Uint8Array> {
        return vscode.workspace.fs.readFile(this.syncManifestUri);
    }

    private async loadSyncManifest(generation = this.syncGeneration) {
        this.requireSyncSession(generation);
        const projectUri = stringifyOverleafUri(this.vfs.origin);
        let manifestWasMissing = false;
        try {
            const content = await this.readSyncManifestFile();
            this.requireSyncSession(generation);
            const manifest = JSON.parse(new TextDecoder().decode(content)) as {
                version?: number;
                projectUri?: string;
                baselineComplete?: boolean;
                files?: Record<string, SyncManifestEntry>;
                directories?: Record<string, SyncManifestDirectoryEntry>;
                conflicts?: Record<string, SyncManifestConflictEntry>;
            };
            let sameProject = false;
            try {
                sameProject = manifest.projectUri!==undefined
                    && vfsProjectKey(vscode.Uri.parse(manifest.projectUri))===vfsProjectKey(this.vfs.origin);
            } catch {
                sameProject = false;
            }
            const validShape = (manifest.version===1 || manifest.version===2)
                && sameProject
                && (manifest.baselineComplete===undefined || typeof manifest.baselineComplete==='boolean')
                && this.isValidSyncManifestRecord<SyncManifestEntry>(
                    manifest.files,
                    (value): value is SyncManifestEntry =>
                        this.isValidSyncManifestEntry(value),
                )
                && (
                    manifest.directories===undefined
                    || this.isValidSyncManifestRecord<SyncManifestDirectoryEntry>(
                        manifest.directories,
                        (value): value is SyncManifestDirectoryEntry =>
                            this.isValidSyncManifestDirectoryEntry(value),
                    )
                )
                && (
                    manifest.conflicts===undefined
                    || this.isValidSyncManifestRecord<SyncManifestConflictEntry>(
                        manifest.conflicts,
                        (value): value is SyncManifestConflictEntry =>
                            this.isValidSyncManifestConflictEntry(value),
                    )
                )
                && this.hasValidSyncManifestTree(
                    manifest.files!,
                    manifest.directories ?? {},
                );
            if (validShape) {
                this.requireSyncSession(generation);
                this.syncManifest = {
                    version: 2,
                    projectUri,
                    baselineComplete: manifest.baselineComplete!==false,
                    files: manifest.files!,
                    directories: manifest.version===2 && manifest.directories
                        ? manifest.directories
                        : {},
                    conflicts: manifest.conflicts ?? {},
                };
                this.syncConflicts = new Map(
                    Object.entries(this.syncManifest.conflicts)
                        .map(([relPath, entry]) => [relPath, entry.reason]),
                );
                this.conflictLocalDigests = new Map(
                    Object.entries(this.syncManifest.conflicts)
                        .map(([relPath, entry]) => [relPath, entry.localDigest]),
                );
                this.syncManifestBaselineMode = manifest.baselineComplete===false
                    ? 'unavailable'
                    : 'trusted';
                this.syncManifestRevision += 1;
                this.syncManifestDirty = manifest.version!==2
                    || manifest.directories===undefined
                    || manifest.conflicts===undefined
                    || manifest.baselineComplete===undefined
                    || manifest.projectUri!==projectUri;
                return;
            }
        } catch (error) {
            if (!this.isSyncSessionActive(generation)) {
                throw error;
            }
            manifestWasMissing = LocalReplicaSCMProvider.isFileNotFoundError(error);
            // Missing or invalid manifests are rebuilt opportunistically.
        }
        this.requireSyncSession(generation);
        this.syncManifestBaselineMode = manifestWasMissing
            && !this.settingsExistedBeforeInitialization
            ? 'fresh-replica'
            : 'unavailable';
        this.syncManifest = this.emptySyncManifest(
            this.syncManifestBaselineMode!=='unavailable',
        );
        this.syncConflicts.clear();
        this.conflictLocalDigests.clear();
        this.markSyncManifestDirty();
    }

    private persistSyncManifest(
        force = false,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        if (!this.syncManifest || (!force && !this.syncManifestDirty)) {
            return Promise.resolve();
        }

        const publish = this.syncManifestPersistQueue
            .catch(() => undefined)
            .then(async () => {
                this.requireSyncSession(generation);
                if (!this.syncManifest || (!force && !this.syncManifestDirty)) { return; }

                while (true) {
                    this.requireSyncSession(generation);
                    const revision = this.syncManifestRevision;
                    const serialized = Buffer.from(JSON.stringify(this.syncManifest, null, 2));
                    const temporaryUri = vscode.Uri.joinPath(
                        this.settingsDirectoryUri,
                        `sync-manifest.${process.pid}.${generation}.${revision}.${Date.now()}.tmp`,
                    );
                    try {
                        await this.runSessionIO(
                            generation,
                            () => vscode.workspace.fs.createDirectory(this.settingsDirectoryUri),
                        );
                        await this.runSessionIO(
                            generation,
                            () => vscode.workspace.fs.writeFile(temporaryUri, serialized),
                        );
                        await this.runSessionIO(
                            generation,
                            () => vscode.workspace.fs.rename(
                                temporaryUri,
                                this.syncManifestUri,
                                {overwrite: true},
                            ),
                        );
                        this.requireSyncSession(generation);
                    } catch (error) {
                        await Promise.resolve(vscode.workspace.fs.delete(temporaryUri)).catch(() => undefined);
                        throw error;
                    }

                    if (revision===this.syncManifestRevision) {
                        this.syncManifestDirty = false;
                        return;
                    }
                }
            });
        this.syncManifestPersistQueue = publish;
        return publish;
    }

    private async captureLocalUriRevision(
        uri: vscode.Uri,
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<PathRevision> {
        this.requireSyncSession(generation);
        let stat: vscode.FileStat;
        try {
            stat = await vscode.workspace.fs.stat(uri);
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return {kind: 'missing', revision: DELETE_DIGEST};
            }
            throw error;
        }
        this.requireSyncSession(generation);

        if (stat.type===vscode.FileType.File) {
            const content = await vscode.workspace.fs.readFile(uri);
            this.requireSyncSession(generation);
            return {
                kind: 'file',
                revision: contentDigest(content),
                content,
            };
        }
        if (stat.type===vscode.FileType.Directory) {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            this.requireSyncSession(generation);
            const revisions: string[] = [];
            for (const [name] of entries.sort(([left], [right]) => left.localeCompare(right))) {
                const childRelPath = this.requireConfinedRelPath(
                    `${relPath.replace(/\/+$/, '')}/${name}`,
                    'local path revision',
                );
                const child = await this.captureLocalUriRevision(
                    vscode.Uri.joinPath(uri, name),
                    childRelPath,
                    generation,
                );
                revisions.push(`${name}\0${child.kind}\0${child.revision}`);
            }
            return {
                kind: 'directory',
                revision: `directory:${contentDigest(Buffer.from(revisions.join('\n')))}`,
            };
        }
        return {
            kind: 'other',
            revision: `other:${stat.type}:${stat.size}:${normalizeMtimeMs(stat.mtime)}`,
        };
    }

    private captureLocalPathRevision(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<PathRevision> {
        return this.captureLocalUriRevision(this.localUri(relPath), relPath, generation);
    }

    private async readLocalFileInSession(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<Uint8Array | undefined> {
        this.requireSyncSession(generation);
        try {
            const content = await this.runSessionIO(
                generation,
                () => vscode.workspace.fs.readFile(this.localUri(relPath)),
            );
            this.requireSyncSession(generation);
            return content;
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                this.requireSyncSession(generation);
                return undefined;
            }
            throw error;
        }
    }

    private async captureRemoteUriRevision(
        uri: vscode.Uri,
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<PathRevision> {
        this.requireSyncSession(generation);
        let stat: vscode.FileStat;
        try {
            stat = await vscode.workspace.fs.stat(uri);
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return {kind: 'missing', revision: DELETE_DIGEST};
            }
            throw error;
        }
        this.requireSyncSession(generation);

        if (stat.type===vscode.FileType.File) {
            const content = await this.pullRemoteFile(relPath, uri, generation);
            return {
                kind: 'file',
                revision: contentDigest(content),
                content,
            };
        }
        if (stat.type===vscode.FileType.Directory) {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            this.requireSyncSession(generation);
            const revisions: string[] = [];
            for (const [name] of entries.sort(([left], [right]) => left.localeCompare(right))) {
                const childRelPath = this.requireConfinedRelPath(
                    `${relPath.replace(/\/+$/, '')}/${name}`,
                    'remote path revision',
                );
                const child = await this.captureRemoteUriRevision(
                    vscode.Uri.joinPath(uri, name),
                    childRelPath,
                    generation,
                );
                revisions.push(`${name}\0${child.kind}\0${child.revision}`);
            }
            return {
                kind: 'directory',
                revision: `directory:${contentDigest(Buffer.from(revisions.join('\n')))}`,
            };
        }
        return {
            kind: 'other',
            revision: `other:${stat.type}:${stat.size}:${normalizeMtimeMs(stat.mtime)}`,
        };
    }

    private captureRemotePathRevision(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<PathRevision> {
        return this.captureRemoteUriRevision(
            this.vfs.pathToUri(relPath),
            relPath,
            generation,
        );
    }

    private remoteDeleteOperationId(relPath: string, expectedRevision: string): string {
        return contentDigest(Buffer.from(`${relPath}\0${expectedRevision}`)).slice(0, 24);
    }

    private remoteDeleteStagingPath(relPath: string, expectedRevision: string): string {
        const parentPath = nodePath.posix.dirname(relPath);
        const operationId = this.remoteDeleteOperationId(relPath, expectedRevision);
        const stageName = `.sr-overleaf-delete-${operationId}`;
        return parentPath==='/' ? `/${stageName}` : `${parentPath}/${stageName}`;
    }

    private async refreshRemoteStateForReconciliation(
        relPath: string,
        generation: number,
        reason: string,
    ): Promise<void> {
        this.requireSyncSession(generation);
        await this.runSessionIO(
            generation,
            () => this.vfs.reconnect(`${reason}: ${relPath}`),
        );
        this.requireSyncSession(generation);
    }

    private renameRemotePathForDelete(
        targetUri: vscode.Uri,
        stagingUri: vscode.Uri,
        generation: number,
    ): Promise<void> {
        return this.runSessionIO(
            generation,
            () => vscode.workspace.fs.rename(
                targetUri,
                stagingUri,
                {overwrite: false},
            ),
        );
    }

    private async remotePathExists(
        uri: vscode.Uri,
        generation: number,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        try {
            await vscode.workspace.fs.stat(uri);
            this.requireSyncSession(generation);
            return true;
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                this.requireSyncSession(generation);
                return false;
            }
            throw error;
        }
    }

    private async restoreRemoteStagingPath(
        stagingUri: vscode.Uri,
        targetUri: vscode.Uri,
        relPath: string,
        generation: number,
    ): Promise<boolean> {
        if (await this.remotePathExists(targetUri, generation)) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [remote concurrent bytes preserved] ${relPath}: ` +
                `recovery=${stagingUri.toString()}`,
            );
            return false;
        }
        try {
            await this.runSessionIO(
                generation,
                () => vscode.workspace.fs.rename(
                    stagingUri,
                    targetUri,
                    {overwrite: false},
                ),
            );
            this.requireSyncSession(generation);
            return true;
        } catch (error) {
            try {
                await this.refreshRemoteStateForReconciliation(
                    relPath,
                    generation,
                    'reconcile ambiguous remote staging restore',
                );
                const stagingExists = await this.remotePathExists(stagingUri, generation);
                const targetExists = await this.remotePathExists(targetUri, generation);
                if (!stagingExists && targetExists) {
                    return true;
                }
            } catch {
                // Keep the original rename error when the reconciliation read
                // is unavailable too.
            }
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [remote staging restore failed] ${relPath}: ` +
                `${formatUnknownError(error)}; recovery=${stagingUri.toString()}`,
            );
            return false;
        }
    }

    private async atomicDeleteRemotePathIfRevision(
        relPath: string,
        expectedRevision: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const targetUri = this.vfs.pathToUri(relPath);
        const operationId = this.remoteDeleteOperationId(relPath, expectedRevision);
        const stagingRelPath = this.remoteDeleteStagingPath(relPath, expectedRevision);
        const stagingUri = this.vfs.pathToUri(stagingRelPath);
        let staged = await this.captureRemoteUriRevision(stagingUri, relPath, generation);
        let target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
        let remoteWasStaged = staged.kind!=='missing';
        await this.createRemoteDeleteOperationRecord({
            version: 1,
            id: operationId,
            relPath,
            stagingRelPath,
            expectedRevision,
            createdAt: new Date().toISOString(),
        });

        const deleteExpectedStaging = async () => {
            try {
                await this.runSessionIO(
                    generation,
                    () => vscode.workspace.fs.delete(stagingUri, {recursive: true}),
                );
            } catch (error) {
                await this.refreshRemoteStateForReconciliation(
                    relPath,
                    generation,
                    'reconcile ambiguous remote staging delete',
                );
                const afterDelete = await this.captureRemoteUriRevision(
                    stagingUri,
                    relPath,
                    generation,
                );
                if (afterDelete.kind==='missing') {
                    return;
                }
                throw error;
            }
        };

        const restoreChangedStaging = async (reason: string) => {
            const restored = await this.restoreRemoteStagingPath(
                stagingUri,
                targetUri,
                relPath,
                generation,
            );
            if (!restored) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [remote staging retained] ${relPath}: ` +
                    `${reason}; recovery=${stagingUri.toString()}`,
                );
            } else {
                await this.removeRemoteDeleteOperationRecord(operationId);
            }
            throw new ConcurrentReplicaChangeError(reason);
        };

        try {
            if (staged.kind!=='missing') {
                if (staged.revision!==expectedRevision) {
                    if (target.kind==='missing') {
                        await restoreChangedStaging(
                            `Overleaf changed ${relPath} while its prior delete was being resumed`,
                        );
                    }
                    throw new ConcurrentReplicaChangeError(
                        `A retained remote delete stage for ${relPath} no longer matches its expected revision`,
                    );
                }
                if (target.kind!=='missing') {
                    await deleteExpectedStaging();
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    throw new ConcurrentReplicaChangeError(
                        `Overleaf recreated ${relPath} while its prior entity was being deleted`,
                    );
                }
            } else {
                if (target.kind==='missing') {
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    return true;
                }
                if (target.revision!==expectedRevision) {
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    throw new ConcurrentReplicaChangeError(
                        `Overleaf changed ${relPath} before it could be staged for delete`,
                    );
                }

                try {
                    await this.renameRemotePathForDelete(targetUri, stagingUri, generation);
                    remoteWasStaged = true;
                } catch (error) {
                    await this.refreshRemoteStateForReconciliation(
                        relPath,
                        generation,
                        'reconcile ambiguous remote delete rename',
                    );
                    staged = await this.captureRemoteUriRevision(stagingUri, relPath, generation);
                    target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
                    if (staged.kind==='missing' && target.kind==='missing') {
                        await this.removeRemoteDeleteOperationRecord(operationId);
                        return true;
                    }
                    if (
                        staged.revision===expectedRevision
                        && target.kind==='missing'
                    ) {
                        remoteWasStaged = true;
                        // The rename was applied but its response was lost.
                    } else if (staged.kind!=='missing' && target.kind==='missing') {
                        await restoreChangedStaging(
                            `Overleaf changed ${relPath} during an ambiguous remote rename`,
                        );
                    } else {
                        throw error;
                    }
                }
            }

            staged = await this.captureRemoteUriRevision(stagingUri, relPath, generation);
            target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
            if (staged.kind==='missing') {
                if (target.kind==='missing') {
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    return true;
                }
                await this.removeRemoteDeleteOperationRecord(operationId);
                throw new ConcurrentReplicaChangeError(
                    `Overleaf recreated ${relPath} after its staged entity disappeared`,
                );
            }
            if (staged.revision!==expectedRevision) {
                if (target.kind==='missing') {
                    await restoreChangedStaging(
                        `Overleaf changed ${relPath} during atomic delete`,
                    );
                }
                throw new ConcurrentReplicaChangeError(
                    `Overleaf changed the retained delete stage for ${relPath}`,
                );
            }
            if (target.kind!=='missing') {
                await deleteExpectedStaging();
                await this.removeRemoteDeleteOperationRecord(operationId);
                throw new ConcurrentReplicaChangeError(
                    `Overleaf recreated ${relPath} while its prior entity was being deleted`,
                );
            }

            const deleteRevision = await this.captureRemoteUriRevision(
                stagingUri,
                relPath,
                generation,
            );
            target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
            if (deleteRevision.revision!==expectedRevision) {
                if (target.kind==='missing' && deleteRevision.kind!=='missing') {
                    await restoreChangedStaging(
                        `Overleaf changed ${relPath} immediately before its staged delete`,
                    );
                }
                throw new ConcurrentReplicaChangeError(
                    `Overleaf changed the final delete stage for ${relPath}`,
                );
            }
            if (target.kind!=='missing') {
                await deleteExpectedStaging();
                await this.removeRemoteDeleteOperationRecord(operationId);
                throw new ConcurrentReplicaChangeError(
                    `Overleaf recreated ${relPath} immediately before its staged delete`,
                );
            }

            await deleteExpectedStaging();
            await this.refreshRemoteStateForReconciliation(
                relPath,
                generation,
                'verify completed remote delete',
            );
            target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
            if (target.kind!=='missing') {
                await this.removeRemoteDeleteOperationRecord(operationId);
                throw new ConcurrentReplicaChangeError(
                    `Overleaf recreated ${relPath} while its staged entity was being deleted`,
                );
            }
            await this.removeRemoteDeleteOperationRecord(operationId);
            return true;
        } catch (error) {
            if (error instanceof ConcurrentReplicaChangeError) {
                throw error;
            }
            try {
                await this.refreshRemoteStateForReconciliation(
                    relPath,
                    generation,
                    'recover failed remote delete',
                );
                staged = await this.captureRemoteUriRevision(stagingUri, relPath, generation);
                target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
                if (staged.kind==='missing') {
                    if (target.kind==='missing') {
                        await this.removeRemoteDeleteOperationRecord(operationId);
                        return true;
                    }
                    if (remoteWasStaged) {
                        await this.removeRemoteDeleteOperationRecord(operationId);
                        throw new ConcurrentReplicaChangeError(
                            `Overleaf recreated ${relPath} after an ambiguous staged delete`,
                        );
                    }
                    throw error;
                }
                if (staged.revision!==expectedRevision) {
                    if (target.kind==='missing') {
                        await restoreChangedStaging(
                            `Overleaf changed ${relPath} while a failed delete was being recovered`,
                        );
                    }
                    throw new ConcurrentReplicaChangeError(
                        `Could not safely recover the changed remote delete stage for ${relPath}`,
                    );
                }
                if (target.kind==='missing') {
                    const restored = await this.restoreRemoteStagingPath(
                        stagingUri,
                        targetUri,
                        relPath,
                        generation,
                    );
                    if (!restored) {
                        throw new ConcurrentReplicaChangeError(
                            `Could not safely restore ${relPath} after a failed remote delete`,
                        );
                    }
                    await this.removeRemoteDeleteOperationRecord(operationId);
                } else {
                    await deleteExpectedStaging();
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    throw new ConcurrentReplicaChangeError(
                        `Overleaf recreated ${relPath} while a failed staged delete was being recovered`,
                    );
                }
            } catch (recoveryError) {
                if (recoveryError===error) {
                    throw error;
                }
                throw recoveryError;
            }
            throw error;
        }
    }

    private async recoverInterruptedRemoteDeletes(
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const records = await this.listRemoteDeleteOperationRecords();
        if (records.length===0) { return; }
        await this.refreshRemoteStateForReconciliation(
            '/',
            generation,
            'recover interrupted remote deletes',
        );
        for (const record of records) {
            this.requireSyncSession(generation);
            const staging = await this.captureRemotePathRevision(
                record.stagingRelPath,
                generation,
            );
            if (staging.kind==='missing') {
                await this.removeRemoteDeleteOperationRecord(record.id);
                continue;
            }
            try {
                await this.atomicDeleteRemotePathIfRevision(
                    record.relPath,
                    record.expectedRevision,
                    generation,
                );
            } catch (error) {
                const localState = await this.captureLocalPathRevision(
                    record.relPath,
                    generation,
                );
                await this.markSyncConflict(
                    record.relPath,
                    `An interrupted remote delete could not be resumed safely: ${formatUnknownError(error)}`,
                    localState.kind==='missing'
                        ? null
                        : (localState.kind==='file' ? localState.content : undefined),
                    generation,
                );
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [remote delete recovery blocked] ${record.relPath}: ` +
                    formatUnknownError(error),
                );
            }
        }
    }

    private isNodeErrorCode(error: unknown, code: string): boolean {
        return !!error
            && typeof error==='object'
            && 'code' in error
            && (error as {code?: string}).code===code;
    }

    private stagingToken(relPath: string): string {
        return `${contentDigest(Buffer.from(relPath)).slice(0, 10)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    }

    private async preserveConcurrentStagingPath(
        stagingPath: string,
        relPath: string,
        reason: string,
    ): Promise<string> {
        const recoveryDirectory = nodePath.join(
            this.settingsDirectoryUri.fsPath,
            'concurrent-recovery',
        );
        await nodeFs.mkdir(recoveryDirectory, {recursive: true});
        const recoveryPath = nodePath.join(
            recoveryDirectory,
            `${this.stagingToken(relPath)}-${nodePath.basename(relPath) || 'root'}`,
        );
        await this.renameDurably(stagingPath, recoveryPath);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [concurrent bytes preserved] ${relPath}: ` +
            `${reason}; recovery=${recoveryPath}`,
        );
        return recoveryPath;
    }

    private linkStagedFileWithoutOverwrite(
        stagingPath: string,
        targetPath: string,
    ): Promise<void> {
        return nodeFs.link(stagingPath, targetPath);
    }

    private async installStagedFileWithoutOverwrite(
        stagingPath: string,
        targetPath: string,
    ): Promise<'linked' | 'copied'> {
        try {
            await this.linkStagedFileWithoutOverwrite(stagingPath, targetPath);
            return 'linked';
        } catch (error) {
            if (this.isNodeErrorCode(error, 'EEXIST')) {
                throw error;
            }
            try {
                await nodeFs.copyFile(
                    stagingPath,
                    targetPath,
                    nodeFsConstants.COPYFILE_EXCL,
                );
                return 'copied';
            } catch (copyError) {
                if (!this.isNodeErrorCode(copyError, 'EEXIST')) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [local exclusive install failed] ` +
                        `link=${formatUnknownError(error)}; copy=${formatUnknownError(copyError)}`,
                    );
                }
                throw copyError;
            }
        }
    }

    private readLocalStagingFile(stagingPath: string): Promise<Buffer> {
        return nodeFs.readFile(stagingPath);
    }

    private async restoreStagedFileWithoutOverwrite(
        stagingPath: string,
        targetPath: string,
        relPath: string,
        reason: string,
        retainedSourcePath?: string,
    ): Promise<boolean> {
        const retainSource = async (retentionReason: string) => {
            if (retainedSourcePath) {
                if (stagingPath!==retainedSourcePath) {
                    await this.renameDurably(stagingPath, retainedSourcePath);
                }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local inode guard retained] ${relPath}: ` +
                    `${retentionReason}; guard=${retainedSourcePath}`,
                );
                return retainedSourcePath;
            }
            return this.preserveConcurrentStagingPath(
                stagingPath,
                relPath,
                retentionReason,
            );
        };
        let installMode: 'linked' | 'copied';
        try {
            installMode = await this.installStagedFileWithoutOverwrite(
                stagingPath,
                targetPath,
            );
        } catch (error) {
            let recoveryPath = stagingPath;
            try {
                recoveryPath = await retainSource(
                    this.isNodeErrorCode(error, 'EEXIST')
                        ? `${reason}; the original path was recreated before rollback`
                        : `${reason}; rollback installation failed`,
                );
            } catch (recoveryError) {
                throw new Error(
                    `Could not restore ${relPath}; rollback failed (${formatUnknownError(error)}) ` +
                    `and recovery retention failed (${formatUnknownError(recoveryError)}). ` +
                    `Original bytes remain at ${stagingPath}`,
                );
            }
            if (this.isNodeErrorCode(error, 'EEXIST')) {
                return false;
            }
            throw new Error(
                `Could not restore ${relPath}; rollback failed: ${formatUnknownError(error)}. ` +
                `Original bytes were recovered at ${recoveryPath}`,
            );
        }

        if (installMode==='linked') {
            await nodeFs.unlink(stagingPath);
        } else {
            await retainSource(
                `${reason}; restored with copy fallback while retaining the original inode`,
            );
        }
        return true;
    }

    private async cleanupDisplacedInstalledFile(
        displacedPath: string,
        relPath: string,
        installedRevision?: string,
    ): Promise<void> {
        try {
            const displacedContent = await this.readLocalStagingFile(displacedPath);
            if (
                installedRevision!==undefined
                && contentDigest(displacedContent)===installedRevision
            ) {
                await nodeFs.unlink(displacedPath);
            } else {
                await this.preserveConcurrentStagingPath(
                    displacedPath,
                    relPath,
                    'the newly installed inode changed while the prior local inode was restored',
                );
            }
        } catch (error) {
            if (!this.isNodeErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
    }

    private async restoreOwnedStagingFileIfTargetMissing(
        stagingPath: string,
        targetPath: string,
        relPath: string,
    ): Promise<void> {
        try {
            await nodeFs.lstat(targetPath);
            return;
        } catch (error) {
            if (!this.isNodeErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
        try {
            await this.installStagedFileWithoutOverwrite(stagingPath, targetPath);
            await nodeFs.unlink(stagingPath);
        } catch (error) {
            let recoveryPath = stagingPath;
            try {
                recoveryPath = await this.preserveConcurrentStagingPath(
                    stagingPath,
                    relPath,
                    'the installed remote copy could not be restored after rollback failure',
                );
            } catch {
                // The error below still identifies the original staging path.
            }
            throw new Error(
                `Could not restore a visible copy of ${relPath}: ${formatUnknownError(error)}. ` +
                `Recovery=${recoveryPath}`,
            );
        }
    }

    private async restoreChangedBackupAfterInstall(
        backupPath: string,
        targetPath: string,
        relPath: string,
        installedRevision: string | undefined,
        retainedSourcePath?: string,
    ): Promise<boolean> {
        const displacedPath = nodePath.join(
            nodePath.dirname(targetPath),
            `.sr-overleaf-${this.stagingToken(relPath)}.replaced`,
        );
        try {
            await this.renameDurably(targetPath, displacedPath);
        } catch (error) {
            await this.restoreStagedFileWithoutOverwrite(
                backupPath,
                targetPath,
                relPath,
                'the changed prior local inode could not replace the installed remote copy',
                retainedSourcePath,
            );
            throw new Error(
                `Could not quarantine the installed copy of ${relPath} while restoring a changed local inode: ` +
                formatUnknownError(error),
            );
        }

        let restored: boolean;
        try {
            restored = await this.restoreStagedFileWithoutOverwrite(
                backupPath,
                targetPath,
                relPath,
                'the prior local inode changed during the atomic swap',
                retainedSourcePath,
            );
        } catch (error) {
            try {
                await this.restoreOwnedStagingFileIfTargetMissing(
                    displacedPath,
                    targetPath,
                    relPath,
                );
            } catch (installedRestoreError) {
                throw new Error(
                    `${formatUnknownError(error)}; additionally failed to restore the installed copy: ` +
                    formatUnknownError(installedRestoreError),
                );
            }
            await this.cleanupDisplacedInstalledFile(
                displacedPath,
                relPath,
                installedRevision,
            );
            throw error;
        }

        await this.cleanupDisplacedInstalledFile(
            displacedPath,
            relPath,
            installedRevision,
        );
        return restored;
    }

    private async restoreStagedPathWithoutOverwrite(
        stagingPath: string,
        targetPath: string,
        relPath: string,
        kind: PathRevision['kind'],
        reason: string,
        retainedSourcePath?: string,
    ): Promise<void> {
        try {
            await nodeFs.lstat(targetPath);
            if (retainedSourcePath) {
                if (stagingPath!==retainedSourcePath) {
                    await this.renameDurably(stagingPath, retainedSourcePath);
                }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local inode guard retained] ${relPath}: ` +
                    `${reason}; guard=${retainedSourcePath}`,
                );
            } else {
                await this.preserveConcurrentStagingPath(stagingPath, relPath, reason);
            }
            return;
        } catch (error) {
            if (!this.isNodeErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
        if (kind==='file') {
            await this.restoreStagedFileWithoutOverwrite(
                stagingPath,
                targetPath,
                relPath,
                reason,
                retainedSourcePath,
            );
            return;
        }
        await this.renameDurably(stagingPath, targetPath);
    }

    private async atomicWriteLocalFileIfRevision(
        relPath: string,
        content: Uint8Array,
        expectedRevision: string,
        generation: number,
    ): Promise<boolean> {
        const targetPath = this.localUri(relPath).fsPath;
        const parentPath = nodePath.dirname(targetPath);
        const token = this.stagingToken(relPath);
        const stagePath = nodePath.join(parentPath, `.sr-overleaf-${token}.new`);
        const backupPath = nodePath.join(parentPath, `.sr-overleaf-${token}.old`);
        const operationRecord: LocalReplicaOperationRecord = {
            version: 1,
            id: token,
            kind: 'write',
            relPath,
            entityKind: 'missing',
            expectedRevision,
            installedRevision: contentDigest(content),
            stageName: nodePath.basename(stagePath),
            backupName: nodePath.basename(backupPath),
            guardName: `.sr-overleaf-${token}.guard`,
            createdAt: new Date().toISOString(),
        };
        const guardPath = this.localOperationGuardPath(operationRecord);
        let rollbackPath: string | undefined;
        let stageExists = false;
        let operationRecordExists = false;
        let operationCommitted = false;
        let operationError: unknown;

        await nodeFs.writeFile(stagePath, content, {flag: 'wx'});
        stageExists = true;
        try {
            const current = await this.captureLocalPathRevision(relPath, generation);
            if (current.revision!==expectedRevision) {
                return false;
            }
            operationRecord.entityKind = current.kind;
            await this.createLocalOperationRecord(operationRecord);
            operationRecordExists = true;
            if (current.kind==='file') {
                try {
                    await this.renameDurably(targetPath, backupPath);
                    rollbackPath = backupPath;
                } catch (error) {
                    if (this.isNodeErrorCode(error, 'ENOENT')) {
                        await this.removeLocalOperationRecord(operationRecord.id);
                        operationRecordExists = false;
                        return false;
                    }
                    throw error;
                }
                const movedContent = await this.readLocalStagingFile(backupPath);
                if (contentDigest(movedContent)!==expectedRevision) {
                    rollbackPath = undefined;
                    await this.restoreStagedFileWithoutOverwrite(
                        backupPath,
                        targetPath,
                        relPath,
                        'the local file changed while it was being staged for replacement',
                        guardPath,
                    );
                    operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                        operationRecord,
                    );
                    operationRecordExists = operationCommitted;
                    return false;
                }
            } else if (current.kind!=='missing') {
                return false;
            }

            try {
                await this.installStagedFileWithoutOverwrite(stagePath, targetPath);
            } catch (error) {
                if (!this.isNodeErrorCode(error, 'EEXIST')) {
                    throw error;
                }
                if (rollbackPath) {
                    const sourcePath = rollbackPath;
                    rollbackPath = undefined;
                    await this.restoreStagedFileWithoutOverwrite(
                        sourcePath,
                        targetPath,
                        relPath,
                        'the target path was recreated during the atomic swap',
                        guardPath,
                    );
                }
                operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                    operationRecord,
                );
                operationRecordExists = operationCommitted;
                return false;
            }
            await nodeFs.unlink(stagePath);
            stageExists = false;

            if (rollbackPath) {
                const finalBackupContent = await this.readLocalStagingFile(backupPath);
                if (contentDigest(finalBackupContent)!==expectedRevision) {
                    rollbackPath = undefined;
                    await this.restoreChangedBackupAfterInstall(
                        backupPath,
                        targetPath,
                        relPath,
                        contentDigest(content),
                        guardPath,
                    );
                    operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                        operationRecord,
                    );
                    operationRecordExists = operationCommitted;
                    return false;
                }
                await this.renameDurably(backupPath, guardPath);
                rollbackPath = guardPath;
                await this.markLocalOperationCommitted(operationRecord.id);
                operationCommitted = true;
                rollbackPath = undefined;
            } else {
                await this.removeLocalOperationRecord(operationRecord.id);
                operationRecordExists = false;
            }
            return true;
        } catch (error) {
            operationError = error;
            throw error;
        } finally {
            const cleanupErrors: string[] = [];
            if (stageExists) {
                try {
                    await nodeFs.unlink(stagePath);
                } catch (error) {
                    if (!this.isNodeErrorCode(error, 'ENOENT')) {
                        cleanupErrors.push(
                            `new-content staging cleanup failed (${formatUnknownError(error)}; staging=${stagePath})`,
                        );
                    }
                }
            }
            if (rollbackPath) {
                const sourcePath = rollbackPath;
                rollbackPath = undefined;
                try {
                    await this.restoreStagedFileWithoutOverwrite(
                        sourcePath,
                        targetPath,
                        relPath,
                        'the atomic write exited before committing',
                        guardPath,
                    );
                    if (operationRecordExists) {
                        operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                            operationRecord,
                        );
                        operationRecordExists = operationCommitted;
                    }
                } catch (error) {
                    cleanupErrors.push(formatUnknownError(error));
                }
            }
            if (
                operationRecordExists
                && !operationCommitted
                && !await this.localPathExists(backupPath)
                && !await this.localPathExists(guardPath)
                && await this.localPathExists(targetPath)
            ) {
                try {
                    await this.removeLocalOperationRecord(operationRecord.id);
                    operationRecordExists = false;
                } catch (error) {
                    cleanupErrors.push(
                        `operation journal cleanup failed (${formatUnknownError(error)})`,
                    );
                }
            }
            if (cleanupErrors.length>0) {
                throw new Error(
                    `Local atomic write cleanup failed for ${relPath}: ${cleanupErrors.join('; ')}` +
                    (operationError===undefined
                        ? ''
                        : `; original operation failed: ${formatUnknownError(operationError)}`),
                );
            }
        }
    }

    private async writeLocalFileIfRevision(
        relPath: string,
        content: Uint8Array,
        expectedRevision: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        await this.ensureParentDirectory(relPath, generation);
        const written = await this.runSessionIO(
            generation,
            () => this.atomicWriteLocalFileIfRevision(
                relPath,
                content,
                expectedRevision,
                generation,
            ),
        );
        this.requireSyncSession(generation);
        if (!written) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [local write blocked:concurrent change] ${relPath}`,
            );
        }
        return written;
    }

    private async atomicDeleteLocalPathIfRevision(
        relPath: string,
        expectedRevision: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const targetPath = this.localUri(relPath).fsPath;
        const parentPath = nodePath.dirname(targetPath);
        const token = this.stagingToken(relPath);
        const quarantinePath = nodePath.join(
            parentPath,
            `.sr-overleaf-${token}.deleted`,
        );
        const current = await this.captureLocalPathRevision(relPath, generation);
        if (current.kind==='missing') {
            return true;
        }
        if (current.revision!==expectedRevision) {
            return false;
        }
        const operationRecord: LocalReplicaOperationRecord = {
            version: 1,
            id: token,
            kind: 'delete',
            relPath,
            entityKind: current.kind,
            expectedRevision,
            backupName: nodePath.basename(quarantinePath),
            guardName: `.sr-overleaf-${token}.guard`,
            createdAt: new Date().toISOString(),
        };
        const guardPath = this.localOperationGuardPath(operationRecord);
        let rollbackPath: string | undefined;
        let operationRecordExists = false;
        let operationCommitted = false;
        let operationError: unknown;
        await this.createLocalOperationRecord(operationRecord);
        operationRecordExists = true;
        try {
            try {
                await this.renameDurably(targetPath, quarantinePath);
                rollbackPath = quarantinePath;
            } catch (error) {
                if (this.isNodeErrorCode(error, 'ENOENT')) {
                    await this.removeLocalOperationRecord(operationRecord.id);
                    operationRecordExists = false;
                    return false;
                }
                throw error;
            }

            const moved = await this.captureLocalUriRevision(
                vscode.Uri.file(quarantinePath),
                relPath,
                generation,
            );
            if (moved.revision!==expectedRevision) {
                rollbackPath = undefined;
                await this.restoreStagedPathWithoutOverwrite(
                    quarantinePath,
                    targetPath,
                    relPath,
                    moved.kind,
                    'the path changed before atomic delete and was recreated before rollback',
                    guardPath,
                );
                operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                    operationRecord,
                );
                operationRecordExists = operationCommitted;
                return false;
            }

            try {
                await nodeFs.lstat(targetPath);
                const finalMoved = await this.captureLocalUriRevision(
                    vscode.Uri.file(quarantinePath),
                    relPath,
                    generation,
                );
                await this.renameDurably(quarantinePath, guardPath);
                rollbackPath = undefined;
                await this.markLocalOperationCommitted(operationRecord.id);
                operationCommitted = true;
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local inode guard retained] ${relPath}: ` +
                    `${finalMoved.revision!==expectedRevision
                        ? 'the quarantined path changed while its original path was recreated'
                        : 'the original path was recreated while its prior inode was quarantined'}; ` +
                    `guard=${guardPath}`,
                );
                return false;
            } catch (error) {
                if (!this.isNodeErrorCode(error, 'ENOENT')) {
                    throw error;
                }
            }

            const finalMoved = await this.captureLocalUriRevision(
                vscode.Uri.file(quarantinePath),
                relPath,
                generation,
            );
            if (finalMoved.revision!==expectedRevision) {
                rollbackPath = undefined;
                await this.restoreStagedPathWithoutOverwrite(
                    quarantinePath,
                    targetPath,
                    relPath,
                    finalMoved.kind,
                    'the quarantined path changed before delete and its original path was recreated',
                    guardPath,
                );
                operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                    operationRecord,
                );
                operationRecordExists = operationCommitted;
                return false;
            }
            await this.renameDurably(quarantinePath, guardPath);
            rollbackPath = guardPath;
            await this.markLocalOperationCommitted(operationRecord.id);
            operationCommitted = true;
            rollbackPath = undefined;
            return true;
        } catch (error) {
            operationError = error;
            throw error;
        } finally {
            const cleanupErrors: string[] = [];
            if (rollbackPath) {
                const sourcePath = rollbackPath;
                rollbackPath = undefined;
                try {
                    const staged = await this.captureLocalUriRevision(
                        vscode.Uri.file(sourcePath),
                        relPath,
                        generation,
                    );
                    await this.restoreStagedPathWithoutOverwrite(
                        sourcePath,
                        targetPath,
                        relPath,
                        staged.kind,
                        'atomic delete cleanup could not restore the original path',
                        guardPath,
                    );
                    if (operationRecordExists) {
                        operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                            operationRecord,
                        );
                        operationRecordExists = operationCommitted;
                    }
                } catch (error) {
                    cleanupErrors.push(
                        `rollback failed (${formatUnknownError(error)}; ` +
                        `journal=${this.localOperationRecordPath(operationRecord.id)}; source=${sourcePath})`,
                    );
                }
            }
            if (cleanupErrors.length>0) {
                throw new Error(
                    `Local atomic delete cleanup failed for ${relPath}: ${cleanupErrors.join('; ')}` +
                    (operationError===undefined
                        ? ''
                        : `; original operation failed: ${formatUnknownError(operationError)}`),
                );
            }
            if (!operationCommitted && operationRecordExists && !rollbackPath) {
                const sourceExists = await this.localPathExists(quarantinePath)
                    || await this.localPathExists(guardPath);
                if (!sourceExists) {
                    await this.removeLocalOperationRecord(operationRecord.id);
                }
            }
        }
    }

    private async collectLocalReplicaSnapshot(
        directoryUri: vscode.Uri = this.baseUri,
        directoryRelPath = '/',
        snapshot: LocalReplicaSnapshot = {files: new Set(), directories: new Set()},
        generation?: number,
    ): Promise<LocalReplicaSnapshot> {
        if (generation!==undefined) { this.requireSyncSession(generation); }
        const entries = await vscode.workspace.fs.readDirectory(directoryUri);
        if (generation!==undefined) { this.requireSyncSession(generation); }
        for (const [name, fileType] of entries) {
            const relPath = this.normalizeConfinedRelPath(
                `${directoryRelPath.replace(/\/+$/, '')}/${name}`,
                'startup local replica scan',
            );
            if (
                relPath===undefined
                || this.matchIgnorePatterns(relPath)
                || this.matchIgnorePatterns(`${relPath}/`)
            ) {
                continue;
            }

            const uri = vscode.Uri.joinPath(directoryUri, name);
            if (fileType===vscode.FileType.Directory) {
                snapshot.directories.add(relPath);
                await this.collectLocalReplicaSnapshot(uri, relPath, snapshot, generation);
            } else if (fileType===vscode.FileType.File) {
                snapshot.files.add(relPath);
            }
        }
        return snapshot;
    }

    private async findIgnoredDescendant(
        directoryUri: vscode.Uri,
        directoryRelPath: string,
        generation?: number,
    ): Promise<string | undefined> {
        if (generation!==undefined) { this.requireSyncSession(generation); }
        const entries = await vscode.workspace.fs.readDirectory(directoryUri);
        if (generation!==undefined) { this.requireSyncSession(generation); }
        for (const [name, fileType] of entries) {
            const relPath = this.requireConfinedRelPath(
                `${directoryRelPath.replace(/\/+$/, '')}/${name}`,
                'ignored descendant scan',
            );
            if (this.matchIgnorePatterns(relPath) || this.matchIgnorePatterns(`${relPath}/`)) {
                return relPath;
            }
            if (fileType===vscode.FileType.Directory) {
                const nested = await this.findIgnoredDescendant(
                    vscode.Uri.joinPath(directoryUri, name),
                    relPath,
                    generation,
                );
                if (nested) {
                    return nested;
                }
            }
        }
        return undefined;
    }

    private async localDirectoryHasChanges(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const snapshot = await this.collectLocalReplicaSnapshot(
            this.localUri(relPath),
            relPath,
            {files: new Set(), directories: new Set()},
            generation,
        );
        const manifestFiles = Object.keys(this.syncManifest?.files ?? {})
            .filter(path => path.startsWith(`${relPath}/`));
        const manifestDirectories = Object.keys(this.syncManifest?.directories ?? {})
            .filter(path => path.startsWith(`${relPath}/`));
        if (
            [...snapshot.files].some(path => this.syncManifest?.files[path]===undefined)
            || [...snapshot.directories].some(path => this.syncManifest?.directories[path]===undefined)
            || manifestFiles.some(path => !snapshot.files.has(path))
            || manifestDirectories.some(path => !snapshot.directories.has(path))
        ) {
            return true;
        }
        for (const path of snapshot.files) {
            if (!await this.isLocalUnchangedFromManifest(path)) {
                return true;
            }
            this.requireSyncSession(generation);
        }
        return false;
    }

    private async collectRemoteDirectorySnapshot(
        rootRelPath: string,
        generation = this.syncGeneration,
    ): Promise<LocalReplicaSnapshot> {
        this.requireSyncSession(generation);
        const snapshot: LocalReplicaSnapshot = {
            files: new Set(),
            directories: new Set(),
        };
        const queue = [rootRelPath];
        while (queue.length>0) {
            const directoryPath = queue.shift()!;
            const entries = await vscode.workspace.fs.readDirectory(this.vfs.pathToUri(directoryPath));
            this.requireSyncSession(generation);
            for (const [name, type] of entries) {
                const relPath = this.requireConfinedRelPath(
                    `${directoryPath.replace(/\/+$/, '')}/${name}`,
                    'remote directory conflict scan',
                );
                if (this.matchIgnorePatterns(relPath) || this.matchIgnorePatterns(`${relPath}/`)) {
                    continue;
                }
                if (type===vscode.FileType.Directory) {
                    snapshot.directories.add(relPath);
                    queue.push(relPath);
                } else if (type===vscode.FileType.File) {
                    snapshot.files.add(relPath);
                }
            }
        }
        return snapshot;
    }

    private async remoteDirectoryHasChanges(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const snapshot = await this.collectRemoteDirectorySnapshot(relPath, generation);
        const manifestFiles = Object.keys(this.syncManifest?.files ?? {})
            .filter(path => path.startsWith(`${relPath}/`));
        const manifestDirectories = Object.keys(this.syncManifest?.directories ?? {})
            .filter(path => path.startsWith(`${relPath}/`));
        if (
            [...snapshot.files].some(path => this.syncManifest?.files[path]===undefined)
            || [...snapshot.directories].some(path => this.syncManifest?.directories[path]===undefined)
            || manifestFiles.some(path => !snapshot.files.has(path))
            || manifestDirectories.some(path => !snapshot.directories.has(path))
        ) {
            return true;
        }
        for (const path of snapshot.files) {
            const entry = this.syncManifest?.files[path];
            if (!entry) { return true; }
            if (this.isLikelyBinaryRelPath(path)) {
                const fingerprint = await this.getRemoteFingerprint(path, this.vfs.pathToUri(path));
                this.requireSyncSession(generation);
                if (!fingerprint || fingerprint!==entry.remoteFingerprint) {
                    return true;
                }
            } else {
                const content = await this.pullRemoteFile(path, this.vfs.pathToUri(path), generation);
                if (contentDigest(content)!==entry.localDigest) {
                    return true;
                }
            }
        }
        return false;
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            if (error instanceof LocalReplicaFolderSelectionCancelledError) {
                return Promise.reject(error);
            }
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async validateExactBaseUri(uri: string, options?: ValidateExactBaseUriOptions): Promise<vscode.Uri> {
        try {
            const baseUri = vscode.Uri.file(uri);
            if (await LocalReplicaSCMProvider.pathExists(baseUri)) {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }

                const settingsStatus = await LocalReplicaSCMProvider.validateExistingExactReplicaSettings(baseUri, options?.projectUri);
                if (settingsStatus==='same-project') {
                    const protectedReason = await LocalReplicaSCMProvider.getProtectedExactBaseUriReasonCode(baseUri);
                    if (
                        protectedReason!==undefined
                        && protectedReason!=='workspace-root'
                        && protectedReason!=='git-repository-root'
                    ) {
                        await LocalReplicaSCMProvider.rejectDangerousExactBaseUri(baseUri);
                    }
                    return baseUri;
                }
                if (settingsStatus==='different-project') {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t(
                            'The selected folder is already configured for a different Overleaf project: {path}. Select another folder.',
                            {path: baseUri.fsPath || baseUri.toString()},
                        ),
                    );
                    throw new LocalReplicaFolderSelectionRejectedError('Selected folder belongs to another Overleaf project.');
                }
            }

            await LocalReplicaSCMProvider.rejectDangerousExactBaseUri(baseUri);
            if (await LocalReplicaSCMProvider.pathExists(baseUri)) {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
            }
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            await LocalReplicaSCMProvider.ensureEmptyExactBaseUri(baseUri, options);
            return baseUri;
        } catch (error) {
            if (
                error instanceof LocalReplicaFolderSelectionCancelledError
                || error instanceof LocalReplicaFolderSelectionRejectedError
            ) {
                return Promise.reject(error);
            }
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    private static async ensureEmptyExactBaseUri(baseUri: vscode.Uri, options?: ValidateExactBaseUriOptions): Promise<void> {
        const entries = await vscode.workspace.fs.readDirectory(baseUri);
        if (entries.length===0) { return; }

        const emptyAndContinue = vscode.l10n.t('Empty Folder and Continue');
        const selected = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                'The selected Local Replica folder is not empty: {path}. Empty it before syncing?',
                {path: baseUri.fsPath || baseUri.toString()},
            ),
            {modal: true},
            emptyAndContinue,
        );
        if (selected!==emptyAndContinue) {
            throw new LocalReplicaFolderSelectionCancelledError('Selected Local Replica folder is not empty.');
        }

        await options?.beforeEmpty?.(baseUri);
        await LocalReplicaSCMProvider.emptyDirectory(baseUri);
    }

    private static async emptyDirectory(baseUri: vscode.Uri): Promise<void> {
        const entries = await vscode.workspace.fs.readDirectory(baseUri);
        for (const [name] of entries) {
            await deleteWithTrashFallback(vscode.Uri.joinPath(baseUri, name), {recursive: true});
        }
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        return pathToLocalUri(path);
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        return localUriToPath(uri);
    }

    public static async readSettings(rootUri?: vscode.Uri): Promise<any | undefined> {
        return readReplicaSettings(rootUri ?? getActiveReplicaRoot());
    }

    private normalizeConfinedRelPath(relPath: string, operation: string): string | undefined {
        const normalized = normalizeLocalReplicaRelPath(relPath);
        if (normalized===undefined) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [path rejected] ${operation}: ${relPath}`,
            );
            return undefined;
        }

        return normalized;
    }

    private requireConfinedRelPath(relPath: string, operation: string): string {
        const normalized = this.normalizeConfinedRelPath(relPath, operation);
        if (normalized===undefined) {
            throw new Error(`Invalid Local Replica path for ${operation}: ${relPath}`);
        }
        return normalized;
    }

    private relPathFromLocalFileUri(localUri: vscode.Uri, operation: string): string | undefined {
        if (localUri.scheme!=='file') { return undefined; }
        const basePath = this.baseUri.path.replace(/\/+$/, '');
        if (localUri.path===basePath || !localUri.path.startsWith(basePath + '/')) { return undefined; }
        if (isLocalReplicaMetadataUri(localUri, this.baseUri)) { return undefined; }
        return this.normalizeConfinedRelPath(localUri.path.slice(basePath.length), operation);
    }

    private async reloadCleanOpenDocumentFromDisk(
        document: vscode.TextDocument,
        diskContent: Uint8Array,
    ): Promise<boolean> {
        if (document.isDirty) { return false; }
        try {
            new TextDecoder('utf-8', {fatal: true}).decode(diskContent);
        } catch {
            return false;
        }
        const uriKey = document.uri.toString();
        const originalEditor = vscode.window.activeTextEditor;
        const originalSelection = originalEditor?.selection;
        const targetEditor = vscode.window.visibleTextEditors.find(
            editor => editor.document.uri.toString()===uriKey,
        );
        let expectedVersion = document.version;
        try {
            for (let attempt = 0; attempt<2; attempt++) {
                if (document.isDirty || document.version!==expectedVersion) {
                    return false;
                }
                const latestDiskContent = await vscode.workspace.fs.readFile(document.uri);
                let latestDiskText: string;
                try {
                    latestDiskText = new TextDecoder('utf-8', {fatal: true}).decode(latestDiskContent);
                } catch {
                    return false;
                }
                if (document.getText()===latestDiskText) {
                    return true;
                }

                // The force-revert command reloads the file model without
                // invoking save participants or emitting an editor save.
                // Re-reading immediately beforehand and verifying afterwards
                // keeps agent writes that race this startup refresh on disk.
                if (document.isDirty || document.version!==expectedVersion) {
                    return false;
                }

                // Re-focus after the asynchronous disk read. The revert
                // command operates on the active editor, so there must be no
                // await between this validation and dispatching the command.
                const focusedEditor = await vscode.window.showTextDocument(document, {
                    viewColumn: targetEditor?.viewColumn ?? vscode.ViewColumn.Active,
                    preserveFocus: false,
                    preview: false,
                    selection: targetEditor?.selection,
                });
                const activeEditor = vscode.window.activeTextEditor;
                if (
                    focusedEditor.document.uri.toString()!==uriKey
                    || document.isDirty
                    || document.version!==expectedVersion
                    || (
                        activeEditor!==undefined
                        && activeEditor.document.uri.toString()!==uriKey
                    )
                ) {
                    return false;
                }
                await vscode.commands.executeCommand('workbench.action.files.revert');
                const currentDocument = document;
                if (currentDocument.isDirty) {
                    return false;
                }
                const verifiedDiskContent = await vscode.workspace.fs.readFile(document.uri);
                let verifiedDiskText: string;
                try {
                    verifiedDiskText = new TextDecoder('utf-8', {fatal: true}).decode(verifiedDiskContent);
                } catch {
                    return false;
                }
                if (currentDocument.getText()===verifiedDiskText) {
                    return true;
                }
                document = currentDocument;
                expectedVersion = currentDocument.version;
            }
            return false;
        } finally {
            if (
                originalEditor
                && originalEditor.document.uri.toString()!==uriKey
                && (
                    vscode.window.activeTextEditor===undefined
                    || vscode.window.activeTextEditor.document.uri.toString()===uriKey
                )
            ) {
                await vscode.window.showTextDocument(originalEditor.document, {
                    viewColumn: originalEditor.viewColumn,
                    preserveFocus: false,
                    preview: false,
                    selection: originalSelection,
                });
            }
        }
    }

    private async refreshCleanOpenReplicaDocumentsFromDisk(
        generation: number,
        documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments,
    ): Promise<string[]> {
        // During a window reload, the workbench can restore a clean editor
        // model from before the initial pull even though the pull already
        // replaced the file on disk. Force-revert only stale clean models;
        // dirty editors are deliberately excluded so unsaved work survives.
        const refreshed: string[] = [];
        await new Promise(resolve => setTimeout(resolve, 50));
        for (const document of documents) {
            if (!this.isSyncSessionActive(generation) || document.isDirty) { continue; }
            const relPath = this.relPathFromLocalFileUri(document.uri, 'refresh open replica document');
            if (relPath===undefined || this.matchIgnorePatterns(relPath)) { continue; }
            try {
                const diskContent = await vscode.workspace.fs.readFile(document.uri);
                this.requireSyncSession(generation);
                const editorContent = new TextEncoder().encode(document.getText());
                if (bytesEqual(editorContent, diskContent)) { continue; }
                if (!await this.reloadCleanOpenDocumentFromDisk(document, diskContent)) {
                    continue;
                }
                this.requireSyncSession(generation);
                refreshed.push(relPath);
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [open document refresh] ${relPath}: reloaded pulled disk content`,
                );
            } catch (error) {
                if (!this.isSyncSessionActive(generation)) { return refreshed; }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [open document refresh skipped] ${relPath}: ${formatUnknownError(error)}`,
                );
            }
        }
        return refreshed;
    }

    private decodeMergeableText(content: Uint8Array): string | undefined {
        return decodeUtf8Text(content, LocalReplicaSCMProvider.maxMergeBaselineBytes);
    }

    private mergeTextContents(
        baseContent: Uint8Array,
        localContent: Uint8Array,
        remoteContent: Uint8Array,
    ): Uint8Array | undefined {
        return mergeUtf8Text(
            baseContent,
            localContent,
            remoteContent,
            LocalReplicaSCMProvider.maxMergeBaselineBytes,
        );
    }

    private manifestBaseContent(entry?: SyncManifestEntry): Uint8Array | undefined {
        if (entry?.baseContentBase64===undefined) { return undefined; }
        try {
            return Buffer.from(entry.baseContentBase64, 'base64');
        } catch {
            return undefined;
        }
    }

    private async markSyncConflict(
        relPath: string,
        reason: string,
        localContent?: Uint8Array | null,
        generation = this.syncGeneration,
    ) {
        this.requireSyncSession(generation);
        let conflictDigest: string;
        if (localContent===null) {
            conflictDigest = DELETE_DIGEST;
        } else if (localContent!==undefined) {
            conflictDigest = contentDigest(localContent);
        } else {
            try {
                const localRevision = await this.captureLocalPathRevision(relPath, generation);
                conflictDigest = localRevision.revision;
            } catch (error) {
                if (!this.isSyncSessionActive(generation)) {
                    throw error;
                }
                conflictDigest = `unreadable:${Date.now()}:${formatUnknownError(error)}`;
            }
        }
        this.requireSyncSession(generation);
        this.syncConflicts.set(relPath, reason);
        this.conflictLocalDigests.set(relPath, conflictDigest);
        if (this.syncManifest) {
            this.syncManifest.conflicts[relPath] = {
                reason,
                localDigest: conflictDigest,
                updatedAt: new Date().toISOString(),
            };
            this.markSyncManifestDirty();
        }
        this.status = {
            status: 'need-attention',
            message: vscode.l10n.t('sync conflict: {relPath}', {relPath}),
        };
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [sync conflict] ${relPath}: ${reason}`,
        );
        maybeWarnSyncFailure(relPath, new Error(
            `Local Replica conflict: ${reason}. Local and Overleaf copies were both preserved.`,
        ));
        await this.persistSyncManifest(false, generation);
    }

    private clearSyncConflict(relPath: string) {
        let changed = false;
        this.syncConflicts.delete(relPath);
        this.conflictLocalDigests.delete(relPath);
        if (this.syncManifest?.conflicts[relPath]) {
            delete this.syncManifest.conflicts[relPath];
            changed = true;
        }
        for (const conflictPath of [...this.syncConflicts.keys()]) {
            if (conflictPath.startsWith(`${relPath}/`)) {
                this.syncConflicts.delete(conflictPath);
                this.conflictLocalDigests.delete(conflictPath);
                if (this.syncManifest?.conflicts[conflictPath]) {
                    delete this.syncManifest.conflicts[conflictPath];
                    changed = true;
                }
            }
        }
        if (changed) {
            this.markSyncManifestDirty();
        }
        this.completeUnavailableBaselineIfResolved();
        if (
            this.syncConflicts.size===0
            && this.status.status==='need-attention'
            && this.status.message?.startsWith('sync conflict:')
        ) {
            this.status = {status: 'idle', message: ''};
        }
    }

    private completeUnavailableBaselineIfResolved() {
        if (
            this.syncManifestBaselineMode!=='unavailable'
            || this.syncConflicts.size!==0
            || this.failedInitialPulls.size!==0
            || !this.syncManifest
        ) {
            return;
        }
        this.syncManifestBaselineMode = 'trusted';
        if (!this.syncManifest.baselineComplete) {
            this.syncManifest.baselineComplete = true;
            this.markSyncManifestDirty();
        }
    }

    private async hasLocalConflictRevision(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const conflictDigest = this.conflictLocalDigests.get(relPath);
        if (conflictDigest===undefined) { return false; }

        try {
            const current = await this.captureLocalPathRevision(relPath, generation);
            return current.revision!==conflictDigest;
        } catch {
            return false;
        }
    }

    private async isConflictStateResolved(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        let localStat: vscode.FileStat | undefined;
        let remoteStat: vscode.FileStat | undefined;
        try {
            localStat = await vscode.workspace.fs.stat(this.localUri(relPath));
        } catch (error) {
            if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return false;
            }
        }
        this.requireSyncSession(generation);
        try {
            remoteStat = await vscode.workspace.fs.stat(this.vfs.pathToUri(relPath));
        } catch (error) {
            if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return false;
            }
        }
        this.requireSyncSession(generation);

        if (!localStat && !remoteStat) {
            return true;
        }
        if (
            localStat?.type===vscode.FileType.Directory
            || remoteStat?.type===vscode.FileType.Directory
        ) {
            try {
                if (localStat && await this.localDirectoryHasChanges(relPath, generation)) {
                    return false;
                }
                if (remoteStat && await this.remoteDirectoryHasChanges(relPath, generation)) {
                    return false;
                }
                return true;
            } catch {
                return false;
            }
        }
        if (!localStat || !remoteStat) {
            return false;
        }
        try {
            const [localContent, remoteContent] = await Promise.all([
                vscode.workspace.fs.readFile(this.localUri(relPath)),
                this.pullRemoteFile(relPath, this.vfs.pathToUri(relPath), generation),
            ]);
            this.requireSyncSession(generation);
            return bytesEqual(localContent, remoteContent);
        } catch {
            return false;
        }
    }

    private async clearSyncConflictAfterSuccess(
        relPath: string,
        generation = this.syncGeneration,
    ) {
        this.requireSyncSession(generation);
        this.clearSyncConflict(relPath);
        const ancestorConflicts = [...this.syncConflicts.keys()]
            .filter(path => this.isPathAtOrBelow(relPath, path))
            .sort((left, right) => right.split('/').length-left.split('/').length);
        for (const conflictPath of ancestorConflicts) {
            const resolved = await this.isConflictStateResolved(conflictPath, generation);
            this.requireSyncSession(generation);
            if (resolved) {
                this.syncConflicts.delete(conflictPath);
                this.conflictLocalDigests.delete(conflictPath);
                if (this.syncManifest?.conflicts[conflictPath]) {
                    delete this.syncManifest.conflicts[conflictPath];
                    this.markSyncManifestDirty();
                }
            }
        }
        this.completeUnavailableBaselineIfResolved();
    }

    private isPathAtOrBelow(relPath: string, parentPath: string): boolean {
        return relPath===parentPath || relPath.startsWith(`${parentPath}/`);
    }

    private hasSyncConflictAtOrBelow(relPath: string): boolean {
        return [...this.syncConflicts.keys()].some(path => this.isPathAtOrBelow(path, relPath));
    }

    private touchesSyncConflict(relPath: string): boolean {
        return [...this.syncConflicts.keys()].some(path =>
            this.isPathAtOrBelow(relPath, path)
            || this.isPathAtOrBelow(path, relPath)
        );
    }

    private isTrackedDirectory(relPath: string): boolean {
        return this.syncManifest?.directories[relPath]!==undefined
            || [...this.seenLocalEntities].some(path => path.startsWith(`${relPath}/`))
            || Object.keys(this.syncManifest?.files ?? {}).some(path => path.startsWith(`${relPath}/`))
            || Object.keys(this.syncManifest?.directories ?? {}).some(path => path.startsWith(`${relPath}/`));
    }

    private async runPrecompilePush(
        relPath: string,
        localUri: vscode.Uri,
        result: LocalReplicaPrecompileFlushResult,
        options: ApplySyncOptions,
        generation: number,
        type: 'update' | 'delete' = 'update',
    ): Promise<void> {
        this.requireSyncSession(generation);
        result.attemptedCount += 1;
        result.paths.push(relPath);
        const vfsUri = this.vfs.pathToUri(relPath);
        const event = await this.enqueueSync(
            relPath,
            () => this.applySync('push', type, relPath, localUri, vfsUri, options, generation),
            generation,
        );
        this.requireSyncSession(generation);

        if (!event) {
            result.failedCount += 1;
            result.failures.push(`${relPath}: no sync completion event`);
            return;
        }

        switch (event.outcome) {
            case 'success': {
                const remainingChange = await this.localTargetNeedsPush(relPath, localUri);
                this.requireSyncSession(generation);
                if (remainingChange===undefined) {
                    this.locallyDivergedPaths.delete(relPath);
                } else {
                    this.locallyDivergedPaths.add(relPath);
                }
                break;
            }
            case 'suppressed':
                if (options.forcePush) {
                    result.blockedCount += 1;
                    result.failures.push(`${relPath}: forced sync was suppressed`);
                } else {
                    result.suppressedCount += 1;
                }
                break;
            case 'blocked':
                result.blockedCount += 1;
                result.failures.push(`${relPath}: ${event.error ?? 'blocked'}`);
                break;
            case 'error':
                result.failedCount += 1;
                result.failures.push(`${relPath}: ${event.error ?? 'sync failed'}`);
                break;
        }
    }

    private isContentKnownSynced(relPath: string, content: Uint8Array): boolean {
        const baseContent = this.baseCache[relPath];
        if (baseContent!==undefined && bytesEqual(baseContent, content)) {
            return true;
        }
        return this.syncManifest?.files[relPath]?.localDigest===contentDigest(content);
    }

    private readLocalFile(uri: vscode.Uri): Thenable<Uint8Array> {
        return vscode.workspace.fs.readFile(uri);
    }

    private async localTargetNeedsPush(relPath: string, localUri: vscode.Uri): Promise<'update' | 'delete' | undefined> {
        try {
            const stat = await vscode.workspace.fs.stat(localUri);
            if (stat.type===vscode.FileType.Directory) {
                return this.syncManifest?.directories[relPath] ? undefined : 'update';
            }
            if (stat.type!==vscode.FileType.File) {
                return undefined;
            }
            const content = await this.readLocalFile(localUri);
            return this.isContentKnownSynced(relPath, content) ? undefined : 'update';
        } catch (error) {
            if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                throw error;
            }
            if (
                this.syncManifest?.files[relPath]
                || this.syncManifest?.directories[relPath]
                || relPath in this.baseCache
                || this.seenLocalEntities.has(relPath)
            ) {
                return 'delete';
            }
            return undefined;
        }
    }

    private async collectChangedLocalTargets(
        dirUri: vscode.Uri,
        dirRelPath: string,
        localFilePaths: Set<string>,
        localDirectoryPaths: Set<string>,
        forcedTargets: Map<string, vscode.Uri>,
        result: LocalReplicaPrecompileFlushResult,
        generation: number,
    ): Promise<void> {
        this.requireSyncSession(generation);
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(dirUri);
            this.requireSyncSession(generation);
        } catch (error) {
            if (!this.isSyncSessionActive(generation)) {
                throw error;
            }
            result.failedCount += 1;
            result.failures.push(`${dirRelPath}: ${formatUnknownError(error)}`);
            return;
        }

        for (const [name, fileType] of entries) {
            const relPath = this.normalizeConfinedRelPath(
                `${dirRelPath.replace(/\/+$/, '')}/${name}`,
                'precompile local source scan',
            );
            if (relPath===undefined || this.matchIgnorePatterns(relPath) || this.matchIgnorePatterns(`${relPath}/`)) {
                continue;
            }

            const uri = vscode.Uri.joinPath(dirUri, name);
            if (fileType===vscode.FileType.Directory) {
                localDirectoryPaths.add(relPath);
                if (!this.syncManifest?.directories[relPath]) {
                    forcedTargets.set(relPath, uri);
                    result.sourceScanCount += 1;
                }
                await this.collectChangedLocalTargets(
                    uri,
                    relPath,
                    localFilePaths,
                    localDirectoryPaths,
                    forcedTargets,
                    result,
                    generation,
                );
                continue;
            }
            if (fileType!==vscode.FileType.File) {
                continue;
            }

            localFilePaths.add(relPath);
            let localContent: Uint8Array;
            try {
                localContent = await this.readLocalFile(uri);
                this.requireSyncSession(generation);
            } catch (error) {
                if (!this.isSyncSessionActive(generation)) {
                    throw error;
                }
                result.failedCount += 1;
                result.failures.push(`${relPath}: ${formatUnknownError(error)}`);
                continue;
            }

            if (!this.isContentKnownSynced(relPath, localContent)) {
                forcedTargets.set(relPath, uri);
                result.sourceScanCount += 1;
            }
        }
    }

    // Force the pending push for a local URI to fire NOW (cancelling its
    // debounce timer) and resolve when the resulting sync settles. If the
    // watcher hasn't fired yet, synthesise a push so callers that need the
    // VFS to reflect a just-saved file (e.g. compile-on-save) don't race
    // with the EVENT_COALESCE_MS window in syncToVFS.
    public async flushPendingPush(localUri: vscode.Uri): Promise<void> {
        const generation = this.syncGeneration;
        if (!this.isSyncSessionActive(generation)) { return; }
        const relPath = this.relPathFromLocalFileUri(localUri, 'flush pending push');
        if (relPath===undefined) { return; }
        if (this.matchIgnorePatterns(relPath)) { return; }

        const pending = this.pendingLocalEvents.get(relPath);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingLocalEvents.delete(relPath);
            const currentType = await this.localTargetNeedsPush(relPath, pending.latestUri);
            this.requireSyncSession(generation);
            if (currentType===undefined) { return; }
            const vfsUri = this.vfs.pathToUri(relPath);
            await this.enqueueSync(
                relPath,
                () => this.applySync('push', currentType, relPath, pending.latestUri, vfsUri, {}, generation),
                generation,
            );
            return;
        }

        // No debounced event yet — the watcher may simply not have fired
        // before onDidSaveTextDocument. Synthesise a push so the VFS is
        // current before the caller proceeds.
        const currentType = await this.localTargetNeedsPush(relPath, localUri);
        this.requireSyncSession(generation);
        if (currentType===undefined) { return; }
        const vfsUri = this.vfs.pathToUri(relPath);
        await this.enqueueSync(
            relPath,
            () => this.applySync('push', currentType, relPath, localUri, vfsUri, {}, generation),
            generation,
        );
    }

    public async flushBeforeCompile(localUris: vscode.Uri[] = []): Promise<LocalReplicaPrecompileFlushResult> {
        const generation = this.syncGeneration;
        this.requireSyncSession(generation);
        await this.recoverChangedCommittedLocalOperations(generation);
        const result: LocalReplicaPrecompileFlushResult = {
            pendingCount: 0,
            divergedCount: 0,
            openDocCount: 0,
            sourceScanCount: 0,
            sourceScanDeleteCount: 0,
            attemptedCount: 0,
            failedCount: 0,
            blockedCount: 0,
            suppressedCount: 0,
            paths: [],
            failures: [],
        };

        const forcedTargets = new Map<string, vscode.Uri>();
        const forcedDeleteTargets = new Map<string, vscode.Uri>();
        const explicitTargets = new Set<string>();
        for (const localUri of localUris) {
            const relPath = this.relPathFromLocalFileUri(localUri, 'precompile saved document flush');
            if (relPath===undefined || this.matchIgnorePatterns(relPath)) { continue; }
            explicitTargets.add(relPath);
            const type = await this.localTargetNeedsPush(relPath, localUri);
            this.requireSyncSession(generation);
            if (type==='update') {
                forcedTargets.set(relPath, localUri);
            } else if (type==='delete') {
                forcedDeleteTargets.set(relPath, localUri);
            }
        }

        const divergedPaths = [...this.locallyDivergedPaths];
        result.divergedCount = divergedPaths.length;
        for (const relPath of divergedPaths) {
            if (this.matchIgnorePatterns(relPath)) { continue; }
            const localUri = this.localUri(relPath);
            const type = await this.localTargetNeedsPush(relPath, localUri);
            this.requireSyncSession(generation);
            if (type==='update') {
                forcedTargets.set(relPath, localUri);
            } else if (type==='delete') {
                forcedDeleteTargets.set(relPath, localUri);
            }
        }

        const localFilePaths = new Set<string>();
        const localDirectoryPaths = new Set<string>();
        await this.collectChangedLocalTargets(
            this.baseUri,
            '/',
            localFilePaths,
            localDirectoryPaths,
            forcedTargets,
            result,
            generation,
        );
        this.requireSyncSession(generation);
        if (result.failedCount===0) {
            const trackedFiles = new Set([
                ...Object.keys(this.baseCache),
                ...Object.keys(this.syncManifest?.files ?? {}),
            ]);
            for (const relPath of trackedFiles) {
                if (this.matchIgnorePatterns(relPath) || localFilePaths.has(relPath)) {
                    continue;
                }
                forcedDeleteTargets.set(relPath, this.localUri(relPath));
                result.sourceScanDeleteCount += 1;
            }
            for (const relPath of Object.keys(this.syncManifest?.directories ?? {})) {
                if (this.matchIgnorePatterns(relPath) || localDirectoryPaths.has(relPath)) {
                    continue;
                }
                forcedDeleteTargets.set(relPath, this.localUri(relPath));
                result.sourceScanDeleteCount += 1;
            }
        } else {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [compile barrier scan incomplete] ` +
                `skipping delete synthesis for base=${this.baseUri.toString()}`,
            );
        }

        const pendingEntries = [...this.pendingLocalEvents.entries()];
        result.pendingCount = pendingEntries.length;
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [compile barrier start] base=${this.baseUri.toString()} ` +
            `pending=${result.pendingCount} diverged=${result.divergedCount} openDocs=${result.openDocCount} ` +
            `sourceScan=${result.sourceScanCount} sourceDeletes=${result.sourceScanDeleteCount}`,
        );

        for (const [relPath, pending] of pendingEntries) {
            if (this.pendingLocalEvents.get(relPath)!==pending) { continue; }
            clearTimeout(pending.timer);
            this.pendingLocalEvents.delete(relPath);
            const currentType = await this.localTargetNeedsPush(relPath, pending.latestUri);
            this.requireSyncSession(generation);
            if (currentType===undefined) {
                this.locallyDivergedPaths.delete(relPath);
                continue;
            }
            if (currentType==='update') {
                forcedDeleteTargets.delete(relPath);
                forcedTargets.set(relPath, pending.latestUri);
            } else {
                forcedTargets.delete(relPath);
                forcedDeleteTargets.set(relPath, pending.latestUri);
            }
        }

        const changedTargetPaths = new Set([
            ...forcedTargets.keys(),
            ...forcedDeleteTargets.keys(),
        ]);
        const conflictResolutionTargets = new Set<string>();
        const conflictPrerequisiteTargets = new Set<string>();
        const relevantConflicts = [...this.syncConflicts.keys()].filter(conflictPath =>
            [...changedTargetPaths].some(relPath =>
                this.isPathAtOrBelow(relPath, conflictPath)
                || this.isPathAtOrBelow(conflictPath, relPath)
            )
        );
        for (const conflictPath of relevantConflicts) {
            if (await this.isConflictStateResolved(conflictPath, generation)) {
                this.clearSyncConflict(conflictPath);
            } else {
                const matchingTargets = [...changedTargetPaths].filter(relPath =>
                    this.isPathAtOrBelow(relPath, conflictPath)
                    || this.isPathAtOrBelow(conflictPath, relPath)
                );
                const localConflictRevision = await this.hasLocalConflictRevision(
                    conflictPath,
                    generation,
                );
                for (const relPath of matchingTargets) {
                    if (
                        explicitTargets.has(relPath)
                        || (
                            localConflictRevision
                            && this.isPathAtOrBelow(relPath, conflictPath)
                        )
                    ) {
                        conflictResolutionTargets.add(relPath);
                        if (forcedTargets.has(relPath)) {
                            let ancestorPath = relPath;
                            try {
                                const targetStat = await vscode.workspace.fs.stat(this.localUri(relPath));
                                if (targetStat.type!==vscode.FileType.Directory) {
                                    ancestorPath = nodePath.posix.dirname(relPath);
                                }
                            } catch {
                                ancestorPath = nodePath.posix.dirname(relPath);
                            }
                            const ancestors: string[] = [];
                            while (
                                ancestorPath!=='/'
                                && this.isPathAtOrBelow(ancestorPath, conflictPath)
                            ) {
                                ancestors.push(ancestorPath);
                                if (ancestorPath===conflictPath) { break; }
                                ancestorPath = nodePath.posix.dirname(ancestorPath);
                            }
                            for (const candidate of ancestors.reverse()) {
                                let localDirectory = false;
                                try {
                                    localDirectory = (
                                        await vscode.workspace.fs.stat(this.localUri(candidate))
                                    ).type===vscode.FileType.Directory;
                                } catch {
                                    localDirectory = false;
                                }
                                if (!localDirectory) { continue; }
                                let remoteExists = true;
                                try {
                                    await vscode.workspace.fs.stat(this.vfs.pathToUri(candidate));
                                } catch (error) {
                                    if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                                        throw error;
                                    }
                                    remoteExists = false;
                                }
                                this.requireSyncSession(generation);
                                if (!remoteExists) {
                                    const alreadyTargeted = forcedTargets.has(candidate);
                                    forcedTargets.set(candidate, this.localUri(candidate));
                                    changedTargetPaths.add(candidate);
                                    conflictResolutionTargets.add(candidate);
                                    if (!alreadyTargeted) {
                                        conflictPrerequisiteTargets.add(candidate);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            this.requireSyncSession(generation);
        }

        for (const relPath of [...forcedTargets.keys()]) {
            if (this.touchesSyncConflict(relPath) && !conflictResolutionTargets.has(relPath)) {
                forcedTargets.delete(relPath);
            }
        }
        for (const relPath of [...forcedDeleteTargets.keys()]) {
            if (this.touchesSyncConflict(relPath) && !conflictResolutionTargets.has(relPath)) {
                forcedDeleteTargets.delete(relPath);
            }
        }

        const recursiveDeleteRoots: string[] = [];
        const deleteEntries = [...forcedDeleteTargets.entries()]
            .sort(([left], [right]) => left.split('/').length-right.split('/').length)
            .filter(([relPath]) => {
                if (recursiveDeleteRoots.some(parent => this.isPathAtOrBelow(relPath, parent))) {
                    return false;
                }
                if (this.isTrackedDirectory(relPath)) {
                    recursiveDeleteRoots.push(relPath);
                }
                return true;
            });
        for (const [relPath, localUri] of deleteEntries) {
            if (forcedTargets.has(relPath)) { continue; }
            await this.runPrecompilePush(
                relPath,
                localUri,
                result,
                {
                    forcePush: true,
                    reason: conflictResolutionTargets.has(relPath)
                        ? 'conflict-resolution'
                        : 'compile-scan',
                    resolveConflict: conflictResolutionTargets.has(relPath),
                },
                generation,
                'delete',
            );
        }

        const updateEntries = [...forcedTargets.entries()]
            .sort(([left], [right]) => left.split('/').length-right.split('/').length);
        for (const [relPath, localUri] of updateEntries) {
            await this.runPrecompilePush(
                relPath,
                localUri,
                result,
                {
                    forcePush: true,
                    reason: conflictResolutionTargets.has(relPath)
                        ? 'conflict-resolution'
                        : 'compile',
                    resolveConflict: conflictResolutionTargets.has(relPath),
                    deferConflictResolution: conflictPrerequisiteTargets.has(relPath),
                },
                generation,
            );
        }

        for (const [relPath, reason] of this.syncConflicts) {
            result.blockedCount += 1;
            result.failures.push(`${relPath}: ${reason}`);
        }

        getOutputChannel().appendLine(
            `${new Date().toISOString()} [compile barrier end] base=${this.baseUri.toString()} ` +
            `attempted=${result.attemptedCount} suppressed=${result.suppressedCount} ` +
            `blocked=${result.blockedCount} failed=${result.failedCount}`,
        );

        if (result.blockedCount>0 || result.failedCount>0) {
            throw new Error(`Local Replica precompile flush failed: ${result.failures.join('; ')}`);
        }

        return result;
    }

    private matchIgnorePatterns(path: string): boolean {
        const ignorePatterns = this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of [...PROTECTED_LOCAL_REPLICA_IGNORE_PATTERNS, ...ignorePatterns]) {
            if (minimatch(path, pattern, {dot:true})) {
                return true;
            }
        }
        return false;
    }

    private setBypassCache(relPath: string, content?: Uint8Array, action?: 'push'|'pull') {
        this.setBypassCacheDigest(relPath, contentDigest(content), action);
    }

    private setBypassCacheDigest(relPath: string, hash: string, action?: 'push'|'pull') {
        const key = normalizeReplicaPath(relPath);
        const date = Date.now();
        const cache = this.bypassCache.get(key) || [undefined,undefined];
        const next = {date, hash};
        // A directional operation advances the synchronized digest for both
        // directions. Keeping the opposite direction's older digest would
        // let A(push) -> B(pull) -> A(push) look like a duplicate of the
        // historical first push.
        if (action==='push') {
            cache[0] = next;
            if (cache[1]?.hash!==hash) {
                cache[1] = next;
            }
        } else if (action==='pull') {
            cache[1] = next;
            if (cache[0]?.hash!==hash) {
                cache[0] = next;
            }
        } else {
            cache[0] = next;
            cache[1] = next;
        }
        // write back to the cache
        this.bypassCache.set(key, cache as [FileCache,FileCache]);
    }

    private snapshotBypassCache(relPath: string): [FileCache, FileCache] | undefined {
        const cache = this.bypassCache.get(normalizeReplicaPath(relPath));
        if (!cache) { return undefined; }
        return [
            {...cache[0]},
            {...cache[1]},
        ];
    }

    private restoreBypassCache(relPath: string, snapshot?: [FileCache, FileCache]) {
        const key = normalizeReplicaPath(relPath);
        if (snapshot) {
            this.bypassCache.set(key, snapshot);
        } else {
            this.bypassCache.delete(key);
        }
    }

    private async getRemoteFingerprint(relPath: string, vfsUri: vscode.Uri): Promise<string | undefined> {
        if (!this.isLikelyBinaryRelPath(relPath)) { return undefined; }
        try {
            const {fileType, fileEntity} = await this.vfs._resolveUri(vfsUri);
            if (fileType==='file' && fileEntity?._id) {
                return `${fileType}:${fileEntity._id}`;
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    private async manifestLocalStat(relPath: string): Promise<{size: number; mtime: number} | undefined> {
        try {
            const stat = await vscode.workspace.fs.stat(this.localUri(relPath));
            if (stat.type!==vscode.FileType.File) { return undefined; }
            return {size: stat.size, mtime: stat.mtime};
        } catch {
            return undefined;
        }
    }

    private async canSkipInitialBinaryPull(
        relPath: string,
        vfsUri: vscode.Uri,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const entry = this.syncManifest?.files[relPath];
        if (!entry) { return false; }
        const remoteFingerprint = await this.getRemoteFingerprint(relPath, vfsUri);
        this.requireSyncSession(generation);
        if (!remoteFingerprint || entry.remoteFingerprint!==remoteFingerprint) { return false; }
        if (!await this.isLocalUnchangedFromManifest(relPath)) { return false; }
        this.requireSyncSession(generation);
        const localContent = await this.readFile(relPath);
        this.requireSyncSession(generation);
        if (localContent===undefined) { return false; }

        this.baseCache[relPath] = localContent;
        this.seenLocalEntities.add(relPath);
        this.setBypassCacheDigest(relPath, entry.localDigest);
        this.clearRemoteDelete(relPath);
        return true;
    }

    private async isLocalUnchangedFromManifest(relPath: string): Promise<boolean> {
        const entry = this.syncManifest?.files[relPath];
        if (!entry) { return false; }
        const localStat = await this.manifestLocalStat(relPath);
        if (!localStat || localStat.size!==entry.localSize) { return false; }
        const localContent = await this.readFile(relPath);
        return localContent!==undefined && contentDigest(localContent)===entry.localDigest;
    }

    private async recordSyncManifestEntry(
        relPath: string,
        vfsUri: vscode.Uri,
        content: Uint8Array,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        if (!this.syncManifest) { return false; }
        const remoteFingerprint = this.isLikelyBinaryRelPath(relPath)
            ? await this.getRemoteFingerprint(relPath, vfsUri)
            : `content:${contentDigest(content)}`;
        this.requireSyncSession(generation);
        let localStatBefore: vscode.FileStat;
        let localContent: Uint8Array;
        let localStatAfter: vscode.FileStat;
        try {
            localStatBefore = await vscode.workspace.fs.stat(this.localUri(relPath));
            localContent = await vscode.workspace.fs.readFile(this.localUri(relPath));
            localStatAfter = await vscode.workspace.fs.stat(this.localUri(relPath));
            this.requireSyncSession(generation);
        } catch {
            if (!this.isSyncSessionActive(generation)) {
                throw new Error('Local Replica sync session is no longer active.');
            }
            this.removeSyncManifestEntry(relPath);
            this.locallyDivergedPaths.add(relPath);
            return false;
        }
        const stableLocalSnapshot = localStatBefore.type===vscode.FileType.File
            && localStatAfter.type===vscode.FileType.File
            && localStatBefore.size===localStatAfter.size
            && normalizeMtimeMs(localStatBefore.mtime)===normalizeMtimeMs(localStatAfter.mtime)
            && localStatAfter.size===localContent.length
            && bytesEqual(localContent, content);
        if (!remoteFingerprint || !stableLocalSnapshot) {
            // The local file changed while the remote operation was in
            // flight. Keep the remote bytes as the merge baseline, but do
            // not bless unrelated size/mtime metadata as synchronized.
            this.removeSyncManifestEntry(relPath);
            this.locallyDivergedPaths.add(relPath);
            return false;
        }
        this.syncManifest.files[relPath] = {
            remoteFingerprint,
            localSize: localStatAfter.size,
            localMtime: localStatAfter.mtime,
            localDigest: contentDigest(content),
            baseContentBase64: this.decodeMergeableText(content)===undefined
                ? undefined
                : Buffer.from(content).toString('base64'),
            updatedAt: new Date().toISOString(),
        };
        this.markSyncManifestDirty();
        return true;
    }

    private recordSyncManifestDirectory(relPath: string) {
        if (!this.syncManifest) { return; }
        this.syncManifest.directories[relPath] = {
            updatedAt: new Date().toISOString(),
        };
        this.markSyncManifestDirty();
    }

    private removeSyncManifestEntry(relPath: string) {
        if (this.syncManifest?.files[relPath]) {
            delete this.syncManifest.files[relPath];
            this.markSyncManifestDirty();
        }
    }

    private removeSyncManifestDirectory(relPath: string) {
        if (this.syncManifest?.directories[relPath]) {
            delete this.syncManifest.directories[relPath];
            this.markSyncManifestDirty();
        }
    }

    private clearReplicaState(
        relPath: string,
        recursive = false,
        preservePendingEvents = false,
    ) {
        const matches = (path: string) => recursive
            ? this.isPathAtOrBelow(path, relPath)
            : path===relPath;
        for (const path of Object.keys(this.baseCache)) {
            if (matches(path)) { delete this.baseCache[path]; }
        }
        for (const path of [...this.seenLocalEntities]) {
            if (matches(path)) { this.seenLocalEntities.delete(path); }
        }
        for (const path of [...this.locallyDivergedPaths]) {
            if (matches(path)) { this.locallyDivergedPaths.delete(path); }
        }
        for (const path of Object.keys(this.syncManifest?.files ?? {})) {
            if (matches(path)) { this.removeSyncManifestEntry(path); }
        }
        for (const path of Object.keys(this.syncManifest?.directories ?? {})) {
            if (matches(path)) { this.removeSyncManifestDirectory(path); }
        }
        for (const path of [...this.syncConflicts.keys()]) {
            if (matches(path)) {
                this.syncConflicts.delete(path);
                this.conflictLocalDigests.delete(path);
                if (this.syncManifest?.conflicts[path]) {
                    delete this.syncManifest.conflicts[path];
                    this.markSyncManifestDirty();
                }
            }
        }
        for (const path of [...this.bypassCache.keys()]) {
            if (matches(path)) { this.bypassCache.delete(path); }
        }
        for (const path of [...this.failedInitialPulls]) {
            if (matches(path)) { this.failedInitialPulls.delete(path); }
        }
        for (const path of [...this.remoteDeleteTombstones.keys()]) {
            if (recursive && path.startsWith(`${relPath}/`)) {
                this.remoteDeleteTombstones.delete(path);
            }
        }
        if (!preservePendingEvents) {
            for (const [path, pending] of [...this.pendingVfsEvents]) {
                if (!matches(path)) { continue; }
                clearTimeout(pending.timer);
                this.pendingVfsEvents.delete(path);
            }
            for (const [path, pending] of [...this.pendingLocalEvents]) {
                if (!matches(path)) { continue; }
                clearTimeout(pending.timer);
                this.pendingLocalEvents.delete(path);
            }
        }
        if (this.initialPullStatus==='partial' && this.failedInitialPulls.size===0) {
            this.initialPullStatus = 'complete';
            this.partialPullToastGeneration = undefined;
        }
    }

    private rememberRemoteDelete(relPath: string, content?: Uint8Array, staleLocalMtime?: number) {
        if (content===undefined) {
            this.remoteDeleteTombstones.delete(relPath);
            return;
        }
        this.remoteDeleteTombstones.set(relPath, {
            digest: contentDigest(content),
            staleLocalMtime: staleLocalMtime===undefined ? undefined : normalizeMtimeMs(staleLocalMtime),
        });
    }

    private clearRemoteDelete(relPath: string) {
        this.remoteDeleteTombstones.delete(relPath);
    }

    private clearFailedInitialPullAfterAuthoritativeSync(
        relPath: string,
        generation = this.syncGeneration,
    ) {
        this.requireSyncSession(generation);
        if (!this.failedInitialPulls.delete(relPath)) { return; }

        if (this.failedInitialPulls.size===0) {
            this.initialPullStatus = 'complete';
            this.partialPullToastGeneration = undefined;
            this.completeUnavailableBaselineIfResolved();
            if (this.syncConflicts.size===0) {
                this.status = {status: 'idle', message: ''};
            }
            this.armLocalWatcher?.();
        } else if (this.initialPullStatus==='partial' && this.syncConflicts.size===0) {
            this.status = {
                status: 'need-attention',
                message: vscode.l10n.t(
                    '{count} files failed to download',
                    {count: this.failedInitialPulls.size},
                ),
            };
        }
    }

    private shouldPropagate(
        action: 'push'|'pull',
        relPath: string,
        content?: Uint8Array,
        options?: ApplySyncOptions,
    ): boolean {
        const key = normalizeReplicaPath(relPath);
        const now = Date.now();
        const cache = this.bypassCache.get(key);
        if (cache) {
            const thisHash = contentDigest(content);
            const ownCache = action==='push' ? cache[0] : cache[1];
            const oppositeCache = action==='push' ? cache[1] : cache[0];
            if (options?.forcePush && action==='push') {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [push forced:${options.reason ?? 'manual'}] ${relPath} ` +
                    `(bypassing echo suppression)`,
                );
                this.setBypassCache(key, content, action);
                return true;
            }
            // Same-direction match: the last operation in THIS direction
            // already produced these exact bytes. Suppress as a redundant
            // no-op (avoids re-uploading identical bytes on bare Ctrl-S,
            // which matters for large binaries). No time bound here — a
            // duplicate save days later is still a duplicate.
            const matchesCurrentBaseline = content===undefined
                || this.isContentKnownSynced(key, content)
                || this.syncManifest?.directories[key]!==undefined;
            if (ownCache?.hash===thisHash && matchesCurrentBaseline) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [${action} suppressed:own-echo] ${relPath} ` +
                    `(age=${now-ownCache.date}ms, hash unchanged since prior ${action})`,
                );
                return false;
            }
            // Cross-direction match: the opposite side just produced these
            // bytes — this fire is the watcher reacting to that write. Only
            // honour while fresh so a stale divergent cache can't swallow a
            // later undo/redo save back to that state.
            if (oppositeCache?.hash===thisHash && now-oppositeCache.date<ECHO_WINDOW_MS) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [${action} suppressed:cross-echo] ${relPath} ` +
                    `(age=${now-oppositeCache.date}ms within ${ECHO_WINDOW_MS}ms window)`,
                );
                this.setBypassCache(key, content, action);
                return false;
            }
        }
        this.setBypassCache(key, content, action);
        return true;
    }

    private enqueueSync<T>(
        relPath: string,
        task: () => Promise<T>,
        generation = this.syncGeneration,
    ): Promise<T | undefined> {
        const previous = this.syncQueues.get(relPath) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(() => {
                this.requireSyncSession(generation);
                return task();
            })
            .catch(error => {
                console.error(error);
                return undefined;
            })
            .finally(() => {
                if (this.syncQueues.get(relPath)===next) {
                    this.syncQueues.delete(relPath);
                }
            });
        this.syncQueues.set(relPath, next);
        return next;
    }

    private async overwrite(
        root: string='/',
        options: InitializeLocalReplicaOptions = {},
        generation = this.syncGeneration,
    ): Promise<boolean|undefined> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Sync Files'),
            cancellable: true,
        }, async (progress, token) => {
            const cancelled = () => token.isCancellationRequested || !this.isSyncSessionActive(generation);
            const resetLocalFilesToRemote = options.resetLocalFilesToRemote ?? false;
            const preserveExistingLocalFiles = (options.preserveExistingLocalFiles ?? false)
                && !resetLocalFilesToRemote;
            const baselineUnavailable = preserveExistingLocalFiles
                && this.syncManifestBaselineMode==='unavailable';
            // breadth-first search for the files
            const files: [string,string][] = [];
            const directories: string[] = [];
            const queue: string[] = [root];
            while (queue.length!==0) {
                const nextRoot = queue.shift();
                const vfsUri = this.vfs.pathToUri(nextRoot!);
                const items = await this.withFileSystemContext(
                    'Read remote directory',
                    vfsUri,
                    () => vscode.workspace.fs.readDirectory(vfsUri),
                );
                if (cancelled()) { return undefined; }
                //
                for (const [name, type] of items) {
                    const relPath = this.normalizeConfinedRelPath(nextRoot + name, 'initial pull');
                    if (relPath===undefined) {
                        continue;
                    }
                    if (this.matchIgnorePatterns(relPath)) {
                        continue;
                    }
                    if (type === vscode.FileType.Directory) {
                        directories.push(relPath);
                        queue.push(relPath+'/');
                    } else {
                        files.push([name, relPath]);
                    }
                }
            }

            const localSnapshot = preserveExistingLocalFiles
                ? await this.collectLocalReplicaSnapshot(
                    this.baseUri,
                    '/',
                    {files: new Set(), directories: new Set()},
                    generation,
                )
                : undefined;
            const remoteFilePaths = new Set(files.map(([_name, relPath]) => relPath));
            const remoteDirectoryPaths = new Set(directories);
            const startupPushPaths = new Set<string>();
            const startupPushDirectoryPaths = new Set<string>();
            const startupRemoteDeletePaths = new Set<string>();
            const startupLocalDeletePaths = new Set<string>();
            const startupRemoteDirectoryDeletePaths = new Set<string>();
            const startupLocalDirectoryDeletePaths = new Set<string>();
            const blockedDirectoryRoots = new Set<string>(this.syncConflicts.keys());
            const requireStartupSync = (
                event: Events['scmSyncCompleteEvent'],
                operation: string,
                relPath: string,
            ) => {
                if (
                    event.outcome==='error'
                    || event.outcome==='blocked'
                    || event.outcome==='suppressed'
                ) {
                    throw new Error(`${operation} failed for ${relPath}: ${event.error ?? event.outcome}`);
                }
            };

            if (resetLocalFilesToRemote) {
                if (cancelled()) { return false; }
                await this.clearLocalProjectFilesForRemoteReset(generation);
                if (cancelled()) { return false; }
                this.syncManifest = this.emptySyncManifest();
                this.syncConflicts.clear();
                this.conflictLocalDigests.clear();
                this.markSyncManifestDirty();
            }

            const pathIsBlockedByDirectory = (relPath: string) =>
                [...blockedDirectoryRoots].some(directoryPath => this.isPathAtOrBelow(relPath, directoryPath));
            const remoteDirectoryIsUnchanged = async (directoryPath: string) => {
                this.requireSyncSession(generation);
                const remoteDescendantFiles = [...remoteFilePaths]
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const remoteDescendantDirectories = [...remoteDirectoryPaths]
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const manifestFiles = Object.keys(this.syncManifest?.files ?? {})
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const manifestDirectories = Object.keys(this.syncManifest?.directories ?? {})
                    .filter(path => path.startsWith(`${directoryPath}/`));
                if (
                    remoteDescendantFiles.some(path => this.syncManifest?.files[path]===undefined)
                    || remoteDescendantDirectories.some(path => this.syncManifest?.directories[path]===undefined)
                    || manifestFiles.some(path => !remoteFilePaths.has(path))
                    || manifestDirectories.some(path => !remoteDirectoryPaths.has(path))
                ) {
                    return false;
                }
                for (const path of remoteDescendantFiles) {
                    const entry = this.syncManifest?.files[path];
                    if (!entry) { return false; }
                    if (this.isLikelyBinaryRelPath(path)) {
                        const fingerprint = await this.getRemoteFingerprint(path, this.vfs.pathToUri(path));
                        this.requireSyncSession(generation);
                        if (!fingerprint || fingerprint!==entry.remoteFingerprint) {
                            return false;
                        }
                    } else {
                        const content = await this.pullRemoteFile(
                            path,
                            this.vfs.pathToUri(path),
                            generation,
                        );
                        if (contentDigest(content)!==entry.localDigest) {
                            return false;
                        }
                    }
                }
                this.requireSyncSession(generation);
                return true;
            };
            const localDirectoryIsUnchanged = async (directoryPath: string) => {
                this.requireSyncSession(generation);
                if (!localSnapshot) { return false; }
                const localDescendantFiles = [...localSnapshot.files]
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const localDescendantDirectories = [...localSnapshot.directories]
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const manifestFiles = Object.keys(this.syncManifest?.files ?? {})
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const manifestDirectories = Object.keys(this.syncManifest?.directories ?? {})
                    .filter(path => path.startsWith(`${directoryPath}/`));
                if (
                    localDescendantFiles.some(path => this.syncManifest?.files[path]===undefined)
                    || localDescendantDirectories.some(path => this.syncManifest?.directories[path]===undefined)
                    || manifestFiles.some(path => !localSnapshot.files.has(path))
                    || manifestDirectories.some(path => !localSnapshot.directories.has(path))
                ) {
                    return false;
                }
                for (const path of localDescendantFiles) {
                    if (!await this.isLocalUnchangedFromManifest(path)) {
                        return false;
                    }
                    this.requireSyncSession(generation);
                }
                return true;
            };

            if (preserveExistingLocalFiles && localSnapshot) {
                for (const relPath of localSnapshot.files) {
                    if (!remoteDirectoryPaths.has(relPath) || pathIsBlockedByDirectory(relPath)) {
                        continue;
                    }
                    blockedDirectoryRoots.add(relPath);
                    const localContent = await this.readLocalFileInSession(relPath, generation);
                    await this.markSyncConflict(
                        relPath,
                        'Overleaf contains a folder where the local replica contains a file',
                        localContent,
                        generation,
                    );
                }
                for (const relPath of localSnapshot.directories) {
                    if (!remoteFilePaths.has(relPath) || pathIsBlockedByDirectory(relPath)) {
                        continue;
                    }
                    blockedDirectoryRoots.add(relPath);
                    await this.markSyncConflict(
                        relPath,
                        'Overleaf contains a file where the local replica contains a folder',
                        undefined,
                        generation,
                    );
                }
                if (baselineUnavailable) {
                    const unknownDirectories = new Set([
                        ...localSnapshot.directories,
                        ...remoteDirectoryPaths,
                    ]);
                    const orderedUnknownDirectories = [...unknownDirectories]
                        .sort((left, right) => left.split('/').length-right.split('/').length);
                    for (const relPath of orderedUnknownDirectories) {
                        if (pathIsBlockedByDirectory(relPath)) { continue; }
                        if (this.syncManifest?.directories[relPath]!==undefined) { continue; }
                        const localExists = localSnapshot.directories.has(relPath);
                        const remoteExists = remoteDirectoryPaths.has(relPath);
                        if (localExists===remoteExists) { continue; }
                        blockedDirectoryRoots.add(relPath);
                        await this.markSyncConflict(
                            relPath,
                            localExists
                                ? 'The local folder exists only on one side and no trusted sync baseline is available'
                                : 'The Overleaf folder exists only on one side and no trusted sync baseline is available',
                            localExists ? undefined : null,
                            generation,
                        );
                    }
                }
                const baselineDirectories = Object.keys(this.syncManifest?.directories ?? {})
                    .sort((left, right) => left.split('/').length-right.split('/').length);
                for (const relPath of baselineDirectories) {
                    if (pathIsBlockedByDirectory(relPath)) { continue; }
                    const localExists = localSnapshot.directories.has(relPath);
                    const remoteExists = remoteDirectoryPaths.has(relPath);
                    if (!localExists && remoteExists) {
                        blockedDirectoryRoots.add(relPath);
                        if (await remoteDirectoryIsUnchanged(relPath)) {
                            this.requireSyncSession(generation);
                            startupRemoteDirectoryDeletePaths.add(relPath);
                        } else {
                            await this.markSyncConflict(
                                relPath,
                                'The local folder was deleted while its Overleaf contents also changed',
                                null,
                                generation,
                            );
                        }
                    } else if (localExists && !remoteExists) {
                        blockedDirectoryRoots.add(relPath);
                        if (await localDirectoryIsUnchanged(relPath)) {
                            this.requireSyncSession(generation);
                            startupLocalDirectoryDeletePaths.add(relPath);
                        } else {
                            await this.markSyncConflict(
                                relPath,
                                'Overleaf deleted the folder while its local contents also changed',
                                undefined,
                                generation,
                            );
                        }
                    }
                }
            }

            for (const relPath of directories) {
                if (cancelled()) { return false; }
                if (pathIsBlockedByDirectory(relPath)) { continue; }
                this.setBypassCache(relPath, new Uint8Array(), 'pull');
                const localUri = this.localUri(relPath);
                await this.withFileSystemContext(
                    'Create local directory',
                    localUri,
                    () => this.runSessionIO(
                        generation,
                        () => vscode.workspace.fs.createDirectory(localUri),
                    ),
                );
                this.requireSyncSession(generation);
                this.seenLocalEntities.add(relPath);
                this.recordSyncManifestDirectory(relPath);
            }

            // sync the files
            const total = files.length;
            for (let i=0; i<total; i++) {
                const [_name, relPath] = files[i];
                const vfsUri = this.vfs.pathToUri(relPath);
                if (cancelled()) { return false; }
                if (pathIsBlockedByDirectory(relPath)) { continue; }
                progress.report({increment: 100/total, message: relPath});
                //
                const manifestEntry = this.syncManifest?.files[relPath];
                const existedLocallyAtStart = localSnapshot?.files.has(relPath) ?? false;
                if (
                    baselineUnavailable
                    && manifestEntry===undefined
                    && !existedLocallyAtStart
                ) {
                    await this.markSyncConflict(
                        relPath,
                        'The Overleaf file exists only on one side and no trusted sync baseline is available',
                        null,
                        generation,
                    );
                    continue;
                }
                if (preserveExistingLocalFiles && manifestEntry && !existedLocallyAtStart) {
                    let remoteChanged = true;
                    try {
                        if (this.isLikelyBinaryRelPath(relPath)) {
                            const remoteFingerprint = await this.getRemoteFingerprint(relPath, vfsUri);
                            this.requireSyncSession(generation);
                            remoteChanged = remoteFingerprint===undefined
                                || remoteFingerprint!==manifestEntry.remoteFingerprint;
                        } else {
                            const remoteContent = await this.pullRemoteFile(relPath, vfsUri, generation);
                            remoteChanged = contentDigest(remoteContent)!==manifestEntry.localDigest;
                        }
                    } catch (error) {
                        if (cancelled()) { return false; }
                        this.failedInitialPulls.add(relPath);
                        await this.markSyncConflict(
                            relPath,
                            `Could not verify a local deletion against Overleaf: ${formatUnknownError(error)}`,
                            null,
                            generation,
                        );
                        continue;
                    }
                    if (remoteChanged) {
                        await this.markSyncConflict(
                            relPath,
                            'The local copy was deleted while the Overleaf copy was also edited',
                            null,
                            generation,
                        );
                    } else {
                        startupRemoteDeletePaths.add(relPath);
                    }
                    continue;
                }
                if (
                    !resetLocalFilesToRemote
                    && await this.canSkipInitialBinaryPull(relPath, vfsUri, generation)
                ) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [initial pull skip] ${relPath}: manifest fingerprint unchanged`,
                    );
                    continue;
                }
                if (preserveExistingLocalFiles && existedLocallyAtStart) {
                    const preservedContent = await this.readLocalFileInSession(relPath, generation);
                    this.requireSyncSession(generation);
                    if (preservedContent!==undefined) {
                        if (this.isLikelyBinaryRelPath(relPath)) {
                            if (manifestEntry===undefined) {
                                const remoteContent = await this.pullRemoteFile(
                                    relPath,
                                    vfsUri,
                                    generation,
                                );
                                if (bytesEqual(preservedContent, remoteContent)) {
                                    this.baseCache[relPath] = preservedContent;
                                    this.seenLocalEntities.add(relPath);
                                    this.setBypassCache(relPath, preservedContent);
                                    this.clearRemoteDelete(relPath);
                                    await this.recordSyncManifestEntry(
                                        relPath,
                                        vfsUri,
                                        preservedContent,
                                        generation,
                                    );
                                } else {
                                    this.seenLocalEntities.add(relPath);
                                    await this.markSyncConflict(
                                        relPath,
                                        'Local and Overleaf binary/media copies differ but no common baseline is available',
                                        preservedContent,
                                        generation,
                                    );
                                }
                                continue;
                            }
                            const localChanged = manifestEntry===undefined
                                || contentDigest(preservedContent)!==manifestEntry.localDigest;
                            const remoteFingerprint = await this.getRemoteFingerprint(relPath, vfsUri);
                            this.requireSyncSession(generation);
                            const remoteChanged = manifestEntry===undefined
                                || remoteFingerprint===undefined
                                || remoteFingerprint!==manifestEntry.remoteFingerprint;
                            if (localChanged && remoteChanged) {
                                this.seenLocalEntities.add(relPath);
                                await this.markSyncConflict(
                                    relPath,
                                    'Local and Overleaf binary/media copies were both changed while disconnected',
                                    preservedContent,
                                    generation,
                                );
                                continue;
                            }
                            if (localChanged) {
                                const remoteBaseContent = await this.pullRemoteFile(relPath, vfsUri, generation);
                                this.baseCache[relPath] = remoteBaseContent;
                                this.seenLocalEntities.add(relPath);
                                this.setBypassCache(relPath, preservedContent);
                                this.clearRemoteDelete(relPath);
                                startupPushPaths.add(relPath);
                                continue;
                            }
                            if (!remoteChanged) {
                                this.baseCache[relPath] = preservedContent;
                                this.seenLocalEntities.add(relPath);
                                this.setBypassCache(relPath, preservedContent);
                                this.clearRemoteDelete(relPath);
                                continue;
                            }
                        } else {
                            let remoteContent: Uint8Array;
                            try {
                                remoteContent = await this.pullRemoteFile(relPath, vfsUri, generation);
                            } catch (error) {
                                if (cancelled()) { return false; }
                                getOutputChannel().appendLine(
                                    `${new Date().toISOString()} [initial pull failed] ${relPath}: ${formatUnknownError(error)}`,
                                );
                                this.failedInitialPulls.add(relPath);
                                this.locallyDivergedPaths.add(relPath);
                                continue;
                            }

                            const localDigest = contentDigest(preservedContent);
                            const remoteDigest = contentDigest(remoteContent);
                            const localChanged = manifestEntry===undefined
                                || localDigest!==manifestEntry.localDigest;
                            const remoteChanged = manifestEntry===undefined
                                || remoteDigest!==manifestEntry.localDigest;

                            if (bytesEqual(preservedContent, remoteContent)) {
                                this.baseCache[relPath] = preservedContent;
                                this.seenLocalEntities.add(relPath);
                                this.setBypassCache(relPath, preservedContent);
                                this.clearRemoteDelete(relPath);
                                await this.recordSyncManifestEntry(relPath, vfsUri, preservedContent, generation);
                            } else if (!localChanged && remoteChanged) {
                                const wroteRemoteContent = await this.writeLocalFileIfRevision(
                                    relPath,
                                    remoteContent,
                                    localDigest,
                                    generation,
                                );
                                if (!wroteRemoteContent) {
                                    const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                    await this.markSyncConflict(
                                        relPath,
                                        'The local file changed while an initial Overleaf update was being applied',
                                        latestLocal.kind==='file' ? latestLocal.content : undefined,
                                        generation,
                                    );
                                    continue;
                                }
                                this.setBypassCache(relPath, remoteContent, 'pull');
                                this.baseCache[relPath] = remoteContent;
                                this.seenLocalEntities.add(relPath);
                                this.clearRemoteDelete(relPath);
                                await this.recordSyncManifestEntry(relPath, vfsUri, remoteContent, generation);
                            } else if (localChanged && !remoteChanged) {
                                this.baseCache[relPath] = remoteContent;
                                this.seenLocalEntities.add(relPath);
                                this.setBypassCache(relPath, preservedContent);
                                this.clearRemoteDelete(relPath);
                                startupPushPaths.add(relPath);
                            } else {
                                const baseContent = this.manifestBaseContent(manifestEntry);
                                const mergedContent = baseContent===undefined
                                    ? undefined
                                    : this.mergeTextContents(baseContent, preservedContent, remoteContent);
                                if (mergedContent===undefined) {
                                    if (baseContent!==undefined) {
                                        this.baseCache[relPath] = baseContent;
                                    }
                                    this.seenLocalEntities.add(relPath);
                                    await this.markSyncConflict(
                                        relPath,
                                        manifestEntry
                                            ? 'Local and Overleaf text copies were both changed and could not be merged automatically'
                                            : 'Local and Overleaf text copies differ but no common baseline is available',
                                        preservedContent,
                                        generation,
                                    );
                                } else {
                                    const wroteMergedContent = await this.writeLocalFileIfRevision(
                                        relPath,
                                        mergedContent,
                                        localDigest,
                                        generation,
                                    );
                                    if (!wroteMergedContent) {
                                        const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                        await this.markSyncConflict(
                                            relPath,
                                            'The local file changed while an initial merged update was being applied',
                                            latestLocal.kind==='file' ? latestLocal.content : undefined,
                                            generation,
                                        );
                                        continue;
                                    }
                                    this.setBypassCache(relPath, mergedContent, 'pull');
                                    this.baseCache[relPath] = remoteContent;
                                    this.seenLocalEntities.add(relPath);
                                    this.clearRemoteDelete(relPath);
                                    if (bytesEqual(mergedContent, remoteContent)) {
                                        await this.recordSyncManifestEntry(relPath, vfsUri, mergedContent, generation);
                                    } else {
                                        startupPushPaths.add(relPath);
                                    }
                                }
                            }
                            continue;
                        }
                    }
                }

                const localStateBeforePull = await this.captureLocalPathRevision(relPath, generation);
                let remoteContent: Uint8Array;
                try {
                    remoteContent = await this.pullRemoteFile(relPath, vfsUri, generation);
                } catch (error) {
                    if (cancelled()) { return false; }
                    // Even after Layer 1 retries the read failed. Record the
                    // failed path so the rest of the system refuses to act on
                    // any local event for it (the delete-guard layers and the
                    // deferred-local-watcher layer key off this set), then
                    // continue the BFS so other files still get pulled.
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [initial pull failed] ${relPath}: ${formatUnknownError(error)}`,
                    );
                    this.failedInitialPulls.add(relPath);
                    continue;
                }
                const latestLocalState = await this.captureLocalPathRevision(relPath, generation);
                if (latestLocalState.revision!==localStateBeforePull.revision) {
                    if (
                        latestLocalState.kind==='file'
                        && latestLocalState.content!==undefined
                        && bytesEqual(latestLocalState.content, remoteContent)
                    ) {
                        this.setBypassCache(relPath, remoteContent);
                    } else {
                        const baseContent = this.manifestBaseContent(manifestEntry);
                        if (baseContent!==undefined) {
                            this.baseCache[relPath] = baseContent;
                        }
                        this.seenLocalEntities.add(relPath);
                        await this.markSyncConflict(
                            relPath,
                            'The local path changed while the initial Overleaf pull was in flight',
                            latestLocalState.kind==='file' ? latestLocalState.content : undefined,
                            generation,
                        );
                        continue;
                    }
                } else {
                    const wroteRemoteContent = await this.writeLocalFileIfRevision(
                        relPath,
                        remoteContent,
                        localStateBeforePull.revision,
                        generation,
                    );
                    if (!wroteRemoteContent) {
                        const concurrentLocalState = await this.captureLocalPathRevision(relPath, generation);
                        await this.markSyncConflict(
                            relPath,
                            'The local path changed immediately before the initial Overleaf pull was written',
                            concurrentLocalState.kind==='file' ? concurrentLocalState.content : undefined,
                            generation,
                        );
                        continue;
                    }
                    this.setBypassCache(relPath, remoteContent);
                }
                this.baseCache[relPath] = remoteContent;
                this.seenLocalEntities.add(relPath);
                this.clearRemoteDelete(relPath);
                await this.recordSyncManifestEntry(relPath, vfsUri, remoteContent, generation);
            }

            if (localSnapshot) {
                for (const relPath of localSnapshot.files) {
                    if (pathIsBlockedByDirectory(relPath)) { continue; }
                    if (remoteFilePaths.has(relPath)) { continue; }
                    const manifestEntry = this.syncManifest?.files[relPath];
                    if (manifestEntry && await this.isLocalUnchangedFromManifest(relPath)) {
                        startupLocalDeletePaths.add(relPath);
                    } else if (manifestEntry) {
                        const baseContent = this.manifestBaseContent(manifestEntry);
                        if (baseContent!==undefined) {
                            this.baseCache[relPath] = baseContent;
                        }
                        this.seenLocalEntities.add(relPath);
                        const localContent = await this.readLocalFileInSession(relPath, generation);
                        await this.markSyncConflict(
                            relPath,
                            'Overleaf deleted the file while the local saved copy was also edited',
                            localContent,
                            generation,
                        );
                    } else if (baselineUnavailable) {
                        const localContent = await this.readLocalFileInSession(relPath, generation);
                        await this.markSyncConflict(
                            relPath,
                            'The local file exists only on one side and no trusted sync baseline is available',
                            localContent,
                            generation,
                        );
                    } else {
                        startupPushPaths.add(relPath);
                    }
                }

                for (const relPath of Object.keys(this.syncManifest?.files ?? {})) {
                    if (pathIsBlockedByDirectory(relPath)) { continue; }
                    if (!remoteFilePaths.has(relPath) && !localSnapshot.files.has(relPath)) {
                        this.removeSyncManifestEntry(relPath);
                    }
                }

                for (const relPath of localSnapshot.directories) {
                    if (pathIsBlockedByDirectory(relPath)) { continue; }
                    if (remoteDirectoryPaths.has(relPath)) {
                        this.seenLocalEntities.add(relPath);
                        this.recordSyncManifestDirectory(relPath);
                    } else if (this.syncManifest?.directories[relPath]===undefined) {
                        startupPushDirectoryPaths.add(relPath);
                    }
                }

                for (const relPath of Object.keys(this.syncManifest?.directories ?? {})) {
                    if (
                        !remoteDirectoryPaths.has(relPath)
                        && !localSnapshot.directories.has(relPath)
                        && !pathIsBlockedByDirectory(relPath)
                    ) {
                        this.removeSyncManifestDirectory(relPath);
                    }
                }

                for (const relPath of startupRemoteDirectoryDeletePaths) {
                    if (cancelled()) { return false; }
                    this.seenLocalEntities.add(relPath);
                    const event = await this.applySync(
                        'push',
                        'delete',
                        relPath,
                        this.localUri(relPath),
                        this.vfs.pathToUri(relPath),
                        {forcePush: true, reason: 'startup-reconcile'},
                        generation,
                    );
                    requireStartupSync(event, 'startup remote directory delete', relPath);
                }

                for (const relPath of startupLocalDirectoryDeletePaths) {
                    if (cancelled()) { return false; }
                    this.seenLocalEntities.add(relPath);
                    const event = await this.applySync(
                        'pull',
                        'delete',
                        relPath,
                        this.vfs.pathToUri(relPath),
                        this.localUri(relPath),
                        {},
                        generation,
                    );
                    requireStartupSync(event, 'startup local directory delete', relPath);
                }

                for (const relPath of startupRemoteDeletePaths) {
                    if (cancelled()) { return false; }
                    const baseContent = this.manifestBaseContent(this.syncManifest?.files[relPath]);
                    if (baseContent!==undefined) {
                        this.baseCache[relPath] = baseContent;
                    }
                    this.seenLocalEntities.add(relPath);
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [startup reconcile:push-delete] ${relPath}`,
                    );
                    const event = await this.applySync(
                        'push',
                        'delete',
                        relPath,
                        this.localUri(relPath),
                        this.vfs.pathToUri(relPath),
                        {forcePush: true, reason: 'startup-reconcile'},
                        generation,
                    );
                    requireStartupSync(event, 'startup remote delete', relPath);
                }

                for (const relPath of startupLocalDeletePaths) {
                    if (cancelled()) { return false; }
                    const localContent = await this.readLocalFileInSession(relPath, generation);
                    if (localContent!==undefined) {
                        this.baseCache[relPath] = localContent;
                    }
                    this.seenLocalEntities.add(relPath);
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [startup reconcile:pull-delete] ${relPath}`,
                    );
                    const event = await this.applySync(
                        'pull',
                        'delete',
                        relPath,
                        this.vfs.pathToUri(relPath),
                        this.localUri(relPath),
                        {},
                        generation,
                    );
                    requireStartupSync(event, 'startup local delete', relPath);
                }

                const requiredRemoteDirectories = new Set<string>();
                for (const relPath of startupPushDirectoryPaths) {
                    requiredRemoteDirectories.add(relPath);
                }
                for (const relPath of startupPushPaths) {
                    const segments = relPath.split('/').filter(Boolean);
                    for (let index=1; index<segments.length; index++) {
                        requiredRemoteDirectories.add('/' + segments.slice(0, index).join('/'));
                    }
                }
                const orderedRemoteDirectories = [...requiredRemoteDirectories]
                    .sort((left, right) => left.split('/').length-right.split('/').length);
                for (const relPath of orderedRemoteDirectories) {
                    if (remoteDirectoryPaths.has(relPath)) { continue; }
                    const event = await this.applySync(
                        'push',
                        'update',
                        relPath,
                        this.localUri(relPath),
                        this.vfs.pathToUri(relPath),
                        {forcePush: true, reason: 'startup-reconcile'},
                        generation,
                    );
                    requireStartupSync(event, 'startup remote directory creation', relPath);
                    remoteDirectoryPaths.add(relPath);
                }

                for (const relPath of startupPushPaths) {
                    if (cancelled()) { return false; }
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [startup reconcile:push-update] ${relPath}`,
                    );
                    const event = await this.applySync(
                        'push',
                        'update',
                        relPath,
                        this.localUri(relPath),
                        this.vfs.pathToUri(relPath),
                        {forcePush: true, reason: 'startup-reconcile'},
                        generation,
                    );
                    requireStartupSync(event, 'startup remote update', relPath);
                }
            }

            return true;
        });
    }

    private localRelPathFromUri(uri: vscode.Uri): string {
        const basePath = this.baseUri.path.replace(/\/+$/, '');
        return normalizeReplicaPath(uri.path.slice(basePath.length));
    }

    private shouldPreserveLocalPathForRemoteReset(uri: vscode.Uri): boolean {
        if (isLocalReplicaMetadataUri(uri, this.baseUri)) {
            return true;
        }

        const relPath = this.localRelPathFromUri(uri);
        const segments = relPath.split('/').filter(Boolean);
        if (segments.some(segment => segment.startsWith('.'))) {
            return true;
        }

        return relPath==='/AGENTS.md' || relPath==='/CLAUDE.md';
    }

    private async clearLocalProjectEntryForRemoteReset(
        uri: vscode.Uri,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        if (this.shouldPreserveLocalPathForRemoteReset(uri)) {
            return;
        }

        const stat = await vscode.workspace.fs.stat(uri);
        this.requireSyncSession(generation);
        if (stat.type===vscode.FileType.Directory) {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            this.requireSyncSession(generation);
            for (const [name] of entries) {
                await this.clearLocalProjectEntryForRemoteReset(
                    vscode.Uri.joinPath(uri, name),
                    generation,
                );
            }

            const remainingEntries = await vscode.workspace.fs.readDirectory(uri);
            this.requireSyncSession(generation);
            if (remainingEntries.length!==0) {
                return;
            }
        }

        const relPath = this.localRelPathFromUri(uri);
        this.setBypassCache(relPath, undefined, 'pull');
        await this.withFileSystemContext(
            'Delete local file before remote-authoritative sync',
            uri,
            () => this.runSessionIO(
                generation,
                () => deleteWithTrashFallback(uri, {recursive: false}),
            ),
        );
        this.requireSyncSession(generation);
    }

    private async clearLocalProjectFilesForRemoteReset(
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const entries = await vscode.workspace.fs.readDirectory(this.baseUri);
        this.requireSyncSession(generation);
        for (const [name] of entries) {
            await this.clearLocalProjectEntryForRemoteReset(
                vscode.Uri.joinPath(this.baseUri, name),
                generation,
            );
        }

        this.baseCache = {};
        this.seenLocalEntities.clear();
        this.remoteDeleteTombstones.clear();
        this.locallyDivergedPaths.clear();
        this.syncConflicts.clear();
        this.conflictLocalDigests.clear();
        this.pendingLocalEvents.forEach(pending => clearTimeout(pending.timer));
        this.pendingLocalEvents.clear();
    }

    private bypassSync(
        action:'push'|'pull',
        type:'update'|'delete',
        relPath: string,
        content?: Uint8Array,
        options?: ApplySyncOptions,
    ): boolean {
        // bypass ignore files
        if (this.matchIgnorePatterns(relPath)) {
            return true;
        }
        // synchronization propagation check
        if (!this.shouldPropagate(action, relPath, content, options)) {
            return true;
        }
        // otherwise, log the synchronization
        console.log(`${new Date().toLocaleString()} [${action}] ${type} "${relPath}"`);
        return false;
    }

    // Wait until the VFS is back to 'connected', or give up after a timeout.
    // Used between pull-retry attempts INSTEAD of forcing a reconnect:
    // forcing a reconnect from every per-file retry causes a storm because
    // VirtualFileSystem.reconnect() clears the entire project state on each
    // call. Multiple parallel pulls each calling reconnect cascade-destroy
    // each other's init. Awaiting the existing connection-state machine is
    // race-free (we re-check after subscribing).
    private async waitForConnectedOrTimeout(timeoutMs: number): Promise<boolean> {
        if (this.vfs.connectionState==='connected') { return true; }
        if (this.vfs.connectionState==='disconnected') { return false; }
        return new Promise<boolean>(resolve => {
            let settled = false;
            const settle = (value: boolean) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                sub.dispose();
                resolve(value);
            };
            const timer = setTimeout(() => settle(false), timeoutMs);
            const sub = this.vfs.onDidChangeConnection(state => {
                if (state==='connected') { settle(true); }
                else if (state==='disconnected') { settle(false); }
            });
            // Re-check after subscribing to close the listener-installation
            // gap in both directions: a transition to 'connected' OR
            // 'disconnected' between our initial check and the .event()
            // subscription would otherwise stick us on the 5s timeout.
            if (this.vfs.connectionState==='connected') { settle(true); }
            else if (this.vfs.connectionState==='disconnected') { settle(false); }
        });
    }

    // Generic bounded-retry helper. Used by both push and pull paths so a stale
    // or reconnecting socket doesn't drop an operation silently. The optional
    // `betweenAttempts` callback runs between failed attempts — both push and
    // pull now passively await the existing connection state machine (no
    // per-attempt reconnect — see waitForConnectedOrTimeout). Callers may still
    // force a one-shot reconnect inside the task itself.
    private async withRetry<T>(
        label: 'push' | 'pull',
        relPath: string,
        task: () => Promise<T>,
        opts?: {
            delays?: number[];
            betweenAttempts?: () => Promise<void>;
            generation?: number;
        },
    ): Promise<T> {
        const generation = opts?.generation ?? this.syncGeneration;
        const delays = opts?.delays ?? LocalReplicaSCMProvider.pushRetryDelays;
        const betweenAttempts = opts?.betweenAttempts;
        let lastError: unknown;
        for (let attempt = 0; attempt<delays.length; attempt++) {
            const delay = delays[attempt];
            if (delay>0) { await new Promise(resolve => setTimeout(resolve, delay)); }
            this.requireSyncSession(generation);
            try {
                const result = await task();
                this.requireSyncSession(generation);
                if (lastError) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [${label} recovered] ${relPath} after retry`,
                    );
                }
                return result;
            } catch (error) {
                if (
                    error instanceof ConcurrentReplicaChangeError
                    || error instanceof RemoteDocumentMergeConflictError
                    || error instanceof RemoteDocumentWriteAmbiguousError
                    || (error as {retryable?: boolean})?.retryable===false
                ) {
                    throw error;
                }
                lastError = error;
                if (attempt<delays.length-1 && betweenAttempts) {
                    try {
                        await betweenAttempts();
                    } catch (cbError) {
                        lastError = cbError;
                    }
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async pushWithRetry(
        relPath: string,
        toUri: vscode.Uri,
        content: Uint8Array,
        generation = this.syncGeneration,
        remoteBaseline?: Uint8Array,
        expectedRemoteMissing = false,
    ): Promise<Uint8Array> {
        return this.withRetry('push', relPath, async () => {
            await this.vfs.ensureConnectedForWrite();
            this.requireSyncSession(generation);
            return this.runSessionIO(
                generation,
                () => this.vfs.writeFileFromRemoteBaseline(
                    toUri,
                    content,
                    remoteBaseline,
                    expectedRemoteMissing,
                ),
            );
        }, {
            delays: LocalReplicaSCMProvider.pushRetryDelays,
            generation,
            // Match the pull-retry pattern: wait passively for the connection
            // state machine to settle rather than firing reconnect() on every
            // attempt. The task itself already calls ensureConnectedForWrite()
            // which is a one-shot reconnect when state is 'disconnected', and
            // back-to-back reconnect() calls clear the entire project state
            // (see VirtualFileSystem.reconnect — root and initializing both
            // get nulled). One-shot at task entry plus passive wait between
            // attempts mirrors how pull handles a flapping socket without
            // amplifying the failure into a socket storm.
            betweenAttempts: async () => {
                await this.waitForConnectedOrTimeout(LocalReplicaSCMProvider.pushReconnectWaitMs);
            },
        });
    }

    // Pull binary files with a wider backoff. Binary VFS reads occasionally
    // return Unknown / zero bytes during socket reconnects; surface those as
    // failures the outer code can retry rather than silently writing empty
    // files into the replica. Push now matches the same budget so a
    // 1-2 second socket reconnect doesn't silently lose accepted edits — the
    // prior 0.9s budget meant push gave up while pull was still recovering.
    private static readonly pullRetryDelays = [0, 300, 900, 2400];
    private static readonly pushRetryDelays = [0, 300, 900, 2400];
    private static readonly pullReconnectWaitMs = 5000;
    private static readonly pushReconnectWaitMs = 5000;

    private isLikelyBinaryRelPath(relPath: string): boolean {
        return /\.(pdf|png|jpe?g|gif|svg|webp|bmp|tiff?|eps|ps|zip|tar|gz|bz2|7z|rar|mp[34]|wav|ogg|woff2?|ttf|otf|ico)$/i.test(relPath);
    }

    private async pullRemoteFile(
        relPath: string,
        vfsUri: vscode.Uri,
        generation = this.syncGeneration,
    ): Promise<Uint8Array> {
        return this.withRetry('pull', relPath, async () => {
            const content = await this.withFileSystemContext(
                'Read remote file',
                vfsUri,
                () => vscode.workspace.fs.readFile(vfsUri),
            );
            // A 0-byte payload for a binary is almost certainly a transient
            // failure rather than a genuinely empty file (no real PDF/PNG is
            // 0 bytes). Throw so the retry loop tries again; if all attempts
            // come back empty we let the caller decide what to do.
            if (this.isLikelyBinaryRelPath(relPath) && content.length===0) {
                throw new Error(`empty binary payload for ${relPath}`);
            }
            return content;
        }, {
            delays: LocalReplicaSCMProvider.pullRetryDelays,
            generation,
            // Critical: do NOT call vfs.reconnect() between attempts. Parallel
            // pulls each issuing reconnect() cascade-clear the project state
            // and produce a socket storm severe enough that Overleaf rate-limits
            // us. Instead, wait passively for the existing reconnect cycle to
            // resolve (it does on its own via the VFS's internal logic).
            betweenAttempts: async () => {
                await this.waitForConnectedOrTimeout(LocalReplicaSCMProvider.pullReconnectWaitMs);
            },
        });
    }

    private retainLocalPushIntentAfterClassificationFailure(
        relPath: string,
        localUri: vscode.Uri,
        observedType: 'update' | 'delete',
        error: unknown,
        generation: number,
    ): void {
        if (!this.isSyncSessionActive(generation)) { return; }
        const errorMessage = formatUnknownError(error);
        this.locallyDivergedPaths.add(relPath);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [push classification failed] ${relPath}: ${errorMessage}`,
        );
        maybeWarnSyncFailure(relPath, error);
        EventBus.fire('scmSyncCompleteEvent', {
            rootUri: this.baseUri,
            relPath,
            direction: 'push',
            type: observedType,
            outcome: 'error',
            error: errorMessage,
        });

        const existing = this.pendingLocalEvents.get(relPath);
        if (existing) {
            clearTimeout(existing.timer);
        }
        const firstEventAt = existing?.firstEventAt ?? Date.now();
        const timer = setTimeout(() => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const pending = this.pendingLocalEvents.get(relPath);
            if (!pending || pending.timer!==timer) { return; }
            this.pendingLocalEvents.delete(relPath);
            void this.syncToVFS(pending.latestUri, pending.latestType);
        }, LocalReplicaSCMProvider.fallbackScanIntervalMs);
        this.pendingLocalEvents.set(relPath, {
            timer,
            firstEventAt,
            latestType: observedType,
            latestUri: localUri,
        });
    }

    private retainRemotePullIntentAfterClassificationFailure(
        relPath: string,
        vfsUri: vscode.Uri,
        observedType: 'update' | 'delete',
        error: unknown,
        generation: number,
    ): void {
        if (!this.isSyncSessionActive(generation)) { return; }
        const errorMessage = formatUnknownError(error);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [pull classification failed] ${relPath}: ${errorMessage}`,
        );
        maybeWarnSyncFailure(relPath, error);
        EventBus.fire('scmSyncCompleteEvent', {
            rootUri: this.baseUri,
            relPath,
            direction: 'pull',
            type: observedType,
            outcome: 'error',
            error: errorMessage,
        });

        const existing = this.pendingVfsEvents.get(relPath);
        if (existing) {
            clearTimeout(existing.timer);
        }
        const firstEventAt = existing?.firstEventAt ?? Date.now();
        const timer = setTimeout(() => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const pending = this.pendingVfsEvents.get(relPath);
            if (!pending || pending.timer!==timer) { return; }
            this.pendingVfsEvents.delete(relPath);
            this.syncFromVFS(pending.latestUri, pending.latestType);
        }, LocalReplicaSCMProvider.fallbackScanIntervalMs);
        this.pendingVfsEvents.set(relPath, {
            timer,
            firstEventAt,
            latestType: observedType,
            latestUri: vfsUri,
        });
    }

    private queueForcedPush(
        relPath: string,
        reason: string,
        observedType: 'update' | 'delete' = 'update',
    ): void {
        if (!this.isSyncSessionActive()) { return; }
        const generation = this.syncGeneration;
        const localUri = this.localUri(relPath);
        const vfsUri = this.vfs.pathToUri(relPath);
        void this.enqueueSync(
            relPath,
            async () => {
                let type: 'update' | 'delete' | undefined;
                try {
                    type = await this.localTargetNeedsPush(relPath, localUri);
                    this.requireSyncSession(generation);
                } catch (error) {
                    this.retainLocalPushIntentAfterClassificationFailure(
                        relPath,
                        localUri,
                        observedType,
                        error,
                        generation,
                    );
                    return undefined;
                }
                if (type===undefined) { return undefined; }
                return this.applySync('push', type, relPath, localUri, vfsUri, {
                    forcePush: true,
                    reason,
                }, generation);
            },
            generation,
        );
    }

    private async applySync(
        action:'push'|'pull',
        type: 'update'|'delete',
        relPath:string,
        fromUri: vscode.Uri,
        toUri: vscode.Uri,
        options: ApplySyncOptions = {},
        generation = this.syncGeneration,
    ): Promise<Events['scmSyncCompleteEvent']> {
        const originalRelPath = relPath;
        const confinedRelPath = this.normalizeConfinedRelPath(relPath, `${action} ${type}`);
        if (confinedRelPath===undefined) {
            this.status = {status: 'idle', message: ''};
            const event: Events['scmSyncCompleteEvent'] = {
                rootUri: this.baseUri,
                relPath: normalizeReplicaPath(originalRelPath),
                direction: action,
                type,
                outcome: 'blocked',
                error: 'invalid replica path',
            };
            EventBus.fire('scmSyncCompleteEvent', event);
            return event;
        }
        relPath = confinedRelPath;
        if (!this.isSyncSessionActive(generation)) {
            const event: Events['scmSyncCompleteEvent'] = {
                rootUri: this.baseUri,
                relPath,
                direction: action,
                type,
                outcome: 'blocked',
                error: 'sync session inactive',
            };
            EventBus.fire('scmSyncCompleteEvent', event);
            return event;
        }
        if (action==='pull') {
            toUri = this.localUri(relPath);
        }
        const bypassCacheSnapshot = this.snapshotBypassCache(relPath);
        this.status = {status: action, message: `${type}: ${relPath}`};

        // Track the terminal outcome so we can fire a single scmSyncCompleteEvent
        // after the IIFE settles. Each early `return` along a guard/suppress
        // path updates `outcome` first; the catch updates `outcome` + `error`.
        // Subscribers (compileManager, status UI, tests) can wait on a specific
        // (relPath, direction, outcome) without polling status.
        let outcome: 'success' | 'error' | 'blocked' | 'suppressed' = 'success';
        let errorMessage: string | undefined;
        let authoritativePullCompleted = false;

        try {
            await (async () => {
            if (
                action==='push'
                && this.touchesSyncConflict(relPath)
                && !options.resolveConflict
            ) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [push blocked:unresolved-conflict] ${relPath}`,
                );
                outcome = 'blocked';
                errorMessage = 'unresolved sync conflict';
                return;
            }
            if (type==='delete') {
                const newContent = undefined;
                const previousBaseContent = this.baseCache[relPath];
                const directoryDelete = this.isTrackedDirectory(relPath);
                let targetAlreadyMissing = false;
                let expectedLocalDeleteRevision: string | undefined;
                let expectedRemoteDeleteRevision: string | undefined;
                let localDeleteState: PathRevision | undefined;
                let remoteDeleteState: PathRevision | undefined;

                // Layer 3 — suppress a pull-delete for a path we never
                // authoritatively replicated. The cascade starts here: a VFS
                // Deleted event for a file that wasn't pulled locally would
                // otherwise call workspace.fs.delete(localUri), which fires
                // the local watcher and echoes back as a remote delete. We
                // refuse to act on it and seed the bypass cache so any
                // spurious echo gets suppressed too.
                if (action==='pull') {
                    localDeleteState = await this.captureLocalPathRevision(relPath, generation);
                    const localExists = localDeleteState.kind!=='missing';
                    expectedLocalDeleteRevision = localDeleteState.revision;
                    const everReplicated = relPath in this.baseCache
                        || this.syncManifest?.files[relPath]!==undefined
                        || this.syncManifest?.directories[relPath]!==undefined;
                    if (!localExists) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [pull delete applied:local-missing] ${relPath}: ` +
                            `everReplicated=${everReplicated} failedInitialPull=${this.failedInitialPulls.has(relPath)}`,
                        );
                        this.setBypassCache(relPath, undefined);
                        this.rememberRemoteDelete(relPath, previousBaseContent);
                        this.clearFailedInitialPullAfterAuthoritativeSync(relPath, generation);
                        this.clearReplicaState(relPath, directoryDelete);
                        await this.persistSyncManifest(false, generation);
                        return;
                    }
                    if (!everReplicated || this.failedInitialPulls.has(relPath)) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [pull delete suppressed] ${relPath}: ` +
                            `localExists=${localExists} everReplicated=${everReplicated} ` +
                            `failedInitialPull=${this.failedInitialPulls.has(relPath)}`,
                        );
                        this.setBypassCache(relPath, undefined);
                        this.failedInitialPulls.add(relPath);
                        this.initialPullStatus = 'partial';
                        const localConflictContent = directoryDelete
                            ? undefined
                            : await this.readFile(relPath);
                        this.requireSyncSession(generation);
                        await this.markSyncConflict(
                            relPath,
                            'Overleaf deleted a path whose local copy was never verified',
                            localConflictContent,
                            generation,
                        );
                        outcome = 'suppressed';
                        return;
                    }
                    if (directoryDelete) {
                        const ignoredDescendant = await this.findIgnoredDescendant(toUri, relPath, generation);
                        this.requireSyncSession(generation);
                        if (ignoredDescendant) {
                            await this.markSyncConflict(
                                relPath,
                                `Overleaf deleted the folder, but local ignored content must be preserved (${ignoredDescendant})`,
                                undefined,
                                generation,
                            );
                            outcome = 'blocked';
                            errorMessage = 'remote folder delete contains ignored local content';
                            return;
                        }
                    }
                    if (directoryDelete && await this.localDirectoryHasChanges(relPath, generation)) {
                        this.requireSyncSession(generation);
                        await this.markSyncConflict(
                            relPath,
                            'Overleaf deleted the folder while its local contents also changed',
                            undefined,
                            generation,
                        );
                        outcome = 'blocked';
                        errorMessage = 'concurrent remote folder delete and local edits';
                        return;
                    }
                    if (previousBaseContent!==undefined) {
                        const localContent = localDeleteState.content;
                        if (localContent!==undefined && !bytesEqual(localContent, previousBaseContent)) {
                            await this.markSyncConflict(
                                relPath,
                                'Overleaf deleted the file while the local saved copy was also edited',
                                localContent,
                                generation,
                            );
                            outcome = 'blocked';
                            errorMessage = 'concurrent remote delete and local edit';
                            return;
                        }
                    }
                }

                // Layer 4 — refuse a push-delete without local-write
                // provenance. If we never wrote this file locally (no entry in
                // baseCache and no seenLocalEntities trace), the local-watcher
                // event is an echo, not user intent.
                if (action==='push') {
                    if (this.failedInitialPulls.has(relPath) && !options.resolveConflict) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [push delete blocked] ${relPath}: initial pull failed; refusing to mutate remote`,
                        );
                        maybeWarnSyncFailure(relPath, new Error(
                            'Remote delete blocked: initial pull failed for this file. Use "Retry Pull" before deleting.',
                        ));
                        outcome = 'blocked';
                        errorMessage = 'initial pull failed';
                        return;
                    }
                    if (
                        !this.seenLocalEntities.has(relPath)
                        && !(relPath in this.baseCache)
                        && this.syncManifest?.files[relPath]===undefined
                        && this.syncManifest?.directories[relPath]===undefined
                    ) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [push delete blocked] ${relPath}: no local-write trace; treating as echo`,
                        );
                        outcome = 'suppressed';
                        return;
                    }
                    remoteDeleteState = await this.captureRemotePathRevision(relPath, generation);
                    if (remoteDeleteState.kind==='missing') {
                        targetAlreadyMissing = true;
                    } else {
                        expectedRemoteDeleteRevision = remoteDeleteState.revision;
                    }
                    if (directoryDelete && !targetAlreadyMissing) {
                        try {
                            const ignoredDescendant = await this.findIgnoredDescendant(toUri, relPath, generation);
                            this.requireSyncSession(generation);
                            if (ignoredDescendant) {
                                await this.markSyncConflict(
                                    relPath,
                                    `The local folder was deleted, but ignored Overleaf content must be preserved (${ignoredDescendant})`,
                                    null,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'local folder delete contains ignored remote content';
                                return;
                            }
                            if (await this.remoteDirectoryHasChanges(relPath, generation)) {
                                this.requireSyncSession(generation);
                                await this.markSyncConflict(
                                    relPath,
                                    'The local folder was deleted while its Overleaf contents also changed',
                                    null,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'concurrent local folder delete and remote edits';
                                return;
                            }
                        } catch (error) {
                            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                                targetAlreadyMissing = true;
                            } else {
                                throw error;
                            }
                        }
                    } else if (!targetAlreadyMissing && previousBaseContent!==undefined) {
                        const remoteContent = remoteDeleteState.content;
                        if (remoteContent!==undefined && !bytesEqual(remoteContent, previousBaseContent)) {
                            await this.markSyncConflict(
                                relPath,
                                'The local copy was deleted while the Overleaf copy was also edited',
                                null,
                                generation,
                            );
                            outcome = 'blocked';
                            errorMessage = 'concurrent local delete and remote edit';
                            return;
                        }
                    }
                }

                if (this.bypassSync(action, type, relPath, newContent, options)) {
                    outcome = 'suppressed';
                    return;
                }
                let staleLocalMtime: number | undefined;
                if (action==='pull') {
                    try {
                        const deleteTargetStat = await vscode.workspace.fs.stat(toUri);
                        this.requireSyncSession(generation);
                        if (deleteTargetStat.type===vscode.FileType.File) {
                            staleLocalMtime = deleteTargetStat.mtime;
                        }
                    } catch {
                        staleLocalMtime = undefined;
                    }
                }
                if (action==='push') {
                    const decision = await getAgentReviewManager()?.beforeLocalReplicaPush({
                        rootUri: this.baseUri,
                        localUri: fromUri,
                        relPath,
                        type,
                        content: newContent,
                    });
                    this.requireSyncSession(generation);
                    if (decision?.kind==='block') {
                        outcome = 'blocked';
                        errorMessage = 'blocked by agent review';
                        return;
                    }
                }
                if (action==='push' && !targetAlreadyMissing) {
                    try {
                        await this.withRetry('push', relPath, async () => {
                            await this.vfs.ensureConnectedForWrite();
                            this.requireSyncSession(generation);
                            if (expectedRemoteDeleteRevision===undefined) {
                                throw new ConcurrentReplicaChangeError(
                                    `Missing expected Overleaf revision for ${relPath}`,
                                );
                            }
                            await this.atomicDeleteRemotePathIfRevision(
                                relPath,
                                expectedRemoteDeleteRevision,
                                generation,
                            );
                        }, {
                            delays: LocalReplicaSCMProvider.pushRetryDelays,
                            generation,
                            betweenAttempts: async () => {
                                await this.waitForConnectedOrTimeout(LocalReplicaSCMProvider.pushReconnectWaitMs);
                            },
                        });
                    } catch (error) {
                        if (!(error instanceof ConcurrentReplicaChangeError)) {
                            throw error;
                        }
                        await this.markSyncConflict(
                            relPath,
                            'The Overleaf path changed immediately before the local delete could be applied',
                            null,
                            generation,
                        );
                        outcome = 'blocked';
                        errorMessage = 'concurrent remote change before delete';
                        return;
                    }
                } else if (action==='pull') {
                    const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                    if (
                        expectedLocalDeleteRevision!==undefined
                        && latestLocal.revision!==expectedLocalDeleteRevision
                    ) {
                        await this.markSyncConflict(
                            relPath,
                            'The local path changed immediately before the Overleaf delete could be applied',
                            latestLocal.kind==='file' ? latestLocal.content : undefined,
                            generation,
                        );
                        outcome = 'blocked';
                        errorMessage = 'concurrent local change before delete';
                        return;
                    }
                    const deleted = await this.runSessionIO(
                        generation,
                        () => this.atomicDeleteLocalPathIfRevision(
                            relPath,
                            expectedLocalDeleteRevision!,
                            generation,
                        ),
                    );
                    if (!deleted) {
                        const concurrentLocal = await this.captureLocalPathRevision(relPath, generation);
                        await this.markSyncConflict(
                            relPath,
                            'The local path changed during atomic application of the Overleaf delete',
                            concurrentLocal.kind==='file' ? concurrentLocal.content : undefined,
                            generation,
                        );
                        outcome = 'blocked';
                        errorMessage = 'concurrent local change during atomic delete';
                        return;
                    }
                }
                this.requireSyncSession(generation);
                let localRecreatedDuringPushDelete = false;
                let pendingLocalChangeDuringPushDelete = false;
                if (action==='push') {
                    localRecreatedDuringPushDelete = (
                        await this.captureLocalPathRevision(relPath, generation)
                    ).kind!=='missing';
                    pendingLocalChangeDuringPushDelete = [...this.pendingLocalEvents.keys()]
                        .some(path => directoryDelete
                            ? this.isPathAtOrBelow(path, relPath)
                            : path===relPath
                        );
                }
                this.setBypassCache(relPath, undefined);
                if (action==='pull') {
                    this.rememberRemoteDelete(relPath, previousBaseContent, staleLocalMtime);
                } else {
                    this.clearRemoteDelete(relPath);
                }
                this.clearReplicaState(
                    relPath,
                    directoryDelete,
                    action==='push',
                );
                await this.persistSyncManifest(false, generation);
                this.requireSyncSession(generation);
                if (action==='push') {
                    await getAgentReviewManager()?.afterLocalReplicaPush({
                        rootUri: this.baseUri,
                        localUri: fromUri,
                        relPath,
                        type,
                        content: newContent,
                    });
                    this.requireSyncSession(generation);
                    if (
                        localRecreatedDuringPushDelete
                        || pendingLocalChangeDuringPushDelete
                    ) {
                        this.locallyDivergedPaths.add(relPath);
                        this.queueForcedPush(
                            relPath,
                            'local-change-during-remote-delete',
                            localRecreatedDuringPushDelete ? 'update' : 'delete',
                        );
                    }
                }
            } else {
                // Layer 4b — refuse a push-update for a path whose initial
                // pull failed. The local replica never authoritatively held
                // this file's remote contents, so propagating local bytes
                // would clobber the remote with whatever happens to be on
                // disk (often nothing, or a stale snapshot). The symmetric
                // delete-side check lives above inside the `type==='delete'`
                // branch; this guards the update path so the local watcher
                // can be armed unconditionally without risk.
                if (
                    action==='push'
                    && this.failedInitialPulls.has(relPath)
                    && !options.resolveConflict
                ) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [push update blocked] ${relPath}: initial pull failed; refusing to mutate remote`,
                    );
                    maybeWarnSyncFailure(relPath, new Error(
                        'Remote update blocked: initial pull failed for this file. Use "Retry Pull" before editing.',
                    ));
                    outcome = 'blocked';
                    errorMessage = 'initial pull failed';
                    return;
                }
                const stat = await vscode.workspace.fs.stat(fromUri);
                this.requireSyncSession(generation);
                if (stat.type===vscode.FileType.Directory) {
                    const newContent = new Uint8Array();
                    if (this.bypassSync(action, type, relPath, newContent, options)) {
                        outcome = 'suppressed';
                        return;
                    }
                    if (action==='push') {
                        try {
                            await this.withRetry('push', relPath, async () => {
                                await this.vfs.ensureConnectedForWrite();
                                this.requireSyncSession(generation);
                                await this.runSessionIO(
                                    generation,
                                    () => this.vfs.createDirectoryIfMissing(toUri),
                                );
                            }, {
                                delays: LocalReplicaSCMProvider.pushRetryDelays,
                                generation,
                                betweenAttempts: async () => {
                                    await this.waitForConnectedOrTimeout(
                                        LocalReplicaSCMProvider.pushReconnectWaitMs,
                                    );
                                },
                            });
                        } catch (error) {
                            if (!(error instanceof RemoteDocumentMergeConflictError)) {
                                throw error;
                            }
                            await this.markSyncConflict(
                                relPath,
                                error.message,
                                undefined,
                                generation,
                            );
                            outcome = 'blocked';
                            errorMessage = 'concurrent untracked path type conflict';
                            return;
                        }
                    } else {
                        this.requireSyncSession(generation);
                        await this.runSessionIO(
                            generation,
                            () => vscode.workspace.fs.createDirectory(toUri),
                        );
                    }
                    this.requireSyncSession(generation);
                    if (action==='pull') {
                        authoritativePullCompleted = true;
                    }
                    this.seenLocalEntities.add(relPath);
                    this.clearRemoteDelete(relPath);
                    this.locallyDivergedPaths.delete(relPath);
                    this.recordSyncManifestDirectory(relPath);
                    await this.persistSyncManifest(false, generation);
                }
                else if (stat.type===vscode.FileType.File) {
                    try {
                        // Pull reads go through the retrying helper since
                        // transient binary failures are the trigger for the
                        // whole cascade we are guarding against. Push reads
                        // are local-disk and need no retry.
                        let newContent = action==='pull'
                            ? await this.pullRemoteFile(relPath, fromUri, generation)
                            : await vscode.workspace.fs.readFile(fromUri);
                        this.requireSyncSession(generation);
                        if (action==='pull') {
                            authoritativePullCompleted = true;
                        }
                        let writeMergedContentBackToLocal = false;
                        let remoteBaselineForPush: Uint8Array | undefined;
                        let expectedRemoteMissingForPush = false;
                        let expectedLocalWriteRevision = action==='push'
                            ? contentDigest(newContent)
                            : undefined;
                        if (action==='push') {
                            const tombstone = this.remoteDeleteTombstones.get(relPath);
                            const staleLocalBytes = tombstone!==undefined
                                && tombstone.digest===contentDigest(newContent)
                                && tombstone.staleLocalMtime!==undefined
                                && normalizeMtimeMs(stat.mtime)<=tombstone.staleLocalMtime+REMOTE_DELETE_MTIME_SLOP_MS;
                            if (staleLocalBytes) {
                                getOutputChannel().appendLine(
                                    `${new Date().toISOString()} [push update suppressed:remote-delete-echo] ${relPath}`,
                                );
                                this.setBypassCache(relPath, undefined);
                                try {
                                    this.requireSyncSession(generation);
                                    await this.runSessionIO(
                                        generation,
                                        () => vscode.workspace.fs.delete(fromUri, {recursive:false}),
                                    );
                                } catch {
                                    // The stale local file may already be gone.
                                }
                                outcome = 'suppressed';
                                return;
                            }

                            const baseContent = options.resolveConflict
                                ? undefined
                                : this.baseCache[relPath]
                                    ?? this.manifestBaseContent(this.syncManifest?.files[relPath]);
                            if (baseContent!==undefined) {
                                const remoteContent = await this.pullRemoteFile(relPath, toUri, generation);
                                this.requireSyncSession(generation);
                                remoteBaselineForPush = remoteContent;
                                if (bytesEqual(newContent, remoteContent)) {
                                    // A watcher push can beat the save-triggered compile barrier.
                                    // Treat an exact remote readback as proof of delivery instead of
                                    // issuing a redundant OT update with a potentially stale version.
                                    this.setBypassCache(relPath, newContent, 'pull');
                                    this.baseCache[relPath] = newContent;
                                    this.seenLocalEntities.add(relPath);
                                    this.clearRemoteDelete(relPath);
                                    this.locallyDivergedPaths.delete(relPath);
                                    await this.recordSyncManifestEntry(relPath, toUri, newContent, generation);
                                    await this.persistSyncManifest(false, generation);
                                    this.requireSyncSession(generation);
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [push verified] ${relPath}: remote already matches local`,
                                    );
                                    return;
                                }
                                const localChanged = !bytesEqual(newContent, baseContent);
                                const remoteChanged = !bytesEqual(remoteContent, baseContent);
                                if (!localChanged && remoteChanged) {
                                    const wroteRemoteContent = await this.writeLocalFileIfRevision(
                                        relPath,
                                        remoteContent,
                                        expectedLocalWriteRevision!,
                                        generation,
                                    );
                                    if (!wroteRemoteContent) {
                                        const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                        await this.markSyncConflict(
                                            relPath,
                                            'The local file changed while a newer Overleaf version was being applied',
                                            latestLocal.kind==='file' ? latestLocal.content : undefined,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'concurrent local edit during pull conversion';
                                        return;
                                    }
                                    this.setBypassCache(relPath, remoteContent, 'pull');
                                    this.baseCache[relPath] = remoteContent;
                                    this.seenLocalEntities.add(relPath);
                                    this.locallyDivergedPaths.delete(relPath);
                                    await this.recordSyncManifestEntry(relPath, toUri, remoteContent, generation);
                                    await this.persistSyncManifest(false, generation);
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [push converted-to-pull] ${relPath}: remote changed, local remained at baseline`,
                                    );
                                    return;
                                }
                                if (localChanged && remoteChanged && !bytesEqual(newContent, remoteContent)) {
                                    const mergedContent = this.isLikelyBinaryRelPath(relPath)
                                        ? undefined
                                        : this.mergeTextContents(baseContent, newContent, remoteContent);
                                    if (mergedContent===undefined) {
                                        await this.markSyncConflict(
                                            relPath,
                                            'Local and Overleaf copies were edited concurrently and could not be merged automatically',
                                            newContent,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'concurrent edits conflict';
                                        return;
                                    }
                                    newContent = mergedContent;
                                    writeMergedContentBackToLocal = true;
                                }
                            } else if (!options.resolveConflict) {
                                const remoteState = await this.captureRemotePathRevision(
                                    relPath,
                                    generation,
                                );
                                this.requireSyncSession(generation);
                                if (remoteState.kind==='file') {
                                    if (bytesEqual(newContent, remoteState.content!)) {
                                        this.setBypassCache(relPath, newContent, 'pull');
                                        this.baseCache[relPath] = newContent;
                                        this.seenLocalEntities.add(relPath);
                                        this.clearRemoteDelete(relPath);
                                        this.locallyDivergedPaths.delete(relPath);
                                        await this.recordSyncManifestEntry(
                                            relPath,
                                            toUri,
                                            newContent,
                                            generation,
                                        );
                                        await this.persistSyncManifest(false, generation);
                                        getOutputChannel().appendLine(
                                            `${new Date().toISOString()} [push verified] ${relPath}: ` +
                                            'untracked remote already matches local',
                                        );
                                        return;
                                    }
                                    await this.markSyncConflict(
                                        relPath,
                                        'Local and Overleaf files appeared concurrently without a common baseline',
                                        newContent,
                                        generation,
                                    );
                                    outcome = 'blocked';
                                    errorMessage = 'concurrent untracked local and remote files';
                                    return;
                                }
                                if (remoteState.kind!=='missing') {
                                    await this.markSyncConflict(
                                        relPath,
                                        'Local and Overleaf paths appeared concurrently with different file types',
                                        newContent,
                                        generation,
                                    );
                                    outcome = 'blocked';
                                    errorMessage = 'concurrent untracked path type conflict';
                                    return;
                                }
                                expectedRemoteMissingForPush = true;
                            }
                        }
                        // Content-equality short-circuit for pull. The bypass
                        // cache already suppresses this case via its sha1
                        // digest, but doing the explicit byte compare here
                        // (a) keeps the optimisation honest if the bypass
                        // cache is ever evicted/cleared, (b) lets us avoid
                        // the agentReview hooks entirely when nothing
                        // changed, and (c) emits a forensic [pull noop] log
                        // line that makes "VFS is noisy but content is
                        // stable" diagnosable.
                        let forcePullWrite = false;
                        if (action==='pull') {
                            const existing = this.baseCache[relPath]
                                ?? this.manifestBaseContent(this.syncManifest?.files[relPath]);
                            const localState = await this.captureLocalPathRevision(relPath, generation);
                            expectedLocalWriteRevision = localState.revision;
                            if (localState.kind==='directory' || localState.kind==='other') {
                                await this.markSyncConflict(
                                    relPath,
                                    'Overleaf could not update a local path with a different file type',
                                    undefined,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'local path type conflict';
                                return;
                            }
                            const localContent = localState.content;
                            if (localContent===undefined) {
                                if (existing!==undefined) {
                                    const remoteChanged = !bytesEqual(newContent, existing);
                                    if (remoteChanged) {
                                        await this.markSyncConflict(
                                            relPath,
                                            'The local copy was deleted while the Overleaf copy was also edited',
                                            null,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'concurrent local delete and remote edit';
                                        return;
                                    }
                                    this.locallyDivergedPaths.add(relPath);
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [pull noop:local-deleted] ${relPath} ` +
                                        '(remote unchanged; queued local delete)',
                                    );
                                    this.queueForcedPush(
                                        relPath,
                                        'local-delete-before-pull',
                                        'delete',
                                    );
                                    outcome = 'suppressed';
                                    return;
                                }
                                forcePullWrite = true;
                                getOutputChannel().appendLine(
                                    `${new Date().toISOString()} [pull repair] ${relPath}: untracked local file missing`,
                                );
                            } else if (existing!==undefined) {
                                const localChanged = !bytesEqual(localContent, existing);
                                const remoteChanged = !bytesEqual(newContent, existing);
                                if (!localChanged && !remoteChanged) {
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [pull noop] ${relPath} (${newContent.length} bytes, content unchanged)`,
                                    );
                                    outcome = 'suppressed';
                                    return;
                                }
                                if (localChanged && !remoteChanged) {
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [pull noop:local-diverged] ${relPath} (${newContent.length} bytes, remote unchanged)`,
                                    );
                                    this.locallyDivergedPaths.add(relPath);
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [pull local-diverged queued-push] ${relPath}`,
                                    );
                                    this.queueForcedPush(relPath, 'local-diverged');
                                    outcome = 'suppressed';
                                    return;
                                }
                                if (localChanged && remoteChanged) {
                                    if (bytesEqual(localContent, newContent)) {
                                        this.baseCache[relPath] = newContent;
                                        this.seenLocalEntities.add(relPath);
                                        this.locallyDivergedPaths.delete(relPath);
                                        await this.recordSyncManifestEntry(relPath, fromUri, newContent, generation);
                                        await this.persistSyncManifest(false, generation);
                                        return;
                                    }
                                    let mergedContent = this.isLikelyBinaryRelPath(relPath)
                                        ? undefined
                                        : this.mergeTextContents(existing, localContent, newContent);
                                    if (mergedContent===undefined) {
                                        await this.markSyncConflict(
                                            relPath,
                                            'Local and Overleaf copies were edited concurrently and could not be merged automatically',
                                            localContent,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'concurrent edits conflict';
                                        return;
                                    }

                                    const mergedPushChange = {
                                        rootUri: this.baseUri,
                                        localUri: toUri,
                                        relPath,
                                        type,
                                        content: mergedContent,
                                    };
                                    const decision = await getAgentReviewManager()?.beforeLocalReplicaPush(mergedPushChange);
                                    this.requireSyncSession(generation);
                                    if (decision?.kind==='block') {
                                        outcome = 'blocked';
                                        errorMessage = 'merged update blocked by agent review';
                                        return;
                                    }
                                    try {
                                        mergedContent = await this.pushWithRetry(
                                            relPath,
                                            fromUri,
                                            mergedContent,
                                            generation,
                                            newContent,
                                        );
                                        mergedPushChange.content = mergedContent;
                                    } catch (error) {
                                        if (
                                            !(error instanceof RemoteDocumentMergeConflictError)
                                            && !(error instanceof RemoteDocumentWriteAmbiguousError)
                                        ) {
                                            throw error;
                                        }
                                        await this.markSyncConflict(
                                            relPath,
                                            error.message,
                                            localContent,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'remote changed during merged pull';
                                        return;
                                    }
                                    this.setBypassCache(relPath, mergedContent, 'push');
                                    const wroteMergedContent = await this.writeLocalFileIfRevision(
                                        relPath,
                                        mergedContent,
                                        expectedLocalWriteRevision!,
                                        generation,
                                    );
                                    if (!wroteMergedContent) {
                                        const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                        await this.markSyncConflict(
                                            relPath,
                                            'The local file changed while a merged Overleaf update was being applied',
                                            latestLocal.kind==='file' ? latestLocal.content : undefined,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'concurrent local edit during merged pull';
                                        return;
                                    }
                                    this.setBypassCache(relPath, mergedContent, 'pull');
                                    this.baseCache[relPath] = mergedContent;
                                    this.seenLocalEntities.add(relPath);
                                    this.clearRemoteDelete(relPath);
                                    this.locallyDivergedPaths.delete(relPath);
                                    await this.recordSyncManifestEntry(relPath, fromUri, mergedContent, generation);
                                    await this.persistSyncManifest(false, generation);
                                    await getAgentReviewManager()?.afterLocalReplicaPush(mergedPushChange);
                                    this.requireSyncSession(generation);
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [pull merged] ${relPath}: concurrent non-overlapping edits`,
                                    );
                                    return;
                                }
                            } else if (!bytesEqual(localContent, newContent)) {
                                await this.markSyncConflict(
                                    relPath,
                                    'Local and Overleaf copies differ but no common baseline is available',
                                    localContent,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'missing merge baseline';
                                return;
                            }
                        }
                        if (forcePullWrite) {
                            this.setBypassCache(relPath, newContent, 'pull');
                        } else {
                            if (options.forcePush && action==='push') {
                                getOutputChannel().appendLine(
                                    `${new Date().toISOString()} [push forced:${options.reason ?? 'manual'}] ${relPath}`,
                                );
                            }
                            if (this.bypassSync(action, type, relPath, newContent, options)) {
                                outcome = 'suppressed';
                                return;
                            }
                        }
                        const pushChange = action==='push' ? {
                            rootUri: this.baseUri,
                            localUri: fromUri,
                            relPath,
                            type,
                            content: newContent,
                        } : undefined;
                        if (action==='push') {
                            const decision = await getAgentReviewManager()?.beforeLocalReplicaPush(pushChange!);
                            this.requireSyncSession(generation);
                            if (decision?.kind==='block') {
                                outcome = 'blocked';
                                errorMessage = 'blocked by agent review';
                                return;
                            }
                        }
                        if (action==='push') {
                            // Push with bounded retry so a transient socket blip doesn't
                            // silently lose the accepted edit.
                            try {
                                const pushedContent = await this.pushWithRetry(
                                    relPath,
                                    toUri,
                                    newContent,
                                    generation,
                                    remoteBaselineForPush,
                                    expectedRemoteMissingForPush,
                                );
                                if (!bytesEqual(pushedContent, newContent)) {
                                    newContent = pushedContent;
                                    writeMergedContentBackToLocal = true;
                                    pushChange!.content = newContent;
                                }
                            } catch (error) {
                                if (
                                    !(error instanceof RemoteDocumentMergeConflictError)
                                    && !(error instanceof RemoteDocumentWriteAmbiguousError)
                                ) {
                                    throw error;
                                }
                                await this.markSyncConflict(
                                    relPath,
                                    error.message,
                                    newContent,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'remote changed during rebased push';
                                return;
                            }
                            if (options.forcePush) {
                                this.setBypassCache(relPath, newContent, 'push');
                            }
                            if (writeMergedContentBackToLocal) {
                                const wroteMergedContent = await this.writeLocalFileIfRevision(
                                    relPath,
                                    newContent,
                                    expectedLocalWriteRevision!,
                                    generation,
                                );
                                if (!wroteMergedContent) {
                                    const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                    await this.markSyncConflict(
                                        relPath,
                                        'The local file changed while a merged push was being written back',
                                        latestLocal.kind==='file' ? latestLocal.content : undefined,
                                        generation,
                                    );
                                    outcome = 'blocked';
                                    errorMessage = 'concurrent local edit during merged push';
                                    return;
                                }
                                this.setBypassCache(relPath, newContent, 'pull');
                            }
                        } else {
                            const wroteRemoteContent = await this.writeLocalFileIfRevision(
                                relPath,
                                newContent,
                                expectedLocalWriteRevision!,
                                generation,
                            );
                            if (!wroteRemoteContent) {
                                const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                await this.markSyncConflict(
                                    relPath,
                                    'The local file changed while an Overleaf update was being applied',
                                    latestLocal.kind==='file' ? latestLocal.content : undefined,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'concurrent local edit during pull';
                                return;
                            }
                            this.setBypassCache(relPath, newContent, 'pull');
                        }
                        this.baseCache[relPath] = newContent;
                        this.seenLocalEntities.add(relPath);
                        this.clearRemoteDelete(relPath);
                        this.locallyDivergedPaths.delete(relPath);
                        await this.recordSyncManifestEntry(
                            relPath,
                            action==='push' ? toUri : fromUri,
                            newContent,
                            generation,
                        );
                        await this.persistSyncManifest(false, generation);
                        if (action==='push') {
                            try {
                                await vscode.workspace.fs.readFile(toUri); // update remote cache
                            } catch (cacheError) {
                                getOutputChannel().appendLine(
                                    `${new Date().toISOString()} [push cache refresh skipped] ${relPath}: ${formatUnknownError(cacheError)}`,
                                );
                            }
                        }
                        if (action==='push') {
                            await getAgentReviewManager()?.afterLocalReplicaPush(pushChange!);
                            this.requireSyncSession(generation);
                        }
                    } catch (error) {
                        // Previously this swallowed every error silently, so an accepted
                        // change could land on disk yet never reach Overleaf. Now we
                        // log to the shared output channel and surface one toast per
                        // (file × message) per 60s so the user is never left in the dark.
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [${action} ${type}] ${relPath}: ${formatUnknownError(error)}`,
                        );
                        if (action==='push' && this.isSyncSessionActive(generation)) {
                            this.locallyDivergedPaths.add(relPath);
                            maybeWarnSyncFailure(relPath, error);
                            await getAgentReviewManager()?.afterLocalReplicaPushFailed({
                                rootUri: this.baseUri,
                                localUri: fromUri,
                                relPath,
                                type,
                                content: await Promise.resolve(vscode.workspace.fs.readFile(fromUri)).catch(() => undefined),
                            });
                        }
                        console.error(error);
                        outcome = 'error';
                        errorMessage = formatUnknownError(error);
                    }
                }
                else {
                    console.error(`Unknown file type: ${stat.type}`);
                    outcome = 'error';
                    errorMessage = `unknown file type: ${stat.type}`;
                }
            }
            })();
        } catch (error) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [${action} ${type}] ${relPath}: ${formatUnknownError(error)}`,
            );
            if (action==='push' && this.isSyncSessionActive(generation)) {
                this.locallyDivergedPaths.add(relPath);
                maybeWarnSyncFailure(relPath, error);
                await getAgentReviewManager()?.afterLocalReplicaPushFailed({
                    rootUri: this.baseUri,
                    localUri: fromUri,
                    relPath,
                    type,
                    content: type==='update'
                        ? await Promise.resolve(vscode.workspace.fs.readFile(fromUri)).catch(() => undefined)
                        : undefined,
                });
            }
            console.error(error);
            outcome = 'error';
            errorMessage = formatUnknownError(error);
        }

        if (
            new Set<string>(['success', 'suppressed']).has(outcome)
            && action==='pull'
            && authoritativePullCompleted
            && this.isSyncSessionActive(generation)
        ) {
            try {
                this.clearFailedInitialPullAfterAuthoritativeSync(relPath, generation);
                await this.persistSyncManifest(false, generation);
            } catch (error) {
                outcome = 'error';
                errorMessage = formatUnknownError(error);
            }
        }
        if (outcome==='success' && this.isSyncSessionActive(generation)) {
            try {
                if (
                    action==='push'
                    && options.resolveConflict
                    && !options.deferConflictResolution
                ) {
                    this.clearFailedInitialPullAfterAuthoritativeSync(relPath, generation);
                }
                if (!options.deferConflictResolution) {
                    await this.clearSyncConflictAfterSuccess(relPath, generation);
                }
                await this.persistSyncManifest(false, generation);
            } catch (error) {
                outcome = 'error';
                errorMessage = formatUnknownError(error);
            }
        }
        const operationStillActive = this.isSyncSessionActive(generation);
        if (!operationStillActive) {
            outcome = 'error';
            errorMessage = 'Local Replica sync session is no longer active.';
        } else {
            if (new Set<string>(['error', 'blocked']).has(outcome)) {
                this.restoreBypassCache(relPath, bypassCacheSnapshot);
                if (action==='push') {
                    this.locallyDivergedPaths.add(relPath);
                }
            }
            this.status = this.syncConflicts.size>0
                ? {
                    status: 'need-attention',
                    message: vscode.l10n.t('{count} sync conflicts', {count: this.syncConflicts.size}),
                }
                : {status: 'idle', message: ''};
        }
        const event: Events['scmSyncCompleteEvent'] = {
            rootUri: this.baseUri,
            relPath,
            direction: action,
            type,
            outcome,
            error: errorMessage,
        };
        EventBus.fire('scmSyncCompleteEvent', event);
        return event;
    }

    // Compute the debounce delay for the next firing of a path's pending
    // event. Returns the smaller of EVENT_COALESCE_MS and the remaining
    // budget under EVENT_MAX_WAIT_MS, clamped to 0. Returning 0 means "fire
    // on the next tick" — the queueing through setTimeout(_, 0) is still
    // serialised against further inflight events for the same path because
    // the `pending` map entry is the source of truth.
    private computeDebounceDelay(firstEventAt: number): number {
        const elapsed = Date.now() - firstEventAt;
        const remainingBudget = LocalReplicaSCMProvider.eventMaxWaitMs - elapsed;
        return Math.max(0, Math.min(LocalReplicaSCMProvider.eventCoalesceMs, remainingBudget));
    }

    private syncFromVFS(vfsUri: vscode.Uri, type: 'update'|'delete') {
        if (!this.isSyncSessionActive()) { return; }
        const generation = this.syncGeneration;
        const {pathParts} = parseUri(vfsUri);
        pathParts.at(-1)==='' && pathParts.pop(); // remove the last empty string
        const relPath = this.normalizeConfinedRelPath('/' + pathParts.join('/'), 'sync from Overleaf');
        if (relPath===undefined) { return; }
        // Early ignore-pattern short-circuit. Without this, ignored paths
        // (compile artifacts under /.output/*, .aux, .log, etc.) still flow
        // through enqueueSync + applySync's stat + readFile before the
        // bypassSync check rejects them — wasting socket traffic and adding
        // retry/reconnect pressure during compile cycles.
        if (this.matchIgnorePatterns(relPath)) { return; }

        // Coalesce rapid-fire VFS events for the same path. Overleaf's VFS
        // fires Change events for every compile touch even when bytes are
        // unchanged; without debouncing we readFile the same file 3-4 times
        // per second during a compile cycle.
        const existing = this.pendingVfsEvents.get(relPath);
        if (existing) { clearTimeout(existing.timer); }
        const firstEventAt = existing?.firstEventAt ?? Date.now();
        const delay = this.computeDebounceDelay(firstEventAt);
        const timer = setTimeout(() => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const pending = this.pendingVfsEvents.get(relPath);
            if (!pending) { return; } // disposed or already drained
            this.pendingVfsEvents.delete(relPath);
            const localUri = this.localUri(relPath);
            void this.enqueueSync(
                relPath,
                async () => {
                    let currentType = pending.latestType;
                    try {
                        currentType = await this.remoteTargetEventType(pending.latestUri);
                        this.requireSyncSession(generation);
                    } catch (error) {
                        this.retainRemotePullIntentAfterClassificationFailure(
                            relPath,
                            pending.latestUri,
                            pending.latestType,
                            error,
                            generation,
                        );
                        return undefined;
                    }
                    return this.applySync(
                        'pull',
                        currentType,
                        relPath,
                        pending.latestUri,
                        localUri,
                        {},
                        generation,
                    );
                },
                generation,
            );
        }, delay);
        this.pendingVfsEvents.set(relPath, { timer, firstEventAt, latestType: type, latestUri: vfsUri });
    }

    private async remoteTargetEventType(
        vfsUri: vscode.Uri,
    ): Promise<'update' | 'delete'> {
        try {
            await vscode.workspace.fs.stat(vfsUri);
            return 'update';
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return 'delete';
            }
            throw error;
        }
    }

    private async syncToVFS(localUri: vscode.Uri, type: 'update'|'delete') {
        if (!this.isSyncSessionActive()) { return; }
        const generation = this.syncGeneration;
        if (isLocalReplicaMetadataUri(localUri, this.baseUri)) {
            return;
        }
        if (!await this.hasLocalReplicaSettings()) {
            console.warn(`Local replica settings missing under "${this.baseUri.toString()}"; local change was not propagated.`);
            return;
        }
        if (!this.isSyncSessionActive(generation)) { return; }
        // Compute the path relative to baseUri. Trailing-slash normalisation on
        // baseUri can otherwise drop the leading slash, producing a relPath
        // shape that disagrees with the pull side and defeats the bypass cache.
        const basePath = this.baseUri.path.replace(/\/+$/, '');
        if (localUri.path===basePath || !localUri.path.startsWith(basePath + '/')) { return; }
        const relPath = this.normalizeConfinedRelPath(localUri.path.slice(basePath.length), 'sync to Overleaf');
        if (relPath===undefined) { return; }
        // Same early-ignore short-circuit as syncFromVFS — no point enqueueing
        // work that bypassSync would reject anyway.
        if (this.matchIgnorePatterns(relPath)) { return; }

        // Debounce local watcher events too. Editors save by write-temp+
        // rename which can fire Change+Create+Change for the same file in
        // milliseconds; coalescing means one applySync per intent.
        const existing = this.pendingLocalEvents.get(relPath);
        if (existing) { clearTimeout(existing.timer); }
        const firstEventAt = existing?.firstEventAt ?? Date.now();
        const delay = this.computeDebounceDelay(firstEventAt);
        const timer = setTimeout(() => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const pending = this.pendingLocalEvents.get(relPath);
            if (!pending) { return; }
            this.pendingLocalEvents.delete(relPath);
            const vfsUri = this.vfs.pathToUri(relPath);
            void this.enqueueSync(
                relPath,
                async () => {
                    let currentType: 'update' | 'delete' | undefined;
                    try {
                        currentType = await this.localTargetNeedsPush(
                            relPath,
                            pending.latestUri,
                        );
                        this.requireSyncSession(generation);
                    } catch (error) {
                        this.retainLocalPushIntentAfterClassificationFailure(
                            relPath,
                            pending.latestUri,
                            pending.latestType,
                            error,
                            generation,
                        );
                        return undefined;
                    }
                    if (currentType===undefined) {
                        this.locallyDivergedPaths.delete(relPath);
                        return undefined;
                    }
                    return this.applySync(
                        'push',
                        currentType,
                        relPath,
                        pending.latestUri,
                        vfsUri,
                        {},
                        generation,
                    );
                },
                generation,
            );
        }, delay);
        this.pendingLocalEvents.set(relPath, { timer, firstEventAt, latestType: type, latestUri: localUri });
    }

    public async initializeLocalReplica(
        options?: InitializeLocalReplicaOptions,
        generation?: number,
    ): Promise<boolean> {
        const activeGeneration = generation
            ?? (this.syncSessionActive ? this.syncGeneration : await this.beginSyncSession());
        if (!this.isSyncSessionActive(activeGeneration)) { return false; }
        const initializationOptions = {
            resetLocalFilesToRemote: false,
            ...definedInitializationOptions(this.initializationOptions),
            ...definedInitializationOptions(options),
        };
        await this.ensureLocalReplicaSettings(activeGeneration);
        if (!this.isSyncSessionActive(activeGeneration)) { return false; }
        await this.loadSyncManifest(activeGeneration);
        if (!this.isSyncSessionActive(activeGeneration)) { return false; }
        this.initialPullStatus = 'pending';
        // Per-file failures accumulate in failedInitialPulls; reset before each
        // attempt so a fresh init starts from a clean slate.
        this.failedInitialPulls.clear();
        try {
            await this.recoverInterruptedLocalOperations(activeGeneration);
            if (!this.isSyncSessionActive(activeGeneration)) { return false; }
            await this.recoverInterruptedRemoteDeletes(activeGeneration);
            const completed = await this.overwrite('/', initializationOptions, activeGeneration);
            if (completed!==true || !this.isSyncSessionActive(activeGeneration)) { return false; }
        } catch (error) {
            if (!this.isSyncSessionActive(activeGeneration)) { return false; }
            this.initialPullStatus = 'partial';
            this.status = {
                status: 'need-attention',
                message: vscode.l10n.t('initial pull failed'),
            };
            const message = formatUnknownError(error);
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [initial pull failed] ${message}`,
            );
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    'Local Replica is attached, but the initial remote pull failed: {message}',
                    {message},
                ),
                vscode.l10n.t('Show Output'),
            ).then((choice) => {
                if (choice==='Show Output') { getOutputChannel().show(true); }
            });
            await this.persistSyncManifest(false, activeGeneration);
            return false;
        }
        if (!this.isSyncSessionActive(activeGeneration)) { return false; }
        if (this.failedInitialPulls.size>0) {
            this.initialPullStatus = 'partial';
            this.syncManifestBaselineMode = 'unavailable';
            if (this.syncManifest?.baselineComplete) {
                this.syncManifest.baselineComplete = false;
                this.markSyncManifestDirty();
            }
            this.status = {
                status: 'need-attention',
                message: vscode.l10n.t('{count} files failed to download', {count: this.failedInitialPulls.size}),
            };
            this.surfacePartialPullToast(activeGeneration);
        } else {
            this.initialPullStatus = 'complete';
            this.partialPullToastGeneration = undefined;
        }
        this.completeUnavailableBaselineIfResolved();
        await this.persistSyncManifest(false, activeGeneration);
        if (this.isSyncSessionActive(activeGeneration)) {
            await this.refreshCleanOpenReplicaDocumentsFromDisk(activeGeneration);
        }
        return this.isSyncSessionActive(activeGeneration);
    }

    private surfacePartialPullToast(generation = this.syncGeneration) {
        if (
            !this.isSyncSessionActive(generation)
            || this.partialPullToastGeneration===generation
        ) {
            return;
        }
        this.partialPullToastGeneration = generation;
        const count = this.failedInitialPulls.size;
        const retry = vscode.l10n.t('Retry Pull');
        const ignore = vscode.l10n.t('Ignore These Files');
        const showOutput = vscode.l10n.t('Show Output');
        vscode.window.showWarningMessage(
            vscode.l10n.t(
                '{count} files failed to download from Overleaf. Edits to those specific files will not push to remote until you Retry Pull or Ignore them; the rest of the project syncs normally.',
                {count},
            ),
            retry, ignore, showOutput,
        ).then(async (choice) => {
            if (
                !this.isSyncSessionActive(generation)
                || this.partialPullToastGeneration!==generation
            ) {
                return;
            }
            if (choice===retry) {
                this.partialPullToastGeneration = undefined;
                await this.retryFailedInitialPulls();
            } else if (choice===ignore) {
                void this.ignoreFailedInitialPulls(generation);
            } else if (choice===showOutput) {
                this.partialPullToastGeneration = undefined;
                getOutputChannel().show(true);
            } else {
                this.partialPullToastGeneration = undefined;
            }
        });
    }

    public async retryFailedInitialPulls(): Promise<{recovered: string[]; stillFailed: string[]}> {
        const generation = this.syncGeneration;
        if (!this.isSyncSessionActive(generation)) {
            return {recovered: [], stillFailed: [...this.failedInitialPulls]};
        }
        const recovered: string[] = [];
        const stillFailed: string[] = [];
        const targets = [...this.failedInitialPulls];
        for (const relPath of targets) {
            if (!this.isSyncSessionActive(generation)) {
                stillFailed.push(...targets.slice(targets.indexOf(relPath)));
                break;
            }
            const vfsUri = this.vfs.pathToUri(relPath);
            try {
                let type: 'update' | 'delete' = 'update';
                try {
                    await vscode.workspace.fs.stat(vfsUri);
                } catch (error) {
                    if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                        throw error;
                    }
                    type = 'delete';
                }
                this.requireSyncSession(generation);
                const event = await this.enqueueSync(
                    relPath,
                    () => this.applySync(
                        'pull',
                        type,
                        relPath,
                        vfsUri,
                        this.localUri(relPath),
                        {},
                        generation,
                    ),
                    generation,
                );
                this.requireSyncSession(generation);
                if (
                    event
                    && (event.outcome==='success' || event.outcome==='suppressed')
                    && !this.failedInitialPulls.has(relPath)
                ) {
                    recovered.push(relPath);
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [pull recovered] ${relPath} via retryFailedInitialPulls`,
                    );
                } else {
                    stillFailed.push(relPath);
                }
            } catch (error) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [pull retry failed] ${relPath}: ${formatUnknownError(error)}`,
                );
                stillFailed.push(relPath);
            }
        }
        if (!this.isSyncSessionActive(generation)) {
            return {recovered, stillFailed};
        }
        if (this.failedInitialPulls.size===0) {
            this.initialPullStatus = 'complete';
            this.status = {status: 'idle', message: ''};
            this.partialPullToastGeneration = undefined;
            // Initial pull is now complete — arm the local watcher if it was
            // deferred. This is the unique recovery edge that flips us from
            // 'partial' to 'complete' at runtime.
            this.armLocalWatcher?.();
        } else {
            this.status = {
                status: 'need-attention',
                message: vscode.l10n.t('{count} files failed to download', {count: this.failedInitialPulls.size}),
            };
        }
        await this.persistSyncManifest(false, generation);
        this.requireSyncSession(generation);
        return {recovered, stillFailed};
    }

    public async ignoreFailedInitialPulls(
        generation = this.syncGeneration,
    ): Promise<void> {
        if (!this.isSyncSessionActive(generation) || this.failedInitialPulls.size===0) { return; }
        const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || [...this.ignorePatterns]).slice();
        for (const relPath of this.failedInitialPulls) {
            // Exact path patterns; minimatch with dot:true treats these as literal.
            if (!ignorePatterns.includes(relPath)) { ignorePatterns.push(relPath); }
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [failed pull ignored] ${relPath}`,
            );
        }
        this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
        this.failedInitialPulls.clear();
        this.initialPullStatus = 'complete';
        this.status = {status: 'idle', message: ''};
        this.partialPullToastGeneration = undefined;
        this.completeUnavailableBaselineIfResolved();
        await this.persistSyncManifest(false, generation);
        // User opted in: the failed paths are now ignored, so it is safe to
        // arm the local watcher for the rest of the project.
        this.armLocalWatcher?.();
    }

    private async replayBufferedVfsEvents(
        events: Iterable<{uri: vscode.Uri; type: 'update' | 'delete'}>,
        generation: number,
    ): Promise<void> {
        const targets: Array<{
            relPath: string;
            uri: vscode.Uri;
            type: 'update' | 'delete';
        }> = [];
        for (const event of events) {
            const {pathParts} = parseUri(event.uri);
            if (pathParts.at(-1)==='') { pathParts.pop(); }
            const relPath = this.normalizeConfinedRelPath(
                '/' + pathParts.join('/'),
                'replay buffered Overleaf watcher event',
            );
            if (relPath===undefined || this.matchIgnorePatterns(relPath)) { continue; }
            let type: 'update' | 'delete' = event.type;
            try {
                await vscode.workspace.fs.stat(event.uri);
                type = 'update';
            } catch (error) {
                if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                    throw error;
                }
                type = 'delete';
            }
            this.requireSyncSession(generation);
            targets.push({relPath, uri: event.uri, type});
        }
        targets.sort((left, right) => {
            if (left.type!==right.type) {
                return left.type==='update' ? -1 : 1;
            }
            const depthDelta = left.relPath.split('/').length-right.relPath.split('/').length;
            return left.type==='update' ? depthDelta : -depthDelta;
        });
        for (const target of targets) {
            await this.enqueueSync(
                target.relPath,
                () => this.applySync(
                    'pull',
                    target.type,
                    target.relPath,
                    target.uri,
                    this.localUri(target.relPath),
                    {},
                    generation,
                ),
                generation,
            );
            this.requireSyncSession(generation);
        }
    }

    private async replayBufferedLocalEvents(
        events: Iterable<{uri: vscode.Uri; type: 'update' | 'delete'}>,
        generation: number,
    ): Promise<number> {
        const targets: Array<{
            relPath: string;
            uri: vscode.Uri;
            type: 'update' | 'delete';
        }> = [];
        for (const event of events) {
            const relPath = this.relPathFromLocalFileUri(
                event.uri,
                'replay buffered local watcher event',
            );
            if (relPath===undefined || this.matchIgnorePatterns(relPath)) { continue; }
            const type = await this.localTargetNeedsPush(relPath, event.uri);
            this.requireSyncSession(generation);
            if (type!==undefined) {
                targets.push({relPath, uri: event.uri, type});
            }
        }
        targets.sort((left, right) => {
            if (left.type!==right.type) {
                return left.type==='update' ? -1 : 1;
            }
            const depthDelta = left.relPath.split('/').length-right.relPath.split('/').length;
            return left.type==='update' ? depthDelta : -depthDelta;
        });
        for (const target of targets) {
            await this.enqueueSync(
                target.relPath,
                () => this.applySync(
                    'push',
                    target.type,
                    target.relPath,
                    target.uri,
                    this.vfs.pathToUri(target.relPath),
                    {},
                    generation,
                ),
                generation,
            );
            this.requireSyncSession(generation);
        }
        return targets.length;
    }

    private observeLocalWatcherProbe(uri: vscode.Uri): boolean {
        const probe = this.localWatcherProbe;
        if (!probe || probe.uri!==uri.toString()) {
            return false;
        }
        probe.resolve();
        return true;
    }

    private async scanLocalChangesWithoutWatcher(generation: number): Promise<number> {
        this.requireSyncSession(generation);
        const snapshot = await this.collectLocalReplicaSnapshot(
            this.baseUri,
            '/',
            {files: new Set(), directories: new Set()},
            generation,
        );
        this.requireSyncSession(generation);

        const candidates = new Map<string, {uri: vscode.Uri; type: 'update' | 'delete'}>();
        for (const relPath of [...snapshot.directories, ...snapshot.files]) {
            candidates.set(relPath, {
                uri: this.localUri(relPath),
                type: 'update',
            });
        }
        const trackedPaths = new Set([
            ...Object.keys(this.baseCache),
            ...Object.keys(this.syncManifest?.files ?? {}),
            ...Object.keys(this.syncManifest?.directories ?? {}),
            ...this.seenLocalEntities,
            ...this.locallyDivergedPaths,
        ]);
        for (const relPath of trackedPaths) {
            if (
                relPath==='/'
                || snapshot.files.has(relPath)
                || snapshot.directories.has(relPath)
                || this.matchIgnorePatterns(relPath)
                || this.matchIgnorePatterns(`${relPath}/`)
            ) {
                continue;
            }
            candidates.set(relPath, {
                uri: this.localUri(relPath),
                type: 'delete',
            });
        }

        return this.replayBufferedLocalEvents(candidates.values(), generation);
    }

    private stopLocalWatcherFallback(generation: number): void {
        if (this.fallbackScanGeneration!==generation) { return; }
        this.fallbackScanGeneration = undefined;
        if (this.fallbackScanTimer) {
            clearTimeout(this.fallbackScanTimer);
            this.fallbackScanTimer = undefined;
        }
    }

    private markLocalWatcherHealthy(generation: number): void {
        if (!this.isSyncSessionActive(generation)) { return; }
        const previous = this.localWatcherHealthState;
        this.localWatcherHealthState = 'healthy';
        this.stopLocalWatcherFallback(generation);
        if (previous!==this.localWatcherHealthState) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [local watcher ${previous==='degraded' ? 'recovered' : 'healthy'}] ` +
                `${this.baseUri.toString()}`,
            );
        }
    }

    private markLocalWatcherDegraded(generation: number): void {
        if (
            !this.isSyncSessionActive(generation)
            || this.localWatcherHealthState==='degraded'
        ) {
            return;
        }
        this.localWatcherHealthState = 'degraded';
        this.startLocalWatcherFallback(generation);
    }

    private startLocalWatcherFallback(generation: number): void {
        if (
            !this.isSyncSessionActive(generation)
            || this.fallbackScanGeneration===generation
        ) {
            return;
        }
        this.fallbackScanGeneration = generation;
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [local watcher degraded] ${this.baseUri.toString()} ` +
            `using ${LocalReplicaSCMProvider.fallbackScanIntervalMs}ms content scans`,
        );
        if (!this.localWatcherWarningShown) {
            this.localWatcherWarningShown = true;
            void vscode.window.showWarningMessage(vscode.l10n.t(
                'Local Replica file watching is unavailable. Closed-file changes will use a periodic content scan.',
            ));
        }

        const schedule = (delay: number) => {
            if (
                !this.isSyncSessionActive(generation)
                || this.fallbackScanGeneration!==generation
            ) {
                return;
            }
            this.fallbackScanTimer = setTimeout(() => {
                this.fallbackScanTimer = undefined;
                if (
                    !this.isSyncSessionActive(generation)
                    || this.fallbackScanGeneration!==generation
                ) {
                    return;
                }
                if (this.fallbackScanRunningGeneration===generation) {
                    schedule(LocalReplicaSCMProvider.fallbackScanIntervalMs);
                    return;
                }
                this.fallbackScanRunningGeneration = generation;
                void this.scanLocalChangesWithoutWatcher(generation)
                    .then(changedCount => {
                        if (changedCount>0 && this.isSyncSessionActive(generation)) {
                            getOutputChannel().appendLine(
                                `${new Date().toISOString()} [fallback scan synced] ` +
                                `${changedCount} local path(s)`,
                            );
                        }
                    })
                    .catch(error => {
                        if (this.isSyncSessionActive(generation)) {
                            getOutputChannel().appendLine(
                                `${new Date().toISOString()} [fallback scan failed] ` +
                                `${formatUnknownError(error)}`,
                            );
                        }
                    })
                    .finally(() => {
                        if (this.fallbackScanRunningGeneration===generation) {
                            this.fallbackScanRunningGeneration = undefined;
                        }
                        if (this.fallbackScanGeneration===generation) {
                            schedule(LocalReplicaSCMProvider.fallbackScanIntervalMs);
                        }
                    });
            }, delay);
        };
        schedule(0);
    }

    private async verifyLocalWatcherHealth(generation: number): Promise<boolean> {
        this.requireSyncSession(generation);
        const probeUri = vscode.Uri.joinPath(
            this.baseUri,
            REPLICA_SETTINGS_DIR,
            `watcher-probe-${generation}-${crypto.randomBytes(6).toString('hex')}.tmp`,
        );
        let observed = false;
        let resolveObserved!: () => void;
        const observedPromise = new Promise<void>(resolve => {
            resolveObserved = resolve;
        });
        const probe = {
            generation,
            uri: probeUri.toString(),
            timeout: undefined as ReturnType<typeof setTimeout> | undefined,
            resolve: () => {
                observed = true;
                resolveObserved();
            },
        };
        this.localWatcherProbe = probe;

        try {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.baseUri, REPLICA_SETTINGS_DIR));
            this.requireSyncSession(generation);
            await vscode.workspace.fs.writeFile(
                probeUri,
                new TextEncoder().encode(`${Date.now()}\n`),
            );
            this.requireSyncSession(generation);
            await Promise.race([
                observedPromise,
                new Promise<void>(resolve => {
                    probe.timeout = setTimeout(
                        resolve,
                        LocalReplicaSCMProvider.watcherProbeTimeoutMs,
                    );
                }),
            ]);
        } catch (error) {
            if (this.isSyncSessionActive(generation)) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local watcher probe failed] ${formatUnknownError(error)}`,
                );
            }
        } finally {
            if (probe.timeout) {
                clearTimeout(probe.timeout);
                probe.timeout = undefined;
            }
            try {
                await vscode.workspace.fs.delete(probeUri, {recursive: false});
            } catch {
                // The probe may have failed before creation or already be gone.
            }
            if (this.localWatcherProbe===probe) {
                this.localWatcherProbe = undefined;
            }
        }

        return this.isSyncSessionActive(generation) && observed;
    }

    private scheduleLocalWatcherHealthCheck(generation: number, delay = 0): void {
        if (!this.isSyncSessionActive(generation)) { return; }
        if (this.localWatcherHealthTimer) {
            clearTimeout(this.localWatcherHealthTimer);
        }
        this.localWatcherHealthTimer = setTimeout(() => {
            this.localWatcherHealthTimer = undefined;
            if (!this.isSyncSessionActive(generation)) { return; }
            void this.runSessionIO(
                generation,
                () => this.verifyLocalWatcherHealth(generation),
            )
                .then(observed => {
                    if (!this.isSyncSessionActive(generation)) { return; }
                    if (observed) {
                        this.markLocalWatcherHealthy(generation);
                    } else {
                        this.markLocalWatcherDegraded(generation);
                    }
                })
                .catch(error => {
                    if (!this.isSyncSessionActive(generation)) { return; }
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [local watcher health check failed] ` +
                        `${formatUnknownError(error)}`,
                    );
                    this.markLocalWatcherDegraded(generation);
                })
                .finally(() => {
                    if (this.isSyncSessionActive(generation)) {
                        this.scheduleLocalWatcherHealthCheck(
                            generation,
                            LocalReplicaSCMProvider.watcherHealthIntervalMs,
                        );
                    }
                });
        }, delay);
    }

    private async initWatch(): Promise<vscode.Disposable[]> {
        const generation = await this.beginSyncSession();
        let bufferingStartupEvents = true;
        const bufferedVfsEvents = new Map<string, {uri: vscode.Uri; type: 'update' | 'delete'}>();
        const bufferedLocalEvents = new Map<string, {uri: vscode.Uri; type: 'update' | 'delete'}>();
        const bufferOrRun = (
            direction: 'pull' | 'push',
            uri: vscode.Uri,
            type: 'update' | 'delete',
        ) => {
            if (direction==='push' && this.observeLocalWatcherProbe(uri)) {
                return;
            }
            if (direction==='push') {
                this.markLocalWatcherHealthy(generation);
                if (!this.localWatcherProbe) {
                    this.scheduleLocalWatcherHealthCheck(
                        generation,
                        LocalReplicaSCMProvider.watcherHealthIntervalMs,
                    );
                }
            }
            if (bufferingStartupEvents) {
                const target = direction==='pull' ? bufferedVfsEvents : bufferedLocalEvents;
                target.set(uri.toString(), {uri, type});
                return;
            }
            if (direction==='pull') {
                this.syncFromVFS(uri, type);
            } else {
                void this.syncToVFS(uri, type);
            }
        };

        // Register both watchers before the initial reconciliation. Events
        // emitted by agent writes, remote collaborators, or our own pull are
        // buffered until the manifest and merge baselines are ready, then
        // replayed through the normal guarded sync path.
        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.vfs.origin, '**/*'),
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.baseUri.fsPath, '**/*'),
        );
        const disposables: vscode.Disposable[] = [
            this.vfsWatcher.onDidChange(uri => bufferOrRun('pull', uri, 'update')),
            this.vfsWatcher.onDidCreate(uri => bufferOrRun('pull', uri, 'update')),
            this.vfsWatcher.onDidDelete(uri => bufferOrRun('pull', uri, 'delete')),
        ];
        this.dynamicLocalDisposables.push(
            this.localWatcher,
            this.localWatcher.onDidChange(uri => bufferOrRun('push', uri, 'update')),
            this.localWatcher.onDidCreate(uri => bufferOrRun('push', uri, 'update')),
            this.localWatcher.onDidDelete(uri => bufferOrRun('push', uri, 'delete')),
        );
        this.armLocalWatcher = () => undefined;

        let initialized: boolean;
        try {
            initialized = await this.initializeLocalReplica(undefined, generation);
        } catch (error) {
            this.deactivateSyncSession(generation);
            throw error;
        }
        if (!this.isSyncSessionActive(generation)) { return []; }
        if (!initialized) {
            this.deactivateSyncSession(generation);
            throw new Error('Local Replica initial pull did not complete; buffered sync watchers were stopped.');
        }

        bufferingStartupEvents = false;
        await this.replayBufferedVfsEvents(bufferedVfsEvents.values(), generation);
        await this.replayBufferedLocalEvents(bufferedLocalEvents.values(), generation);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [sync watchers live] ` +
            `replayedRemote=${bufferedVfsEvents.size} replayedLocal=${bufferedLocalEvents.size} ` +
            `initialPullStatus=${this.initialPullStatus}`,
        );
        bufferedVfsEvents.clear();
        bufferedLocalEvents.clear();

        // Recheck restored clean editor models after watcher replay. Dirty
        // buffers remain untouched.
        await this.refreshCleanOpenReplicaDocumentsFromDisk(generation);
        this.requireSyncSession(generation);
        if (this.initialPullStatus!=='complete') {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [partial pull active] ${this.failedInitialPulls.size} files pending; ` +
                `their local edits will be rejected by Layer 4/4b until retry/ignore. Other files push normally.`,
            );
        }

        // Keep probing asynchronously so startup and edits never wait for
        // watcher diagnostics. A failed probe enables exact-content scans;
        // a later successful probe stops them, and continued probes detect a
        // watcher that dies after startup.
        this.scheduleLocalWatcherHealthCheck(generation);

        // Auto-recover on reconnect: a transient socket drop that left files
        // in failedInitialPulls is the typical case, and the connection is now
        // available again. Try once per (re)connect.
        const connSub = this.vfs.onDidChangeConnection(state => {
            if (
                this.isSyncSessionActive(generation)
                && state==='connected'
                && this.failedInitialPulls.size>0
            ) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [pull retry on reconnect] ${this.failedInitialPulls.size} files`,
                );
                void this.retryFailedInitialPulls();
            }
        });
        disposables.push(connSub);

        // Dispose-sentinel for the dynamic list so trigger teardown cleans up.
        // Also drops any pending debounce timers — without this a fire-after-
        // dispose would call applySync against a torn-down SCM. The map
        // .get() check inside the timer callback handles in-flight timers
        // that fire between clearTimeout and our Map.clear() (the entry is
        // gone, so the callback bails).
        disposables.push({
            dispose: () => {
                this.deactivateSyncSession(generation);
            },
        });

        return disposables;
    }

    private localUri(relPath: string): vscode.Uri {
        const confinedRelPath = this.requireConfinedRelPath(relPath, 'local URI resolution');
        return vscode.Uri.joinPath(this.baseUri, ...confinedRelPath.replace(/^\/+/, '').split('/'));
    }

    private async withFileSystemContext<T>(
        operation: string,
        uri: vscode.Uri,
        task: () => Thenable<T> | Promise<T>,
    ): Promise<T> {
        try {
            return await task();
        } catch (error) {
            throw new Error(`${operation} failed for ${uri.toString()}: ${formatUnknownError(error)}`);
        }
    }

    private async ensureParentDirectory(
        relPath: string,
        generation = this.syncGeneration,
    ) {
        this.requireSyncSession(generation);
        const confinedRelPath = this.requireConfinedRelPath(relPath, 'create local parent directory');
        const pathParts = confinedRelPath.replace(/^\/+/, '').split('/');
        if (pathParts.length<=1) { return; }
        const parentUri = vscode.Uri.joinPath(this.baseUri, ...pathParts.slice(0, -1));
        await this.withFileSystemContext(
            'Create local parent directory',
            parentUri,
            () => this.runSessionIO(
                generation,
                () => vscode.workspace.fs.createDirectory(parentUri),
            ),
        );
    }

    async writeFile(
        relPath: string,
        content: Uint8Array,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        await this.ensureParentDirectory(relPath, generation);
        this.requireSyncSession(generation);
        const uri = this.localUri(relPath);
        await this.withFileSystemContext(
            'Write local file',
            uri,
            () => this.runSessionIO(
                generation,
                () => vscode.workspace.fs.writeFile(uri, content),
            ),
        );
        this.requireSyncSession(generation);
    }

    readFile(relPath: string): Thenable<Uint8Array|undefined> {
        let uri: vscode.Uri;
        try {
            uri = this.localUri(relPath);
        } catch {
            return Promise.resolve(undefined);
        }
        return new Promise(async (resolve, reject) => {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                resolve(content);
            } catch (error) {
                resolve(undefined);
            }
        });
    }

    get triggers(): Promise<vscode.Disposable[]> {
        return this.initWatch().then((watches) => {
            if (this.vfsWatcher===undefined) {
                // initWatch should always create the vfsWatcher; if not, bail.
                return [];
            }
            return [this.vfsWatcher, ...watches];
        });
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = nodePath.sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., local parent folder');
        inputBox.value = os.homedir()+sep;

        let lookupTimer: ReturnType<typeof setTimeout> | undefined;
        let lookupRequest = 0;
        const stripTrailingSeparator = (value: string) => {
            const normalized = value.replace(/[\\/]+$/, '');
            return normalized==='' ? value : normalized;
        };
        const getDirectoryRequest = (value: string) => {
            const trimmed = value.trim();
            if (trimmed==='') {
                return undefined;
            }
            const browsingDirectory = /[\\/]$/.test(trimmed);
            const directory = browsingDirectory
                ? stripTrailingSeparator(trimmed)
                : nodePath.dirname(trimmed);
            const prefix = browsingDirectory ? '' : nodePath.basename(trimmed);
            return {
                directory: directory==='' ? sep : directory,
                prefix,
            };
        };
        const readDirectoryWithTimeout = async (uri: vscode.Uri) => {
            return Promise.race([
                vscode.workspace.fs.readDirectory(uri),
                new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 3000)),
            ]);
        };

        // enable auto-complete
        inputBox.onDidChangeValue(value => {
            if (lookupTimer) {
                clearTimeout(lookupTimer);
                lookupTimer = undefined;
            }
            const request = getDirectoryRequest(value);
            const currentRequest = ++lookupRequest;
            inputBox.activeItems = [];
            if (!request) {
                inputBox.items = [];
                inputBox.busy = false;
                return;
            }
            inputBox.busy = true;
            lookupTimer = setTimeout(async () => {
                try {
                    const items = await readDirectoryWithTimeout(vscode.Uri.file(request.directory));
                    if (currentRequest!==lookupRequest) { return; }
                    if (!items) {
                        inputBox.items = [];
                        return;
                    }
                    const prefixLower = request.prefix.toLowerCase();
                    const subDirs = items
                        .filter(([name, type]) => type===vscode.FileType.Directory && name.toLowerCase().startsWith(prefixLower))
                        .slice(0, 200);
                    const candidates = subDirs.map(([name]) => ({label:name, alwaysShow:true, picked:false}));
                    if (request.directory!==nodePath.dirname(request.directory)) {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                } catch {
                    if (currentRequest===lookupRequest) {
                        inputBox.items = [];
                    }
                } finally {
                    if (currentRequest===lookupRequest) {
                        inputBox.busy = false;
                    }
                }
            }, 150);
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const request = getDirectoryRequest(inputBox.value);
                if (!request) { return; }
                const nextPath = selected.label==='..'
                    ? nodePath.dirname(stripTrailingSeparator(request.directory))
                    : nodePath.join(request.directory, selected.label);
                inputBox.value = nextPath.endsWith(sep) ? nextPath : `${nextPath}${sep}`;
            }
        });
        inputBox.onDidHide(() => {
            if (lookupTimer) {
                clearTimeout(lookupTimer);
                lookupTimer = undefined;
            }
            lookupRequest++;
            inputBox.busy = false;
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
