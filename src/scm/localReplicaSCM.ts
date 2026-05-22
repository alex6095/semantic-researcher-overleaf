import * as crypto from 'crypto';
import * as nodeFs from 'fs/promises';
import * as os from 'os';
import * as nodePath from 'path';
import * as vscode from 'vscode';
import * as DiffMatchPatch from 'diff-match-patch';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
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
import { EventBus } from '../utils/eventBus';
import { formatUnknownError } from '../utils/errorMessage';
import { PROTECTED_LOCAL_REPLICA_IGNORE_PATTERNS, getAgentReviewManager } from '../agentReview';

const IGNORE_SETTING_KEY = 'ignore-patterns';
const ECHO_WINDOW_MS = 500;
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

type FileCache = {date:number, hash:string};

const DELETE_DIGEST = '\0';

interface SyncManifestEntry {
    remoteFingerprint: string;
    localSize: number;
    localMtime: number;
    localDigest: string;
    updatedAt: string;
}

interface SyncManifest {
    version: 1;
    projectUri: string;
    files: Record<string, SyncManifestEntry>;
}

interface PendingEvent {
    timer: ReturnType<typeof setTimeout>;
    firstEventAt: number;
    latestType: 'update' | 'delete';
    latestUri: vscode.Uri;
}

interface InitializeLocalReplicaOptions {
    preserveExistingLocalFiles?: boolean;
    resetLocalFilesToRemote?: boolean;
}

interface ValidateExactBaseUriOptions {
    beforeEmpty?: (baseUri: vscode.Uri) => void | Promise<void>;
    projectUri?: vscode.Uri;
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
    private syncManifestDirty = false;
    // Files we have written locally at least once. A push-delete arriving for a
    // relPath that isn't in here AND isn't in baseCache is treated as an echo,
    // not a user-driven delete, and is refused in the delete-guard layer.
    private seenLocalEntities: Set<string> = new Set();
    // Files whose initial pull failed even after Layer 1 retries. These are
    // present on the remote but never landed locally, so a watcher event for
    // them must NEVER propagate to the remote. Cleared by retryFailedInitialPulls
    // or by ignoreFailedInitialPulls.
    private failedInitialPulls: Set<string> = new Set();
    private initialPullStatus: 'pending' | 'complete' | 'partial' = 'pending';
    private partialPullToastShown = false;
    private syncQueues: Map<string, Promise<void>> = new Map();
    private localReplicaSettings?: {
        uri: string,
        serverName: string,
        enableCompileNPreview: boolean,
        projectName: string,
    };
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
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
    private static readonly eventCoalesceMs = 250;
    private static readonly eventMaxWaitMs = 2000;
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
        } catch {
            return false;
        }
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
        const existingProjectUri = stringifyOverleafUri(vscode.Uri.parse(settings.uri));
        const targetProjectUri = stringifyOverleafUri(expectedProjectUri);
        return existingProjectUri===targetProjectUri ? 'same-project' : 'different-project';
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

    private async backupLegacySettings() {
        if (!await LocalReplicaSCMProvider.pathExists(this.legacySettingsUri)) {
            return;
        }
        try {
            await vscode.workspace.fs.rename(
                this.legacySettingsUri,
                vscode.Uri.joinPath(this.baseUri, LEGACY_REPLICA_SETTINGS_BACKUP_FILE),
                {overwrite: false},
            );
        } catch {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            try {
                await vscode.workspace.fs.rename(
                    this.legacySettingsUri,
                    vscode.Uri.joinPath(this.baseUri, LEGACY_REPLICA_SETTINGS_DIR, `settings.${timestamp}.overleaf-workshop.json`),
                    {overwrite: false},
                );
            } catch (error) {
                console.warn(`Could not back up legacy local replica settings under ${this.baseUri.toString()}:`, error);
            }
        }
    }

    private async ensureLocalReplicaSettings() {
        const canonicalSettings = {
            'uri': stringifyOverleafUri(this.vfs.origin),
            'serverName': this.vfs.serverName,
            'enableCompileNPreview': true,
            'projectName': this.vfs.projectName,
        };
        let shouldPersist = false;
        try {
            const content = await vscode.workspace.fs.readFile(this.settingsUri);
            const storedSettings = JSON.parse(new TextDecoder().decode(content));
            const {enableAgentReview: _legacyEnableAgentReview, ...storedWithoutLegacyAgentReview} = storedSettings;
            this.localReplicaSettings = {
                ...canonicalSettings,
            };
            shouldPersist = JSON.stringify(storedWithoutLegacyAgentReview)!==JSON.stringify(this.localReplicaSettings);
        } catch (error) {
            this.localReplicaSettings = canonicalSettings;
            shouldPersist = true;
        }
        if (shouldPersist) {
            await this.persistLocalReplicaSettings();
        }
        await this.backupLegacySettings();
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

    private async persistLocalReplicaSettings() {
        if (this.localReplicaSettings===undefined) { return; }
        await vscode.workspace.fs.createDirectory(this.settingsDirectoryUri);
        await vscode.workspace.fs.writeFile(
            this.settingsUri,
            Buffer.from(JSON.stringify(this.localReplicaSettings, null, 4)),
        );
    }

    private emptySyncManifest(): SyncManifest {
        return {
            version: 1,
            projectUri: stringifyOverleafUri(this.vfs.origin),
            files: {},
        };
    }

    private async loadSyncManifest() {
        const projectUri = stringifyOverleafUri(this.vfs.origin);
        try {
            const content = await vscode.workspace.fs.readFile(this.syncManifestUri);
            const manifest = JSON.parse(new TextDecoder().decode(content)) as SyncManifest;
            if (manifest.version===1 && manifest.projectUri===projectUri && manifest.files) {
                this.syncManifest = manifest;
                this.syncManifestDirty = false;
                return;
            }
        } catch {
            // Missing or invalid manifests are rebuilt opportunistically.
        }
        this.syncManifest = this.emptySyncManifest();
        this.syncManifestDirty = true;
    }

    private async persistSyncManifest(force = false) {
        if (!this.syncManifest || (!force && !this.syncManifestDirty)) { return; }
        await vscode.workspace.fs.createDirectory(this.settingsDirectoryUri);
        await vscode.workspace.fs.writeFile(
            this.syncManifestUri,
            Buffer.from(JSON.stringify(this.syncManifest, null, 2)),
        );
        this.syncManifestDirty = false;
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
                    if (protectedReason!==undefined && protectedReason!=='workspace-root') {
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
        const cancel = vscode.l10n.t('Cancel');
        const selected = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                'The selected Local Replica folder is not empty: {path}. Empty it before syncing?',
                {path: baseUri.fsPath || baseUri.toString()},
            ),
            {modal: true},
            emptyAndContinue,
            cancel,
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
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(baseUri, name), {
                recursive: true,
                useTrash: true,
            });
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

    // Force the pending push for a local URI to fire NOW (cancelling its
    // debounce timer) and resolve when the resulting sync settles. If the
    // watcher hasn't fired yet, synthesise a push so callers that need the
    // VFS to reflect a just-saved file (e.g. compile-on-save) don't race
    // with the EVENT_COALESCE_MS window in syncToVFS.
    public async flushPendingPush(localUri: vscode.Uri): Promise<void> {
        if (localUri.scheme!=='file') { return; }
        const basePath = this.baseUri.path.replace(/\/+$/, '');
        if (localUri.path===basePath) { return; }
        if (!localUri.path.startsWith(basePath + '/')) { return; }
        if (isLocalReplicaMetadataUri(localUri, this.baseUri)) { return; }
        const relPath = this.normalizeConfinedRelPath(localUri.path.slice(basePath.length), 'flush pending push');
        if (relPath===undefined) { return; }
        if (this.matchIgnorePatterns(relPath)) { return; }

        const pending = this.pendingLocalEvents.get(relPath);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingLocalEvents.delete(relPath);
            const vfsUri = this.vfs.pathToUri(relPath);
            await this.enqueueSync(relPath, () => this.applySync('push', pending.latestType, relPath, pending.latestUri, vfsUri));
            return;
        }

        // No debounced event yet — the watcher may simply not have fired
        // before onDidSaveTextDocument. Synthesise a push so the VFS is
        // current before the caller proceeds.
        const vfsUri = this.vfs.pathToUri(relPath);
        await this.enqueueSync(relPath, () => this.applySync('push', 'update', relPath, localUri, vfsUri));
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
        // update the push/pull cache
        if (action==='push') {
            cache[0] = {date, hash};
            cache[1] = cache[1] ?? {date, hash};
        } else if (action==='pull') {
            cache[1] = {date, hash};
            cache[0] = cache[0] ?? {date, hash};
        } else {
            cache[0] = {date, hash};
            cache[1] = {date, hash};
        }
        // write back to the cache
        this.bypassCache.set(key, cache as [FileCache,FileCache]);
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

    private async canSkipInitialBinaryPull(relPath: string, vfsUri: vscode.Uri): Promise<boolean> {
        const entry = this.syncManifest?.files[relPath];
        if (!entry) { return false; }
        const remoteFingerprint = await this.getRemoteFingerprint(relPath, vfsUri);
        if (!remoteFingerprint || entry.remoteFingerprint!==remoteFingerprint) { return false; }
        const localStat = await this.manifestLocalStat(relPath);
        if (!localStat) { return false; }
        if (localStat.size!==entry.localSize || localStat.mtime!==entry.localMtime) {
            return false;
        }

        this.baseCache[relPath] = new Uint8Array();
        this.seenLocalEntities.add(relPath);
        this.setBypassCacheDigest(relPath, entry.localDigest);
        return true;
    }

    private async isLocalUnchangedFromManifest(relPath: string): Promise<boolean> {
        const entry = this.syncManifest?.files[relPath];
        if (!entry) { return false; }
        const localStat = await this.manifestLocalStat(relPath);
        return localStat!==undefined
            && localStat.size===entry.localSize
            && localStat.mtime===entry.localMtime;
    }

    private async recordSyncManifestEntry(relPath: string, vfsUri: vscode.Uri, content: Uint8Array) {
        if (!this.syncManifest || !this.isLikelyBinaryRelPath(relPath)) { return; }
        const remoteFingerprint = await this.getRemoteFingerprint(relPath, vfsUri);
        const localStat = await this.manifestLocalStat(relPath);
        if (!remoteFingerprint || !localStat) { return; }
        this.syncManifest.files[relPath] = {
            remoteFingerprint,
            localSize: localStat.size,
            localMtime: localStat.mtime,
            localDigest: contentDigest(content),
            updatedAt: new Date().toISOString(),
        };
        this.syncManifestDirty = true;
    }

    private removeSyncManifestEntry(relPath: string) {
        if (this.syncManifest?.files[relPath]) {
            delete this.syncManifest.files[relPath];
            this.syncManifestDirty = true;
        }
    }

    private shouldPropagate(action: 'push'|'pull', relPath: string, content?: Uint8Array): boolean {
        const key = normalizeReplicaPath(relPath);
        const now = Date.now();
        const cache = this.bypassCache.get(key);
        if (cache) {
            const thisHash = contentDigest(content);
            const ownCache = action==='push' ? cache[0] : cache[1];
            const oppositeCache = action==='push' ? cache[1] : cache[0];
            // Same-direction match: the last operation in THIS direction
            // already produced these exact bytes. Suppress as a redundant
            // no-op (avoids re-uploading identical bytes on bare Ctrl-S,
            // which matters for large binaries). No time bound here — a
            // duplicate save days later is still a duplicate.
            if (ownCache.hash===thisHash) {
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
            if (oppositeCache.hash===thisHash && now-oppositeCache.date<ECHO_WINDOW_MS) {
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

    private enqueueSync(relPath: string, task: () => Promise<void>): Promise<void> {
        const previous = this.syncQueues.get(relPath) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(task)
            .catch(error => console.error(error))
            .finally(() => {
                if (this.syncQueues.get(relPath)===next) {
                    this.syncQueues.delete(relPath);
                }
            });
        this.syncQueues.set(relPath, next);
        return next;
    }

    private async overwrite(root: string='/', options: InitializeLocalReplicaOptions = {}): Promise<boolean|undefined> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Sync Files'),
            cancellable: true,
        }, async (progress, token) => {
            const preserveExistingLocalFiles = options.preserveExistingLocalFiles ?? false;
            const resetLocalFilesToRemote = options.resetLocalFilesToRemote ?? false;
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
                if (token.isCancellationRequested) { return undefined; }
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

            if (resetLocalFilesToRemote) {
                if (token.isCancellationRequested) { return false; }
                await this.clearLocalProjectFilesForRemoteReset();
                this.syncManifest = this.emptySyncManifest();
                this.syncManifestDirty = true;
            }

            for (const relPath of directories) {
                if (token.isCancellationRequested) { return false; }
                this.setBypassCache(relPath, new Uint8Array(), 'pull');
                const localUri = this.localUri(relPath);
                await this.withFileSystemContext(
                    'Create local directory',
                    localUri,
                    () => vscode.workspace.fs.createDirectory(localUri),
                );
            }

            // sync the files
            const total = files.length;
            for (let i=0; i<total; i++) {
                const [_name, relPath] = files[i];
                const vfsUri = this.vfs.pathToUri(relPath);
                if (token.isCancellationRequested) { return false; }
                progress.report({increment: 100/total, message: relPath});
                //
                if (!resetLocalFilesToRemote && await this.canSkipInitialBinaryPull(relPath, vfsUri)) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [initial pull skip] ${relPath}: manifest fingerprint unchanged`,
                    );
                    continue;
                }
                const baseContent = this.baseCache[relPath];
                const refreshPreservedBinary = preserveExistingLocalFiles
                    && this.isLikelyBinaryRelPath(relPath)
                    && await this.isLocalUnchangedFromManifest(relPath);
                const localContent = refreshPreservedBinary ? undefined : await this.readFile(relPath);
                if (preserveExistingLocalFiles && localContent!==undefined) {
                    this.baseCache[relPath] = localContent;
                    this.seenLocalEntities.add(relPath);
                    this.setBypassCache(relPath, localContent);
                    continue;
                }

                let remoteContent: Uint8Array;
                try {
                    remoteContent = await this.pullRemoteFile(relPath, vfsUri);
                } catch (error) {
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
                if (baseContent===undefined || localContent===undefined) {
                    this.setBypassCache(relPath, remoteContent);
                    await this.writeFile(relPath, remoteContent);
                    this.baseCache[relPath] = remoteContent;
                    this.seenLocalEntities.add(relPath);
                    await this.recordSyncManifestEntry(relPath, vfsUri, remoteContent);
                } else if (this.isLikelyBinaryRelPath(relPath)) {
                    this.setBypassCache(relPath, remoteContent);
                    await this.writeFile(relPath, remoteContent);
                    this.baseCache[relPath] = remoteContent;
                    this.seenLocalEntities.add(relPath);
                    await this.recordSyncManifestEntry(relPath, vfsUri, remoteContent);
                } else {
                    const dmp = new DiffMatchPatch();
                    const baseContentStr = new TextDecoder().decode(baseContent);
                    const localContentStr = new TextDecoder().decode(localContent);
                    const remoteContentStr = new TextDecoder().decode(remoteContent);
                    // merge local and remote changes
                    const localPatches = dmp.patch_make( baseContentStr, localContentStr );
                    const remotePatches = dmp.patch_make( baseContentStr, remoteContentStr );
                    const [mergedContentStr, _results] = dmp.patch_apply( remotePatches, localContentStr );
                    // write the merged content to local
                    const mergedContent = new TextEncoder().encode(mergedContentStr);
                    await this.writeFile(relPath, mergedContent);
                    this.baseCache[relPath] = mergedContent;
                    this.seenLocalEntities.add(relPath);
                    // write the merged content to remote
                    if (localPatches.length!==0) {
                        await this.withFileSystemContext(
                            'Write remote file',
                            vfsUri,
                            () => vscode.workspace.fs.writeFile(vfsUri, mergedContent),
                        );
                    }
                }
            }

            return true;
        });
    }

    private async collectLocalProjectRelPaths(rootUri: vscode.Uri = this.baseUri): Promise<string[]> {
        const relPaths: string[] = [];
        const entries = await vscode.workspace.fs.readDirectory(rootUri);
        const basePath = this.baseUri.path.replace(/\/+$/, '');
        for (const [name, type] of entries) {
            const childUri = vscode.Uri.joinPath(rootUri, name);
            if (isLocalReplicaMetadataUri(childUri, this.baseUri)) {
                continue;
            }
            const relPath = normalizeReplicaPath(childUri.path.slice(basePath.length));
            relPaths.push(relPath);
            if (type===vscode.FileType.Directory) {
                relPaths.push(...await this.collectLocalProjectRelPaths(childUri));
            }
        }
        return relPaths;
    }

    private async clearLocalProjectFilesForRemoteReset(): Promise<void> {
        const relPaths = await this.collectLocalProjectRelPaths();
        for (const relPath of relPaths) {
            this.setBypassCache(relPath, undefined, 'pull');
        }

        const entries = await vscode.workspace.fs.readDirectory(this.baseUri);
        for (const [name] of entries) {
            const childUri = vscode.Uri.joinPath(this.baseUri, name);
            if (isLocalReplicaMetadataUri(childUri, this.baseUri)) {
                continue;
            }
            await this.withFileSystemContext(
                'Delete local file before remote-authoritative sync',
                childUri,
                () => vscode.workspace.fs.delete(childUri, {recursive: true, useTrash: true}),
            );
        }

        this.baseCache = {};
        this.seenLocalEntities.clear();
        this.pendingLocalEvents.forEach(pending => clearTimeout(pending.timer));
        this.pendingLocalEvents.clear();
    }

    private bypassSync(action:'push'|'pull', type:'update'|'delete', relPath: string, content?: Uint8Array): boolean {
        // bypass ignore files
        if (this.matchIgnorePatterns(relPath)) {
            return true;
        }
        // synchronization propagation check
        if (!this.shouldPropagate(action, relPath, content)) {
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
        opts?: { delays?: number[]; betweenAttempts?: () => Promise<void> },
    ): Promise<T> {
        const delays = opts?.delays ?? LocalReplicaSCMProvider.pushRetryDelays;
        const betweenAttempts = opts?.betweenAttempts;
        let lastError: unknown;
        for (let attempt = 0; attempt<delays.length; attempt++) {
            const delay = delays[attempt];
            if (delay>0) { await new Promise(resolve => setTimeout(resolve, delay)); }
            try {
                const result = await task();
                if (lastError) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [${label} recovered] ${relPath} after retry`,
                    );
                }
                return result;
            } catch (error) {
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

    private async pushWithRetry(relPath: string, toUri: vscode.Uri, content: Uint8Array) {
        return this.withRetry('push', relPath, async () => {
            await this.vfs.ensureConnectedForWrite();
            await vscode.workspace.fs.writeFile(toUri, content);
        }, {
            delays: LocalReplicaSCMProvider.pushRetryDelays,
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

    private async pullRemoteFile(relPath: string, vfsUri: vscode.Uri): Promise<Uint8Array> {
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

    private async applySync(action:'push'|'pull', type: 'update'|'delete', relPath:string, fromUri: vscode.Uri, toUri: vscode.Uri) {
        const originalRelPath = relPath;
        const confinedRelPath = this.normalizeConfinedRelPath(relPath, `${action} ${type}`);
        if (confinedRelPath===undefined) {
            this.status = {status: 'idle', message: ''};
            EventBus.fire('scmSyncCompleteEvent', {
                rootUri: this.baseUri,
                relPath: normalizeReplicaPath(originalRelPath),
                direction: action,
                type,
                outcome: 'blocked',
                error: 'invalid replica path',
            });
            return;
        }
        relPath = confinedRelPath;
        if (action==='pull') {
            toUri = this.localUri(relPath);
        }
        this.status = {status: action, message: `${type}: ${relPath}`};

        // Track the terminal outcome so we can fire a single scmSyncCompleteEvent
        // after the IIFE settles. Each early `return` along a guard/suppress
        // path updates `outcome` first; the catch updates `outcome` + `error`.
        // Subscribers (compileManager, status UI, tests) can wait on a specific
        // (relPath, direction, outcome) without polling status.
        let outcome: 'success' | 'error' | 'blocked' | 'suppressed' = 'success';
        let errorMessage: string | undefined;

        await (async () => {
            if (type==='delete') {
                const newContent = undefined;

                // Layer 3 — suppress a pull-delete for a path we never
                // authoritatively replicated. The cascade starts here: a VFS
                // Deleted event for a file that wasn't pulled locally would
                // otherwise call workspace.fs.delete(localUri), which fires
                // the local watcher and echoes back as a remote delete. We
                // refuse to act on it and seed the bypass cache so any
                // spurious echo gets suppressed too.
                if (action==='pull') {
                    const localExists = await LocalReplicaSCMProvider.pathExists(toUri);
                    const everReplicated = relPath in this.baseCache;
                    if (!localExists || !everReplicated || this.failedInitialPulls.has(relPath)) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [pull delete suppressed] ${relPath}: ` +
                            `localExists=${localExists} everReplicated=${everReplicated} ` +
                            `failedInitialPull=${this.failedInitialPulls.has(relPath)}`,
                        );
                        this.setBypassCache(relPath, undefined);
                        this.failedInitialPulls.delete(relPath);
                        outcome = 'suppressed';
                        return;
                    }
                }

                // Layer 4 — refuse a push-delete without local-write
                // provenance. If we never wrote this file locally (no entry in
                // baseCache and no seenLocalEntities trace), the local-watcher
                // event is an echo, not user intent.
                if (action==='push') {
                    if (this.failedInitialPulls.has(relPath)) {
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
                    if (!this.seenLocalEntities.has(relPath) && !(relPath in this.baseCache)) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [push delete blocked] ${relPath}: no local-write trace; treating as echo`,
                        );
                        outcome = 'suppressed';
                        return;
                    }
                }

                if (this.bypassSync(action, type, relPath, newContent)) {
                    outcome = 'suppressed';
                    return;
                }
                if (action==='push') {
                    const decision = await getAgentReviewManager()?.beforeLocalReplicaPush({
                        rootUri: this.baseUri,
                        localUri: fromUri,
                        relPath,
                        type,
                        content: newContent,
                    });
                    if (decision?.kind==='block') {
                        outcome = 'blocked';
                        errorMessage = 'blocked by agent review';
                        return;
                    }
                }
                delete this.baseCache[relPath];
                this.seenLocalEntities.delete(relPath);
                await vscode.workspace.fs.delete(toUri, {recursive:true});
                this.removeSyncManifestEntry(relPath);
                await this.persistSyncManifest();
                if (action==='push') {
                    await getAgentReviewManager()?.afterLocalReplicaPush({
                        rootUri: this.baseUri,
                        localUri: fromUri,
                        relPath,
                        type,
                        content: newContent,
                    });
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
                if (action==='push' && this.failedInitialPulls.has(relPath)) {
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
                if (stat.type===vscode.FileType.Directory) {
                    const newContent = new Uint8Array();
                    if (this.bypassSync(action, type, relPath, newContent)) {
                        outcome = 'suppressed';
                        return;
                    }
                    await vscode.workspace.fs.createDirectory(toUri);
                }
                else if (stat.type===vscode.FileType.File) {
                    try {
                        // Pull reads go through the retrying helper since
                        // transient binary failures are the trigger for the
                        // whole cascade we are guarding against. Push reads
                        // are local-disk and need no retry.
                        const newContent = action==='pull'
                            ? await this.pullRemoteFile(relPath, fromUri)
                            : await vscode.workspace.fs.readFile(fromUri);
                        // Content-equality short-circuit for pull. The bypass
                        // cache already suppresses this case via its sha1
                        // digest, but doing the explicit byte compare here
                        // (a) keeps the optimisation honest if the bypass
                        // cache is ever evicted/cleared, (b) lets us avoid
                        // the agentReview hooks entirely when nothing
                        // changed, and (c) emits a forensic [pull noop] log
                        // line that makes "VFS is noisy but content is
                        // stable" diagnosable.
                        if (action==='pull') {
                            const existing = this.baseCache[relPath];
                            if (existing && bytesEqual(existing, newContent)) {
                                getOutputChannel().appendLine(
                                    `${new Date().toISOString()} [pull noop] ${relPath} (${newContent.length} bytes, content unchanged)`,
                                );
                                outcome = 'suppressed';
                                return;
                            }
                        }
                        if (this.bypassSync(action, type, relPath, newContent)) {
                            outcome = 'suppressed';
                            return;
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
                            if (decision?.kind==='block') {
                                outcome = 'blocked';
                                errorMessage = 'blocked by agent review';
                                return;
                            }
                        }
                        if (action==='push') {
                            // Push with bounded retry so a transient socket blip doesn't
                            // silently lose the accepted edit.
                            await this.pushWithRetry(relPath, toUri, newContent);
                        } else {
                            await vscode.workspace.fs.writeFile(toUri, newContent);
                        }
                        this.baseCache[relPath] = newContent;
                        this.seenLocalEntities.add(relPath);
                        await this.recordSyncManifestEntry(relPath, action==='push' ? toUri : fromUri, newContent);
                        await this.persistSyncManifest();
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
                        }
                    } catch (error) {
                        // Previously this swallowed every error silently, so an accepted
                        // change could land on disk yet never reach Overleaf. Now we
                        // log to the shared output channel and surface one toast per
                        // (file × message) per 60s so the user is never left in the dark.
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [${action} ${type}] ${relPath}: ${formatUnknownError(error)}`,
                        );
                        if (action==='push') {
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

        this.status = {status: 'idle', message: ''};
        EventBus.fire('scmSyncCompleteEvent', {
            rootUri: this.baseUri,
            relPath,
            direction: action,
            type,
            outcome,
            error: errorMessage,
        });
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
            const pending = this.pendingVfsEvents.get(relPath);
            if (!pending) { return; } // disposed or already drained
            this.pendingVfsEvents.delete(relPath);
            const localUri = this.localUri(relPath);
            void this.enqueueSync(relPath, () => this.applySync('pull', pending.latestType, relPath, pending.latestUri, localUri));
        }, delay);
        this.pendingVfsEvents.set(relPath, { timer, firstEventAt, latestType: type, latestUri: vfsUri });
    }

    private async syncToVFS(localUri: vscode.Uri, type: 'update'|'delete') {
        if (isLocalReplicaMetadataUri(localUri, this.baseUri)) {
            return;
        }
        if (!await this.hasLocalReplicaSettings()) {
            console.warn(`Local replica settings missing under "${this.baseUri.toString()}"; local change was not propagated.`);
            return;
        }
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
            const pending = this.pendingLocalEvents.get(relPath);
            if (!pending) { return; }
            this.pendingLocalEvents.delete(relPath);
            const vfsUri = this.vfs.pathToUri(relPath);
            void this.enqueueSync(relPath, () => this.applySync('push', pending.latestType, relPath, pending.latestUri, vfsUri));
        }, delay);
        this.pendingLocalEvents.set(relPath, { timer, firstEventAt, latestType: type, latestUri: localUri });
    }

    public async initializeLocalReplica(options?: InitializeLocalReplicaOptions) {
        const initializationOptions = {
            resetLocalFilesToRemote: false,
            ...definedInitializationOptions(this.initializationOptions),
            ...definedInitializationOptions(options),
        };
        await this.ensureLocalReplicaSettings();
        await this.loadSyncManifest();
        this.initialPullStatus = 'pending';
        // Per-file failures accumulate in failedInitialPulls; reset before each
        // attempt so a fresh init starts from a clean slate.
        this.failedInitialPulls.clear();
        try {
            await this.overwrite('/', initializationOptions);
        } catch (error) {
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
            await this.persistSyncManifest();
            return;
        }
        if (this.failedInitialPulls.size>0) {
            this.initialPullStatus = 'partial';
            this.status = {
                status: 'need-attention',
                message: vscode.l10n.t('{count} files failed to download', {count: this.failedInitialPulls.size}),
            };
            this.surfacePartialPullToast();
        } else {
            this.initialPullStatus = 'complete';
            this.partialPullToastShown = false;
        }
        await this.persistSyncManifest();
    }

    private surfacePartialPullToast() {
        if (this.partialPullToastShown) { return; }
        this.partialPullToastShown = true;
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
            if (choice===retry) {
                this.partialPullToastShown = false;
                await this.retryFailedInitialPulls();
            } else if (choice===ignore) {
                this.ignoreFailedInitialPulls();
            } else if (choice===showOutput) {
                this.partialPullToastShown = false;
                getOutputChannel().show(true);
            } else {
                this.partialPullToastShown = false;
            }
        });
    }

    public async retryFailedInitialPulls(): Promise<{recovered: string[]; stillFailed: string[]}> {
        const recovered: string[] = [];
        const stillFailed: string[] = [];
        const targets = [...this.failedInitialPulls];
        for (const relPath of targets) {
            const vfsUri = this.vfs.pathToUri(relPath);
            try {
                const content = await this.pullRemoteFile(relPath, vfsUri);
                this.setBypassCache(relPath, content);
                await this.writeFile(relPath, content);
                this.baseCache[relPath] = content;
                this.seenLocalEntities.add(relPath);
                await this.recordSyncManifestEntry(relPath, vfsUri, content);
                this.failedInitialPulls.delete(relPath);
                recovered.push(relPath);
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [pull recovered] ${relPath} via retryFailedInitialPulls`,
                );
            } catch (error) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [pull retry failed] ${relPath}: ${formatUnknownError(error)}`,
                );
                stillFailed.push(relPath);
            }
        }
        if (this.failedInitialPulls.size===0) {
            this.initialPullStatus = 'complete';
            this.status = {status: 'idle', message: ''};
            this.partialPullToastShown = false;
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
        await this.persistSyncManifest();
        return {recovered, stillFailed};
    }

    public ignoreFailedInitialPulls() {
        if (this.failedInitialPulls.size===0) { return; }
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
        this.partialPullToastShown = false;
        // User opted in: the failed paths are now ignored, so it is safe to
        // arm the local watcher for the rest of the project.
        this.armLocalWatcher?.();
    }

    private async initWatch(): Promise<vscode.Disposable[]> {
        await this.initializeLocalReplica();
        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.vfs.origin, '**/*' )
        );

        const disposables: vscode.Disposable[] = [
            // sync from vfs to local (always armed — pull-delete is gated by Layer 3)
            // Synchronous handlers — syncFromVFS now schedules a debounce
            // timer rather than awaiting the full applySync chain.
            this.vfsWatcher.onDidChange(uri => this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidCreate(uri => this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidDelete(uri => this.syncFromVFS(uri, 'delete')),
        ];

        // Arm the local watcher unconditionally. Until 0.15.20 we deferred
        // arming whenever the initial pull was partial — that was safe but
        // silently disabled ALL local→remote sync for the whole project
        // until the user clicked Retry/Ignore on a single toast they often
        // missed. Push correctness for the failed-pull paths is now enforced
        // inline by Layer 4 (push-delete) and Layer 4b (push-update) in
        // applySync, both of which reject mutations for entries in
        // failedInitialPulls. So the watcher firing for a failed-pull path
        // is logged and ignored, while every other path syncs normally.
        this.armLocalWatcher = () => {
            if (this.localWatcher) { return; }
            this.localWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern( this.baseUri.path, '**/*' )
            );
            this.dynamicLocalDisposables.push(
                this.localWatcher,
                this.localWatcher.onDidChange(uri => { void this.syncToVFS(uri, 'update'); }),
                this.localWatcher.onDidCreate(uri => { void this.syncToVFS(uri, 'update'); }),
                this.localWatcher.onDidDelete(uri => { void this.syncToVFS(uri, 'delete'); }),
            );
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [localWatcher armed] initialPullStatus=${this.initialPullStatus} ` +
                `failedInitialPulls=${this.failedInitialPulls.size}`,
            );
        };
        this.armLocalWatcher();
        if (this.initialPullStatus!=='complete') {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [partial pull active] ${this.failedInitialPulls.size} files pending; ` +
                `their local edits will be rejected by Layer 4/4b until retry/ignore. Other files push normally.`,
            );
        }

        // Auto-recover on reconnect: a transient socket drop that left files
        // in failedInitialPulls is the typical case, and the connection is now
        // available again. Try once per (re)connect.
        const connSub = this.vfs.onDidChangeConnection(state => {
            if (state==='connected' && this.failedInitialPulls.size>0) {
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
                for (const d of this.dynamicLocalDisposables) { d.dispose(); }
                this.dynamicLocalDisposables = [];
                this.localWatcher = undefined;
                this.armLocalWatcher = undefined;
                for (const pending of this.pendingVfsEvents.values()) { clearTimeout(pending.timer); }
                this.pendingVfsEvents.clear();
                for (const pending of this.pendingLocalEvents.values()) { clearTimeout(pending.timer); }
                this.pendingLocalEvents.clear();
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

    private async ensureParentDirectory(relPath: string) {
        const confinedRelPath = this.requireConfinedRelPath(relPath, 'create local parent directory');
        const pathParts = confinedRelPath.replace(/^\/+/, '').split('/');
        if (pathParts.length<=1) { return; }
        const parentUri = vscode.Uri.joinPath(this.baseUri, ...pathParts.slice(0, -1));
        await this.withFileSystemContext(
            'Create local parent directory',
            parentUri,
            () => vscode.workspace.fs.createDirectory(parentUri),
        );
    }

    async writeFile(relPath: string, content: Uint8Array): Promise<void> {
        await this.ensureParentDirectory(relPath);
        const uri = this.localUri(relPath);
        return this.withFileSystemContext(
            'Write local file',
            uri,
            () => vscode.workspace.fs.writeFile(uri, content),
        );
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
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., local parent folder');
        inputBox.value = require('os').homedir()+sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async value => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory( vscode.Uri.file(path) );
                const subDirs = items.filter( ([name, type]) => type===vscode.FileType.Directory )
                                    .filter( ([name, type]) => `${path}${sep}${name}`.startsWith(value) );
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length!==0) {
                    const candidates = subDirs.map(([name, type]) => ({label:name, alwaysShow:true, picked:false}));
                    if (path!=='') {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label==='..'? path : `${path}${sep}${selected.label}${sep}`;
            }
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
