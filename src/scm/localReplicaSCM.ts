import * as crypto from 'crypto';
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
    pathToLocalUri,
    readReplicaSettings,
} from '../utils/localReplicaWorkspace';
import {
    LEGACY_REPLICA_SETTINGS_BACKUP_FILE,
    LEGACY_REPLICA_SETTINGS_DIR,
    LEGACY_REPLICA_SETTINGS_FILE,
    REPLICA_SETTINGS_DIR,
    REPLICA_SETTINGS_FILE,
} from '../consts';
import { stringifyOverleafUri } from '../utils/overleafUri';
import { formatUnknownError } from '../utils/errorMessage';
import { PROTECTED_LOCAL_REPLICA_IGNORE_PATTERNS, getAgentReviewManager } from '../agentReview';

const IGNORE_SETTING_KEY = 'ignore-patterns';
const ECHO_WINDOW_MS = 500;

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

interface InitializeLocalReplicaOptions {
    preserveExistingLocalFiles?: boolean;
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

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private bypassCache: Map<string, [FileCache,FileCache]> = new Map();
    private baseCache: {[key:string]: Uint8Array} = {};
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
        '/*.pdf',
        '**/main.pdf',
        '**/output.pdf',
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    private static sanitizeProjectFolderName(projectName: string): string {
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

    public setInitializationOptions(options?: InitializeLocalReplicaOptions) {
        this.initializationOptions = {
            ...this.initializationOptions,
            ...options,
        };
        return this;
    }

    private get settingsUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, REPLICA_SETTINGS_FILE);
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
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async validateExactBaseUri(uri: string): Promise<vscode.Uri> {
        try {
            const baseUri = vscode.Uri.file(uri);
            if (await LocalReplicaSCMProvider.pathExists(baseUri)) {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
            }
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
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
        const key = normalizeReplicaPath(relPath);
        const date = Date.now();
        const hash = contentDigest(content);
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

    private shouldPropagate(action: 'push'|'pull', relPath: string, content?: Uint8Array): boolean {
        const key = normalizeReplicaPath(relPath);
        const now = Date.now();
        const cache = this.bypassCache.get(key);
        if (cache) {
            const thisHash = contentDigest(content);
            const ownCache = action==='push' ? cache[0] : cache[1];
            const oppositeCache = action==='push' ? cache[1] : cache[0];
            if (ownCache.hash===thisHash) { return false; }
            // Only suppress a cross-direction echo while it is fresh. A stale
            // divergent cache must not swallow a later undo/redo save.
            if (oppositeCache.hash===thisHash && now-oppositeCache.date<ECHO_WINDOW_MS) {
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
            // breadth-first search for the files
            const files: [string,string][] = [];
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
                    const relPath = nextRoot + name;
                    if (this.matchIgnorePatterns(relPath)) {
                        continue;
                    }
                    if (type === vscode.FileType.Directory) {
                        this.setBypassCache(relPath, new Uint8Array(), 'pull');
                        const localUri = this.localUri(relPath);
                        await this.withFileSystemContext(
                            'Create local directory',
                            localUri,
                            () => vscode.workspace.fs.createDirectory(localUri),
                        );
                        queue.push(relPath+'/');
                    } else {
                        files.push([name, relPath]);
                    }
                }
            }

            // sync the files
            const total = files.length;
            for (let i=0; i<total; i++) {
                const [name, relPath] = files[i];
                const vfsUri = this.vfs.pathToUri(relPath);
                if (token.isCancellationRequested) { return false; }
                progress.report({increment: 100/total, message: relPath});
                //
                const baseContent = this.baseCache[relPath];
                const localContent = await this.readFile(relPath);
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
            // Re-check after subscribing to close the listener-installation gap.
            if (this.vfs.connectionState==='connected') { settle(true); }
        });
    }

    // Generic bounded-retry helper. Used by both push and pull paths so a stale
    // or reconnecting socket doesn't drop an operation silently. The optional
    // `betweenAttempts` callback runs between failed attempts — push uses it
    // to force a reconnect, pull uses it to passively await the existing
    // connection state machine (no own reconnect — see waitForConnectedOrTimeout).
    private async withRetry<T>(
        label: 'push' | 'pull',
        relPath: string,
        task: () => Promise<T>,
        opts?: { delays?: number[]; betweenAttempts?: () => Promise<void> },
    ): Promise<T> {
        const delays = opts?.delays ?? [0, 200, 700];
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
            // Push genuinely needs a fresh connection — if the socket is dead,
            // there is nothing else that will repair it for us before the next
            // attempt. ensureConnectedForWrite() is itself a no-op when
            // already connected so this is not a forced re-init.
            betweenAttempts: () => this.vfs.ensureConnectedForWrite(),
        });
    }

    // Pull binary files with a wider backoff. Binary VFS reads occasionally
    // return Unknown / zero bytes during socket reconnects; surface those as
    // failures the outer code can retry rather than silently writing empty
    // files into the replica.
    private static readonly PULL_RETRY_DELAYS = [0, 300, 900, 2400];
    private static readonly PULL_RECONNECT_WAIT_MS = 5000;

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
            delays: LocalReplicaSCMProvider.PULL_RETRY_DELAYS,
            // Critical: do NOT call vfs.reconnect() between attempts. Parallel
            // pulls each issuing reconnect() cascade-clear the project state
            // and produce a socket storm severe enough that Overleaf rate-limits
            // us. Instead, wait passively for the existing reconnect cycle to
            // resolve (it does on its own via the VFS's internal logic).
            betweenAttempts: async () => {
                await this.waitForConnectedOrTimeout(LocalReplicaSCMProvider.PULL_RECONNECT_WAIT_MS);
            },
        });
    }

    private async applySync(action:'push'|'pull', type: 'update'|'delete', relPath:string, fromUri: vscode.Uri, toUri: vscode.Uri) {
        this.status = {status: action, message: `${type}: ${relPath}`};

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
                        return;
                    }
                    if (!this.seenLocalEntities.has(relPath) && !(relPath in this.baseCache)) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [push delete blocked] ${relPath}: no local-write trace; treating as echo`,
                        );
                        return;
                    }
                }

                if (this.bypassSync(action, type, relPath, newContent)) { return; }
                if (action==='push') {
                    const decision = await getAgentReviewManager()?.beforeLocalReplicaPush({
                        rootUri: this.baseUri,
                        localUri: fromUri,
                        relPath,
                        type,
                        content: newContent,
                    });
                    if (decision?.kind==='block') { return; }
                }
                delete this.baseCache[relPath];
                this.seenLocalEntities.delete(relPath);
                await vscode.workspace.fs.delete(toUri, {recursive:true});
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
                const stat = await vscode.workspace.fs.stat(fromUri);
                if (stat.type===vscode.FileType.Directory) {
                    const newContent = new Uint8Array();
                    if (this.bypassSync(action, type, relPath, newContent)) { return; }
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
                        if (this.bypassSync(action, type, relPath, newContent)) { return; }
                        const pushChange = action==='push' ? {
                            rootUri: this.baseUri,
                            localUri: fromUri,
                            relPath,
                            type,
                            content: newContent,
                        } : undefined;
                        if (action==='push') {
                            const decision = await getAgentReviewManager()?.beforeLocalReplicaPush(pushChange!);
                            if (decision?.kind==='block') { return; }
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
                    }
                }
                else {
                    console.error(`Unknown file type: ${stat.type}`);
                }
            }
        })();

        this.status = {status: 'idle', message: ''};
    }

    private async syncFromVFS(vfsUri: vscode.Uri, type: 'update'|'delete') {
        const {pathParts} = parseUri(vfsUri);
        pathParts.at(-1)==='' && pathParts.pop(); // remove the last empty string
        const relPath = normalizeReplicaPath('/' + pathParts.join('/'));
        // Early ignore-pattern short-circuit. Without this, ignored paths
        // (compile artifacts under /.output/*, .aux, .log, etc.) still flow
        // through enqueueSync + applySync's stat + readFile before the
        // bypassSync check rejects them — wasting socket traffic and adding
        // retry/reconnect pressure during compile cycles.
        if (this.matchIgnorePatterns(relPath)) { return; }
        const localUri = this.localUri(relPath);
        await this.enqueueSync(relPath, () => this.applySync('pull', type, relPath, vfsUri, localUri));
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
        const relPath = normalizeReplicaPath(localUri.path.slice(basePath.length));
        // Same early-ignore short-circuit as syncFromVFS — no point enqueueing
        // work that bypassSync would reject anyway.
        if (this.matchIgnorePatterns(relPath)) { return; }
        const vfsUri = this.vfs.pathToUri(relPath);
        await this.enqueueSync(relPath, () => this.applySync('push', type, relPath, localUri, vfsUri));
    }

    public async initializeLocalReplica(options?: InitializeLocalReplicaOptions) {
        const initializationOptions = {
            ...this.initializationOptions,
            ...options,
        };
        await this.ensureLocalReplicaSettings();
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
                '{count} files failed to download from Overleaf. Local edits will NOT sync until you Retry Pull or Ignore These Files.',
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
            this.vfsWatcher.onDidChange(async uri => await this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidCreate(async uri => await this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidDelete(async uri => await this.syncFromVFS(uri, 'delete')),
        ];

        // The local watcher is the dangerous direction (local→remote). Defer
        // its creation until the initial pull is fully complete; while pull is
        // partial there is literally no listener to fire syncToVFS, so a stray
        // local FS event can never be translated into a remote mutation.
        this.armLocalWatcher = () => {
            if (this.localWatcher) { return; }
            this.localWatcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern( this.baseUri.path, '**/*' )
            );
            this.dynamicLocalDisposables.push(
                this.localWatcher,
                this.localWatcher.onDidChange(async uri => await this.syncToVFS(uri, 'update')),
                this.localWatcher.onDidCreate(async uri => await this.syncToVFS(uri, 'update')),
                this.localWatcher.onDidDelete(async uri => await this.syncToVFS(uri, 'delete')),
            );
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [localWatcher armed]`,
            );
        };

        if (this.initialPullStatus==='complete') {
            this.armLocalWatcher();
        } else {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [localWatcher deferred] initialPullStatus=${this.initialPullStatus}; ` +
                `${this.failedInitialPulls.size} files pending. Local edits will NOT push until retry/ignore.`,
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
        disposables.push({
            dispose: () => {
                for (const d of this.dynamicLocalDisposables) { d.dispose(); }
                this.dynamicLocalDisposables = [];
                this.localWatcher = undefined;
                this.armLocalWatcher = undefined;
            },
        });

        return disposables;
    }

    private localUri(relPath: string): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, relPath.replace(/^\/+/, ''));
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
        const pathParts = relPath.replace(/^\/+/, '').split('/').filter(Boolean);
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
        const uri = this.localUri(relPath);
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
