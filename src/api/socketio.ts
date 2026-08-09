/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { Identity, BaseAPI, ProjectMessageResponseSchema } from './base';
import { FileEntity, DocumentEntity, FileRefEntity, FileType, FolderEntity, ProjectEntity } from '../core/remoteFileSystemProvider';
import { EventBus, Events } from '../utils/eventBus';
import { SocketIOAlt } from './socketioAlt';

function decodePackedUtf8(text: string): string {
    return Buffer.from(text, 'latin1').toString('utf-8');
}

const SOCKET_ACK_TIMEOUT_MS = 20_000;

export interface UpdateUserSchema {
    id: string,
    user_id: string,
    name: string,
    email: string,
    doc_id: string,
    row: number,
    column: number,
    last_updated_at?: number, //unix timestamp
}

export interface OnlineUserSchema {
    client_age: number,
    client_id: string,
    connected: boolean,
    cursorData?: {
        column: number,
        doc_id: string,
        row: number,
    },
    email: string,
    first_name: string,
    last_name?: string,
    last_updated_at: string, //unix timestamp
    user_id: string,
}

export interface UpdateSchema {
    doc: string, //doc id
    op?: {
        p: number, //position
        i?: string, //insert
        d?: string, //delete
        u?: boolean, //isUndo
    }[],
    v: number, //doc version number
    lastV?: number, //last version number
    hash?: string, //(not needed if lastV is provided)
    meta?: {
        source: string, //socketio client id
        ts: number, //unix timestamp
        user_id: string,
    }
}

export interface JoinDocumentResponse {
    docLines: string[],
    version: number,
    updates: UpdateSchema[],
    ranges: any,
    type?: string,
}

export interface EventsHandler {
    onFileCreated?: (parentFolderId:string, type:FileType, entity:FileEntity) => void,
    onFileRenamed?: (entityId:string, newName:string) => void,
    onFileRemoved?: (entityId:string) => void,
    onFileMoved?: (entityId:string, newParentFolderId:string) => void,
    onFileChanged?: (update:UpdateSchema) => void,
    //
    onDisconnected?: () => void,
    onConnectionAccepted?: (publicId:string) => void,
    onClientUpdated?: (user:UpdateUserSchema) => void,
    onClientDisconnected?: (id:string) => void,
    //
    onReceivedMessage?: (message:ProjectMessageResponseSchema) => void,
    //
    onSpellCheckLanguageUpdated?: (language:string) => void,
    onCompilerUpdated?: (compiler:string) => void,
    onRootDocUpdated?: (rootDocId:string) => void,
}

type ConnectionScheme = 'Alt' | 'v1' | 'v2';
type SocketConnectionError = Error & { retryable?: boolean };
type SocketErrorHandler = (error: SocketConnectionError) => void;

export class SocketIOAPI {
    private scheme: ConnectionScheme = 'v1';
    private record?: Promise<ProjectEntity>;
    private _handlers: Array<EventsHandler> = [];
    private socketErrorHandlers = new Set<SocketErrorHandler>();
    private recordErrorHandler?: SocketErrorHandler;

    private socket?: any;
    private emit: any;
    private initializedScheme?: ConnectionScheme;
    // A torn down (or server-dropped) socket is still a live object reference,
    // so liveness has to be tracked explicitly: otherwise `needsReinit` keeps
    // reporting a dead transport as usable and every emit waits for an ack
    // that can never arrive.
    private socketDead = false;
    private socketGeneration = 0;
    private announcedDisconnectGeneration?: number;
    private suppressDisconnectNotification = false;
    // `init()` builds a brand new raw socket. Listeners registered by the VFS,
    // collaboration and chat layers are bound to the discarded one, so they are
    // kept here and re-armed on every new socket.
    private socketListeners: Array<{event: string, listener: (...args:any[]) => void}> = [];
    // The v2 `joinProjectResponse` belongs to exactly one socket; the record
    // must never outlive it.
    private recordGeneration?: number;

    constructor(private url:string,
                private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string)
    {
        this.init();
    }

    init() {
        // This teardown *is* the reconnect: announcing it would make the VFS
        // restart the very initialization chain that called us.
        this.disconnectSocket({notify: false});
        this.socketErrorHandlers.clear();
        this.recordErrorHandler = undefined;
        this.socketGeneration += 1;
        // connect
        switch(this.scheme) {
            case 'Alt':
                this.socket = new SocketIOAlt(this.url, this.api, this.identity, this.projectId, this.record!);
                break;
            case 'v1':
                this.record = undefined;
                this.socket = this.api._initSocketV0(this.identity);
                break;
            case 'v2':
                this.record = undefined;
                const query = `?projectId=${this.projectId}&t=${Date.now()}`;
                this.socket = this.api._initSocketV0(this.identity, query);
                break;
        }
        this.initializedScheme = this.scheme;
        this.socketDead = false;
        // create emit
        (this.socket.emit)[require('util').promisify.custom] = (event:string, ...args:any[]) => {
            let timeout: NodeJS.Timeout;
            const timeoutPromise = new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error('timeout'));
                }, SOCKET_ACK_TIMEOUT_MS);
            });
            const waitPromise = new Promise((resolve, reject) => {
                this.socket.emit(event, ...args, (err:any, ...data:any[]) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                });
            });
            return Promise.race([waitPromise, timeoutPromise]).finally(() => clearTimeout(timeout));
        };
        this.emit = require('util').promisify(this.socket.emit).bind(this.socket);
        // resume handlers
        this.initInternalHandlers();
        this.resumeSocketListeners();
    }

    private normalizeSocketError(error:any, retryable = true): SocketConnectionError {
        let normalizedError: SocketConnectionError;
        if (error instanceof Error) {
            normalizedError = error;
        } else if (error?.message) {
            normalizedError = new Error(error.message);
        } else {
            normalizedError = new Error(String(error));
        }
        normalizedError.retryable = retryable;
        return normalizedError;
    }

    private isHandshakeFallbackError(error: Error): boolean {
        return error.message==='client not handshaken'
            || /^Unexpected server response:\s*[45]\d{2}$/i.test(error.message);
    }

    private isKnownFallbackError(error: Error): boolean {
        return this.isHandshakeFallbackError(error)
            || error.message==='invalid session'
            || error.message==='connect_failed';
    }

    private disconnectSocket(options: {removeListeners?: boolean, notify?: boolean} = {}) {
        // Hold on to the transport we are tearing down: notifying the VFS can
        // synchronously build its replacement, and the cleanup below must never
        // touch that new socket.
        const socket = this.socket;
        if (!socket) { return; }
        const generation = this.socketGeneration;
        const notify = options.notify!==false;
        this.socketDead = true;
        this.suppressDisconnectNotification = !notify;
        try {
            // Disconnect before removing listeners: stripping them first
            // swallows the `disconnect` event the VFS drives its reconnect
            // state machine from.
            socket.disconnect();
        } catch {
            // Ignore cleanup errors from already-closing transports.
        }
        this.suppressDisconnectNotification = false;
        if (notify && this.socketGeneration===generation) {
            // The transport may vanish without ever dispatching `disconnect`
            // (already dead, or listeners removed by an earlier teardown), so
            // the notification cannot depend on it being polite.
            this.notifyDisconnected();
        }
        if (options.removeListeners!==false) {
            try {
                socket.removeAllListeners?.();
            } catch {
                // Ignore cleanup errors from already-closing transports.
            }
        }
    }

    private notifyDisconnected() {
        if (this.suppressDisconnectNotification) { return; }
        if (this.announcedDisconnectGeneration===this.socketGeneration) { return; }
        this.announcedDisconnectGeneration = this.socketGeneration;
        this.socketDead = true;
        for (const handlers of [...this._handlers]) {
            handlers.onDisconnected?.();
        }
    }

    private addSocketListener(event: string, listener: (...args:any[]) => void) {
        this.socketListeners.push({event, listener});
        this.socket?.on(event, listener);
    }

    private removeSocketListener(event: string, listener: (...args:any[]) => void) {
        const index = this.socketListeners.findIndex(
            registered => registered.event===event && registered.listener===listener,
        );
        if (index!==-1) {
            this.socketListeners.splice(index, 1);
        }
        this.socket?.removeListener?.(event, listener);
        this.socket?.off?.(event, listener);
    }

    private resumeSocketListeners() {
        // Without this, every non-VFS handler stays bound to the socket that
        // `init()` just discarded: collaborator cursors, join/leave and chat go
        // silently dead for the rest of the session after any reconnect or
        // v1->v2 fallback.
        for (const {event, listener} of this.socketListeners) {
            this.socket?.on(event, listener);
        }
    }

    private notifySocketError(error: SocketConnectionError) {
        if (this.socketErrorHandlers.size===0) {
            if (!this.isKnownFallbackError(error)) {
                console.error('SocketIOAPI: error', error);
            }
            return;
        }

        for (const handler of [...this.socketErrorHandlers]) {
            handler(error);
        }
    }

    private handleSocketError(error:any) {
        const normalizedError = this.normalizeSocketError(error);
        if (this.scheme==='v1' && this.isHandshakeFallbackError(normalizedError)) {
            this.scheme = 'v2';
            console.log(`SocketIOAPI: falling back to v2 (${normalizedError.message})`);
            this.disconnectSocket();
        }

        this.notifySocketError(normalizedError);
    }

    private initInternalHandlers() {
        this.socket.on('connect', () => {
            console.log('SocketIOAPI: connected');
        });
        // Registered internally rather than per-handler: this is the single
        // place the connection state machine is driven from, so it must survive
        // socket replacement and must fire exactly once per socket.
        this.socket.on('disconnect', () => {
            this.notifyDisconnected();
        });
        this.socket.on('connect_failed', () => {
            const error = this.normalizeSocketError('connect_failed');
            if (this.socketErrorHandlers.size>0) {
                console.log('SocketIOAPI: connect_failed');
                this.notifySocketError(error);
            }
            // The legacy client does not reconnect on its own, so a failed
            // handshake leaves a permanently dead socket behind.
            this.notifyDisconnected();
        });
        this.socket.on('forceDisconnect', (message:string, delay=10) => {
            console.log('SocketIOAPI: forceDisconnect', message);
            this.notifySocketError(this.normalizeSocketError(message));
        });
        this.socket.on('connectionRejected', (err:any) => {
            const error = this.normalizeSocketError(err, this.scheme==='v1');
            console.log('SocketIOAPI: connectionRejected.', error.message);
            if (this.scheme==='v1') {
                this.scheme = 'v2';
                console.log(`SocketIOAPI: falling back to v2 (${error.message})`);
                this.disconnectSocket();
            }
            this.notifySocketError(error);
        });
        this.socket.on('error', (err:any) => {
            this.handleSocketError(err);
        });

        if (this.scheme==='v2') {
            this.recordGeneration = this.socketGeneration;
            this.record = new Promise((resolve, reject) => {
                const socketErrorHandler: SocketErrorHandler = (error) => {
                    this.socketErrorHandlers.delete(socketErrorHandler);
                    if (this.recordErrorHandler===socketErrorHandler) {
                        this.recordErrorHandler = undefined;
                    }
                    reject(error);
                };
                this.recordErrorHandler = socketErrorHandler;
                this.socketErrorHandlers.add(socketErrorHandler);
                this.socket.on('joinProjectResponse', (...args:any[]) => {
                    this.socketErrorHandlers.delete(socketErrorHandler);
                    if (this.recordErrorHandler===socketErrorHandler) {
                        this.recordErrorHandler = undefined;
                    }
                    const parsed = this.parseJoinProjectResponse(args);
                    if (!parsed) {
                        const shape = args.map(value => {
                            if (Array.isArray(value)) {
                                return `array(${value.length})`;
                            }
                            if (value && typeof value==='object') {
                                return `object(${Object.keys(value).sort().join(',')})`;
                            }
                            return typeof value;
                        }).join(', ');
                        reject(new Error(`Invalid joinProjectResponse payload: ${shape}`));
                        return;
                    }
                    const {publicId, project} = parsed;
                    EventBus.fire('socketioConnectedEvent', {publicId});
                    resolve(project);
                });
            });
        }
    }

    private parseJoinProjectResponse(
        args: any[],
    ): {publicId: string; project: ProjectEntity} | undefined {
        const values = args.flatMap(value => Array.isArray(value) ? value : [value]);
        const containers = values.filter(value => value && typeof value==='object');
        const project = [
            ...containers.map(value => value.project),
            ...containers.map(value => value.data?.project),
            ...containers,
        ].find(candidate =>
            candidate
            && typeof candidate==='object'
            && Array.isArray(candidate.rootFolder)
        ) as ProjectEntity | undefined;
        if (!project) { return undefined; }

        const publicId = containers
            .map(value => value.publicId ?? value.public_id ?? value.data?.publicId)
            .find(value => typeof value==='string')
            ?? values.find(value => typeof value==='string')
            ?? '';
        return {publicId, project};
    }

    disconnect() {
        this.disconnectSocket({removeListeners: false});
    }

    dispose() {
        // The owner is going away, so a reconnect must not be attempted.
        this.disconnectSocket({notify: false});
    }

    get handlers() {
        return this._handlers;
    }

    get isUsingAlternativeConnectionScheme() {
        return this.scheme==='Alt';
    }

    get needsReinit() {
        return this.initializedScheme!==this.scheme || !this.socket || this.socketDead;
    }

    toggleAlternativeConnectionScheme(url: string, updatedRecord?: ProjectEntity) {
        this.scheme = this.scheme==='Alt' ? 'v1' : 'Alt';
        if (updatedRecord) {
            this.url = url;
            this.record = Promise.resolve(updatedRecord);
        }
    }

    resumeEventHandlers(handlers: Array<EventsHandler>) {
        this._handlers = [];
        handlers.forEach((handler) => {
            this.updateEventHandlers(handler);
        });
    }

    updateEventHandlers(handlers: EventsHandler): vscode.Disposable {
        this._handlers.push(handlers);
        const disposables: vscode.Disposable[] = [];
        const addSocketListener = (event: string, listener: (...args:any[]) => void) => {
            // Registered through the registry, not against the socket captured
            // at registration time: `init()` replaces the socket and the
            // listener has to follow it.
            this.addSocketListener(event, listener);
            disposables.push(new vscode.Disposable(() => {
                this.removeSocketListener(event, listener);
            }));
        };
        const addEventBusListener = <T extends keyof Events>(event: T, listener: (arg: Events[T]) => void) => {
            disposables.push(EventBus.on(event, listener));
        };
        Object.values(handlers).forEach((handler) => {
            switch (handler) {
                case handlers.onFileCreated:
                    addSocketListener('reciveNewDoc', (parentFolderId:string, doc:DocumentEntity) => {
                        handler(parentFolderId, 'doc', doc);
                    });
                    addSocketListener('reciveNewFile', (parentFolderId:string, file:FileRefEntity) => {
                        handler(parentFolderId, 'file', file);
                    });
                    addSocketListener('reciveNewFolder', (parentFolderId:string, folder:FolderEntity) => {
                        handler(parentFolderId, 'folder', folder);
                    });
                    break;
                case handlers.onFileRenamed:
                    addSocketListener('reciveEntityRename', (entityId:string, newName:string) => {
                        handler(entityId, newName);
                    });
                    break;
                case handlers.onFileRemoved:
                    addSocketListener('removeEntity', (entityId:string) => {
                        handler(entityId);
                    });
                    break;
                case handlers.onFileMoved:
                    addSocketListener('reciveEntityMove', (entityId:string, folderId:string) => {
                        handler(entityId, folderId);
                    });
                    break;
                case handlers.onFileChanged:
                    addSocketListener('otUpdateApplied', (update: UpdateSchema) => {
                        handler(update);
                    });
                    break;
                case handlers.onDisconnected:
                    // Dispatched by `notifyDisconnected` over `_handlers`: a
                    // socket listener would be silent whenever the transport is
                    // torn down without emitting `disconnect`.
                    break;
                case handlers.onConnectionAccepted:
                    addSocketListener('connectionAccepted', (_:any, publicId:any) => {
                        handler(publicId);
                    });
                    addEventBusListener('socketioConnectedEvent', (arg:{publicId:string}) => {
                        handler(arg.publicId);
                    });
                    break;
                case handlers.onClientUpdated:
                    addSocketListener('clientTracking.clientUpdated', (user:UpdateUserSchema) => {
                        handler(user);
                    });
                    break;
                case handlers.onClientDisconnected:
                    addSocketListener('clientTracking.clientDisconnected', (id:string) => {
                        handler(id);
                    });
                    break;
                case handlers.onReceivedMessage:
                    addSocketListener('new-chat-message', (message:ProjectMessageResponseSchema) => {
                        handler(message);
                    });
                    break;
                case handlers.onSpellCheckLanguageUpdated:
                    addSocketListener('spellCheckLanguageUpdated', (language:string) => {
                        handler(language);
                    });
                    break;
                case handlers.onCompilerUpdated:
                    addSocketListener('compilerUpdated', (compiler:string) => {
                        handler(compiler);
                    });
                    break;
                case handlers.onRootDocUpdated:
                    addSocketListener('rootDocUpdated', (rootDocId:string) => {
                        handler(rootDocId);
                    });
                    break;
                default:
                    break;
            }
        });
        return new vscode.Disposable(() => {
            const index = this._handlers.indexOf(handlers);
            if (index!==-1) {
                this._handlers.splice(index, 1);
            }
            disposables.forEach(disposable => disposable.dispose());
        });
    }

    get unSyncFileChanges(): number {
        if (this.socket instanceof SocketIOAlt) {
            return this.socket.unSyncedChanges;
        }
        return 0;
    }

    async syncFileChanges() {
        if (this.socket instanceof SocketIOAlt) {
            return await this.socket.uploadToVFS();
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/connection/ConnectionManager.js#L427
     * @param {string} projectId - The project id.
     * @returns {Promise}
     */
    async joinProject(project_id:string): Promise<ProjectEntity> {
        if (this.scheme==='v2' && (
            this.record===undefined
            || this.recordGeneration!==this.socketGeneration
            || this.socketDead
        )) {
            // The v2 branch emits nothing and just awaits the cached record, so
            // a record left over from a superseded socket would resolve the
            // previous session's project tree and report a dead connection as
            // live. Fail instead and let the caller re-init the socket.
            throw new Error('socket session superseded');
        }
        let timeout: NodeJS.Timeout;
        const timeoutPromise: Promise<ProjectEntity> = new Promise((_, reject) => {
            timeout = setTimeout(() => {
                reject(new Error('timeout'));
            }, SOCKET_ACK_TIMEOUT_MS);
        });

        switch(this.scheme) {
            case 'Alt':
            case 'v1':
                const joinPromise = this.emit('joinProject', {project_id})
                .then((returns:[ProjectEntity, string, number]) => {
                    const [project, permissionsLevel, protocolVersion] = returns;
                    this.record = Promise.resolve(project);
                    return project;
                });
                let socketErrorHandler: SocketErrorHandler | undefined;
                const rejectPromise = new Promise((_, reject) => {
                    socketErrorHandler = (error: SocketConnectionError) => {
                        reject(error);
                    };
                    this.socketErrorHandlers.add(socketErrorHandler);
                });
                return Promise.race([joinPromise, rejectPromise, timeoutPromise]).finally(() => {
                    clearTimeout(timeout);
                    if (socketErrorHandler) {
                        this.socketErrorHandlers.delete(socketErrorHandler);
                    }
                }) as Promise<ProjectEntity>;
            case 'v2':
                return Promise.race([this.record!, timeoutPromise]).finally(() => {
                    clearTimeout(timeout);
                    if (this.recordErrorHandler) {
                        this.socketErrorHandlers.delete(this.recordErrorHandler);
                        this.recordErrorHandler = undefined;
                    }
                }) as Promise<ProjectEntity>;
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L500
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async joinDoc(
        docId:string,
        fromVersion?: number,
    ): Promise<JoinDocumentResponse> {
        // The official editor requests the known document version when it has
        // a subscribed cache. The server then returns only the retained OT
        // operations necessary to catch up, while a first join remains the
        // legacy two-argument request for full compatibility.
        // Do not advertise history OT support: this extension validates only
        // sharejs-text-ot operations, so the server must reject an unsupported
        // history document instead of sending an unsafe wire representation.
        const options = {encodeRanges: true};
        const request = fromVersion===undefined || fromVersion<0
            ? this.emit('joinDoc', docId, options)
            : this.emit('joinDoc', docId, fromVersion, options);
        return request
            .then((returns: [Array<string>, number, Array<UpdateSchema>?, any?, string?]) => {
                const [docLinesAscii, version, updates = [], ranges, type] = returns;
                const docLines = docLinesAscii.map((line) => decodePackedUtf8(line));
                return {docLines, version, updates, ranges, type};
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L591
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async leaveDoc(docId:string) {
        return this.emit('leaveDoc', docId)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/ShareJsDocs.js#L78
     * @param {string} docId - The document id.
     * @param {any} update - The changes.
     * @returns {Promise}
     */
    async applyOtUpdate(docId:string, update:UpdateSchema) {
        return this.emit('applyOtUpdate', docId, update)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L42
     * @returns {Promise}
     */
    async getConnectedUsers(): Promise<OnlineUserSchema[]> {
        return this.emit('clientTracking.getConnectedUsers')
            .then((returns:[OnlineUserSchema[]]) => {
                const [connectedUsers] = returns;
                return connectedUsers;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L150
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async updatePosition(doc_id:string, row:number, column:number) {
        return this.emit('clientTracking.updatePosition', {row, column, doc_id})
            .then(() => {
                return;
            });
    }
}
