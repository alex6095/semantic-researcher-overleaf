import * as vscode from 'vscode';
import * as DiffMatchPatch from 'diff-match-patch';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
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

type FileCache = {date:number, hash:number};

interface InitializeLocalReplicaOptions {
    preserveExistingLocalFiles?: boolean;
}

/**
 * Returns a hash code from a string
 * @param  {String} str The string to hash.
 * @return {Number}    A 32bit integer
 * @see http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
 */
function hashCode(content?: Uint8Array): number {
    if (content===undefined) { return -1; }
    const str = new TextDecoder().decode(content);

    let hash = 0;
    for (let i = 0, len = str.length; i < len; i++) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
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
    private syncQueues: Map<string, Promise<void>> = new Map();
    private localReplicaSettings?: {
        uri: string,
        serverName: string,
        enableCompileNPreview: boolean,
        projectName: string,
    };
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
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
        const date = Date.now();
        const hash = hashCode(content);
        const cache = this.bypassCache.get(relPath) || [undefined,undefined];
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
        this.bypassCache.set(relPath, cache as [FileCache,FileCache]);
    }

    private shouldPropagate(action: 'push'|'pull', relPath: string, content?: Uint8Array): boolean {
        const now = Date.now();
        const cache = this.bypassCache.get(relPath);
        if (cache) {
            const thisHash = hashCode(content);
            const ownCache = action==='push' ? cache[0] : cache[1];
            const oppositeCache = action==='push' ? cache[1] : cache[0];
            if (ownCache.hash===thisHash) { return false; }
            // Only suppress a cross-direction echo while it is fresh. A stale
            // divergent cache must not swallow a later undo/redo save.
            if (oppositeCache.hash===thisHash && now-oppositeCache.date<ECHO_WINDOW_MS) {
                this.setBypassCache(relPath, content, action);
                return false;
            }
        }
        this.setBypassCache(relPath, content, action);
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
                    this.setBypassCache(relPath, localContent);
                    continue;
                }

                let remoteContent: Uint8Array;
                try {
                    remoteContent = await this.withFileSystemContext(
                        'Read remote file',
                        vfsUri,
                        () => vscode.workspace.fs.readFile(vfsUri),
                    );
                } catch (error) {
                    if (preserveExistingLocalFiles) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [initial pull skipped] ${relPath}: ${formatUnknownError(error)}`,
                        );
                        continue;
                    }
                    throw error;
                }
                if (baseContent===undefined || localContent===undefined) {
                    this.setBypassCache(relPath, remoteContent);
                    await this.writeFile(relPath, remoteContent);
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

    // Up to 3 attempts with short backoff so a stale or reconnecting socket
    // doesn't drop the edit silently. The error surfacing happens in the
    // outer catch if every attempt fails.
    private async pushWithRetry(relPath: string, toUri: vscode.Uri, content: Uint8Array) {
        const delays = [0, 200, 700];
        let lastError: unknown;
        for (let attempt = 0; attempt<delays.length; attempt++) {
            const delay = delays[attempt];
            if (delay>0) { await new Promise(resolve => setTimeout(resolve, delay)); }
            try {
                await this.vfs.ensureConnectedForWrite();
                await vscode.workspace.fs.writeFile(toUri, content);
                if (lastError) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [push recovered] ${relPath} after retry`,
                    );
                }
                return;
            } catch (error) {
                lastError = error;
                if (attempt<delays.length-1) {
                    try {
                        await this.vfs.reconnect(`retry push for ${relPath}`);
                    } catch (reconnectError) {
                        lastError = reconnectError;
                    }
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async applySync(action:'push'|'pull', type: 'update'|'delete', relPath:string, fromUri: vscode.Uri, toUri: vscode.Uri) {
        this.status = {status: action, message: `${type}: ${relPath}`};

        await (async () => {
            if (type==='delete') {
                const newContent = undefined;
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
                        const newContent = await vscode.workspace.fs.readFile(fromUri);
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
        const relPath = ('/' + pathParts.join('/'));
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
        // get relative path to baseUri
        const basePath = this.baseUri.path;
        const relPath = localUri.path.slice(basePath.length);
        const vfsUri = this.vfs.pathToUri(relPath);
        await this.enqueueSync(relPath, () => this.applySync('push', type, relPath, localUri, vfsUri));
    }

    public async initializeLocalReplica(options?: InitializeLocalReplicaOptions) {
        const initializationOptions = {
            ...this.initializationOptions,
            ...options,
        };
        await this.ensureLocalReplicaSettings();
        try {
            await this.overwrite('/', initializationOptions);
        } catch (error) {
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
        }
    }

    private async initWatch() {
        await this.initializeLocalReplica();
        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.vfs.origin, '**/*' )
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.baseUri.path, '**/*' )
        );

        return [
            // sync from vfs to local
            this.vfsWatcher.onDidChange(async uri => await this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidCreate(async uri => await this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidDelete(async uri => await this.syncFromVFS(uri, 'delete')),
            // sync from local to vfs
            this.localWatcher.onDidChange(async uri => await this.syncToVFS(uri, 'update')),
            this.localWatcher.onDidCreate(async uri => await this.syncToVFS(uri, 'update')),
            this.localWatcher.onDidDelete(async uri => await this.syncToVFS(uri, 'delete')),
        ];
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
            if (this.vfsWatcher!==undefined && this.localWatcher!==undefined) {
                return [
                    this.vfsWatcher,
                    this.localWatcher,
                    ...watches,
                ];
            } else {
                return [];
            }
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
