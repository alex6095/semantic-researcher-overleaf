/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import DiffMatchPatch = require('diff-match-patch');
import { BaseAPI, Identity, MemberEntity, ProjectSettingsSchema } from '../api/base';
import { OtUpdateErrorSchema, SocketIOAPI, UpdateSchema } from '../api/socketio';
import { OUTPUT_FOLDER_NAME, PREFETCH_COMMAND, ROOT_NAME } from '../consts';
import { GlobalStateManager } from '../utils/globalStateManager';
import { ClientManager } from '../collaboration/clientManager';
import { EventBus } from '../utils/eventBus';
import {
    SCMCollectionProvider,
    removeDetachedLocalReplicaSCM,
} from '../scm/scmCollectionProvider';
import { ExtendedBaseAPI, ProjectLinkedFileProvider, UrlLinkedFileProvider } from '../api/extendedBase';
import { canonicalizeOverleafUri, normalizeOverleafQuery } from '../utils/overleafUri';
import {
    getActiveReplicaOriginUri,
    getActiveReplicaRoot,
} from '../utils/localReplicaWorkspace';
import { decodeUtf8Text, mergeUtf8Text } from '../utils/threeWayMerge';
import { getOutputChannel } from '../utils/outputChannel';

const __OUTPUTS_ID = `${ROOT_NAME}-outputs`;

export type FileType = 'doc' | 'file' | 'folder' | 'outputs';
export type FolderKey = 'docs' | 'fileRefs' | 'folders' | 'outputs';
const FolderKeys: {[_type:string]: FolderKey} = {
    'folder': 'folders',
    'doc': 'docs',
    'file': 'fileRefs',
    'outputs': 'outputs',
};

export interface FileEntity {
    _id: string,
    name: string,
    _type?: FileType,
    readonly?: boolean,
}

export interface DocumentEntity extends FileEntity {
    version?: number,
    mtime?: number,
    lastVersion?: number,
    localCache?: string,
    remoteCache?: string,
}

export interface FileRefEntity extends FileEntity {
    linkedFileData: ProjectLinkedFileProvider | UrlLinkedFileProvider | null,
    created: string, //ISO date string
}

export interface OutputFileEntity extends FileEntity {
    path: string, //output file name
    url: string, // `project/${projectId}/user/${userId}/output/${build}/output/${path}`
    type: string, //output file type (postfix)
    build: string, //build id
}

export interface FolderEntity extends FileEntity {
    docs: Array<DocumentEntity>,
    fileRefs: Array<FileRefEntity>,
    folders: Array<FolderEntity>,
    outputs?: Array<OutputFileEntity>,
}

export interface ProjectEntity {
    _id: string,
    name: string,
    rootDoc_id: string,
    rootFolder: Array<FolderEntity>,
    publicAccessLevel: string, //"tokenBased"
    compiler: string,
    spellCheckLanguage: string,
    deletedDocs: Array<{
        _id: string,
        name: string,
        deletedAt: string,
    }>,
    members: Array<MemberEntity>,
    invites: Array<MemberEntity>,
    owner: MemberEntity,
    features: {[key:string]:any},
    settings: ProjectSettingsSchema,
}

export class File implements vscode.FileStat {
    type: vscode.FileType;
    name: string;
    ctime: number;
    mtime: number;
    size: number;
    permissions?: vscode.FilePermission;
    constructor(name: string, type: vscode.FileType, ctime?: number, permissions?:vscode.FilePermission) {
        this.type = type;
        this.name = name;
        this.ctime = ctime || Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.permissions = permissions;
    }
}

export function parseUri(uri: vscode.Uri) {
    uri = canonicalizeOverleafUri(uri);
    const queryString = normalizeOverleafQuery(uri.query);
    const query:any = queryString.split('&').reduce((acc, v) => {
        const [key,value] = v.split('=');
        return {...acc, [key]:value};
    }, {});
    const [userId, projectId] = [query.user, query.project];
    const _pathParts = uri.path.split('/');
    const serverName = uri.authority;
    const projectName = decodeURIComponent(_pathParts[1]);
    const pathParts = _pathParts.splice(2);
    const identifier = `${userId}/${projectId}/${projectName}`;
    return {userId, projectId, serverName, projectName, identifier, pathParts};
}

export function vfsProjectKey(uri: vscode.Uri) {
    uri = canonicalizeOverleafUri(uri);
    if (uri.scheme!==ROOT_NAME) {
        return uri.with({fragment: ''}).toString();
    }
    const {userId, projectId} = parseUri(uri);
    return `${uri.scheme.toLowerCase()}://${uri.authority.toLowerCase()}` +
        `?user=${encodeURIComponent(userId ?? '')}&project=${encodeURIComponent(projectId ?? '')}`;
}

export type VFSConnectionState = 'initial' | 'connected' | 'reconnecting' | 'disconnected';

interface ActivateProjectOptions {
    restorePersistedSCMs?: boolean;
}

export class RemoteDocumentMergeConflictError extends Error {}
export class RemoteDocumentWriteAmbiguousError extends Error {}
export class RemoteMutationRejectedError extends Error {
    readonly retryable = false;
}
export class RemoteMutationRetryableError extends Error {
    readonly retryable = true;

    constructor(
        message: string,
        readonly requiresAuthoritativeRecheck: boolean,
    ) {
        super(message);
    }
}

interface PendingDocumentWrite {
    submittedVersion: number;
    collaboratorRevision: number;
    requiresAuthoritativeReconciliation: boolean;
    appliedVersion?: number;
    submittedSourceIds: string[];
    rejectedError?: RemoteDocumentWriteAmbiguousError;
    applied: Promise<number | undefined>;
    resolveApplied: (version?: number) => void;
}

export class VirtualFileSystem extends vscode.Disposable {
    private root?: ProjectEntity;
    private currentVersion?: number;
    private context: vscode.ExtensionContext;
    private api: BaseAPI;
    private socket: SocketIOAPI;
    private publicId?: string;
    private userId: string;
    private isDirty: boolean = true;
    private initializing?: Promise<ProjectEntity>;
    // Overleaf real-time tracks one join/leave epoch per socket client. Two
    // overlapping joinDoc RPCs make the later call supersede the earlier one,
    // so every authoritative socket join must pass through this queue.
    private documentJoinQueue: Promise<void> = Promise.resolve();
    private retryConnection: number = 0;
    private lastConnectionError?: Error;
    private outputBuildId?: string;
    private compileGroup?: string;
    private clsiServerId?: string;
    private pdfDownloadDomain?: string;
    private notify: (events:vscode.FileChangeEvent[])=>void;
    private clientManagerItem?: {manager: ClientManager, triggers: vscode.Disposable[]};
    private scmCollectionItem?: {collection: SCMCollectionProvider, triggers: vscode.Disposable[]};
    private remoteWatchDisposable?: vscode.Disposable;
    private readonly documentWriteQueues = new Map<string, Promise<void>>();
    private readonly documentCollaboratorRevisions = new Map<string, number>();
    private readonly pendingDocumentWrites = new Map<string, PendingDocumentWrite>();
    private readonly documentInDoubtSenderVersions = new Map<string, number[]>();
    // Real-time delivery may briefly reorder operations for one document. Keep
    // only bounded, unapplied operation messages; acknowledgements are never
    // inferred from this queue.
    private queuedRemoteDocumentUpdates?: Map<string, UpdateSchema[]>;
    private queuedRemoteDocumentUpdateTimers?: Map<string, ReturnType<typeof setTimeout>>;
    private readonly sessionIdentity: Identity;
    private disposed = false;
    private restorePersistedSCMsOnManagerCreation = true;
    private static readonly documentAppliedTimeoutMs = 5000;
    private static readonly maxQueuedRemoteDocumentVersionGap = 4;
    private static readonly maxInDoubtSenderVersions = 8;
    private static readonly maxQueuedRemoteDocumentUpdates = 32;
    private static readonly queuedRemoteDocumentUpdateTimeoutMs = 5000;
    // Real pauses between reconnect attempts: without them a two second blip
    // burns the whole 3-strike budget in milliseconds and pops a modal, while a
    // failing project join hammers the server with no pause at all.
    private static readonly reconnectBackoffMs = [1000, 2000, 4000];
    // The last text each document was known to be synchronized with, lifted out
    // of the entity graph before anything invalidates it. Lazily created
    // because most sessions never need one.
    private documentMergeBaselines?: Map<string, string>;
    private pendingRejoinSnapshot?: {paths: Set<string>, cachedDocPaths: string[]};
    // The outputs folder is a client-side construct, so it has to be rebuilt
    // after a rejoin: a fresh joinProject payload never contains it.
    private lastOutputs?: Array<OutputFileEntity>;
    private sessionRecoveryPrompted = false;

    // Connection state is useful for SCM and UI layers: we don't want to trust
    // "selected" as a proxy for "live".
    private _connectionState: VFSConnectionState = 'initial';
    private readonly _onDidChangeConnectionEmitter = new vscode.EventEmitter<VFSConnectionState>();
    public readonly onDidChangeConnection = this._onDidChangeConnectionEmitter.event;

    public readonly origin: vscode.Uri;
    public readonly projectName: string;
    public readonly serverName: string;
    public readonly projectId: string;

    constructor(
        context: vscode.ExtensionContext,
        uri: vscode.Uri,
        notify: (events:vscode.FileChangeEvent[])=>void,
        private readonly isActiveProject?: () => boolean,
    ) {
        // define the dispose behavior
        super(() => {
            if (this.disposed) { return; }
            this.disposed = true;
            this.root = undefined;
            this.initializing = undefined;
            // Drive the state machine on the way out. Assigning the state
            // without firing left the status bar advertising "connected
            // (changes sync live)" for a project that no longer exists.
            if (this._connectionState!=='disconnected') {
                this._connectionState = 'disconnected';
                this._onDidChangeConnectionEmitter.fire('disconnected');
            }
            // dispose all triggers of clientManager
            this.clientManagerItem?.triggers.forEach((trigger) => trigger.dispose());
            this.clientManagerItem = undefined;
            // dispose all triggers of scmCollection
            this.scmCollectionItem?.triggers.forEach((trigger) => trigger.dispose());
            this.scmCollectionItem?.collection.dispose();
            this.scmCollectionItem = undefined;
            this.remoteWatchDisposable?.dispose();
            this.remoteWatchDisposable = undefined;
            for (const pending of this.pendingDocumentWrites.values()) {
                pending.resolveApplied();
            }
            this.pendingDocumentWrites.clear();
            this.documentWriteQueues.clear();
            this.documentCollaboratorRevisions.clear();
            // An in-doubt barrier is only ever consumed by a sender-ack from
            // the socket that produced it, so keeping it past disposal just
            // leaks and, on a reused entity id, steals a later write's ack.
            this.documentInDoubtSenderVersions.clear();
            this.documentMergeBaselines?.clear();
            for (const timer of this.queuedRemoteDocumentUpdateTimers?.values() ?? []) {
                clearTimeout(timer);
            }
            this.queuedRemoteDocumentUpdateTimers?.clear();
            this.queuedRemoteDocumentUpdates?.clear();
            // disconnect socketio
            try {
                this.socket.dispose();
            } catch (error) {
                console.warn(`Could not disconnect socket for ${this.origin.toString()}:`, error);
            }
            this._onDidChangeConnectionEmitter.dispose();
        });

        uri = canonicalizeOverleafUri(uri);
        const {userId,projectId,serverName,projectName} = parseUri(uri);
        this.serverName = serverName;
        this.projectName = projectName;
        this.origin = uri.with({path: '/'+projectName});
        this.userId = userId;
        this.projectId = projectId;
        this.context = context;
        this.notify = notify;

        const res = GlobalStateManager.initSocketIOAPI(
            this.context,
            this.serverName,
            projectId,
            userId,
        );
        if (res) {
            this.api = res.api;
            this.socket = res.socket;
            this.sessionIdentity = res.identity;
            this.api.setSessionExpiryHandler((error) => this.onSessionExpired(error));
        } else {
            throw new Error( vscode.l10n.t('Cannot init SocketIOAPI for {serverName}', {serverName}) );
        }
    }

    get _userId() {
        return this.userId;
    }

    get isDisposed() {
        return this.disposed;
    }

    get connectionState(): VFSConnectionState {
        return this._connectionState;
    }

    async reconnect(reason = 'manual reconnect'): Promise<ProjectEntity> {
        if (this.disposed) {
            throw new Error(`Cannot reconnect disposed Overleaf project ${this.origin.toString()}`);
        }
        if (this._connectionState==='reconnecting' && this.initializing) {
            return this.initializing;
        }
        console.log(`Reconnecting Overleaf project ${this.origin.toString()}: ${reason}`);
        this.setConnectionState('reconnecting');
        this.retryConnection = Math.max(this.retryConnection, 1);
        this.captureRejoinState();
        this.root = undefined;
        this.initializing = this.initializingPromise;
        return this.initializing;
    }

    async ensureConnectedForWrite(): Promise<void> {
        this.requireCurrentSession();
        if (this.connectionState==='connected') {
            return;
        }
        if (this.initializing) {
            await this.initializing;
            return;
        }
        await this.reconnect('before remote write');
    }

    private requireCurrentSession(): Identity {
        if (this.disposed) {
            throw vscode.FileSystemError.Unavailable(
                `Overleaf project is disposed: ${this.origin.toString()}`,
            );
        }
        try {
            return GlobalStateManager.requireAuthenticatedIdentity(
                this.context,
                this.serverName,
                this.userId,
                this.sessionIdentity,
            );
        } catch (error) {
            // Disposal alone is invisible: it used to leave the status bar
            // claiming a live sync while every later read threw. Tell the user
            // how to recover before tearing the project down.
            this.promptSessionRecovery(vscode.l10n.t(
                'Overleaf session for {serverName} is no longer available. Please log in again.',
                {serverName: this.serverName},
            ));
            this.dispose();
            throw error;
        }
    }

    private onSessionExpired(error: Error) {
        if (this.disposed) { return; }
        // The websocket keeps serving reads after the HTTP session dies, so
        // without this the project silently degrades into a one-way sync:
        // mkdir/upload/rename/remove/compile all fail forever with a generic
        // error and no re-login is ever offered.
        console.warn(`Overleaf session expired for ${this.origin.toString()}:`, error);
        this.setConnectionState('disconnected');
        this.promptSessionRecovery(vscode.l10n.t(
            'Overleaf session expired: {serverName}. Changes can no longer be saved until you log in again.',
            {serverName: this.serverName},
        ));
    }

    private promptSessionRecovery(message: string) {
        if (this.sessionRecoveryPrompted) { return; }
        this.sessionRecoveryPrompted = true;
        const openLogin = vscode.l10n.t('Open Login');
        vscode.window.showErrorMessage(message, openLogin).then((choice) => {
            if (choice===openLogin) {
                vscode.commands.executeCommand(`workbench.view.extension.${ROOT_NAME}`);
            }
        }, () => undefined);
    }

    private setConnectionState(next: VFSConnectionState) {
        if (this.disposed) { return; }
        if (this._connectionState===next) { return; }
        this._connectionState = next;
        this._onDidChangeConnectionEmitter.fire(next);
    }

    private acceptRemoteEvent(): boolean {
        if (this.disposed) { return false; }
        try {
            this.requireCurrentSession();
            return true;
        } catch (error) {
            console.warn(
                `Discarding an event from a stale Overleaf session for ${this.origin.toString()}:`,
                error,
            );
            return false;
        }
    }

    async init() : Promise<ProjectEntity> {
        if (this.disposed) {
            throw vscode.FileSystemError.Unavailable(`Overleaf project is disposed: ${this.origin.toString()}`);
        }
        this.requireCurrentSession();
        if (this.root) {
            this.ensureActiveManagers();
            return Promise.resolve(this.root);
        }

        if (!this.initializing) {
            this.initializing = this.initializingPromise;
        }
        return this.initializing;
    }

    configureInitialSCMRestore(restorePersistedSCMs: boolean) {
        if (this.scmCollectionItem) {
            return;
        }
        this.restorePersistedSCMsOnManagerCreation = restorePersistedSCMs;
    }

    private ensureActiveManagers(force = false) {
        if (this.disposed) { return; }
        const activeCondition = force
            || this.isActiveProject?.()===true
            || (vscode.workspace.workspaceFolders ?? []).some(folder =>
                folder.uri.scheme===ROOT_NAME
                && vfsProjectKey(folder.uri)===vfsProjectKey(this.origin)
            );
        if (!activeCondition) { return; }

        if (!this.clientManagerItem) {
            const clientManager = new ClientManager(this, this.context, this.publicId||'', this.socket);
            this.clientManagerItem = {
                manager: clientManager,
                triggers: clientManager.triggers,
            };
        }
        if (!this.scmCollectionItem) {
            const scmCollection = new SCMCollectionProvider(this, this.context, {
                restorePersistedSCMs: this.restorePersistedSCMsOnManagerCreation,
            });
            this.scmCollectionItem = {
                collection: scmCollection,
                triggers: scmCollection.triggers,
            };
        }
    }

    private getConnectionFailureMessage(error?: unknown): string {
        const reason = error instanceof Error ? error.message : typeof error==='string' ? error : undefined;
        if (reason && reason!=='timeout' && reason!=='connect_failed') {
            return vscode.l10n.t(
                'Connection lost: {serverName} ({reason})',
                {serverName:this.serverName, reason},
            );
        }
        return vscode.l10n.t('Connection lost: {serverName}', {serverName:this.serverName});
    }

    private isRetryableConnectionError(error: unknown): boolean {
        return (error as {retryable?: boolean})?.retryable!==false;
    }

    private async backoffBeforeRetry(): Promise<void> {
        const backoffs = VirtualFileSystem.reconnectBackoffMs;
        const delay = backoffs[Math.min(Math.max(this.retryConnection, 1), backoffs.length)-1];
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    /**
     * A rejoin replaces every entity object in the project tree, so everything
     * the write and notification paths still need has to be lifted out of it
     * first.
     */
    private captureRejoinState() {
        if (this.root===undefined) { return; }
        const paths = new Set<string>();
        const cachedDocPaths: string[] = [];
        for (const {entity, path} of this.walk(() => true)) {
            if (path==='/') { continue; }
            paths.add(path);
            if (entity._type!=='doc') { continue; }
            const doc = entity as DocumentEntity;
            if (doc.localCache!==undefined || doc.remoteCache!==undefined) {
                cachedDocPaths.push(path);
            }
            this.preserveDocumentBaseline(doc);
        }
        this.pendingRejoinSnapshot = {paths, cachedDocPaths};
        // An in-doubt barrier can only be consumed by a sender-ack from the
        // socket that produced it, which can never arrive across a rejoin. A
        // surviving barrier forces full joinDoc reconciliation on every future
        // save of that document and steals the ack of the next write.
        this.documentInDoubtSenderVersions.clear();
    }

    private preserveDocumentBaseline(doc: DocumentEntity) {
        // The merge base is the last text the local side is known to have been
        // synchronized with. Losing it makes the next write diff the freshly
        // reloaded server text against itself: that empty patch turns the local
        // text into a silent winner which deletes every collaborator edit made
        // while we were away.
        const baseline = doc.localCache ?? doc.remoteCache;
        if (baseline===undefined) { return; }
        const baselines = this.documentMergeBaselines ?? new Map<string, string>();
        this.documentMergeBaselines = baselines;
        // Keep the oldest surviving base: a newer one would let a local buffer
        // that predates it silently revert collaborator work.
        if (!baselines.has(doc._id)) {
            baselines.set(doc._id, baseline);
        }
    }

    private preservedBaselineContent(doc: DocumentEntity): Uint8Array | undefined {
        const baseline = this.documentMergeBaselines?.get(doc._id);
        return baseline===undefined ? undefined : new TextEncoder().encode(baseline);
    }

    private clearPreservedBaseline(docId: string) {
        this.documentMergeBaselines?.delete(docId);
    }

    private notifyRejoinChanges() {
        const snapshot = this.pendingRejoinSnapshot;
        this.pendingRejoinSnapshot = undefined;
        if (snapshot===undefined) { return; }

        const currentPaths = new Set<string>();
        this.walk(() => true).forEach(({path}) => {
            if (path!=='/') { currentPaths.add(path); }
        });
        const events: vscode.FileChangeEvent[] = [];
        for (const path of snapshot.paths) {
            if (!currentPaths.has(path)) {
                events.push({type: vscode.FileChangeType.Deleted, uri: this.pathToUri(path)});
            }
        }
        for (const path of currentPaths) {
            if (!snapshot.paths.has(path)) {
                events.push({type: vscode.FileChangeType.Created, uri: this.pathToUri(path)});
            }
        }
        // Every cached revision died with the old entity graph, so whatever the
        // user may still be looking at has to be re-read from the server.
        for (const path of snapshot.cachedDocPaths) {
            if (currentPaths.has(path)) {
                events.push({type: vscode.FileChangeType.Changed, uri: this.pathToUri(path)});
            }
        }
        if (events.length>0) {
            this.notify(events);
        }
    }

    private get initializingPromise(): Promise<ProjectEntity> {
        if (this.disposed) {
            throw vscode.FileSystemError.Unavailable(`Overleaf project is disposed: ${this.origin.toString()}`);
        }
        // if retry connection failed 3 times, throw error
        if (this.retryConnection >= 3) {
            const message = this.getConnectionFailureMessage(this.lastConnectionError);
            this.retryConnection = 0;
            this.setConnectionState('disconnected');
            vscode.window.showErrorMessage(message, vscode.l10n.t('Reload')).then((choice) => {
                if (choice==='Reload') {
                    vscode.commands.executeCommand("workbench.action.reloadWindow");
                };
            });
            // reset retry connection
            this.retryConnection = 0;
            this.initializing = undefined;
            this.lastConnectionError = undefined;
            throw new Error(message);
        }
        // if evert connection failed, reset socketio
        if (this.retryConnection > 0 || this.socket.needsReinit) {
            this.setConnectionState('reconnecting');
            this.socket.init();
        }

        this.remoteWatch();
        this.captureRejoinState();
        this.root = undefined;
        return this.socket.joinProject(this.projectId).then(async (project) => {
            this.requireCurrentSession();
            // fetch project settings
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
            this.requireCurrentSession();
            const settingsResponse = await this.api.getProjectSettings(identity, this.projectId);
            this.requireCurrentSession();
            if (settingsResponse.settings===undefined) {
                // Publishing a root without settings leaves every settings
                // reader throwing later on; failing the join keeps the retry
                // budget and the session-expiry prompt in charge instead.
                throw new Error(
                    settingsResponse.message ?? 'Could not load Overleaf project settings.',
                );
            }
            project.settings = settingsResponse.settings;
            this.root = project;
            this.retryConnection = 0;
            this.lastConnectionError = undefined;
            this.restoreOutputsEntity();
            this.notifyRejoinChanges();
            this.setConnectionState('connected');
            this.ensureActiveManagers();
            return project;
        }).catch(async (err) => {
            if (this.disposed) {
                this.initializing = undefined;
                throw err;
            }
            this.lastConnectionError = err instanceof Error ? err : new Error(String(err));
            if (!this.isRetryableConnectionError(err)) {
                const message = this.getConnectionFailureMessage(err);
                this.retryConnection = 0;
                this.setConnectionState('disconnected');
                this.initializing = undefined;
                this.lastConnectionError = undefined;
                vscode.window.showErrorMessage(message);
                throw new Error(message);
            }
            if (this.socket.needsReinit) {
                // A protocol fallback is a new connection strategy, not another
                // failed attempt of the old strategy. Give it a fresh retry budget.
                this.retryConnection = 0;
            } else {
                this.retryConnection += 1;
                // Without a pause the recursion is a hot loop: a two second
                // outage exhausts the whole budget instantly and a repeatedly
                // failing join hammers the server.
                await this.backoffBeforeRetry();
                if (this.disposed) {
                    this.initializing = undefined;
                    throw err;
                }
            }
            return this.initializingPromise;
        });
    }

    get isInvisibleMode() {
        return this.socket.isUsingAlternativeConnectionScheme;
    }

    toggleInvisibleMode() {
        this.socket.toggleAlternativeConnectionScheme(this.origin.toString(), this.root);
        this.socket.disconnect(); // jump to `onDisconnected` handler
    }

    async _resolveUri(uri: vscode.Uri) {
        // resolve path
        const [parentFolder, fileName] = await (async () => {
            const {pathParts} = parseUri(uri);
            const root = await this.init();

            let currentFolder = root.rootFolder[0];
            for (let i = 0; i < pathParts.length-1; i++) {
                const folderName = pathParts[i];
                const folder = currentFolder.folders.find((folder) => folder.name === folderName);
                if (folder) {
                    currentFolder = folder;
                } else {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
            }
            const fileName = pathParts[pathParts.length-1];
            return [currentFolder, fileName];
        })();
        // resolve file
        const [fileEntity, fileType, fileId] = (() => {
            for (const _type of Object.keys(FolderKeys)) {
                // The four entity arrays have different element types, so the
                // union of their `find` overloads is not callable as such.
                let entity = (parentFolder[ FolderKeys[_type] ] as Array<any>|undefined)
                    ?.find((entity) => entity.name === fileName);
                if (!fileName && _type==='folder') { entity = parentFolder; }
                if (entity) {
                    return [entity, _type as FileType, entity._id];
                }
            }
            return [];
        })();
        return {parentFolder, fileName, fileEntity, fileType, fileId};
    }

    _resolveById(
        entityId: string,
        root?: FolderEntity,
        path?: string,
        parentFolder?: FolderEntity,
    ): {
        parentFolder: FolderEntity, fileEntity: FileEntity, fileType:FileType, path:string
    } | undefined {
        root = root || this.root?.rootFolder[0];
        if (!root) { return undefined; }
        path = path || '/';
        parentFolder = parentFolder || root;

        if (root._id === entityId) {
            return {parentFolder, fileType: 'folder', fileEntity: root, path};
        } else {
            // search files in root
            for (const _type of Object.keys(FolderKeys)) {
                const key = FolderKeys[_type];
                if (key==='folders') { continue; }
                const entity = (root[key] as Array<any>|undefined)
                    ?.find((entity) => entity._id === entityId);
                if (entity) {
                    return {parentFolder: root, fileType: _type as FileType, fileEntity: entity, path:path+entity.name};
                }
            }
            // recursive search
            for (const folder of root.folders) {
                const res = this._resolveById(entityId, folder, path+folder.name+'/', root);
                if (res) { return res; }
            }
        }
        return undefined;
    }

    walk(filter:(entity:FileEntity)=>boolean): {entity:FileEntity, path:string}[] {
        const result: {entity:FileEntity, path:string}[] = [];
        const root = this.root?.rootFolder[0];
        if (!root) { return result; }
        const folders = [{entity:root, path:'/'}];

        // apply filter to root folder
        filter(folders[0].entity) && result.push(folders[0]);
        // walk through all folders
        for (const folder of folders) {
            for (const [key,value] of Object.entries(FolderKeys)) {
                if (value==='folders') {
                    folder.entity[value]?.forEach((entity) => {
                        folders.push({entity, path:folder.path+entity.name+'/'});
                    });
                }
                folder.entity[value]?.forEach((entity) => {
                    entity._type = key as FileType;
                    filter(entity) && result.push({ entity, path:folder.path+entity.name });
                });
            };
        }

        return result;
    }

    private insertEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index===undefined || index<0) {
            parentFolder[key]?.push(entity as any);
        }
    }

    private removeEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index!==undefined && index>=0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private removeEntityById(parentFolder: FolderEntity, fileType:FileType, entityId: string, recursive?:boolean) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entityId);
        if (index!==undefined && index>=0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private appendCreatedEntityEvents(
        events: vscode.FileChangeEvent[],
        fileType: FileType,
        entity: FileEntity,
        entityPath: string,
    ) {
        events.push({
            type: vscode.FileChangeType.Created,
            uri: this.pathToUri(entityPath),
        });
        if (fileType!=='folder') { return; }

        const folder = entity as FolderEntity;
        for (const [type, key] of Object.entries(FolderKeys) as Array<[FileType, FolderKey]>) {
            if (type==='outputs') { continue; }
            for (const child of folder[key] ?? []) {
                const childPath = `${entityPath.replace(/\/+$/, '')}/${child.name}`;
                this.appendCreatedEntityEvents(events, type, child, childPath);
            }
        }
    }

    private createdEntityEvents(fileType: FileType, entity: FileEntity, entityPath: string) {
        const events: vscode.FileChangeEvent[] = [];
        this.appendCreatedEntityEvents(events, fileType, entity, entityPath);
        return events;
    }

    private remoteWatch(): void {
        if (this.disposed) { return; }
        this.remoteWatchDisposable?.dispose();
        this.remoteWatchDisposable = this.socket.updateEventHandlers({
            onDisconnected: () => {
                if (!this.acceptRemoteEvent()) { return; }
                if (this.root===undefined) { return; } // bypass the first initialization
                console.log("Disconnected");
                this.setConnectionState('reconnecting');
                this.retryConnection += 1;
                this.initializing = this.initializingPromise;
            },
            onConnectionAccepted: (publicId:string) => {
                if (!this.acceptRemoteEvent()) { return; }
                // A transport handshake is not a project join. Resetting the
                // retry budget here made a handshake that always succeeds and a
                // join that always fails recurse forever with zero backoff, and
                // announcing 'connected' advertised a project whose tree is
                // still undefined. Both now wait for joinProject to succeed.
                this.publicId = publicId;
            },
            onFileCreated: (parentFolderId:string, type:FileType, entity:FileEntity) => {
                if (!this.acceptRemoteEvent()) { return; }
                const res = this._resolveById(parentFolderId);
                if (res) {
                    const {fileEntity,path} = res;
                    const entityPath = path + entity.name;
                    this.insertEntity(fileEntity as FolderEntity, type, entity);
                    this.notify([
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(entityPath)}
                    ]);
                }
            },
            onFileRenamed: (entityId:string, newName:string) => {
                if (!this.acceptRemoteEvent()) { return; }
                const res = this._resolveById(entityId);
                if (res) {
                    const {fileEntity} = res;
                    const oldPathWithoutTrailingSlash = res.path.replace(/\/+$/, '');
                    const parentPath = oldPathWithoutTrailingSlash.slice(
                        0,
                        oldPathWithoutTrailingSlash.lastIndexOf('/')+1,
                    );
                    const newPath = parentPath+newName;
                    fileEntity.name = newName;
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)},
                        ...this.createdEntityEvents(res.fileType, fileEntity, newPath),
                    ]);
                }
            },
            onFileRemoved: (entityId:string) => {
                if (!this.acceptRemoteEvent()) { return; }
                const res = this._resolveById(entityId);
                if (res) {
                    const {parentFolder, fileType, fileEntity} = res;
                    this.removeEntity(parentFolder, fileType, fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)}
                    ]);
                }
            },
            onFileMoved: (entityId:string, folderId:string) => {
                if (!this.acceptRemoteEvent()) { return; }
                const oldPath = this._resolveById(entityId);
                const newPath = this._resolveById(folderId);
                if (oldPath && newPath) {
                    const newParentFolder = newPath.fileEntity as FolderEntity;
                    this.insertEntity(newParentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(oldPath.path)},
                        ...this.createdEntityEvents(
                            oldPath.fileType,
                            oldPath.fileEntity,
                            `${newPath.path.replace(/\/+$/, '')}/${oldPath.fileEntity.name}`,
                        ),
                    ]);
                }
            },
            onFileChanged: (update:UpdateSchema) => {
                if (!this.acceptRemoteEvent()) { return; }
                this.applyRemoteDocumentUpdate(update);
            },
            onOtUpdateError: (error, message) => {
                if (!this.acceptRemoteEvent()) { return; }
                this.applyRemoteDocumentUpdateError(error, message);
            },
            onSpellCheckLanguageUpdated: (language:string) => {
                if (!this.acceptRemoteEvent()) { return; }
                if (this.root) {
                    this.root.spellCheckLanguage = language;
                    EventBus.fire('spellCheckLanguageUpdateEvent', {language});
                }
            },
            onCompilerUpdated: (compiler:string) => {
                if (!this.acceptRemoteEvent()) { return; }
                if (this.root) {
                    this.root.compiler = compiler;
                    EventBus.fire('compilerUpdateEvent', {compiler});
                }
            },
            onRootDocUpdated: (rootDocId:string) => {
                if (!this.acceptRemoteEvent()) { return; }
                //NOTE: do not sync rootDocId
                // if (this.root) {
                //     this.root.rootDoc_id = rootDocId;
                //     EventBus.fire('rootDocUpdateEvent', {rootDocId});
                // }
            },
        });
    }

    pathToUri(...path: string[]): vscode.Uri {
        return vscode.Uri.joinPath(this.origin, ...path);
    }

    // Drain any pending Local Replica push for a local file URI before the
    // caller runs an operation that depends on the VFS reflecting it (e.g.
    // compile-on-save in local replica mode races the EVENT_COALESCE_MS
    // debounce in syncToVFS).
    public async flushPendingLocalPush(localUri: vscode.Uri): Promise<void> {
        await this.scmCollectionItem?.collection.flushPendingLocalPush(localUri);
    }

    public async flushLocalReplicaBeforeCompile(localUris: vscode.Uri[] = []): Promise<void> {
        const activeReplicaOrigin = getActiveReplicaOriginUri();
        if (
            !activeReplicaOrigin
            || vfsProjectKey(activeReplicaOrigin)!==vfsProjectKey(this.origin)
        ) {
            return;
        }

        this.ensureActiveManagers(true);
        const collection = this.scmCollectionItem?.collection;
        const activeReplicaRoot = getActiveReplicaRoot();
        if (!collection || !activeReplicaRoot) {
            throw new Error('Active Local Replica manager is not available.');
        }
        await collection.flushLocalReplicaBeforeCompile(localUris, activeReplicaRoot);
    }

    public async removeLocalReplicaSCM(
        scmKey: string,
        baseUri: vscode.Uri,
    ): Promise<void> {
        const collection = this.scmCollectionItem?.collection;
        if (collection) {
            await collection.removeLocalReplicaSCM(scmKey, baseUri);
        } else {
            const detachedCollection = new SCMCollectionProvider(
                this,
                this.context,
                {restorePersistedSCMs: false},
            );
            try {
                await detachedCollection.removeLocalReplicaSCM(scmKey, baseUri);
            } finally {
                detachedCollection.dispose();
            }
        }
    }

    async resolve(uri: vscode.Uri): Promise<File> {
        const {fileName, fileEntity, fileType} = await this._resolveUri(uri);
        const readonly = fileEntity?.readonly ? vscode.FilePermission.Readonly : undefined;
        switch (fileType) {
            case undefined:
                throw vscode.FileSystemError.FileNotFound(uri);
            case 'folder':
                return new File(fileName, vscode.FileType.Directory, undefined, readonly);
            case 'file':
                if ((fileEntity as FileRefEntity).linkedFileData!==null) {
                    return new File(fileName, vscode.FileType.File | vscode.FileType.SymbolicLink, Date.parse((fileEntity as FileRefEntity).created), readonly);
                } else {
                    return new File(fileName, vscode.FileType.File, Date.parse((fileEntity as FileRefEntity).created), readonly);
                }
            default:
                return new File(fileName, vscode.FileType.File, undefined, readonly);
        }
    }

    async list(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const {fileEntity} = await this._resolveUri(uri);
        const folder = fileEntity as FolderEntity;
        let results:[string, vscode.FileType][] = [];
        if (folder) {
            Object.values(FolderKeys).forEach((key) => {
                const _type = key==='folders'? vscode.FileType.Directory : vscode.FileType.File;
                folder[key]?.forEach((entity) => {
                    results.push([entity.name, _type]);
                });
            });
        }
        return results;
    }

    private invalidateRemoteDocumentCache(
        doc: DocumentEntity,
        path: string,
    ): void {
        this.preserveDocumentBaseline(doc);
        doc.remoteCache = undefined;
        doc.localCache = undefined;
        this.isDirty = true;
        this.notify([{
            type: vscode.FileChangeType.Changed,
            uri: this.pathToUri(path),
        }]);
    }

    private discardQueuedRemoteDocumentUpdates(docId: string): void {
        this.queuedRemoteDocumentUpdates?.delete(docId);
        const timer = this.queuedRemoteDocumentUpdateTimers?.get(docId);
        if (timer) {
            clearTimeout(timer);
        }
        this.queuedRemoteDocumentUpdateTimers?.delete(docId);
    }

    private queueRemoteDocumentUpdate(
        doc: DocumentEntity,
        path: string,
        update: UpdateSchema,
    ): void {
        const queuedByDocument = this.queuedRemoteDocumentUpdates ?? new Map<string, UpdateSchema[]>();
        this.queuedRemoteDocumentUpdates = queuedByDocument;
        const queued = queuedByDocument.get(doc._id) ?? [];
        queuedByDocument.set(doc._id, queued);

        // A ShareJS revision can have only one operation. Treat a repeat at
        // the same base version as a duplicate rather than extending the
        // timeout or applying it twice.
        if (!queued.some(candidate => candidate.v===update.v)) {
            queued.push(update);
            queued.sort((left, right) => left.v-right.v);
        }
        if (queued.length>VirtualFileSystem.maxQueuedRemoteDocumentUpdates) {
            this.discardQueuedRemoteDocumentUpdates(doc._id);
            this.invalidateRemoteDocumentCache(doc, path);
            return;
        }

        const timers = this.queuedRemoteDocumentUpdateTimers ?? new Map<string, ReturnType<typeof setTimeout>>();
        this.queuedRemoteDocumentUpdateTimers = timers;
        if (timers.has(doc._id)) { return; }
        timers.set(doc._id, setTimeout(() => {
            const timedOut = this.queuedRemoteDocumentUpdates?.get(doc._id);
            this.discardQueuedRemoteDocumentUpdates(doc._id);
            if (this.disposed || !timedOut?.length) { return; }
            const current = this._resolveById(doc._id);
            if (current===undefined) { return; }
            this.invalidateRemoteDocumentCache(
                current.fileEntity as DocumentEntity,
                current.path,
            );
        }, VirtualFileSystem.queuedRemoteDocumentUpdateTimeoutMs));
    }

    private drainQueuedRemoteDocumentUpdates(docId: string): boolean {
        const queued = this.queuedRemoteDocumentUpdates?.get(docId);
        if (!queued?.length) {
            this.discardQueuedRemoteDocumentUpdates(docId);
            return true;
        }
        const res = this._resolveById(docId);
        if (res===undefined) {
            this.discardQueuedRemoteDocumentUpdates(docId);
            return false;
        }
        const doc = res.fileEntity as DocumentEntity;
        if (doc.version===undefined || doc.remoteCache===undefined) {
            return false;
        }
        while (queued.length>0) {
            const next = queued[0];
            if (next.v<doc.version) {
                // The current authoritative cache/rejoin already includes it.
                queued.shift();
                continue;
            }
            if (next.v>doc.version) {
                return false;
            }
            queued.shift();
            this.applyRemoteDocumentUpdateInOrder(next, res, true);
            if (doc.remoteCache===undefined) {
                this.discardQueuedRemoteDocumentUpdates(docId);
                return false;
            }
        }
        this.discardQueuedRemoteDocumentUpdates(docId);
        return true;
    }

    private applyRemoteDocumentUpdate(update: UpdateSchema): void {
        const res = this._resolveById(update.doc);
        if (res===undefined) { return; }
        const doc = res.fileEntity as DocumentEntity;
        const hasOperation = Boolean(update.op?.length);
        // Queue only a small delivery inversion. A larger gap means this
        // subscription missed state, so the fail-closed path below preserves
        // the merge base and triggers an authoritative rejoin.
        if (
            hasOperation
            && doc.version!==undefined
            && doc.remoteCache!==undefined
            && update.v>doc.version
            && update.v-doc.version<=VirtualFileSystem.maxQueuedRemoteDocumentVersionGap
        ) {
            this.documentCollaboratorRevisions.set(
                doc._id,
                (this.documentCollaboratorRevisions.get(doc._id) ?? 0) + 1,
            );
            this.queueRemoteDocumentUpdate(doc, res.path, update);
            return;
        }
        if (hasOperation) {
            this.documentCollaboratorRevisions.set(
                doc._id,
                (this.documentCollaboratorRevisions.get(doc._id) ?? 0) + 1,
            );
        }
        this.applyRemoteDocumentUpdateInOrder(update, res, hasOperation);
        this.drainQueuedRemoteDocumentUpdates(doc._id);
    }

    private applyRemoteDocumentUpdateInOrder(
        update: UpdateSchema,
        res: {fileEntity: FileEntity, path: string},
        hasOperation: boolean,
    ): void {
        const doc = res.fileEntity as DocumentEntity;
        const pending = this.pendingDocumentWrites.get(doc._id);
        const inDoubtVersions = this.documentInDoubtSenderVersions.get(doc._id);
        let consumedInDoubtSenderEvent = false;
        if (!hasOperation && inDoubtVersions?.length) {
            const barrierIndex = inDoubtVersions.findIndex(version => update.v>=version);
            if (barrierIndex!==-1) {
                inDoubtVersions.splice(barrierIndex, 1);
                consumedInDoubtSenderEvent = true;
                if (inDoubtVersions.length===0) {
                    this.documentInDoubtSenderVersions.delete(doc._id);
                }
            }
        }
        if (
            !hasOperation
            && !consumedInDoubtSenderEvent
            && pending
            && update.v>=pending.submittedVersion
            && pending.appliedVersion===undefined
        ) {
            pending.appliedVersion = update.v;
            pending.resolveApplied(update.v);
        }

        if (doc.version!==undefined && update.v<doc.version) {
            // An authoritative rejoin can overtake a delayed sender ack. An
            // older operation is likewise already represented by this cache.
            return;
        }

        if (update.v===doc.version) {
            if (hasOperation && doc.remoteCache!==undefined) {
                let content = doc.remoteCache;
                let valid = true;
                for (const op of update.op ?? []) {
                    if (
                        !Number.isSafeInteger(op.p)
                        || op.p<0
                        || op.p>content.length
                        || (op.i!==undefined && op.d!==undefined)
                    ) {
                        valid = false;
                        break;
                    }
                    if (typeof op.i==='string') {
                        content = content.slice(0, op.p) + op.i + content.slice(op.p);
                    } else if (typeof op.d==='string') {
                        const deleted = Buffer.from(op.d, 'ascii').toString('utf-8');
                        if (content.slice(op.p, op.p+deleted.length)!==deleted) {
                            valid = false;
                            break;
                        }
                        content = content.slice(0, op.p) + content.slice(op.p+deleted.length);
                    } else {
                        valid = false;
                        break;
                    }
                }
                if (!valid) {
                    this.invalidateRemoteDocumentCache(doc, res.path);
                    return;
                }
                doc.version += 1;
                const remoteUri = this.pathToUri(res.path);
                const openDocument = vscode.workspace.textDocuments.find(
                    candidate => candidate.uri.toString()===remoteUri.toString(),
                );
                if (!openDocument || !openDocument.isDirty) {
                    doc.localCache = content;
                    // Local and remote agree again, so a base preserved by an
                    // earlier invalidation is obsolete.
                    this.clearPreservedBaseline(doc._id);
                }
                doc.remoteCache = content;
                this.isDirty = true;
                this.notify([{type: vscode.FileChangeType.Changed, uri: remoteUri}]);
            } else {
                doc.version += 1;
                if (!hasOperation && !pending) {
                    // A sender acknowledgement without its pending write
                    // context proves a version advance, not accepted content.
                    this.invalidateRemoteDocumentCache(doc, res.path);
                }
            }
        } else {
            // A missing (rather than merely delayed) OT update invalidates the
            // cache. Local Replica receives a change event and rejoins before
            // it can use this document as a write baseline.
            this.invalidateRemoteDocumentCache(doc, res.path);
        }
    }

    private applyRemoteDocumentUpdateError(
        error: unknown,
        message?: OtUpdateErrorSchema,
    ): void {
        const docId = message?.doc_id;
        if (typeof docId!=='string' || docId==='') { return; }
        const res = this._resolveById(docId);
        if (res===undefined || res.fileType!=='doc') { return; }

        const detail = error instanceof Error
            ? error.message
            : typeof error==='string'
                ? error
                : message?.error ?? 'unknown Overleaf OT update error';
        const rejection = new RemoteDocumentWriteAmbiguousError(
            `Overleaf rejected the document update for ${res.path}: ${detail}`,
        );
        const doc = res.fileEntity as DocumentEntity;
        const pending = this.pendingDocumentWrites.get(docId);
        if (pending) {
            pending.rejectedError = rejection;
            pending.resolveApplied();
        }

        this.discardQueuedRemoteDocumentUpdates(docId);
        this.invalidateRemoteDocumentCache(doc, res.path);
    }

    private async enqueueDocumentWrite<T>(docId: string, task: () => Promise<T>): Promise<T> {
        const previous = this.documentWriteQueues.get(docId) ?? Promise.resolve();
        const result = previous
            .catch(() => undefined)
            .then(task);
        const settled = result.then(
            () => undefined,
            () => undefined,
        );
        this.documentWriteQueues.set(docId, settled);
        try {
            return await result;
        } finally {
            if (this.documentWriteQueues.get(docId)===settled) {
                this.documentWriteQueues.delete(docId);
            }
        }
    }

    private async waitForDocumentApplied(
        pending: PendingDocumentWrite,
        timeoutMs: number,
    ): Promise<number | undefined> {
        if (pending.appliedVersion!==undefined) {
            return pending.appliedVersion;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                pending.applied,
                new Promise<undefined>(resolve => {
                    timer = setTimeout(() => resolve(undefined), timeoutMs);
                }),
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    private canReplayInFlightDocumentUpdate(
        acknowledgementError: unknown,
        pending: PendingDocumentWrite,
    ): boolean {
        // `dupIfSource` is proof-based: without the source identity of the
        // original submission, repeating an uncertain OT could duplicate user
        // text. Explicit server rejections are never replayed.
        if (
            pending.rejectedError!==undefined
            || pending.appliedVersion!==undefined
            || pending.submittedSourceIds.length===0
            || !(acknowledgementError instanceof Error)
        ) {
            return false;
        }
        return acknowledgementError.message==='timeout'
            || this.connectionState!=='connected'
            || this.socket.needsReinit;
    }

    private async replayInFlightDocumentUpdate(
        uri: vscode.Uri,
        update: UpdateSchema,
        pending: PendingDocumentWrite,
    ): Promise<unknown | undefined> {
        try {
            if (pending.rejectedError!==undefined) {
                return pending.rejectedError;
            }
            // A fresh project join supplies the new public id. The original
            // id remains in the set so the server can recognize an update it
            // accepted just before the old transport disappeared.
            if (this.connectionState!=='connected' || this.socket.needsReinit) {
                await this.reconnect(`retry in-flight document update ${uri.path}`);
            }
            this.requireCurrentSession();
            const duplicateSources = Array.from(new Set([
                ...pending.submittedSourceIds,
                ...(this.publicId ? [this.publicId] : []),
            ]));
            if (duplicateSources.length===0) {
                return new RemoteDocumentWriteAmbiguousError(
                    `Overleaf did not provide a source identity for ${uri.path}.`,
                );
            }
            pending.submittedSourceIds = duplicateSources;
            await this.socket.applyOtUpdate(update.doc, {
                ...update,
                dupIfSource: duplicateSources,
            });
            this.requireCurrentSession();
            return undefined;
        } catch (error) {
            return error;
        }
    }

    private documentRefreshTargets(doc: DocumentEntity): DocumentEntity[] {
        const live = this._resolveById(doc._id)?.fileEntity as DocumentEntity | undefined;
        // A rejoin swaps the whole entity graph, so the caller may be holding a
        // document that is no longer in the tree. Seed both, otherwise one of
        // them keeps serving a pre-outage revision.
        return live!==undefined && live!==doc ? [doc, live] : [doc];
    }

    private async refreshDocumentFromServer(
        uri: vscode.Uri,
        doc: DocumentEntity,
        forceFullSnapshot = false,
    ): Promise<Uint8Array> {
        let releaseTurn!: () => void;
        const previousTurn = this.documentJoinQueue;
        this.documentJoinQueue = new Promise<void>(resolve => {
            releaseTurn = resolve;
        });
        await previousTurn;
        try {
            // A proof step after an ambiguous OT write cannot trust the cached
            // revision even when its version matches the server. Ordinary
            // subscribed refreshes may safely use the versioned OT catch-up.
            return await this.refreshDocumentFromServerNow(uri, doc, forceFullSnapshot);
        } finally {
            releaseTurn();
        }
    }

    private applyJoinDocCatchUp(
        uri: vscode.Uri,
        doc: DocumentEntity,
        response: {version: number; updates?: UpdateSchema[]; type?: string},
    ): Uint8Array | undefined {
        const startingVersion = doc.version;
        const startingContent = doc.remoteCache;
        const updates = response.updates ?? [];
        if (
            startingVersion===undefined
            || startingContent===undefined
            || response.version<startingVersion
            || (response.type!==undefined && response.type!=='sharejs-text-ot')
        ) {
            return undefined;
        }

        let content = startingContent;
        let expectedVersion = startingVersion;
        for (const update of updates) {
            if (
                (update.doc!==undefined && update.doc!==doc._id)
                || (update.v!==undefined && update.v!==expectedVersion)
                || !Array.isArray(update.op)
                || update.op.length===0
            ) {
                return undefined;
            }
            for (const operation of update.op) {
                if (
                    !Number.isSafeInteger(operation.p)
                    || operation.p<0
                    || operation.p>content.length
                    || (operation.i!==undefined && operation.d!==undefined)
                ) {
                    return undefined;
                }
                if (typeof operation.i==='string') {
                    content = content.slice(0, operation.p) + operation.i + content.slice(operation.p);
                } else if (typeof operation.d==='string') {
                    const deleted = Buffer.from(operation.d, 'ascii').toString('utf-8');
                    if (content.slice(operation.p, operation.p+deleted.length)!==deleted) {
                        return undefined;
                    }
                    content = content.slice(0, operation.p) + content.slice(operation.p+deleted.length);
                } else {
                    return undefined;
                }
            }
            expectedVersion += 1;
        }
        if (expectedVersion!==response.version) {
            return undefined;
        }
        for (const target of this.documentRefreshTargets(doc)) {
            target.version = response.version;
            target.remoteCache = content;
            target.localCache = content;
        }
        this.isDirty = true;
        if (content!==startingContent) {
            this.notify([{type: vscode.FileChangeType.Changed, uri}]);
        }
        if (!this.drainQueuedRemoteDocumentUpdates(doc._id)) {
            return undefined;
        }
        return new TextEncoder().encode(doc.remoteCache ?? content);
    }

    private async refreshDocumentFromServerNow(
        uri: vscode.Uri,
        doc: DocumentEntity,
        forceFullSnapshot = false,
    ): Promise<Uint8Array> {
        // `joinDoc` is only answered by a socket that has already joined the
        // project. Dispatching it into a socket that is still (re)joining never
        // gets an ack, so it burns three 20s timeouts and then fails the user's
        // save with the caches nulled.
        if (this.initializing) {
            await this.initializing;
        } else if (this._connectionState==='disconnected') {
            await this.reconnect(`join document ${uri.path}`);
        }
        this.requireCurrentSession();
        // Match the official editor: when we still hold a subscribed text
        // revision, ask the real-time service for the exact operations since
        // that revision. A malformed, unavailable, or non-text catch-up is
        // never applied speculatively; retry once with a full snapshot.
        let requireFullSnapshot = forceFullSnapshot;
        for (let attempt = 0; attempt<3; attempt++) {
            const collaboratorRevision = this.documentCollaboratorRevisions.get(doc._id) ?? 0;
            const fromVersion = !requireFullSnapshot
                && doc.version!==undefined
                && doc.remoteCache!==undefined
                ? doc.version
                : undefined;
            const response = await this.socket.joinDoc(doc._id, fromVersion);
            this.requireCurrentSession();
            if (
                (this.documentCollaboratorRevisions.get(doc._id) ?? 0)
                !== collaboratorRevision
            ) {
                continue;
            }
            if (doc.version!==undefined && doc.version>response.version) {
                requireFullSnapshot = true;
                continue;
            }
            if (fromVersion!==undefined) {
                const caughtUp = this.applyJoinDocCatchUp(uri, doc, response);
                if (caughtUp!==undefined) {
                    return caughtUp;
                }
                requireFullSnapshot = true;
                continue;
            }
            const content = response.docLines.join('\n');
            for (const target of this.documentRefreshTargets(doc)) {
                target.version = response.version;
                target.remoteCache = content;
                target.localCache = content;
            }
            this.isDirty = true;
            if (!this.drainQueuedRemoteDocumentUpdates(doc._id)) {
                requireFullSnapshot = true;
                continue;
            }
            return new TextEncoder().encode(doc.remoteCache ?? content);
        }
        throw new RemoteDocumentWriteAmbiguousError(
            `Could not obtain a current Overleaf revision for ${uri.path}.`,
        );
    }

    async downloadDocumentSnapshot(uri: vscode.Uri): Promise<Uint8Array> {
        if (this.initializing) {
            await this.initializing;
        } else if (this._connectionState==='disconnected') {
            await this.reconnect(`download document snapshot ${uri.path}`);
        }
        const identity = this.requireCurrentSession();
        const {fileType, fileEntity} = await this._resolveUri(uri);
        this.requireCurrentSession();
        if (fileType!=='doc' || !fileEntity?._id) {
            throw vscode.FileSystemError.Unavailable(
                `Overleaf path is not a downloadable document: ${uri.path}`,
            );
        }
        const response = await this.api.getDocumentSnapshot(
            identity,
            this.projectId,
            fileEntity._id,
        );
        this.requireCurrentSession();
        return response.content!;
    }

    async downloadDocumentSnapshots(
        uris: vscode.Uri[],
    ): Promise<Map<string, Uint8Array>> {
        if (this.initializing) {
            await this.initializing;
        } else if (this._connectionState==='disconnected') {
            await this.reconnect('download document snapshots');
        }
        const identity = this.requireCurrentSession();
        const documents = await Promise.all(uris.map(async uri => {
            const {fileType, fileEntity} = await this._resolveUri(uri);
            if (fileType!=='doc' || !fileEntity?._id) { return undefined; }
            return {uri, docId: fileEntity._id};
        }));
        this.requireCurrentSession();
        const requested = documents.filter(
            (entry): entry is {uri: vscode.Uri; docId: string} => entry!==undefined,
        );
        const snapshots = await this.api.getDocumentSnapshots(
            identity,
            this.projectId,
            requested.map(entry => entry.docId),
        );
        this.requireCurrentSession();
        const result = new Map<string, Uint8Array>();
        for (const {uri, docId} of requested) {
            const content = snapshots.get(docId);
            if (content===undefined) {
                throw new Error(`Overleaf document snapshot was omitted: ${uri.path}`);
            }
            result.set(uri.toString(), content);
        }
        return result;
    }

    get documentSnapshotTransport(): 'h2' | 'http1' {
        return this.api.documentSnapshotTransport;
    }

    private desiredChangeIsPresent(
        submittedRemote: Uint8Array,
        desired: Uint8Array,
        authoritative: Uint8Array,
    ): boolean {
        if (Buffer.from(desired).equals(Buffer.from(authoritative))) {
            return true;
        }
        const merged = mergeUtf8Text(submittedRemote, desired, authoritative);
        return merged!==undefined && Buffer.from(merged).equals(Buffer.from(authoritative));
    }

    async openFile(uri: vscode.Uri): Promise<Uint8Array> {
        const identity = this.requireCurrentSession();
        const {fileType, fileEntity} = await this._resolveUri(uri);
        this.requireCurrentSession();
        if (!fileEntity) {
            throw vscode.FileSystemError.FileNotFound();
        }

        if (fileType==='doc') {
            const doc = fileEntity as DocumentEntity;
            if (doc.remoteCache!==undefined) {
                const content = doc.remoteCache;
                EventBus.fire('fileWillOpenEvent', {uri});
                return new TextEncoder().encode(content);
            } else {
                const content = await this.refreshDocumentFromServer(uri, doc);
                EventBus.fire('fileWillOpenEvent', {uri});
                return content;
            }
        } else if (fileType==='outputs') {
            const {compileGroup, clsiServerId, pdfDownloadDomain} = this;
            const res = await this.api.getFileFromClsi(
                identity,
                (fileEntity as OutputFileEntity).url,
                compileGroup || 'standard',
                clsiServerId,
                pdfDownloadDomain,
            );
            this.requireCurrentSession();
            if (res.type==='success') {
                EventBus.fire('fileWillOpenEvent', {uri});
                return res.content;
            }
            return new Uint8Array(0);
        } else {
            const fileId = fileEntity._id;
            const res = await this.api.getFile(identity, this.projectId, fileId);
            this.requireCurrentSession();
            if (res.type==='success' && res.content) {
                EventBus.fire('fileWillOpenEvent', {uri});
                return res.content;
            } else {
                throw vscode.FileSystemError.Unavailable(
                    `Could not download Overleaf file "${fileEntity.name}".`,
                );
            }
        }
    }

    async createFile(uri: vscode.Uri, content:Uint8Array, overwrite?:boolean) {
        const {parentFolder, fileName, fileEntity} = await this._resolveUri(uri);
        if (fileEntity && !overwrite) {
            throw vscode.FileSystemError.FileExists(uri);
        }

        let res = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);

        if (content.length===0) {
            const _res = await this.api.addDoc(identity, this.projectId, parentFolder._id, fileName);
            this.requireCurrentSession();
            if (_res.type==='success' && _res.entity!==undefined) {
                res = _res.entity;
            } else {
                const message = _res.message ?? `Could not create Overleaf document "${fileName}".`;
                vscode.window.showErrorMessage(message);
                throw this.createMutationResponseError(message, _res.status);
            }
        } else {
            const parentFolderId = parentFolder._id;
            const _res = await this.api.uploadFile(identity, this.projectId, parentFolderId, fileName, content);
            this.requireCurrentSession();
            if (_res.type==='success' && _res.entity!==undefined) {
                res = _res.entity;
            } else {
                const message = _res.message ?? `Could not upload Overleaf file "${fileName}".`;
                vscode.window.showErrorMessage(message);
                throw this.createMutationResponseError(message, _res.status);
            }
        }
        if (res && res._type) {
            this.insertEntity(parentFolder, res._type, res);
            this.notify([
                {type: vscode.FileChangeType.Created, uri: uri},
            ]);
            return;
        }
        const message = `Overleaf returned an invalid entity while creating "${fileName}".`;
        vscode.window.showErrorMessage(message);
        throw new RemoteMutationRetryableError(message, true);
    }

    private createMutationResponseError(message: string, status?: number): Error {
        if (status===408 || status===409 || (status!==undefined && status>=500)) {
            return new RemoteMutationRetryableError(message, true);
        }
        if (status===423 || status===425 || status===429) {
            return new RemoteMutationRetryableError(message, false);
        }
        return new RemoteMutationRejectedError(message);
    }

    async refreshLinkedFile(uri: vscode.Uri) {
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType==='file' && fileEntity) {
            if ((fileEntity as FileRefEntity).linkedFileData===null) { return; }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `${vscode.l10n.t('Refreshing')} ${fileEntity.name}`,
                cancellable: true,
            }, async (progress, token) => {
                token.onCancellationRequested(() => {});
                
                const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
                const res = await (this.api as ExtendedBaseAPI).refreshLinkedFile(identity, this.projectId, fileEntity._id);
                this.requireCurrentSession();

                if (res.type==='success' && res.message!==undefined) {
                    // refresh the entity id
                    fileEntity._id = res.message;
                    this.notify([
                        {type: vscode.FileChangeType.Changed, uri: uri},
                    ]);
                    progress.report({message: vscode.l10n.t('Done')});
                } else {
                    if (res.message!==undefined) {
                        throw new Error(res.message);
                    }
                }
            });
        }
    }

    async createLinkedFile(uri: vscode.Uri) {
        const res = await this._resolveUri(uri);
        const parentFolder = res.fileType==='folder' ? res.fileEntity as FolderEntity : res.parentFolder;

        const supportedProviders = [
            vscode.l10n.t('From Another Project'),
            vscode.l10n.t('From External URL'),
        ];
        const selection = await vscode.window.showQuickPick(supportedProviders, {
            placeHolder: vscode.l10n.t('Import file from...'),
        });

        let provider = undefined, entityId = undefined, fileName = undefined, data = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        if (selection === vscode.l10n.t('From Another Project')) {
            provider = 'project_file';
            const allTagsResponse = await this.api.getAllTags(identity);
            this.requireCurrentSession();
            const allTags = allTagsResponse.tags || [];
            const projectsResponse = await this.api.userProjectsJson(identity);
            this.requireCurrentSession();
            const projectId = await vscode.window.showQuickPick(
                projectsResponse.projects!
                .filter(project => project.id!==this.projectId)
                .map(project => {
                    let detail = '';
                    for (const tag of allTags) {
                        if (tag.project_ids.includes(project.id)) {
                            detail += `$(tag) ${tag.name} `;
                        }
                    }
                    return {label: project.name, id: project.id, detail};
                }),
                {
                    title: vscode.l10n.t('Select a Project'),
                    ignoreFocusOut: true,
                }
            );
            const entitiesResponse = projectId
                ? await this.api.projectEntitiesJson(identity, projectId.id)
                : undefined;
            if (entitiesResponse) {
                this.requireCurrentSession();
            }
            const filePath = projectId && await vscode.window.showQuickPick(
                entitiesResponse!.entities!.map(entity => entity.path),
                {
                    title: vscode.l10n.t('Select a File'),
                    ignoreFocusOut: true,
                }
            );
            fileName = filePath && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: filePath?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {source_entity_path: filePath!, source_project_id: projectId!.id};
            this.requireCurrentSession();
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            this.requireCurrentSession();
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else if (selection === vscode.l10n.t('From External URL')) {
            provider = 'url';
            const url = await vscode.window.showInputBox({
                title: vscode.l10n.t('URL to fetch the file from'),
                placeHolder: 'https://example.com/my-file.png',
                ignoreFocusOut: true,
            });
            fileName = url && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: url?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {url:url!};
            this.requireCurrentSession();
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            this.requireCurrentSession();
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else {
            return;
        }

        this.requireCurrentSession();
        // insert entity
        const entity = {
            _id: entityId!, name: fileName!, _type: 'file', readonly: false,
            linkedFileData: { provider, ...data! },
            created: new Date().toISOString(),
        } as FileRefEntity;
        this.insertEntity(parentFolder, 'file', entity);
        const {path} = this._resolveById(entityId!)!;
        this.notify([
            {type: vscode.FileChangeType.Created, uri: uri.with({path:`/${this.projectName}${path}`})},
        ]);
    }

    private async updateDocument(
        uri: vscode.Uri,
        doc: DocumentEntity,
        content: Uint8Array,
        remoteBaseline?: Uint8Array,
    ): Promise<Uint8Array> {
        return this.enqueueDocumentWrite(
            doc._id,
            () => this.updateDocumentSerial(uri, doc, content, remoteBaseline),
        );
    }

    private async updateDocumentSerial(
        uri: vscode.Uri,
        doc: DocumentEntity,
        content: Uint8Array,
        remoteBaseline?: Uint8Array,
    ): Promise<Uint8Array> {
        if (doc.version===undefined || doc.localCache===undefined || doc.remoteCache===undefined) {
            await this.openFile(uri);
        }
        if (doc.version===undefined || doc.localCache===undefined || doc.remoteCache===undefined) {
            throw new Error(`Remote document cache is not initialized for ${uri.toString()}`);
        }

        const desiredText = decodeUtf8Text(content);
        if (desiredText===undefined) {
            throw new Error(`Remote document content is not mergeable UTF-8 for ${uri.toString()}`);
        }

        const dmp = new DiffMatchPatch();
        let mergeRes: string;
        // A base preserved across cache invalidation outranks the current
        // remote text: after a rejoin `remoteCache` is the *new* server text,
        // and diffing it against itself would make the local text a silent
        // winner that deletes every collaborator edit made during the outage.
        const mergeBaseline = remoteBaseline ?? this.preservedBaselineContent(doc);
        if (mergeBaseline!==undefined) {
            const baselineText = decodeUtf8Text(mergeBaseline);
            if (baselineText===undefined) {
                throw new Error(`Remote document baseline is not mergeable UTF-8 for ${uri.toString()}`);
            }
            if (doc.remoteCache===baselineText || doc.remoteCache===desiredText) {
                mergeRes = desiredText;
            } else {
                const merged = mergeUtf8Text(
                    mergeBaseline,
                    content,
                    new TextEncoder().encode(doc.remoteCache),
                );
                if (merged===undefined) {
                    throw new RemoteDocumentMergeConflictError(
                        `Overleaf changed ${uri.path} again before the rebased Local Replica write could be applied.`,
                    );
                }
                mergeRes = new TextDecoder().decode(merged);
            }
        } else {
            // Direct VFS writes do not carry a Local Replica manifest
            // baseline. When a collaborator has advanced the subscribed cache,
            // do an explicit three-way merge from the last local cache rather
            // than letting diff-match-patch choose a fuzzy nearby match.
            if (doc.localCache===doc.remoteCache) {
                mergeRes = desiredText;
            } else {
                const merged = mergeUtf8Text(
                    new TextEncoder().encode(doc.localCache),
                    content,
                    new TextEncoder().encode(doc.remoteCache),
                );
                if (merged===undefined) {
                    throw new RemoteDocumentMergeConflictError(
                        `Overleaf changed ${uri.path} in an overlapping direct editor write.`,
                    );
                }
                mergeRes = new TextDecoder().decode(merged);
            }
        }

        let writtenContent = new TextEncoder().encode(mergeRes);
        if (mergeRes===doc.remoteCache) {
            doc.localCache = mergeRes;
            // Local and remote are provably identical again.
            this.clearPreservedBaseline(doc._id);
            return writtenContent;
        }

        const submittedVersion = doc.version;
        const submittedRemoteText = doc.remoteCache;
        const submittedRemote = new TextEncoder().encode(submittedRemoteText);
        const update = {
            doc: doc._id,
            lastV: doc.lastVersion,
            v: submittedVersion,
            // Reference: services/web/frontend/js/vendor/libs/sharejs.js#L1288
            hash: (()=>{
                if (!doc.mtime || Date.now()-doc.mtime>5000) {
                    doc.mtime = Date.now();
                    return require('crypto').createHash('sha1').update(
                        "blob " + mergeRes.length + "\x00" + mergeRes
                    ).digest('hex');
                }
            })() as string,
            op: (()=>{
                const remoteCacheAscii = Buffer.from(doc.remoteCache, 'utf-8').toString('utf-8');
                const mergeResAscii = Buffer.from(mergeRes, 'utf-8').toString('utf-8');
                let currentPos = 0;
                return dmp.diff_main(remoteCacheAscii, mergeResAscii)
                            .map((part) => {
                                // part[0] === -1: delete, 0: equal, 1: insert; part[1]: compared content
                                const incCount = part[0] === -1 ? 0 : part[1].length;
                                currentPos += incCount;
                                if (part[0] !== 0) {
                                    return {
                                        p: currentPos - incCount,
                                        i: part[0] ===  1 ?  part[1] : undefined,
                                        d: part[0] === -1 ?  part[1] : undefined,
                                    };
                                }
                            })
                            .filter(x => x) as any;
            })(),
        };
        if (update.op && update.op.length) {
            // Project-wide flag: an empty diff for *this* document says nothing
            // about the others, so it must never clear it.
            this.isDirty = true;
        }

        let resolveApplied!: (version?: number) => void;
        const pending: PendingDocumentWrite = {
            submittedVersion,
            collaboratorRevision: this.documentCollaboratorRevisions.get(doc._id) ?? 0,
            requiresAuthoritativeReconciliation:
                (this.documentInDoubtSenderVersions.get(doc._id)?.length ?? 0)>0,
            submittedSourceIds: this.publicId ? [this.publicId] : [],
            applied: new Promise<number | undefined>(resolve => {
                resolveApplied = resolve;
            }),
            resolveApplied: version => resolveApplied(version),
        };
        this.pendingDocumentWrites.set(doc._id, pending);

        let acknowledgementError: unknown;
        let alternativeWriteAccepted = false;
        let acknowledgementWasExplicitlyRejected = false;
        try {
            try {
                GlobalStateManager.requireAuthenticatedIdentity(
                    this.context,
                    this.serverName,
                    this.userId,
                    this.sessionIdentity,
                );
                await this.socket.applyOtUpdate(doc._id, update);
                this.requireCurrentSession();
            } catch (error) {
                acknowledgementError = error;
            }

            if (this.canReplayInFlightDocumentUpdate(acknowledgementError, pending)) {
                acknowledgementError = await this.replayInFlightDocumentUpdate(
                    uri,
                    update,
                    pending,
                );
            }
            alternativeWriteAccepted = acknowledgementError===undefined
                && this.socket.isUsingAlternativeConnectionScheme;
            const appliedVersion = alternativeWriteAccepted
                ? submittedVersion
                : await this.waitForDocumentApplied(
                    pending,
                    acknowledgementError===undefined
                        && !pending.requiresAuthoritativeReconciliation
                        ? VirtualFileSystem.documentAppliedTimeoutMs
                        : 0,
                );
            if (pending.rejectedError!==undefined) {
                acknowledgementError = pending.rejectedError;
            }
            acknowledgementWasExplicitlyRejected = acknowledgementError instanceof Error
                && acknowledgementError.message!=='timeout';
            const collaboratorRevision = this.documentCollaboratorRevisions.get(doc._id) ?? 0;
            const canUseSubmittedResult = alternativeWriteAccepted
                || (
                    !acknowledgementWasExplicitlyRejected
                    && !pending.requiresAuthoritativeReconciliation
                    && appliedVersion!==undefined
                    && collaboratorRevision===pending.collaboratorRevision
                    && doc.version===appliedVersion+1
                    && doc.remoteCache===submittedRemoteText
                );

            if (canUseSubmittedResult) {
                doc.localCache = mergeRes;
                doc.remoteCache = mergeRes;
                // The server accepted exactly this text, so it is the new base.
                this.clearPreservedBaseline(doc._id);
            } else {
                let authoritative: Uint8Array;
                try {
                    authoritative = await this.refreshDocumentFromServer(uri, doc, true);
                } catch (error) {
                    doc.remoteCache = undefined;
                    doc.localCache = undefined;
                    if (error instanceof RemoteDocumentWriteAmbiguousError) {
                        throw error;
                    }
                    throw new RemoteDocumentWriteAmbiguousError(
                        `Overleaf could not reconcile the submitted document update for ${uri.path}: ` +
                        `${error instanceof Error ? error.message : String(error)}`,
                    );
                }
                if (
                    appliedVersion===undefined
                    && !this.desiredChangeIsPresent(submittedRemote, writtenContent, authoritative)
                ) {
                    if (
                        acknowledgementWasExplicitlyRejected
                        && Buffer.from(authoritative).equals(Buffer.from(submittedRemote))
                    ) {
                        throw acknowledgementError;
                    }
                    throw new RemoteDocumentWriteAmbiguousError(
                        `Overleaf could not prove whether the document update for ${uri.path} was applied.`,
                    );
                }
                // The authoritative revision is proven to carry the desired
                // change, so the caches it just seeded are the new base.
                this.clearPreservedBaseline(doc._id);
                writtenContent = authoritative;
            }
        } finally {
            if (
                !alternativeWriteAccepted
                && !acknowledgementWasExplicitlyRejected
                && pending.appliedVersion===undefined
            ) {
                const barriers = this.documentInDoubtSenderVersions.get(doc._id) ?? [];
                barriers.push(submittedVersion);
                // Bounded: a barrier whose sender-ack never arrives would
                // otherwise grow for the whole session.
                if (barriers.length>VirtualFileSystem.maxInDoubtSenderVersions) {
                    barriers.splice(0, barriers.length-VirtualFileSystem.maxInDoubtSenderVersions);
                }
                this.documentInDoubtSenderVersions.set(doc._id, barriers);
            }
            if (this.pendingDocumentWrites.get(doc._id)===pending) {
                this.pendingDocumentWrites.delete(doc._id);
            }
            pending.resolveApplied();
        }

        doc.lastVersion = submittedVersion;
        setTimeout(() => {
            this.notify([
                {type: vscode.FileChangeType.Changed, uri: uri}
            ]);
        }, 10);
        return writtenContent;
    }

    async writeFileFromRemoteBaseline(
        uri: vscode.Uri,
        content: Uint8Array,
        remoteBaseline?: Uint8Array,
        expectedRemoteMissing = false,
    ): Promise<Uint8Array> {
        await this.ensureConnectedForWrite();
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (expectedRemoteMissing) {
            if (fileType) {
                if (fileType==='doc' || fileType==='file') {
                    const remoteContent = await this.readCreateVerificationContent(
                        uri,
                        fileType,
                        fileEntity,
                    );
                    if (Buffer.compare(Buffer.from(remoteContent), Buffer.from(content))===0) {
                        return content;
                    }
                }
                throw new RemoteDocumentMergeConflictError(
                    `Overleaf path appeared while the local file was being created: ${uri.path}`,
                );
            }
            try {
                await this.createFile(uri, content, false);
                return content;
            } catch (error) {
                if ((error as {retryable?: boolean})?.retryable===false) {
                    throw error;
                }
                if (
                    error instanceof RemoteMutationRetryableError
                    && !error.requiresAuthoritativeRecheck
                ) {
                    throw error;
                }
                await this.reconnect(`verify create-if-missing: ${uri.path}`);
                const refreshed = await this._resolveUri(uri);
                if (refreshed.fileType) {
                    if (refreshed.fileType==='doc' || refreshed.fileType==='file') {
                        const remoteContent = await this.readCreateVerificationContent(
                            uri,
                            refreshed.fileType,
                            refreshed.fileEntity,
                        );
                        if (Buffer.compare(Buffer.from(remoteContent), Buffer.from(content))===0) {
                            return content;
                        }
                    }
                    throw new RemoteDocumentMergeConflictError(
                        `Overleaf path appeared while the local file was being created: ${uri.path}`,
                    );
                }
                throw error;
            }
        }
        if (fileType==='doc' && fileEntity) {
            const doc = fileEntity as DocumentEntity;
            if (doc.version===undefined || doc.localCache===undefined || doc.remoteCache===undefined) {
                await this.openFile(uri);
            }
            const effectiveBaseline = remoteBaseline
                // A base preserved across a rejoin (or a missed OT update) must
                // win over `remoteCache`: that cache was just reloaded from the
                // server, so using it as the baseline collapses the merge and
                // silently overwrites whatever changed while we were away.
                ?? this.preservedBaselineContent(doc)
                ?? (doc.remoteCache===undefined
                    ? undefined
                    : new TextEncoder().encode(doc.remoteCache));
            return this.updateDocument(uri, doc, content, effectiveBaseline);
        }
        await this.writeFile(uri, content, true, true);
        return content;
    }

    private async readCreateVerificationContent(
        uri: vscode.Uri,
        fileType: 'doc' | 'file',
        fileEntity?: FileEntity,
    ): Promise<Uint8Array> {
        if (!fileEntity) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        if (fileType==='doc') {
            return this.refreshDocumentFromServer(uri, fileEntity as DocumentEntity);
        }
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const response = await this.api.getFile(identity, this.projectId, fileEntity._id);
        this.requireCurrentSession();
        if (response.type==='success' && response.content!==undefined) {
            return response.content;
        }
        throw vscode.FileSystemError.Unavailable(
            `Could not verify Overleaf file "${fileEntity.name}".`,
        );
    }

    async createDirectoryIfMissing(uri: vscode.Uri): Promise<void> {
        await this.ensureConnectedForWrite();
        const current = await this._resolveUri(uri);
        if (current.fileType==='folder') {
            return;
        }
        if (current.fileType) {
            throw new RemoteDocumentMergeConflictError(
                `Overleaf path has a different type while the local folder was being created: ${uri.path}`,
            );
        }
        try {
            await this.mkdir(uri);
        } catch (error) {
            if ((error as {retryable?: boolean})?.retryable===false) {
                throw error;
            }
            if (
                error instanceof RemoteMutationRetryableError
                && !error.requiresAuthoritativeRecheck
            ) {
                throw error;
            }
            await this.reconnect(`verify folder create-if-missing: ${uri.path}`);
            const refreshed = await this._resolveUri(uri);
            if (refreshed.fileType==='folder') {
                return;
            }
            if (refreshed.fileType) {
                throw new RemoteDocumentMergeConflictError(
                    `Overleaf path has a different type while the local folder was being created: ${uri.path}`,
                );
            }
            throw error;
        }
    }

    async writeFile(uri: vscode.Uri, content:Uint8Array, create:boolean, overwrite:boolean) {
        await this.ensureConnectedForWrite();
        const {fileType, fileEntity} = await this._resolveUri(uri);

        if (!fileType && create) {
            return this.createFile(uri, content, true);
        }
        if (fileType && fileType!=='doc' && create) {
            return this.createFile(uri, content, overwrite);
        }
        if (fileType==='doc' && fileEntity) {
            await this.updateDocument(uri, fileEntity as DocumentEntity, content);
        }
    }

    async mkdir(uri: vscode.Uri) {
        const {parentFolder, fileName} = await this._resolveUri(uri);
        const [folderName, parentFolderId] = [fileName, parentFolder._id];
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.addFolder(identity, this.projectId, folderName, parentFolderId);
        this.requireCurrentSession();

        if (res.type==='success') {
            if (res.entity!==undefined) {
                this.insertEntity(parentFolder, 'folder', res.entity as FolderEntity);
                this.notify([
                    {type: vscode.FileChangeType.Created, uri: uri},
                ]);
                return;
            }
            const message = `Overleaf returned an invalid entity while creating "${folderName}".`;
            vscode.window.showErrorMessage(message);
            throw new RemoteMutationRetryableError(message, true);
        } else {
            const message = res.message ?? `Could not create Overleaf folder "${folderName}".`;
            vscode.window.showErrorMessage(message);
            throw this.createMutationResponseError(message, res.status);
        }
    }

    async remove(uri: vscode.Uri, recursive: boolean) {
        const {parentFolder, fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType && fileEntity) {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
            const res = await this.api.deleteEntity(identity, this.projectId, fileType, fileEntity._id);
            this.requireCurrentSession();
            if (res.type==='success') {
                this.removeEntityById(parentFolder, fileType, fileEntity._id, recursive);
                this.notify([
                    {type: vscode.FileChangeType.Deleted, uri: uri},
                ]);
            } else {
                const message = res.message ?? `Could not delete Overleaf ${fileType} "${fileEntity.name}".`;
                vscode.window.showErrorMessage(message);
                throw vscode.FileSystemError.Unavailable(message);
            }
        } else {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async rename(
        oldUri: vscode.Uri,
        newUri: vscode.Uri,
        force: boolean,
        expectedEntity?: {id: string; type: 'doc' | 'file'},
    ) {
        const oldPath = await this._resolveUri(oldUri);
        const newPath = await this._resolveUri(newUri);
        if (
            expectedEntity!==undefined
            && (
                oldPath.fileType!==expectedEntity.type
                || oldPath.fileEntity?._id!==expectedEntity.id
            )
        ) {
            throw vscode.FileSystemError.Unavailable(
                'Overleaf move source no longer matches the recorded entity.',
            );
        }

        if (oldPath.fileType && oldPath.fileEntity && oldPath.fileEntity) {
            // delete existence firstly
            if (newPath.fileType && newPath.fileEntity) {
                if (!force) {
                    throw vscode.FileSystemError.FileExists(newUri);
                }
                await this.remove(newUri, true);
            }
            // rename or move
            let res = undefined;
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
            if (oldPath.parentFolder===newPath.parentFolder) {
                const [entityType, entityId, newName] = [oldPath.fileType, oldPath.fileEntity._id, newPath.fileName];
                res = await this.api.renameEntity(identity, this.projectId, entityType, entityId, newName);
            } else {
                const [entityType, entityId, newParentFolderId] = [oldPath.fileType, oldPath.fileEntity._id, newPath.parentFolder._id];
                res = await this.api.moveEntity(identity, this.projectId, entityType, entityId, newParentFolderId);
            }
            this.requireCurrentSession();
            // update local cache
            if (res?.type==='success') {
                const newEntity = Object.assign(oldPath.fileEntity);
                newEntity.name = newPath.fileName;
                this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                this.insertEntity(newPath.parentFolder, oldPath.fileType, newEntity);
                this.notify([
                    {type: vscode.FileChangeType.Deleted, uri: oldUri},
                    {type: vscode.FileChangeType.Created, uri: newUri},
                ]);
            } else {
                const message = res?.message
                    ?? `Could not rename Overleaf ${oldPath.fileType} "${oldPath.fileEntity.name}".`;
                vscode.window.showErrorMessage(message);
                throw vscode.FileSystemError.Unavailable(message);
            }
        } else {
            throw vscode.FileSystemError.FileNotFound(oldUri);
        }
    }

    async compile(force:boolean=false, draft:boolean=false, stopOnFirstError:boolean=false, rootDocId?:string) {
        if (force || (this.root && this.isDirty)) {
            let needCacheClearFirst = false;
            try{
                await this.resolve(this.pathToUri(OUTPUT_FOLDER_NAME, "output.log"));
            }
            catch (e) {
                needCacheClearFirst = true;
            }
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
            // clear cache if needed
            if (needCacheClearFirst) {
                await this.api.deleteAuxFiles(identity, this.projectId);
                this.requireCurrentSession();
            }
            // compile project
            const resolvedRootDocId = rootDocId ?? this.root?.rootDoc_id ?? null;
            let rootResourcePath: string | null = null;
            if (resolvedRootDocId) {
                const rootEntry = this._resolveById(resolvedRootDocId);
                if (rootEntry?.path) {
                    rootResourcePath = rootEntry.path.replace(/^\//, '');
                } else {
                    console.warn(`Unable to resolve root document id '${resolvedRootDocId}' to a path; compiling without explicit rootResourcePath.`);
                }
            }
            let res = await this.api.compile(identity, this.projectId, rootResourcePath, draft, stopOnFirstError);
            this.requireCurrentSession();
            // Overleaf rate-limits auto compiles; a backoff status is transient,
            // so retry once after a short delay instead of reporting a failure.
            const transientStatus = res.type==='success' ? res.compile?.status : undefined;
            if (transientStatus==='autocompile-backoff' || transientStatus==='too-recently-compiled') {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [compile backoff] status=${transientStatus}; retrying in 2s`,
                );
                await new Promise(resolve => setTimeout(resolve, 2000));
                res = await this.api.compile(identity, this.projectId, rootResourcePath, draft, stopOnFirstError);
                this.requireCurrentSession();
            }
            if (res.type==='success' && res.compile?.status==='success') {
                try {
                    // Awaited: an unhandled rejection here used to leave this
                    // call returning true while the caller went on to parse the
                    // *previous* build's output.log and refresh the previous
                    // output.pdf.
                    await this.updateOutputs(res.compile.outputFiles, {
                        compileGroup: res.compile.compileGroup,
                        clsiServerId: res.compile.clsiServerId,
                        pdfDownloadDomain: res.compile.pdfDownloadDomain,
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error('Compile succeeded but its outputs could not be published.', error);
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [compile outputs rejected] ${message}`,
                    );
                    vscode.window.showErrorMessage(message);
                    return false;
                }
                // Only a compile the server actually accepted may clear the
                // flag: clearing it up front permanently lost it whenever the
                // request threw.
                this.isDirty = false;
                return true;
            } else {
                const details = {
                    responseType: res.type,
                    httpStatus: res.status,
                    compileStatus: res.compile?.status,
                    outputCount: res.compile?.outputFiles?.length,
                    latexmkErrors: res.compile?.stats?.['latexmk-errors'],
                };
                console.error('Compile response rejected.', details);
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [compile rejected] ${JSON.stringify(details)}` +
                    (res.message ? ` message=${res.message}` : ''),
                );
                return false;
            }
        }
        return Promise.resolve(undefined);
    }

    async stopCompile() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.stopCompile(identity, this.projectId);
        this.requireCurrentSession();
        if (res.type==='success') {
            return true;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return false;
        }
    }

    async updateOutputs(
        outputs: Array<OutputFileEntity>,
        metadata?: {
            compileGroup: string;
            clsiServerId?: string;
            pdfDownloadDomain?: string;
        },
    ) {
        if (!outputs?.length || !outputs[0]?.url) {
            // A "successful" compile without output files cannot refresh the
            // output folder. Silently keeping the previous build would make the
            // log and PDF views present a stale result as if it were this one.
            throw new Error(
                'Overleaf reported a successful compile without any output files.',
            );
        }
        // update output buildId
        // '/project/65dbfff719ad65b54b9eaed4/user/65094b5fa537faaba0bec01f/build/19620231e54-5372f67292889500/output/output.aux' --> 19620231e54-5372f67292889500'
        const outputBuildId = outputs[0].url.match(/\/build\/([^\/]+)/)?.[1];
        const preparedOutputs = outputs.map((file) => ({
            ...file,
            _id: __OUTPUTS_ID,
            name: file.path,
            readonly: true,
        }));

        // Publish the build routing metadata and output tree as one validated
        // snapshot. Otherwise a malformed new response can leave the previous
        // output.pdf attached to the new build's CDN metadata and make that
        // known-good artifact download as a 404.
        this.outputBuildId = outputBuildId;
        if (metadata) {
            this.compileGroup = metadata.compileGroup;
            this.clsiServerId = metadata.clsiServerId;
            this.pdfDownloadDomain = metadata.pdfDownloadDomain;
        }
        this.lastOutputs = preparedOutputs;
        this.installOutputsEntity(preparedOutputs);
    }

    private installOutputsEntity(outputs: Array<OutputFileEntity>) {
        const rootFolder = this.root?.rootFolder[0];
        if (!rootFolder) { return; }

        if (this.removeEntityById(rootFolder, 'folder', __OUTPUTS_ID)) {
            this.notify([
                {type:vscode.FileChangeType.Deleted, uri:this.pathToUri(OUTPUT_FOLDER_NAME)}
            ]);
        }

        this.insertEntity(rootFolder, 'folder', {
            _id: __OUTPUTS_ID,
            name: OUTPUT_FOLDER_NAME,
            readonly: true,
            docs: [], fileRefs: [], folders:[],
            outputs,
        } as FolderEntity);
        this.notify([
            {type:vscode.FileChangeType.Created, uri:this.pathToUri(OUTPUT_FOLDER_NAME)},
            ...(outputs.map((file) => {
                return {type:vscode.FileChangeType.Changed, uri:this.pathToUri(OUTPUT_FOLDER_NAME, file.path)};
            }))
        ]);
    }

    private restoreOutputsEntity() {
        // The outputs folder is a client-side construct that a fresh
        // joinProject payload never carries. Without rebuilding it, a socket
        // drop during a compile makes `output/output.log` unresolvable, so a
        // successful compile is reported as "Compile Failed" and an open PDF
        // tab can no longer resolve output.pdf.
        if (this.lastOutputs?.length) {
            this.installOutputsEntity(this.lastOutputs);
        }
    }

    async syncCode(filePath: string, line:number, column:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.proxySyncCode(identity, this.projectId, filePath, line, column, this.outputBuildId ?? '');
        this.requireCurrentSession();
        if (res.type==='success') {
            return res.syncCode;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    async syncPdf(page:number, h:number, v:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.proxySyncPdf(identity, this.projectId, page, h, v, this.outputBuildId ?? '');
        this.requireCurrentSession();
        if (res.type==='success') {
            return res.syncPdf;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    async spellCheck(uri: vscode.Uri, words: string[]) {
        if (this.root?.spellCheckLanguage==='') { return []; }

        const {fileType} = await this._resolveUri(uri);
        if (fileType==='doc' || fileType==='file') {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
            const res = this.root && await this.api.proxyRequestToSpellingApi(identity, this.root.spellCheckLanguage, this.userId, words);
            this.requireCurrentSession();
            if (res?.type==='success') {
                return res.misspellings;
            }
        }
    }

    async spellLearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.spellingControllerLearn(identity, this.userId, word);
        this.requireCurrentSession();
        if (res.type==='success') {
            this.root?.settings.learnedWords.push(word);
            return true;
        } else {
            return false;
        }
    }

    async spellUnlearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.spellingControllerUnlearn(identity, word);
        this.requireCurrentSession();
        if (res.type==='success') {
            const index = this.root?.settings.learnedWords.findIndex((w) => w===word);
            if (index!==undefined && index>=0) {
                this.root?.settings.learnedWords.splice(index, 1);
            }
            return true;
        } else {
            return false;
        }
    }

    getSpellCheckLanguage() {
        const language = this.root?.spellCheckLanguage;
        if (language==='') {
            return {name:'Off', code:''};
        } else {
            return this.root?.settings.languages.find(item => item.code===language);
        }
    }

    getAllSpellCheckLanguages() {
        return this.root?.settings.languages;
    }

    getCompiler() {
        const compiler = this.root?.compiler;
        const compilerItem = this.root?.settings.compilers.find(item => item.code===compiler);
        return compilerItem;
    }

    getAllCompilers() {
        return this.root?.settings.compilers;
    }

    getDictionary() {
        return this.root?.settings.learnedWords;
    }

    getRootDocName() {
        return this._resolveById(this.root?.rootDoc_id!)?.path ?? '';
    }

    getValidMainDocs() {
        return this.walk((entity) => {
            return entity._type==='doc' && entity.name.match(/\.tex$/g)!==null;
        });
    }

    getProjectSCMPersist(scmKey: string) {
        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(
            this.context,
            this.serverName,
            this.userId,
            this.projectId,
        );
        return scmPersists[scmKey];
    }

    setProjectSCMPersist(scmKey: string, persist: any) {
        return GlobalStateManager.updateServerProjectSCMPersist(
            this.context,
            this.serverName,
            this.userId,
            this.projectId,
            scmKey,
            persist,
        );
    }

    async updateSettings(setting: any) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.updateProjectSettings(identity, this.projectId, setting);
        this.requireCurrentSession();
        if (res.type==='success') {
            const keys = Object.keys(setting);
            if (keys.includes('spellCheckLanguage')) {
                this.root!.spellCheckLanguage = setting.spellCheckLanguage;
            }
            if (keys.includes('compiler')) {
                this.root!.compiler = setting.compiler;
            }
            if (keys.includes('rootDocId')) {
                this.root!.rootDoc_id = setting.rootDocId;
            }
        }
        return res.type==='success'? true : false;
    }

    async metadata() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.getMetadata(identity, this.projectId);
        this.requireCurrentSession();
        if (res.type==='success') {
            return res.meta?.projectMeta;
        } else {
            return undefined;
        }
    }

    async getUpdates(before?: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.proxyToHistoryApiAndGetUpdates(identity, this.projectId, before);
        this.requireCurrentSession();
        if (res.type==='success') {
            return res.updates;
        } else {
            return undefined;
        }
    }

    async getFileDiff(pathname:string, from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.proxyToHistoryApiAndGetFileDiff(identity, this.projectId, pathname, from, to);
        this.requireCurrentSession();
        if (res.type==='success') {
            return res.diff;
        } else {
            return undefined;
        }
    }

    async getFileTreeDiff(from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.proxyToHistoryApiAndGetFileTreeDiff(identity, this.projectId, from, to);
        this.requireCurrentSession();
        if (res.type==='success') {
            return res.treeDiff;
        } else {
            return undefined;
        }
    }

    async getCurrentVersion() {
        const base = this.currentVersion ?? 0;
        let lb = base;
        let rb = base+2**4;
        // firstly try: a) no update `+1`, b) one update `+2`
        const res = await this.getFileTreeDiff(base+1, base+1);
        if (res===undefined) {
            this.currentVersion = base;
            return base;
        }
        const res2 = await this.getFileTreeDiff(base+2, base+2);
        if (res2===undefined) {
            this.currentVersion = base+1;
            return this.currentVersion;
        }
        // locate the actual upper bound
        do {
            const res = await this.getFileTreeDiff(rb, rb);
            if (res!==undefined) {
                rb = lb + (rb-lb)*2;
            } else {
                break;
            }
        } while (true);
        // binary search the current version
        while (lb<rb) {
            const mid = Math.floor((lb+rb)/2);
            const res = await this.getFileTreeDiff(mid, mid);
            if (res!==undefined) {
                lb = mid+1;
            } else {
                rb = mid;
            }
        }
        // update current version
        this.currentVersion = rb-1;
        return this.currentVersion;
    }

    async createLabel(comment: string, version: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.createLabel(identity, this.projectId, comment, version);
        this.requireCurrentSession();
        if (res.type==='success') {
            return res.labels?.at(0);
        } else {
            return undefined;
        }
    }

    async deleteLabel(labelId: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.deleteLabel(identity, this.projectId, labelId);
        this.requireCurrentSession();
        if (res.type==='success') {
            return true;
        } else {
            return false;
        }
    }

    async downloadProjectArchive(version: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.downloadZipOfVersion(identity, this.projectId, version);
        this.requireCurrentSession();
        return res.content;
    }

    async getMessages() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.getMessages(identity, this.projectId);
        this.requireCurrentSession();
        if (res.type==='success') {
            return res.messages;
        } else {
            return undefined;
        }
    }

    async sendMessage(publicId:string, content: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName, this.userId, this.sessionIdentity);
        const res = await this.api.sendMessage(identity, this.projectId, publicId, content);
        this.requireCurrentSession();
        if (res.type==='success') {
            return true;
        } else {
            return false;
        }
    }
}

export interface ActiveConnectionChange {
    vfs: VirtualFileSystem | undefined,
    state: VFSConnectionState,
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private vfss: {[key:string]:VirtualFileSystem};
    private disposed = false;

    private _activeVFS: VirtualFileSystem | undefined;
    private _activeConnectionSubscription?: vscode.Disposable;
    private readonly _onDidChangeActiveConnectionEmitter = new vscode.EventEmitter<ActiveConnectionChange>();
    public readonly onDidChangeActiveConnection = this._onDidChangeActiveConnectionEmitter.event;

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
        this.vfss = {};
    }

    getActiveVFS(): VirtualFileSystem | undefined {
        if (this.disposed) { return undefined; }
        return this._activeVFS?.isDisposed ? undefined : this._activeVFS;
    }

    getActiveConnectionState(): VFSConnectionState {
        const vfs = this.getActiveVFS();
        return vfs ? vfs.connectionState : 'disconnected';
    }

    private setActiveVFS(vfs: VirtualFileSystem | undefined) {
        if (this.disposed) {
            vfs?.dispose();
            return;
        }
        if (this._activeVFS===vfs) { return; }
        this._activeConnectionSubscription?.dispose();
        this._activeVFS = vfs;
        if (vfs) {
            this._activeConnectionSubscription = vfs.onDidChangeConnection(state => {
                this._onDidChangeActiveConnectionEmitter.fire({vfs, state});
            });
        } else {
            this._activeConnectionSubscription = undefined;
        }
        this._onDidChangeActiveConnectionEmitter.fire({vfs, state: vfs?.connectionState ?? 'disconnected'});
    }

    private getVFS(uri: vscode.Uri): Promise<VirtualFileSystem> {
        if (this.disposed) {
            return Promise.reject(vscode.FileSystemError.Unavailable('Overleaf file system provider is disposed.'));
        }
        uri = canonicalizeOverleafUri(uri);
        const key = vfsProjectKey(uri);
        const vfs = this.vfss[key];
        if (vfs && !vfs.isDisposed) {
            return Promise.resolve(vfs);
        } else {
            if (vfs?.isDisposed) {
                delete this.vfss[key];
            }
            let newVfs: VirtualFileSystem;
            newVfs = new VirtualFileSystem(
                this.context,
                uri,
                this.notify.bind(this),
                () => this._activeVFS===newVfs,
            );
            this.vfss[key] = newVfs;
            return Promise.resolve(newVfs);
        }
    }

    prefetch(uri: vscode.Uri): Promise<VirtualFileSystem> {
        return this.getVFS(uri).then((vfs) => {return vfs;});
    }

    async activateProject(
        uri: vscode.Uri,
        options: ActivateProjectOptions = {},
    ): Promise<VirtualFileSystem> {
        if (this.disposed) {
            throw vscode.FileSystemError.Unavailable('Overleaf file system provider is disposed.');
        }
        uri = canonicalizeOverleafUri(uri);
        const targetKey = vfsProjectKey(uri);
        Object.entries(this.vfss).forEach(([key, vfs]) => {
            if (key!==targetKey) {
                if (this._activeVFS===vfs) { this.setActiveVFS(undefined); }
                vfs.dispose();
                delete this.vfss[key];
            }
        });

        const vfs = await this.prefetch(uri);
        vfs.configureInitialSCMRestore(options.restorePersistedSCMs!==false);
        if (this.disposed) {
            vfs.dispose();
            throw vscode.FileSystemError.Unavailable('Overleaf file system provider is disposed.');
        }
        this.setActiveVFS(vfs);
        await vfs.init();
        return vfs;
    }

    async deactivateProject(uri?: vscode.Uri): Promise<void> {
        if (this.disposed) { return; }
        const targetKey = uri ? vfsProjectKey(uri) : this._activeVFS ? vfsProjectKey(this._activeVFS.origin) : undefined;
        if (!targetKey) { return; }

        const vfs = this.vfss[targetKey];
        if (vfs===undefined) { return; }
        if (this._activeVFS===vfs) {
            this.setActiveVFS(undefined);
        }
        vfs.dispose();
        delete this.vfss[targetKey];
    }

    async removeLocalReplicaSCM(
        projectUri: vscode.Uri,
        scmKey: string,
        baseUri: vscode.Uri,
    ): Promise<void> {
        const targetKey = vfsProjectKey(projectUri);
        const vfs = this.vfss[targetKey];
        if (vfs && !vfs.isDisposed) {
            await vfs.removeLocalReplicaSCM(scmKey, baseUri);
            return;
        }
        if (vfs?.isDisposed) {
            delete this.vfss[targetKey];
        }
        await removeDetachedLocalReplicaSCM(
            this.context,
            projectUri,
            scmKey,
            baseUri,
        );
    }

    async deactivateServer(serverName: string): Promise<void> {
        if (this.disposed) { return; }
        const entries = Object.entries(this.vfss)
            .filter(([_key, vfs]) => vfs.serverName===serverName);
        for (const [key, vfs] of entries) {
            if (this._activeVFS===vfs) {
                this.setActiveVFS(undefined);
            }
            vfs.dispose();
            delete this.vfss[key];
        }
    }

    notify(events :vscode.FileChangeEvent[]) {
        if (this.disposed) { return; }
        this._emitter.fire(events);
    }

    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        this._activeConnectionSubscription?.dispose();
        this._activeConnectionSubscription = undefined;
        this._activeVFS = undefined;
        const vfss = Object.values(this.vfss);
        this.vfss = {};
        vfss.forEach(vfs => vfs.dispose());
        this._emitter.dispose();
        this._onDidChangeActiveConnectionEmitter.dispose();
    }

    stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
        return this.getVFS(uri).then( vfs => vfs.resolve(uri) );
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
        return this.getVFS(uri).then( vfs => vfs.list(uri) );
    }

    createDirectory(uri: vscode.Uri): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.mkdir(uri) );
    }

    readFile(uri: vscode.Uri): Thenable<Uint8Array> {
        return this.getVFS(uri).then( vfs => vfs.openFile(uri) );
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.writeFile(uri, content, options.create, options.overwrite) );
    }

    delete(uri: vscode.Uri, options: { recursive: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.remove(uri, options.recursive) );
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }) {
        if (oldUri.authority !== newUri.authority) {
            vscode.window.showErrorMessage( vscode.l10n.t('Cannot rename across servers') );
            return;
        } else {
            return this.getVFS(oldUri).then( vfs => vfs.rename(oldUri, newUri, options.overwrite) );
        }
    }

    get triggers() {
        return [
            // register file system provider
            vscode.workspace.registerFileSystemProvider(ROOT_NAME, this, { isCaseSensitive: true }),
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.refreshLinkedFile`, (uri: vscode.Uri) => {
                return this.prefetch(uri).then((vfs) => vfs.refreshLinkedFile(uri));
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.createLinkedFile`, (uri?: vscode.Uri) => {
                uri = uri || vscode.workspace.workspaceFolders?.[0].uri;
                if (uri) {
                    return this.prefetch(uri).then((vfs) => vfs.createLinkedFile(uri!));
                }                
            }),
            vscode.commands.registerCommand(PREFETCH_COMMAND, (uri: vscode.Uri) => {
                return this.prefetch(uri);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.activateProject`, (
                uri: vscode.Uri,
                options?: ActivateProjectOptions,
            ) => {
                return this.activateProject(uri, options);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.deactivateProject`, (uri?: vscode.Uri) => {
                return this.deactivateProject(uri);
            }),
        ];
    }
}
