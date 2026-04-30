/* eslint-disable @typescript-eslint/naming-convention */
import { Identity, BaseAPI, ProjectMessageResponseSchema } from './base';
import { FileEntity, DocumentEntity, FileRefEntity, FileType, FolderEntity, ProjectEntity } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';
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

    constructor(private url:string,
                private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string)
    {
        this.init();
    }

    init() {
        this.disconnectSocket();
        this.socketErrorHandlers.clear();
        this.recordErrorHandler = undefined;
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
        // create emit
        (this.socket.emit)[require('util').promisify.custom] = (event:string, ...args:any[]) => {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
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
            return Promise.race([waitPromise, timeoutPromise]);
        };
        this.emit = require('util').promisify(this.socket.emit).bind(this.socket);
        // resume handlers
        this.initInternalHandlers();
        // this.resumeEventHandlers(this._handlers);
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
        return error.message==='client not handshaken';
    }

    private isKnownFallbackError(error: Error): boolean {
        return this.isHandshakeFallbackError(error)
            || error.message==='invalid session'
            || error.message==='connect_failed';
    }

    private disconnectSocket() {
        try {
            this.socket?.removeAllListeners?.();
            this.socket?.disconnect();
        } catch {
            // Ignore cleanup errors from already-closing transports.
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
            this.disconnectSocket();
        }

        this.notifySocketError(normalizedError);
    }

    private initInternalHandlers() {
        this.socket.on('connect', () => {
            console.log('SocketIOAPI: connected');
        });
        this.socket.on('connect_failed', () => {
            const error = this.normalizeSocketError('connect_failed');
            if (this.socketErrorHandlers.size>0) {
                console.log('SocketIOAPI: connect_failed');
                this.notifySocketError(error);
            }
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
                this.disconnectSocket();
            }
            this.notifySocketError(error);
        });
        this.socket.on('error', (err:any) => {
            this.handleSocketError(err);
        });

        if (this.scheme==='v2') {
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
                this.socket.on('joinProjectResponse', (res:any) => {
                    this.socketErrorHandlers.delete(socketErrorHandler);
                    if (this.recordErrorHandler===socketErrorHandler) {
                        this.recordErrorHandler = undefined;
                    }
                    const publicId = res.publicId as string;
                    const project = res.project as ProjectEntity;
                    EventBus.fire('socketioConnectedEvent', {publicId});
                    resolve(project);
                });
            });
        }
    }

    disconnect() {
        this.socket.disconnect();
    }

    get handlers() {
        return this._handlers;
    }

    get isUsingAlternativeConnectionScheme() {
        return this.scheme==='Alt';
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

    updateEventHandlers(handlers: EventsHandler) {
        this._handlers.push(handlers);
        Object.values(handlers).forEach((handler) => {
            switch (handler) {
                case handlers.onFileCreated:
                    this.socket.on('reciveNewDoc', (parentFolderId:string, doc:DocumentEntity) => {
                        handler(parentFolderId, 'doc', doc);
                    });
                    this.socket.on('reciveNewFile', (parentFolderId:string, file:FileRefEntity) => {
                        handler(parentFolderId, 'file', file);
                    });
                    this.socket.on('reciveNewFolder', (parentFolderId:string, folder:FolderEntity) => {
                        handler(parentFolderId, 'folder', folder);
                    });
                    break;
                case handlers.onFileRenamed:
                    this.socket.on('reciveEntityRename', (entityId:string, newName:string) => {
                        handler(entityId, newName);
                    });
                    break;
                case handlers.onFileRemoved:
                    this.socket.on('removeEntity', (entityId:string) => {
                        handler(entityId);
                    });
                    break;
                case handlers.onFileMoved:
                    this.socket.on('reciveEntityMove', (entityId:string, folderId:string) => {
                        handler(entityId, folderId);
                    });
                    break;
                case handlers.onFileChanged:
                    this.socket.on('otUpdateApplied', (update: UpdateSchema) => {
                        handler(update);
                    });
                    break;
                case handlers.onDisconnected:
                    this.socket.on('disconnect', () => {
                        handler();
                    });
                    break;
                case handlers.onConnectionAccepted:
                    this.socket.on('connectionAccepted', (_:any, publicId:any) => {
                        handler(publicId);
                    });
                    EventBus.on('socketioConnectedEvent', (arg:{publicId:string}) => {
                        handler(arg.publicId);
                    });
                    break;
                case handlers.onClientUpdated:
                    this.socket.on('clientTracking.clientUpdated', (user:UpdateUserSchema) => {
                        handler(user);
                    });
                    break;
                case handlers.onClientDisconnected:
                    this.socket.on('clientTracking.clientDisconnected', (id:string) => {
                        handler(id);
                    });
                    break;
                case handlers.onReceivedMessage:
                    this.socket.on('new-chat-message', (message:ProjectMessageResponseSchema) => {
                        handler(message);
                    });
                    break;
                case handlers.onSpellCheckLanguageUpdated:
                    this.socket.on('spellCheckLanguageUpdated', (language:string) => {
                        handler(language);
                    });
                    break;
                case handlers.onCompilerUpdated:
                    this.socket.on('compilerUpdated', (compiler:string) => {
                        handler(compiler);
                    });
                    break;
                case handlers.onRootDocUpdated:
                    this.socket.on('rootDocUpdated', (rootDocId:string) => {
                        handler(rootDocId);
                    });
                    break;
                default:
                    break;
            }
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
        const timeoutPromise: Promise<ProjectEntity> = new Promise((_, reject) => {
            setTimeout(() => {
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
                    if (socketErrorHandler) {
                        this.socketErrorHandlers.delete(socketErrorHandler);
                    }
                }) as Promise<ProjectEntity>;
            case 'v2':
                return Promise.race([this.record!, timeoutPromise]).finally(() => {
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
    async joinDoc(docId:string) {
        return this.emit('joinDoc', docId, { encodeRanges: true })
            .then((returns: [Array<string>, number, Array<any>, any]) => {
                const [docLinesAscii, version, updates, ranges] = returns;
                const docLines = docLinesAscii.map((line) => decodePackedUtf8(line));
                return {docLines, version, updates, ranges};
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
