import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentReviewManager } from '../../agentReview/agentReviewManager';
import { BaseAPI } from '../../api/base';
import { SocketIOAPI } from '../../api/socketio';
import {
    RemoteDocumentMergeConflictError,
    RemoteDocumentWriteAmbiguousError,
    RemoteMutationRejectedError,
    RemoteFileSystemProvider,
    VirtualFileSystem,
    vfsProjectKey,
} from '../../core/remoteFileSystemProvider';
import { ProjectManagerProvider } from '../../core/projectManagerProvider';
import { GlobalStateManager } from '../../utils/globalStateManager';
import { ROOT_NAME, STATE_SERVERS_KEY } from '../../consts';

suite('Extension host and lifecycle isolation', () => {
    const attachAuthenticatedSession = (internals: any) => {
        const serverName = 'www.overleaf.com';
        const userId = 'user-1';
        const identity = {
            csrfToken: 'test-token',
            cookies: 'session=test',
        };
        const persists = {
            [serverName]: {
                name: serverName,
                url: `https://${serverName}`,
                login: {
                    userId,
                    username: 'user@example.test',
                    identity,
                },
            },
        };
        internals.context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    key===STATE_SERVERS_KEY ? persists as T : defaultValue as T,
            },
        } as unknown as vscode.ExtensionContext;
        internals.serverName = serverName;
        internals.userId = userId;
        internals.sessionIdentity = identity;
    };

    test('refuses stale replica activation when its server or account state is missing', async () => {
        const state = new Map<string, unknown>();
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
            },
        } as unknown as vscode.ExtensionContext;

        assert.strictEqual(
            GlobalStateManager.initSocketIOAPI(
                context,
                'www.overleaf.com',
                'demo-project',
                'demo-user',
            ),
            undefined,
        );
        await assert.rejects(
            GlobalStateManager.authenticate(context, 'www.overleaf.com', 'demo-user'),
            /No matching authenticated account/,
        );
    });

    test('refuses to reuse another account session for a persisted replica', async () => {
        const serverName = 'www.overleaf.com';
        const state = new Map<string, unknown>([[
            STATE_SERVERS_KEY,
            {
                [serverName]: {
                    name: serverName,
                    url: 'https://www.overleaf.com',
                    login: {
                        userId: 'current-user',
                        username: 'current@example.test',
                        identity: {csrfToken: 'token', cookies: 'session=test'},
                    },
                },
            },
        ]]);
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
            },
        } as unknown as vscode.ExtensionContext;

        assert.strictEqual(
            GlobalStateManager.initSocketIOAPI(
                context,
                serverName,
                'shared-project',
                'persisted-user',
            ),
            undefined,
        );
        await assert.rejects(
            GlobalStateManager.authenticate(context, serverName, 'persisted-user'),
            /No matching authenticated account/,
        );
    });

    test('lets only the latest overlapping login response update server state', async () => {
        const serverName = 'www.overleaf.com';
        const state = new Map<string, unknown>([[
            STATE_SERVERS_KEY,
            {
                [serverName]: {
                    name: serverName,
                    url: 'https://www.overleaf.com',
                },
            },
        ]]);
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
                update: async (key: string, value: unknown) => {
                    state.set(key, value);
                },
            },
        } as unknown as vscode.ExtensionContext;
        let releaseFirst!: (value: unknown) => void;
        let releaseSecond!: (value: unknown) => void;
        const firstResponse = new Promise(resolve => {
            releaseFirst = resolve;
        });
        const secondResponse = new Promise(resolve => {
            releaseSecond = resolve;
        });
        const api = {
            cookiesLogin: async (cookies: string) =>
                cookies==='first' ? firstResponse : secondResponse,
        };

        const first = GlobalStateManager.loginServer(
            context,
            api as any,
            serverName,
            {cookies: 'first'},
        );
        const second = GlobalStateManager.loginServer(
            context,
            api as any,
            serverName,
            {cookies: 'second'},
        );
        releaseSecond({
            type: 'success',
            identity: {csrfToken: 'second-token', cookies: 'second-cookie'},
            userInfo: {userId: 'user-2', userEmail: 'second@example.test'},
        });
        assert.strictEqual(await second, true);
        releaseFirst({
            type: 'success',
            identity: {csrfToken: 'first-token', cookies: 'first-cookie'},
            userInfo: {userId: 'user-1', userEmail: 'first@example.test'},
        });
        assert.strictEqual(await first, false);

        const servers = state.get(STATE_SERVERS_KEY) as any;
        assert.strictEqual(servers[serverName].login.userId, 'user-2');
        assert.strictEqual(servers[serverName].login.identity.cookies, 'second-cookie');
    });

    test('rejects a project-list response after the authenticated session changes', async () => {
        const serverName = 'www.overleaf.com';
        const firstIdentity = {
            csrfToken: 'first-token',
            cookies: 'first-cookie',
        };
        const state = new Map<string, unknown>([[
            STATE_SERVERS_KEY,
            {
                [serverName]: {
                    name: serverName,
                    url: 'https://www.overleaf.com',
                    login: {
                        userId: 'user-1',
                        username: 'first@example.test',
                        identity: firstIdentity,
                    },
                },
            },
        ]]);
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
                update: async (key: string, value: unknown) => {
                    state.set(key, value);
                },
            },
        } as unknown as vscode.ExtensionContext;
        let signalRequest!: () => void;
        const requestStarted = new Promise<void>(resolve => {
            signalRequest = resolve;
        });
        let releaseProjects!: (value: unknown) => void;
        const projectsResponse = new Promise(resolve => {
            releaseProjects = resolve;
        });
        const api = {
            getProjectsJson: async () => {
                signalRequest();
                return projectsResponse;
            },
            userProjectsJson: async () => assert.fail('Fallback must not run for a successful stale response.'),
        };

        const fetch = GlobalStateManager.fetchServerProjects(
            context,
            api as any,
            serverName,
        );
        await requestStarted;
        state.set(STATE_SERVERS_KEY, {
            [serverName]: {
                name: serverName,
                url: 'https://www.overleaf.com',
                login: {
                    userId: 'user-2',
                    username: 'second@example.test',
                    identity: {
                        csrfToken: 'second-token',
                        cookies: 'second-cookie',
                    },
                },
            },
        });
        releaseProjects({
            type: 'success',
            projects: [{id: 'project-a', name: 'First account project'}],
        });

        await assert.rejects(fetch, /No matching authenticated account/);
        const servers = state.get(STATE_SERVERS_KEY) as any;
        assert.strictEqual(servers[serverName].login.userId, 'user-2');
        assert.strictEqual(servers[serverName].login.projects, undefined);
    });

    test('rejects a tag response after login replacement without rebuilding the tree cache', async () => {
        const serverName = 'www.overleaf.com';
        const firstIdentity = {
            csrfToken: 'first-token',
            cookies: 'first-cookie',
        };
        const state = new Map<string, unknown>([[
            STATE_SERVERS_KEY,
            {
                [serverName]: {
                    name: serverName,
                    url: 'https://www.overleaf.com',
                    login: {
                        userId: 'user-1',
                        username: 'first@example.test',
                        identity: firstIdentity,
                    },
                },
            },
        ]]);
        const context = {
            extensionUri: vscode.Uri.file('/tmp/test-extension'),
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
                update: async (key: string, value: unknown) => {
                    state.set(key, value);
                },
            },
        } as unknown as vscode.ExtensionContext;
        let signalTags!: () => void;
        const tagsStarted = new Promise<void>(resolve => {
            signalTags = resolve;
        });
        let releaseTags!: (value: unknown) => void;
        const tagsResponse = new Promise(resolve => {
            releaseTags = resolve;
        });
        const server = {
            name: serverName,
            api: {
                getAllTags: async () => {
                    signalTags();
                    return tagsResponse;
                },
            },
            tags: undefined,
        };
        const provider = new ProjectManagerProvider(context);
        const originalFetch = (GlobalStateManager as any).fetchServerProjects;
        (GlobalStateManager as any).fetchServerProjects = async () => [{
            id: 'project-a',
            name: 'First account project',
            userId: 'user-1',
        }];

        try {
            const children = (provider as any).getServerChildren(server);
            await tagsStarted;
            state.set(STATE_SERVERS_KEY, {
                [serverName]: {
                    name: serverName,
                    url: 'https://www.overleaf.com',
                    login: {
                        userId: 'user-2',
                        username: 'second@example.test',
                        identity: {
                            csrfToken: 'second-token',
                            cookies: 'second-cookie',
                        },
                    },
                },
            });
            releaseTags({
                type: 'success',
                tags: [{
                    _id: 'tag-a',
                    name: 'Old account tag',
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    project_ids: ['project-a'],
                }],
            });

            assert.deepStrictEqual(await children, []);
            assert.strictEqual((provider as any).itemIndex.size, 0);
            assert.strictEqual(server.tags, undefined);
        } finally {
            (GlobalStateManager as any).fetchServerProjects = originalFetch;
        }
    });

    test('does not let a delayed logout clear a replacement login', async () => {
        const serverName = 'www.overleaf.com';
        const firstIdentity = {
            csrfToken: 'first-token',
            cookies: 'first-cookie',
        };
        const state = new Map<string, unknown>([[
            STATE_SERVERS_KEY,
            {
                [serverName]: {
                    name: serverName,
                    url: 'https://www.overleaf.com',
                    login: {
                        userId: 'user-1',
                        username: 'first@example.test',
                        identity: firstIdentity,
                    },
                },
            },
        ]]);
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
                update: async (key: string, value: unknown) => {
                    state.set(key, value);
                },
            },
        } as unknown as vscode.ExtensionContext;
        let signalLogout!: () => void;
        const logoutStarted = new Promise<void>(resolve => {
            signalLogout = resolve;
        });
        let releaseLogout!: () => void;
        const logoutBlocked = new Promise<void>(resolve => {
            releaseLogout = resolve;
        });
        const api = {
            logout: async () => {
                signalLogout();
                await logoutBlocked;
            },
        };

        const logout = GlobalStateManager.logoutServer(
            context,
            api as any,
            serverName,
        );
        await logoutStarted;
        state.set(STATE_SERVERS_KEY, {
            [serverName]: {
                name: serverName,
                url: 'https://www.overleaf.com',
                login: {
                    userId: 'user-2',
                    username: 'second@example.test',
                    identity: {
                        csrfToken: 'second-token',
                        cookies: 'second-cookie',
                    },
                },
            },
        });
        releaseLogout();

        assert.strictEqual(await logout, false);
        const servers = state.get(STATE_SERVERS_KEY) as any;
        assert.strictEqual(servers[serverName].login.userId, 'user-2');
    });

    test('blocks a connected VFS after logout or session replacement before OT can be sent', async () => {
        const serverName = 'www.overleaf.com';
        const userId = 'user-1';
        const originalIdentity = {
            csrfToken: 'original-token',
            cookies: 'session=original',
        };
        const state = new Map<string, unknown>([[
            STATE_SERVERS_KEY,
            {
                [serverName]: {
                    name: serverName,
                    url: 'https://www.overleaf.com',
                    login: {
                        userId,
                        username: 'user@example.test',
                        identity: originalIdentity,
                    },
                },
            },
        ]]);
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
            },
        } as unknown as vscode.ExtensionContext;
        let otUpdateCount = 0;
        const createConnectedVfs = () => {
            const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
            const internals = vfs as any;
            internals.context = context;
            internals.serverName = serverName;
            internals.userId = userId;
            internals.sessionIdentity = originalIdentity;
            internals._connectionState = 'connected';
            internals.disposed = false;
            internals.origin = vscode.Uri.parse(
                `${ROOT_NAME}://www.overleaf.com/Project?user=${userId}&project=project-1`,
            );
            internals.dispose = () => {
                internals.disposed = true;
            };
            internals.socket = {
                applyOtUpdate: async () => {
                    otUpdateCount += 1;
                },
            };
            return vfs;
        };
        const documentUri = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project/main.tex?user=${userId}&project=project-1`,
        );

        const logoutVfs = createConnectedVfs();
        await logoutVfs.ensureConnectedForWrite();
        state.set(STATE_SERVERS_KEY, {});
        await assert.rejects(
            () => logoutVfs.writeFileFromRemoteBaseline(
                documentUri,
                new TextEncoder().encode('blocked after logout'),
            ),
            /No matching authenticated account/,
        );

        state.set(STATE_SERVERS_KEY, {
            [serverName]: {
                name: serverName,
                url: 'https://www.overleaf.com',
                login: {
                    userId,
                    username: 'user@example.test',
                    identity: {
                        csrfToken: 'replacement-token',
                        cookies: 'session=replacement',
                    },
                },
            },
        });
        const replacementVfs = createConnectedVfs();
        await assert.rejects(
            () => replacementVfs.writeFileFromRemoteBaseline(
                documentUri,
                new TextEncoder().encode('blocked after session replacement'),
            ),
            /No matching authenticated account/,
        );
        assert.strictEqual(otUpdateCount, 0);
    });

    test('drops inbound socket events and disposes a VFS after its session is removed', () => {
        const state = new Map<string, unknown>();
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        state.set(
            STATE_SERVERS_KEY,
            internals.context.globalState.get(STATE_SERVERS_KEY, {}),
        );
        internals.context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
            },
        } as unknown as vscode.ExtensionContext;
        internals.disposed = false;
        internals.origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project?user=user-1&project=project-1`,
        );
        internals.remoteWatchDisposable = undefined;
        let handlers: any;
        let disposeCount = 0;
        let notifyCount = 0;
        internals.socket = {
            updateEventHandlers: (value: any) => {
                handlers = value;
                return {dispose: () => undefined};
            },
        };
        internals.dispose = () => {
            internals.disposed = true;
            disposeCount += 1;
        };
        internals._resolveById = () => ({
            fileEntity: {
                _id: 'doc-1',
                name: 'main.tex',
                version: 0,
                remoteCache: '',
                localCache: '',
            },
            path: '/main.tex',
        });
        internals.notify = () => {
            notifyCount += 1;
        };
        internals.remoteWatch();

        state.set(STATE_SERVERS_KEY, {});
        handlers.onFileChanged({
            doc: 'doc-1',
            v: 0,
            op: [{p: 0, i: 'must not arrive'}],
        });

        assert.strictEqual(disposeCount, 1);
        assert.strictEqual(internals.disposed, true);
        assert.strictEqual(notifyCount, 0);
    });

    test('deactivates every live project for a removed server', async () => {
        const provider = Object.create(RemoteFileSystemProvider.prototype) as RemoteFileSystemProvider;
        const internals = provider as any;
        const disposed: string[] = [];
        const makeVfs = (serverName: string, name: string) => ({
            serverName,
            origin: vscode.Uri.parse(`${ROOT_NAME}://${serverName}/${name}?user=u&project=${name}`),
            dispose: () => disposed.push(name),
        });
        const first = makeVfs('www.overleaf.com', 'first');
        const second = makeVfs('www.overleaf.com', 'second');
        const retained = makeVfs('other.example.test', 'retained');
        internals.disposed = false;
        internals.vfss = {first, second, retained};
        internals._activeVFS = first;
        internals.setActiveVFS = (vfs: unknown) => {
            internals._activeVFS = vfs;
        };

        await provider.deactivateServer('www.overleaf.com');

        assert.deepStrictEqual(disposed.sort(), ['first', 'second']);
        assert.strictEqual(internals._activeVFS, undefined);
        assert.deepStrictEqual(Object.keys(internals.vfss), ['retained']);
    });

    test('deactivates an expired server before clearing its authenticated state', async () => {
        const calls: string[] = [];
        const remoteFileSystem = {
            deactivateServer: async (serverName: string) => {
                calls.push(`deactivate:${serverName}`);
            },
        } as unknown as RemoteFileSystemProvider;
        const provider = new ProjectManagerProvider(
            {} as vscode.ExtensionContext,
            remoteFileSystem,
        );
        const originalLogout = (GlobalStateManager as any).logoutServer;
        (GlobalStateManager as any).logoutServer = async (
            _context: vscode.ExtensionContext,
            _api: unknown,
            serverName: string,
        ) => {
            calls.push(`logout:${serverName}`);
            return true;
        };
        (provider as any).refresh = () => {
            calls.push('refresh');
        };

        try {
            await (provider as any).logoutExpiredServer({}, 'www.overleaf.com');
            assert.deepStrictEqual(calls, [
                'deactivate:www.overleaf.com',
                'logout:www.overleaf.com',
                'refresh',
            ]);
        } finally {
            (GlobalStateManager as any).logoutServer = originalLogout;
        }
    });

    test('rejects a document response that arrives after session replacement', async () => {
        const state = new Map<string, unknown>();
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        state.set(
            STATE_SERVERS_KEY,
            internals.context.globalState.get(STATE_SERVERS_KEY, {}),
        );
        internals.context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
            },
        } as unknown as vscode.ExtensionContext;
        internals.disposed = false;
        internals.origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project?user=user-1&project=project-1`,
        );
        internals.documentCollaboratorRevisions = new Map();
        const document = {
            _id: 'doc-1',
            name: 'main.tex',
            version: undefined,
            remoteCache: undefined,
            localCache: undefined,
        };
        internals._resolveUri = async () => ({
            fileType: 'doc',
            fileEntity: document,
        });
        let signalJoin!: () => void;
        const joinStarted = new Promise<void>(resolve => {
            signalJoin = resolve;
        });
        let releaseJoin!: () => void;
        const joinBlocked = new Promise<void>(resolve => {
            releaseJoin = resolve;
        });
        internals.socket = {
            joinDoc: async () => {
                signalJoin();
                await joinBlocked;
                return {docLines: ['stale session content'], version: 4};
            },
        };
        let disposeCount = 0;
        internals.dispose = () => {
            internals.disposed = true;
            disposeCount += 1;
        };
        const uri = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project/main.tex?user=user-1&project=project-1`,
        );

        const read = vfs.openFile(uri);
        await joinStarted;
        state.set(STATE_SERVERS_KEY, {
            ['www.overleaf.com']: {
                name: 'www.overleaf.com',
                url: 'https://www.overleaf.com',
                login: {
                    userId: 'user-1',
                    username: 'user@example.test',
                    identity: {
                        csrfToken: 'replacement-token',
                        cookies: 'session=replacement',
                    },
                },
            },
        });
        releaseJoin();

        await assert.rejects(read, /No matching authenticated account/);
        assert.strictEqual(disposeCount, 1);
        assert.strictEqual(document.remoteCache, undefined);
        assert.strictEqual(document.localCache, undefined);
    });

    test('rejects a binary response that arrives after logout', async () => {
        const state = new Map<string, unknown>();
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        state.set(
            STATE_SERVERS_KEY,
            internals.context.globalState.get(STATE_SERVERS_KEY, {}),
        );
        internals.context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
            },
        } as unknown as vscode.ExtensionContext;
        internals.disposed = false;
        internals.origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project?user=user-1&project=project-1`,
        );
        internals.projectId = 'project-1';
        internals._resolveUri = async () => ({
            fileType: 'file',
            fileEntity: {
                _id: 'file-1',
                name: 'figure.png',
            },
        });
        let signalDownload!: () => void;
        const downloadStarted = new Promise<void>(resolve => {
            signalDownload = resolve;
        });
        let releaseDownload!: () => void;
        const downloadBlocked = new Promise<void>(resolve => {
            releaseDownload = resolve;
        });
        internals.api = {
            getFile: async () => {
                signalDownload();
                await downloadBlocked;
                return {
                    type: 'success',
                    content: Buffer.from([1, 2, 3]),
                };
            },
        };
        let disposeCount = 0;
        internals.dispose = () => {
            internals.disposed = true;
            disposeCount += 1;
        };
        const uri = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project/figure.png?user=user-1&project=project-1`,
        );

        const read = vfs.openFile(uri);
        await downloadStarted;
        state.set(STATE_SERVERS_KEY, {});
        releaseDownload();

        await assert.rejects(read, /No matching authenticated account/);
        assert.strictEqual(disposeCount, 1);
    });

    test('rejects project settings that arrive after session replacement', async () => {
        const state = new Map<string, unknown>();
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        state.set(
            STATE_SERVERS_KEY,
            internals.context.globalState.get(STATE_SERVERS_KEY, {}),
        );
        internals.context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
            },
        } as unknown as vscode.ExtensionContext;
        internals.disposed = false;
        internals.origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project?user=user-1&project=project-1`,
        );
        internals.projectId = 'project-1';
        internals.retryConnection = 0;
        internals._connectionState = 'initial';
        internals.remoteWatch = () => undefined;
        internals.ensureActiveManagers = () => {
            throw new Error('stale project must not activate managers');
        };
        const project = {
            _id: 'project-1',
            name: 'Project',
            rootFolder: [],
        };
        internals.socket = {
            joinProject: async () => project,
        };
        let signalSettings!: () => void;
        const settingsStarted = new Promise<void>(resolve => {
            signalSettings = resolve;
        });
        let releaseSettings!: () => void;
        const settingsBlocked = new Promise<void>(resolve => {
            releaseSettings = resolve;
        });
        internals.api = {
            getProjectSettings: async () => {
                signalSettings();
                await settingsBlocked;
                return {settings: {compiler: 'pdflatex'}};
            },
        };
        let disposeCount = 0;
        internals.dispose = () => {
            internals.disposed = true;
            disposeCount += 1;
        };

        const initialization = vfs.init();
        await settingsStarted;
        state.set(STATE_SERVERS_KEY, {
            ['www.overleaf.com']: {
                name: 'www.overleaf.com',
                url: 'https://www.overleaf.com',
                login: {
                    userId: 'user-1',
                    username: 'user@example.test',
                    identity: {
                        csrfToken: 'replacement-token',
                        cookies: 'session=replacement',
                    },
                },
            },
        });
        releaseSettings();

        await assert.rejects(initialization, /No matching authenticated account/);
        assert.strictEqual(disposeCount, 1);
        assert.strictEqual(internals.root, undefined);
        assert.strictEqual((project as any).settings, undefined);
    });

    test('rejects document and binary create responses from a removed session', async () => {
        for (const content of [new Uint8Array(0), Buffer.from([1, 2, 3])]) {
            const state = new Map<string, unknown>();
            const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
            const internals = vfs as any;
            attachAuthenticatedSession(internals);
            state.set(
                STATE_SERVERS_KEY,
                internals.context.globalState.get(STATE_SERVERS_KEY, {}),
            );
            internals.context = {
                globalState: {
                    get: <T>(key: string, defaultValue?: T) =>
                        state.has(key) ? state.get(key) as T : defaultValue as T,
                },
            } as unknown as vscode.ExtensionContext;
            internals.disposed = false;
            internals.origin = vscode.Uri.parse(
                `${ROOT_NAME}://www.overleaf.com/Project?user=user-1&project=project-1`,
            );
            internals.projectId = 'project-1';
            const parentFolder = {
                _id: 'folder-1',
                name: 'root',
                docs: [],
                fileRefs: [],
                folders: [],
            };
            internals._resolveUri = async () => ({
                parentFolder,
                fileName: content.length===0 ? 'late.tex' : 'late.png',
                fileEntity: undefined,
            });
            let signalCreate!: () => void;
            const createStarted = new Promise<void>(resolve => {
                signalCreate = resolve;
            });
            let releaseCreate!: () => void;
            const createBlocked = new Promise<void>(resolve => {
                releaseCreate = resolve;
            });
            const response = {
                type: 'success',
                entity: {
                    _id: 'late-entity',
                    _type: content.length===0 ? 'doc' : 'file',
                    name: content.length===0 ? 'late.tex' : 'late.png',
                },
            };
            internals.api = {
                addDoc: async () => {
                    signalCreate();
                    await createBlocked;
                    return response;
                },
                uploadFile: async () => {
                    signalCreate();
                    await createBlocked;
                    return response;
                },
            };
            let insertedCount = 0;
            let notifyCount = 0;
            internals.insertEntity = () => {
                insertedCount += 1;
            };
            internals.notify = () => {
                notifyCount += 1;
            };
            internals.dispose = () => {
                internals.disposed = true;
            };
            const uri = vscode.Uri.parse(
                `${ROOT_NAME}://www.overleaf.com/Project/${content.length===0 ? 'late.tex' : 'late.png'}` +
                '?user=user-1&project=project-1',
            );

            const create = vfs.createFile(uri, content);
            await createStarted;
            state.set(STATE_SERVERS_KEY, {});
            releaseCreate();

            await assert.rejects(create, /No matching authenticated account/);
            assert.strictEqual(insertedCount, 0);
            assert.strictEqual(notifyCount, 0);
        }
    });

    test('rejects a late binary create-verification response after logout', async () => {
        const state = new Map<string, unknown>();
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        state.set(
            STATE_SERVERS_KEY,
            internals.context.globalState.get(STATE_SERVERS_KEY, {}),
        );
        internals.context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
            },
        } as unknown as vscode.ExtensionContext;
        internals.disposed = false;
        internals.origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project?user=user-1&project=project-1`,
        );
        internals.projectId = 'project-1';
        let signalVerification!: () => void;
        const verificationStarted = new Promise<void>(resolve => {
            signalVerification = resolve;
        });
        let releaseVerification!: () => void;
        const verificationBlocked = new Promise<void>(resolve => {
            releaseVerification = resolve;
        });
        internals.api = {
            getFile: async () => {
                signalVerification();
                await verificationBlocked;
                return {
                    type: 'success',
                    content: Buffer.from([4, 5, 6]),
                };
            },
        };
        internals.dispose = () => {
            internals.disposed = true;
        };
        const uri = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project/late.png?user=user-1&project=project-1`,
        );

        const verification = internals.readCreateVerificationContent(
            uri,
            'file',
            {_id: 'file-1', name: 'late.png'},
        );
        await verificationStarted;
        state.set(STATE_SERVERS_KEY, {});
        releaseVerification();

        await assert.rejects(verification, /No matching authenticated account/);
    });

    test('stores project SCM state independently when the project list cache is stale', async () => {
        const state = new Map<string, unknown>();
        const serverName = 'www.overleaf.com';
        state.set(STATE_SERVERS_KEY, {
            [serverName]: {
                name: serverName,
                url: 'https://www.overleaf.com',
                login: {
                    userId: 'user-1',
                    username: 'demo@example.test',
                    identity: {},
                    projects: [],
                },
            },
        });
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
                update: async (key: string, value: unknown) => {
                    if (value===undefined) {
                        state.delete(key);
                    } else {
                        state.set(key, value);
                    }
                },
            },
        } as unknown as vscode.ExtensionContext;
        const scmKey = 'file:///workspace/privacy-safe-demo/';
        const scmPersist = {
            enabled: true,
            label: 'Local Replica',
            baseUri: scmKey,
            settings: {} as JSON,
        };

        GlobalStateManager.updateServerProjectSCMPersist(
            context,
            serverName,
            'user-1',
            'new-demo-project',
            scmKey,
            scmPersist,
        );
        await Promise.resolve();

        assert.deepStrictEqual(
            GlobalStateManager.getServerProjectSCMPersists(
                context,
                serverName,
                'user-1',
                'new-demo-project',
            ),
            {[scmKey]: scmPersist},
        );

        state.set(STATE_SERVERS_KEY, {});
        assert.deepStrictEqual(
            GlobalStateManager.getServerProjectSCMPersists(
                context,
                serverName,
                'user-1',
                'new-demo-project',
            ),
            {[scmKey]: scmPersist},
        );
    });

    test('keeps an empty project SCM tombstone from reviving a removed legacy mapping', async () => {
        const scmKey = 'file:///workspace/removed-replica/';
        const serverName = 'www.overleaf.com';
        const legacyPersist = {
            enabled: true,
            label: 'Local Replica',
            baseUri: scmKey,
            settings: {} as JSON,
        };
        const state = new Map<string, unknown>([[
            STATE_SERVERS_KEY,
            {
                [serverName]: {
                    name: serverName,
                    url: 'https://www.overleaf.com',
                    login: {
                        userId: 'user-1',
                        username: 'demo@example.test',
                        identity: {},
                        projects: [{
                            id: 'legacy-project',
                            name: 'Legacy',
                            scm: {[scmKey]: legacyPersist},
                        }],
                    },
                },
            },
        ]]);
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
                update: async (key: string, value: unknown) => {
                    if (value===undefined) {
                        state.delete(key);
                    } else {
                        state.set(key, value);
                    }
                },
            },
        } as unknown as vscode.ExtensionContext;

        assert.deepStrictEqual(
            GlobalStateManager.getServerProjectSCMPersists(
                context,
                serverName,
                'user-1',
                'legacy-project',
            ),
            {[scmKey]: legacyPersist},
        );
        await Promise.resolve();
        GlobalStateManager.updateServerProjectSCMPersist(
            context,
            serverName,
            'user-1',
            'legacy-project',
            scmKey,
            undefined,
        );
        await Promise.resolve();

        assert.deepStrictEqual(
            GlobalStateManager.getServerProjectSCMPersists(
                context,
                serverName,
                'user-1',
                'legacy-project',
            ),
            {},
        );
    });

    test('isolates dedicated project SCM state across users sharing one project', async () => {
        const state = new Map<string, unknown>();
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
                update: async (key: string, value: unknown) => {
                    if (value===undefined) {
                        state.delete(key);
                    } else {
                        state.set(key, value);
                    }
                },
            },
        } as unknown as vscode.ExtensionContext;
        const serverName = 'www.overleaf.com';
        const projectId = 'shared-project';
        const firstKey = 'file:///workspace/first-account/';
        const secondKey = 'file:///workspace/second-account/';
        const persist = (baseUri: string) => ({
            enabled: true,
            label: 'Local Replica',
            baseUri,
            settings: {} as JSON,
        });

        GlobalStateManager.updateServerProjectSCMPersist(
            context,
            serverName,
            'user-1',
            projectId,
            firstKey,
            persist(firstKey),
        );
        GlobalStateManager.updateServerProjectSCMPersist(
            context,
            serverName,
            'user-2',
            projectId,
            secondKey,
            persist(secondKey),
        );
        await Promise.resolve();

        assert.deepStrictEqual(
            GlobalStateManager.getServerProjectSCMPersists(
                context,
                serverName,
                'user-1',
                projectId,
            ),
            {[firstKey]: persist(firstKey)},
        );
        assert.deepStrictEqual(
            GlobalStateManager.getServerProjectSCMPersists(
                context,
                serverName,
                'user-2',
                projectId,
            ),
            {[secondKey]: persist(secondKey)},
        );
    });

    test('does not migrate a legacy project mapping into another user account', () => {
        const serverName = 'www.overleaf.com';
        const projectId = 'shared-project';
        const scmKey = 'file:///workspace/first-account/';
        const legacyPersist = {
            enabled: true,
            label: 'Local Replica',
            baseUri: scmKey,
            settings: {} as JSON,
        };
        const state = new Map<string, unknown>([[
            STATE_SERVERS_KEY,
            {
                [serverName]: {
                    name: serverName,
                    url: 'https://www.overleaf.com',
                    login: {
                        userId: 'user-1',
                        username: 'first@example.test',
                        identity: {},
                        projects: [{
                            id: projectId,
                            name: 'Shared',
                            scm: {[scmKey]: legacyPersist},
                        }],
                    },
                },
            },
        ]]);
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
                update: async (key: string, value: unknown) => {
                    state.set(key, value);
                },
            },
        } as unknown as vscode.ExtensionContext;

        assert.deepStrictEqual(
            GlobalStateManager.getServerProjectSCMPersists(
                context,
                serverName,
                'user-2',
                projectId,
            ),
            {},
        );
    });

    test('keeps the main extension on the workspace host and the Remote Pack on the UI host', () => {
        const repositoryRoot = path.resolve(__dirname, '../../..');
        const mainManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
        const remotePackManifestPath = process.env.VSCODE_TEST_REMOTE_PACK_MANIFEST_PATH
            ? path.resolve(process.env.VSCODE_TEST_REMOTE_PACK_MANIFEST_PATH)
            : path.join(repositoryRoot, 'remote-pack', 'package.json');
        const remotePackManifest = JSON.parse(
            fs.readFileSync(remotePackManifestPath, 'utf8'),
        );

        assert.deepStrictEqual(mainManifest.extensionKind, ['workspace']);
        assert.deepStrictEqual(remotePackManifest.extensionKind, ['ui']);
        assert.notStrictEqual(
            `${mainManifest.publisher}.${mainManifest.name}`,
            `${remotePackManifest.publisher}.${remotePackManifest.name}`,
        );
    });

    test('separates VFS instances by server while sharing one instance across project paths', () => {
        const projectRoot = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project?user=user-1&project=project-1',
        );
        const nestedFile = projectRoot.with({path: '/Project/figures/plot.png'});
        const otherServer = projectRoot.with({authority: 'overleaf.example.edu'});

        assert.strictEqual(vfsProjectKey(projectRoot), vfsProjectKey(nestedFile));
        assert.notStrictEqual(vfsProjectKey(projectRoot), vfsProjectKey(otherServer));
    });

    test('provider disposal closes every VFS exactly once and rejects future access', async () => {
        const provider = new RemoteFileSystemProvider({} as vscode.ExtensionContext);
        let disposeCount = 0;
        const fakeVfs = {
            dispose: () => {
                disposeCount += 1;
            },
        };
        (provider as any).vfss = {project: fakeVfs};
        (provider as any)._activeVFS = fakeVfs;

        provider.dispose();
        provider.dispose();

        assert.strictEqual(disposeCount, 1);
        assert.strictEqual(provider.getActiveVFS(), undefined);
        await assert.rejects(() => provider.prefetch(vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project?user=user-1&project=project-1',
        )));
    });

    test('removes a logged-out Local Replica without constructing a VFS', async () => {
        const provider = Object.create(
            RemoteFileSystemProvider.prototype,
        ) as RemoteFileSystemProvider;
        const internals = provider as any;
        const projectUri = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project?user=user-1&project=project-1`,
        );
        const baseUri = vscode.Uri.file('/tmp/detached-local-replica');
        const targetKey = vfsProjectKey(projectUri);
        const state = new Map<string, unknown>();
        const context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
                update: async (key: string, value: unknown) => {
                    if (value===undefined) {
                        state.delete(key);
                    } else {
                        state.set(key, value);
                    }
                },
            },
        } as unknown as vscode.ExtensionContext;
        await GlobalStateManager.updateServerProjectSCMPersist(
            context,
            'www.overleaf.com',
            'user-1',
            'project-1',
            baseUri.toString(),
            {
                enabled: true,
                label: 'Local Replica',
                baseUri: baseUri.toString(),
                settings: {} as JSON,
            },
        );
        internals.context = context;
        internals.vfss = {};
        internals.getVFS = async () => {
            throw new Error('removal must not require an authenticated VFS');
        };

        await provider.removeLocalReplicaSCM(
            projectUri,
            baseUri.toString(),
            baseUri,
        );

        assert.strictEqual(internals.vfss[targetKey], undefined);
        assert.strictEqual(
            GlobalStateManager.getServerProjectSCMPersists(
                context,
                'www.overleaf.com',
                'user-1',
                'project-1',
            )[baseUri.toString()],
            undefined,
        );
    });

    test('collaboration lookups tolerate an unavailable project tree during reconnect', () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;

        assert.strictEqual(vfs._resolveById('missing'), undefined);
        assert.deepStrictEqual(vfs.walk(() => true), []);
    });

    test('shares one in-flight reconnect across concurrent writes', async () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const project = {name: 'reconnected'};
        let releaseReconnect!: (value: unknown) => void;
        const reconnecting = new Promise(resolve => {
            releaseReconnect = resolve;
        });

        internals.disposed = false;
        internals._connectionState = 'reconnecting';
        internals.initializing = reconnecting;
        internals.root = undefined;

        const manualReconnects = [
            vfs.reconnect('first concurrent push'),
            vfs.reconnect('second concurrent push'),
        ];
        const writeReconnects = [
            vfs.ensureConnectedForWrite(),
            vfs.ensureConnectedForWrite(),
        ];

        assert.strictEqual(internals.initializing, reconnecting);
        releaseReconnect(project);
        assert.deepStrictEqual(await Promise.all(manualReconnects), [project, project]);
        await Promise.all(writeReconnects);
        assert.strictEqual(internals.initializing, reconnecting);
    });

    test('promotes a prefetched VFS with a cached root into active managers', async () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        internals.disposed = false;
        internals.root = {name: 'cached project'};
        let managerActivationCount = 0;
        internals.ensureActiveManagers = () => {
            managerActivationCount += 1;
        };

        const root = await vfs.init();

        assert.strictEqual(root, internals.root);
        assert.strictEqual(managerActivationCount, 1);
    });

    test('rejects a cached VFS root after its authenticated session is removed', async () => {
        const state = new Map<string, unknown>();
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        state.set(
            STATE_SERVERS_KEY,
            internals.context.globalState.get(STATE_SERVERS_KEY, {}),
        );
        internals.context = {
            globalState: {
                get: <T>(key: string, defaultValue?: T) =>
                    state.has(key) ? state.get(key) as T : defaultValue as T,
            },
        } as unknown as vscode.ExtensionContext;
        internals.disposed = false;
        internals.origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project?user=user-1&project=project-1`,
        );
        internals.root = {name: 'cached project'};
        let managerActivationCount = 0;
        let disposeCount = 0;
        internals.ensureActiveManagers = () => {
            managerActivationCount += 1;
        };
        internals.dispose = () => {
            internals.disposed = true;
            disposeCount += 1;
        };

        state.set(STATE_SERVERS_KEY, {});
        await assert.rejects(
            () => vfs.init(),
            /No matching authenticated account/,
        );
        assert.strictEqual(managerActivationCount, 0);
        assert.strictEqual(disposeCount, 1);
    });

    test('emits a change event when an out-of-order OT update invalidates the document cache', () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const document = {
            _id: 'doc-1',
            name: 'main.tex',
            version: 4,
            localCache: 'baseline',
            remoteCache: 'baseline',
        };
        const notifications: vscode.FileChangeEvent[] = [];
        let onFileChanged: ((update: any) => void) | undefined;

        internals.disposed = false;
        internals.origin = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project?user=user-1&project=project-1',
        );
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals.socket = {
            updateEventHandlers: (handlers: {onFileChanged: (update: any) => void}) => {
                onFileChanged = handlers.onFileChanged;
                return new vscode.Disposable(() => undefined);
            },
        };
        internals.notify = (events: vscode.FileChangeEvent[]) => notifications.push(...events);
        internals._resolveById = () => ({
            fileEntity: document,
            path: '/main.tex',
        });

        internals.remoteWatch();
        assert.ok(onFileChanged);
        onFileChanged!({doc: 'doc-1', v: 7, op: [{p: 0, i: 'remote'}]});

        assert.strictEqual(document.localCache, undefined);
        assert.strictEqual(document.remoteCache, undefined);
        assert.strictEqual(notifications.length, 1);
        assert.strictEqual(notifications[0].type, vscode.FileChangeType.Changed);
        assert.strictEqual(notifications[0].uri.path, '/Project/main.tex');
    });

    test('emits the complete subtree at the exact path after remote rename and move', () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const notifications: vscode.FileChangeEvent[] = [];
        let handlers: {
            onFileRenamed: (entityId: string, newName: string) => void;
            onFileMoved: (entityId: string, folderId: string) => void;
        } | undefined;
        const figures = {
            _id: 'folder-figures',
            name: 'figures',
            docs: [{_id: 'doc-fig', name: 'fig'}],
            fileRefs: [{
                _id: 'file-plot',
                name: 'plot.png',
                linkedFileData: null,
                created: new Date(0).toISOString(),
            }],
            folders: [{
                _id: 'folder-nested',
                name: 'nested',
                docs: [{_id: 'doc-notes', name: 'notes.tex'}],
                fileRefs: [],
                folders: [],
            }],
        };
        const archive = {
            _id: 'folder-archive',
            name: 'archive',
            docs: [],
            fileRefs: [],
            folders: [],
        };
        internals.disposed = false;
        internals.origin = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project' +
            '?user=user-1&project=project-1',
        );
        internals.root = {
            rootFolder: [{
                _id: 'root',
                name: '',
                docs: [],
                fileRefs: [],
                folders: [figures, archive],
            }],
        };
        internals.socket = {
            updateEventHandlers: (nextHandlers: typeof handlers) => {
                handlers = nextHandlers;
                return new vscode.Disposable(() => undefined);
            },
        };
        internals.notify = (events: vscode.FileChangeEvent[]) => notifications.push(...events);

        internals.remoteWatch();
        assert.ok(handlers);

        handlers!.onFileRenamed('doc-fig', 'plot');
        assert.deepStrictEqual(
            notifications.map(event => event.uri.path),
            ['/Project/figures/fig', '/Project/figures/plot'],
        );
        assert.ok(!notifications.some(event => event.uri.path.includes('/plotures/')));

        notifications.length = 0;
        handlers!.onFileRenamed('folder-figures', 'images');
        assert.strictEqual(notifications[0].type, vscode.FileChangeType.Deleted);
        assert.strictEqual(notifications[0].uri.path.replace(/\/+$/, ''), '/Project/figures');
        assert.deepStrictEqual(
            notifications.slice(1).map(event => event.uri.path).sort(),
            [
                '/Project/images',
                '/Project/images/nested',
                '/Project/images/nested/notes.tex',
                '/Project/images/plot',
                '/Project/images/plot.png',
            ].sort(),
        );

        notifications.length = 0;
        handlers!.onFileMoved('folder-figures', 'folder-archive');
        assert.strictEqual(notifications[0].type, vscode.FileChangeType.Deleted);
        assert.strictEqual(notifications[0].uri.path.replace(/\/+$/, ''), '/Project/images');
        assert.deepStrictEqual(
            notifications.slice(1).map(event => event.uri.path).sort(),
            [
                '/Project/archive/images',
                '/Project/archive/images/nested',
                '/Project/archive/images/nested/notes.tex',
                '/Project/archive/images/plot',
                '/Project/archive/images/plot.png',
            ].sort(),
        );
    });

    test('removes a remotely deleted nested folder from the cached VFS tree', () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const notifications: vscode.FileChangeEvent[] = [];
        let handlers: {
            onFileRemoved: (entityId: string) => void;
        } | undefined;
        const nested = {
            _id: 'folder-nested',
            name: 'nested',
            docs: [{_id: 'doc-notes', name: 'notes.tex'}],
            fileRefs: [],
            folders: [],
        };
        const parent = {
            _id: 'folder-parent',
            name: 'parent',
            docs: [],
            fileRefs: [],
            folders: [nested],
        };
        const rootFolder = {
            _id: 'root',
            name: '',
            docs: [],
            fileRefs: [],
            folders: [parent],
        };

        internals.disposed = false;
        internals.origin = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project' +
            '?user=user-1&project=project-1',
        );
        internals.root = {rootFolder: [rootFolder]};
        internals.socket = {
            updateEventHandlers: (nextHandlers: typeof handlers) => {
                handlers = nextHandlers;
                return new vscode.Disposable(() => undefined);
            },
        };
        internals.notify = (events: vscode.FileChangeEvent[]) => notifications.push(...events);

        internals.remoteWatch();
        assert.ok(handlers);
        handlers!.onFileRemoved('folder-nested');

        assert.deepStrictEqual(parent.folders, []);
        assert.strictEqual(notifications.length, 1);
        assert.strictEqual(notifications[0].type, vscode.FileChangeType.Deleted);
        assert.strictEqual(
            notifications[0].uri.path.replace(/\/+$/, ''),
            '/Project/parent/nested',
        );
        assert.strictEqual(internals._resolveById('folder-nested'), undefined);
    });

    test('rebases Local Replica OT writes from the supplied remote baseline exactly once', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex' +
            '?user=user-1&project=project-1',
        );
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const applyOps = (
            content: string,
            ops: Array<{p: number; i?: string; d?: string}>,
        ) => {
            for (const op of ops) {
                if (op.i!==undefined) {
                    content = content.slice(0, op.p) + op.i + content.slice(op.p);
                } else if (op.d!==undefined) {
                    content = content.slice(0, op.p) + content.slice(op.p+op.d.length);
                }
            }
            return content;
        };
        const makeVfs = (
            document: {
                _id: string;
                name: string;
                version: number;
                lastVersion: number;
                localCache: string;
                remoteCache: string;
            },
        ) => {
            const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
            const internals = vfs as any;
            attachAuthenticatedSession(internals);
            const updates: any[] = [];
            const server = {
                content: document.remoteCache,
                version: document.version,
            };
            internals.disposed = false;
            internals.origin = vscode.Uri.parse(
                'semantic-researcher-overleaf://www.overleaf.com/Project' +
                '?user=user-1&project=project-1',
            );
            internals.projectName = 'Project';
            internals.documentWriteQueues = new Map();
            internals.documentCollaboratorRevisions = new Map();
            internals.pendingDocumentWrites = new Map();
            internals.documentInDoubtSenderVersions = new Map();
            internals.ensureConnectedForWrite = async () => undefined;
            internals._resolveUri = async () => ({
                fileType: 'doc',
                fileEntity: document,
            });
            internals._resolveById = () => ({
                fileEntity: document,
                path: '/main.tex',
            });
            internals.socket = {
                applyOtUpdate: async (_docId: string, update: any) => {
                    updates.push(update);
                    const appliedVersion = server.version;
                    server.content = applyOps(server.content, update.op);
                    server.version += 1;
                    internals.applyRemoteDocumentUpdate({
                        doc: document._id,
                        v: appliedVersion,
                    });
                },
                joinDoc: async () => ({
                    docLines: server.content.split('\n'),
                    version: server.version,
                }),
            };
            internals.notify = () => undefined;
            return {vfs, internals, server, updates};
        };

        const closedDocument = {
            _id: 'doc-closed',
            name: 'main.tex',
            version: 4,
            lastVersion: 3,
            localCache: 'base\n',
            remoteCache: 'base\nremote\n',
        };
        const closedVfs = makeVfs(closedDocument);
        const alreadyRebased = encoder.encode('base\nremote\nlocal\n');
        const written = await closedVfs.vfs.writeFileFromRemoteBaseline(
            uri,
            alreadyRebased,
            encoder.encode('base\nremote\n'),
        );

        assert.strictEqual(decoder.decode(written), 'base\nremote\nlocal\n');
        assert.strictEqual(closedDocument.remoteCache, 'base\nremote\nlocal\n');
        assert.strictEqual(closedVfs.updates.length, 1);
        assert.strictEqual(
            applyOps('base\nremote\n', closedVfs.updates[0].op),
            'base\nremote\nlocal\n',
        );

        const racedDocument = {
            _id: 'doc-raced',
            name: 'main.tex',
            version: 7,
            lastVersion: 6,
            localCache: 'title: base\nmiddle: base\nbody: base\n',
            remoteCache: 'title: remote\nmiddle: base\nbody: base\n',
        };
        const racedVfs = makeVfs(racedDocument);
        const racedWritten = await racedVfs.vfs.writeFileFromRemoteBaseline(
            uri,
            encoder.encode('title: base\nmiddle: base\nbody: local\n'),
            encoder.encode('title: base\nmiddle: base\nbody: base\n'),
        );

        assert.strictEqual(
            decoder.decode(racedWritten),
            'title: remote\nmiddle: base\nbody: local\n',
        );
        assert.strictEqual(
            racedDocument.remoteCache,
            'title: remote\nmiddle: base\nbody: local\n',
        );
        assert.strictEqual(racedVfs.updates.length, 1);

        const retryDocument = {
            _id: 'doc-retry',
            name: 'main.tex',
            version: 9,
            lastVersion: 8,
            localCache: 'base\n',
            remoteCache: 'base\nlocal\n',
        };
        const retryVfs = makeVfs(retryDocument);
        const retryWritten = await retryVfs.vfs.writeFileFromRemoteBaseline(
            uri,
            encoder.encode('base\nlocal\n'),
            encoder.encode('base\n'),
        );

        assert.strictEqual(decoder.decode(retryWritten), 'base\nlocal\n');
        assert.strictEqual(retryVfs.updates.length, 0);

        const conflictDocument = {
            _id: 'doc-conflict',
            name: 'main.tex',
            version: 11,
            lastVersion: 10,
            localCache: 'title: base\n',
            remoteCache: 'title: remote\n',
        };
        const conflictVfs = makeVfs(conflictDocument);
        await assert.rejects(
            () => conflictVfs.vfs.writeFileFromRemoteBaseline(
                uri,
                encoder.encode('title: local\n'),
                encoder.encode('title: base\n'),
            ),
            RemoteDocumentMergeConflictError,
        );
        assert.strictEqual(conflictDocument.remoteCache, 'title: remote\n');
        assert.strictEqual(conflictVfs.updates.length, 0);
    });

    test('refreshes authoritative text when a collaborator OT races a Local Replica write', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex' +
            '?user=user-1&project=project-1',
        );
        const encoder = new TextEncoder();
        const document = {
            _id: 'doc-race',
            name: 'main.tex',
            version: 20,
            lastVersion: 19,
            localCache: 'title: base\nbody: base\n',
            remoteCache: 'title: base\nbody: base\n',
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const updates: any[] = [];
        const server = {
            content: document.remoteCache,
            version: document.version,
        };
        internals.disposed = false;
        internals.origin = uri.with({path: '/Project'});
        internals.projectName = 'Project';
        internals.documentWriteQueues = new Map();
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals.ensureConnectedForWrite = async () => undefined;
        internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
        internals._resolveById = () => ({fileEntity: document, path: '/main.tex'});
        internals.notify = () => undefined;
        internals.socket = {
            applyOtUpdate: async (_docId: string, update: any) => {
                updates.push(update);
                const collaboratorVersion = server.version;
                server.content = 'title: remote\nbody: base\n';
                server.version += 1;
                internals.applyRemoteDocumentUpdate({
                    doc: document._id,
                    v: collaboratorVersion,
                    op: [
                        {p: 7, d: 'base'},
                        {p: 7, i: 'remote'},
                    ],
                });

                const localVersion = server.version;
                server.content = 'title: remote\nbody: local\n';
                server.version += 1;
                internals.applyRemoteDocumentUpdate({
                    doc: document._id,
                    v: localVersion,
                });
            },
            joinDoc: async () => ({
                docLines: server.content.split('\n'),
                version: server.version,
            }),
        };

        const written = await vfs.writeFileFromRemoteBaseline(
            uri,
            encoder.encode('title: base\nbody: local\n'),
            encoder.encode('title: base\nbody: base\n'),
        );

        assert.strictEqual(new TextDecoder().decode(written), server.content);
        assert.strictEqual(document.localCache, server.content);
        assert.strictEqual(document.remoteCache, server.content);
        assert.strictEqual(document.version, 22);
        assert.strictEqual(updates.length, 1);
    });

    test('retries the first document read when an immediate collaborator OT overtakes it', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/new.tex' +
            '?user=user-1&project=project-1',
        );
        const document = {
            _id: 'doc-new',
            name: 'new.tex',
            version: undefined,
            localCache: undefined,
            remoteCache: undefined,
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        internals.disposed = false;
        internals.origin = uri.with({path: '/Project'});
        internals.projectName = 'Project';
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
        internals._resolveById = () => ({fileEntity: document, path: '/new.tex'});
        internals.notify = () => undefined;

        let releaseFirstJoin!: () => void;
        const firstJoinBlocked = new Promise<void>(resolve => {
            releaseFirstJoin = resolve;
        });
        let signalFirstJoin!: () => void;
        const firstJoinStarted = new Promise<void>(resolve => {
            signalFirstJoin = resolve;
        });
        let joinCount = 0;
        const server = {content: '', version: 0};
        internals.socket = {
            joinDoc: async () => {
                joinCount += 1;
                if (joinCount===1) {
                    signalFirstJoin();
                    await firstJoinBlocked;
                    return {docLines: [''], version: 0};
                }
                return {
                    docLines: server.content.split('\n'),
                    version: server.version,
                };
            },
        };

        const read = vfs.openFile(uri);
        await firstJoinStarted;
        server.content = 'filled immediately after creation';
        server.version = 1;
        internals.applyRemoteDocumentUpdate({
            doc: document._id,
            v: 0,
            op: [{p: 0, i: server.content}],
        });
        releaseFirstJoin();

        assert.strictEqual(
            new TextDecoder().decode(await read),
            server.content,
        );
        assert.strictEqual(joinCount, 2);
        assert.strictEqual(document.remoteCache, server.content);
        assert.strictEqual(document.version, server.version);
    });

    test('fails closed when collaborator OT overtakes every document read retry', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/busy.tex' +
            '?user=user-1&project=project-1',
        );
        const document = {
            _id: 'doc-busy',
            name: 'busy.tex',
            version: undefined,
            localCache: undefined,
            remoteCache: undefined,
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        internals.disposed = false;
        internals.origin = uri.with({path: '/Project'});
        internals.documentCollaboratorRevisions = new Map();
        internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
        let joinCount = 0;
        internals.socket = {
            joinDoc: async () => {
                joinCount += 1;
                internals.documentCollaboratorRevisions.set(document._id, joinCount);
                return {
                    docLines: [`revision ${joinCount}`],
                    version: joinCount,
                };
            },
        };

        await assert.rejects(
            () => vfs.openFile(uri),
            RemoteDocumentWriteAmbiguousError,
        );
        assert.strictEqual(joinCount, 3);
        assert.strictEqual(document.remoteCache, undefined);
        assert.strictEqual(document.localCache, undefined);
    });

    test('reconciles an applied OT after its acknowledgement is lost', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex' +
            '?user=user-1&project=project-1',
        );
        const encoder = new TextEncoder();
        for (const senderEventObserved of [true, false]) {
            const document = {
                _id: `doc-timeout-${senderEventObserved}`,
                name: 'main.tex',
                version: 30,
                lastVersion: 29,
                localCache: 'base\n',
                remoteCache: 'base\n',
            };
            const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
            const internals = vfs as any;
            attachAuthenticatedSession(internals);
            const server = {content: 'base\n', version: 30};
            let updateCount = 0;
            internals.disposed = false;
            internals.origin = uri.with({path: '/Project'});
            internals.projectName = 'Project';
            internals.documentWriteQueues = new Map();
            internals.documentCollaboratorRevisions = new Map();
            internals.pendingDocumentWrites = new Map();
            internals.documentInDoubtSenderVersions = new Map();
            internals.ensureConnectedForWrite = async () => undefined;
            internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
            internals._resolveById = () => ({fileEntity: document, path: '/main.tex'});
            internals.notify = () => undefined;
            internals.socket = {
                applyOtUpdate: async () => {
                    updateCount += 1;
                    const appliedVersion = server.version;
                    server.content = 'base\nlocal\n';
                    server.version += 1;
                    if (senderEventObserved) {
                        internals.applyRemoteDocumentUpdate({
                            doc: document._id,
                            v: appliedVersion,
                        });
                    }
                    throw new Error('timeout');
                },
                joinDoc: async () => ({
                    docLines: server.content.split('\n'),
                    version: server.version,
                }),
            };

            const written = await vfs.writeFileFromRemoteBaseline(
                uri,
                encoder.encode('base\nlocal\n'),
                encoder.encode('base\n'),
            );

            assert.strictEqual(new TextDecoder().decode(written), server.content);
            assert.strictEqual(document.remoteCache, server.content);
            assert.strictEqual(updateCount, 1);
        }
    });

    test('blocks an ambiguous OT timeout without retrying or overwriting collaborator text', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex' +
            '?user=user-1&project=project-1',
        );
        const document = {
            _id: 'doc-ambiguous',
            name: 'main.tex',
            version: 40,
            lastVersion: 39,
            localCache: 'title: base\n',
            remoteCache: 'title: base\n',
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const server = {content: 'title: remote\n', version: 41};
        let updateCount = 0;
        internals.disposed = false;
        internals.origin = uri.with({path: '/Project'});
        internals.projectName = 'Project';
        internals.documentWriteQueues = new Map();
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals.ensureConnectedForWrite = async () => undefined;
        internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
        internals._resolveById = () => ({fileEntity: document, path: '/main.tex'});
        internals.notify = () => undefined;
        internals.socket = {
            applyOtUpdate: async () => {
                updateCount += 1;
                throw new Error('timeout');
            },
            joinDoc: async () => ({
                docLines: server.content.split('\n'),
                version: server.version,
            }),
        };

        await assert.rejects(
            () => vfs.writeFileFromRemoteBaseline(
                uri,
                new TextEncoder().encode('title: local\n'),
                new TextEncoder().encode('title: base\n'),
            ),
            RemoteDocumentWriteAmbiguousError,
        );
        assert.strictEqual(document.remoteCache, server.content);
        assert.strictEqual(updateCount, 1);
    });

    test('does not retry when authoritative reconciliation fails after an uncertain OT', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex' +
            '?user=user-1&project=project-1',
        );
        const document = {
            _id: 'doc-readback-failure',
            name: 'main.tex',
            version: 45,
            lastVersion: 44,
            localCache: 'title: base\n',
            remoteCache: 'title: base\n',
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        let updateCount = 0;
        internals.disposed = false;
        internals.origin = uri.with({path: '/Project'});
        internals.projectName = 'Project';
        internals.documentWriteQueues = new Map();
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals.ensureConnectedForWrite = async () => undefined;
        internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
        internals._resolveById = () => ({fileEntity: document, path: '/main.tex'});
        internals.notify = () => undefined;
        internals.socket = {
            applyOtUpdate: async () => {
                updateCount += 1;
                throw new Error('timeout');
            },
            joinDoc: async () => {
                throw new Error('readback unavailable');
            },
        };

        await assert.rejects(
            () => vfs.writeFileFromRemoteBaseline(
                uri,
                new TextEncoder().encode('title: local\n'),
                new TextEncoder().encode('title: base\n'),
            ),
            RemoteDocumentWriteAmbiguousError,
        );

        assert.strictEqual(updateCount, 1);
        assert.strictEqual(document.remoteCache, undefined);
        assert.strictEqual(document.localCache, undefined);
        assert.deepStrictEqual(
            internals.documentInDoubtSenderVersions.get(document._id),
            [45],
        );
    });

    test('does not let a delayed sender event approve a later rejected write', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex' +
            '?user=user-1&project=project-1',
        );
        const document = {
            _id: 'doc-delayed-sender',
            name: 'main.tex',
            version: 46,
            lastVersion: 45,
            localCache: 'title: base\n',
            remoteCache: 'title: base\n',
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const server = {content: 'title: base\n', version: 46};
        let updateCount = 0;
        let joinCount = 0;
        internals.disposed = false;
        internals.origin = uri.with({path: '/Project'});
        internals.projectName = 'Project';
        internals.documentWriteQueues = new Map();
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals.ensureConnectedForWrite = async () => undefined;
        internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
        internals._resolveById = () => ({fileEntity: document, path: '/main.tex'});
        internals.notify = () => undefined;
        internals.socket = {
            applyOtUpdate: async () => {
                updateCount += 1;
                if (updateCount===1) {
                    throw new Error('timeout');
                }
                const delayedVersion = server.version;
                server.content = 'title: first\n';
                server.version += 1;
                internals.applyRemoteDocumentUpdate({
                    doc: document._id,
                    v: delayedVersion,
                });
                throw new Error('rejected');
            },
            joinDoc: async () => {
                joinCount += 1;
                if (joinCount===1) {
                    throw new Error('readback unavailable');
                }
                return {
                    docLines: server.content.split('\n'),
                    version: server.version,
                };
            },
        };

        await assert.rejects(
            () => vfs.writeFileFromRemoteBaseline(
                uri,
                new TextEncoder().encode('title: first\n'),
                new TextEncoder().encode('title: base\n'),
            ),
            RemoteDocumentWriteAmbiguousError,
        );
        await assert.rejects(
            () => vfs.writeFileFromRemoteBaseline(
                uri,
                new TextEncoder().encode('title: resolved\n'),
                new TextEncoder().encode('title: base\n'),
            ),
            RemoteDocumentWriteAmbiguousError,
        );

        assert.strictEqual(updateCount, 2);
        assert.strictEqual(document.remoteCache, server.content);
        assert.strictEqual(document.localCache, server.content);
        assert.strictEqual(server.content, 'title: first\n');
        assert.strictEqual(
            internals.documentInDoubtSenderVersions.has(document._id),
            false,
        );
    });

    test('does not wait for a sender event on the alternative connection scheme', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex' +
            '?user=user-1&project=project-1',
        );
        const document = {
            _id: 'doc-alt',
            name: 'main.tex',
            version: 50,
            lastVersion: 49,
            localCache: 'base\n',
            remoteCache: 'base\n',
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        internals.disposed = false;
        internals.origin = uri.with({path: '/Project'});
        internals.projectName = 'Project';
        internals.documentWriteQueues = new Map();
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals.ensureConnectedForWrite = async () => undefined;
        internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
        internals.notify = () => undefined;
        internals.socket = {
            isUsingAlternativeConnectionScheme: true,
            applyOtUpdate: async () => undefined,
            joinDoc: async () => assert.fail('Alternative writes must not wait for authoritative join'),
        };

        const written = await vfs.writeFileFromRemoteBaseline(
            uri,
            new TextEncoder().encode('base\nlocal\n'),
            new TextEncoder().encode('base\n'),
        );

        assert.strictEqual(new TextDecoder().decode(written), 'base\nlocal\n');
        assert.strictEqual(document.remoteCache, 'base\nlocal\n');
    });

    test('serializes two writes to the same Overleaf document through applied events', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex' +
            '?user=user-1&project=project-1',
        );
        const encoder = new TextEncoder();
        const document = {
            _id: 'doc-serialized',
            name: 'main.tex',
            version: 60,
            lastVersion: 59,
            localCache: 'base\n',
            remoteCache: 'base\n',
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const server = {content: 'base\n', version: 60};
        let updateCount = 0;
        internals.disposed = false;
        internals.origin = uri.with({path: '/Project'});
        internals.projectName = 'Project';
        internals.documentWriteQueues = new Map();
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals.ensureConnectedForWrite = async () => undefined;
        internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
        internals._resolveById = () => ({fileEntity: document, path: '/main.tex'});
        internals.notify = () => undefined;
        internals.socket = {
            applyOtUpdate: async () => {
                updateCount += 1;
                if (updateCount===2) {
                    const appliedVersion = server.version;
                    server.content = 'base\nfirst\nsecond\n';
                    server.version += 1;
                    internals.applyRemoteDocumentUpdate({
                        doc: document._id,
                        v: appliedVersion,
                    });
                }
            },
            joinDoc: async () => ({
                docLines: server.content.split('\n'),
                version: server.version,
            }),
        };

        const first = vfs.writeFileFromRemoteBaseline(
            uri,
            encoder.encode('base\nfirst\n'),
            encoder.encode('base\n'),
        );
        while (updateCount<1) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        const second = vfs.writeFileFromRemoteBaseline(
            uri,
            encoder.encode('base\nfirst\nsecond\n'),
            encoder.encode('base\nfirst\n'),
        );
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.strictEqual(updateCount, 1);

        const firstVersion = server.version;
        server.content = 'base\nfirst\n';
        server.version += 1;
        internals.applyRemoteDocumentUpdate({
            doc: document._id,
            v: firstVersion,
        });

        const [firstWritten, secondWritten] = await Promise.all([first, second]);
        assert.strictEqual(new TextDecoder().decode(firstWritten), 'base\nfirst\n');
        assert.strictEqual(new TextDecoder().decode(secondWritten), server.content);
        assert.strictEqual(document.remoteCache, server.content);
        assert.strictEqual(updateCount, 2);
    });

    test('throws when Overleaf rejects document creation or file upload', async () => {
        const originalAuthenticate = (GlobalStateManager as any).authenticate;
        const originalShowErrorMessage = vscode.window.showErrorMessage;
        const errors: string[] = [];
        (GlobalStateManager as any).authenticate = async () => ({});
        (vscode.window as any).showErrorMessage = async (message: string) => {
            errors.push(message);
            return undefined;
        };

        try {
            for (const scenario of [
                {
                    name: 'new.tex',
                    content: new Uint8Array(),
                    api: {
                        addDoc: async () => ({type: 'error', message: 'document create failed'}),
                    },
                    expected: /document create failed/,
                },
                {
                    name: 'plot.png',
                    content: Buffer.from([1, 2, 3]),
                    api: {
                        uploadFile: async () => ({type: 'error', message: 'media upload failed'}),
                    },
                    expected: /media upload failed/,
                },
            ]) {
                const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
                const internals = vfs as any;
                attachAuthenticatedSession(internals);
                internals.disposed = false;
                internals.projectId = 'project-1';
                internals.api = scenario.api;
                internals._resolveUri = async () => ({
                    parentFolder: {_id: 'root-folder'},
                    fileName: scenario.name,
                    fileEntity: undefined,
                });
                internals.insertEntity = () => {
                    assert.fail('A failed create must not insert a remote entity.');
                };
                internals.notify = () => {
                    assert.fail('A failed create must not emit a success notification.');
                };

                await assert.rejects(
                    () => internals.createFile(vscode.Uri.file(`/tmp/${scenario.name}`), scenario.content, true),
                    scenario.expected,
                );
            }
            assert.deepStrictEqual(errors, ['document create failed', 'media upload failed']);
        } finally {
            (GlobalStateManager as any).authenticate = originalAuthenticate;
            (vscode.window as any).showErrorMessage = originalShowErrorMessage;
        }
    });

    test('never verifies an empty create from a failed remote readback', async () => {
        const originalAuthenticate = (GlobalStateManager as any).authenticate;
        (GlobalStateManager as any).authenticate = async () => ({});

        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        internals.disposed = false;
        internals.projectId = 'project-1';
        internals.ensureConnectedForWrite = async () => undefined;
        internals._resolveUri = async () => ({
            fileType: 'file',
            fileEntity: {
                _id: 'remote-file',
                name: 'empty.png',
            },
        });
        internals.api = {
            getFile: async () => {
                throw new Error('remote download failed');
            },
        };

        try {
            await assert.rejects(
                () => vfs.writeFileFromRemoteBaseline(
                    vscode.Uri.file('/tmp/empty.png'),
                    new Uint8Array(),
                    undefined,
                    true,
                ),
                /remote download failed/,
            );
        } finally {
            (GlobalStateManager as any).authenticate = originalAuthenticate;
        }
    });

    test('rejects non-success API downloads instead of returning empty bytes', async function () {
        this.timeout(10000);
        const server = http.createServer((_request, response) => {
            response.statusCode = 503;
            response.setHeader('Connection', 'close');
            response.end('temporarily unavailable');
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        assert.ok(address && typeof address!=='string');
        const api = new BaseAPI(`http://127.0.0.1:${address.port}/`);

        try {
            await assert.rejects(
                () => api.getFile(
                    {csrfToken: 'test', cookies: 'test'},
                    'project-1',
                    'file-1',
                ),
                /Overleaf download failed \(503\)/,
            );
        } finally {
            (
                server as http.Server & {closeAllConnections?: () => void}
            ).closeAllConnections?.();
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        }
    });

    test('preserves mutation HTTP status for retry classification', async function () {
        this.timeout(10000);
        const server = http.createServer((_request, response) => {
            response.statusCode = 409;
            response.setHeader('Connection', 'close');
            response.end('duplicate path');
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        assert.ok(address && typeof address!=='string');
        const api = new BaseAPI(`http://127.0.0.1:${address.port}/`);

        try {
            const response = await api.addDoc(
                {csrfToken: 'test', cookies: 'test'},
                'project-1',
                'folder-1',
                'duplicate.tex',
            );
            assert.strictEqual(response.type, 'error');
            assert.strictEqual(response.status, 409);
            assert.match(response.message ?? '', /duplicate path/);
        } finally {
            (
                server as http.Server & {closeAllConnections?: () => void}
            ).closeAllConnections?.();
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        }
    });

    test('rechecks a duplicate create response and preserves collaborator bytes', async () => {
        const originalAuthenticate = (GlobalStateManager as any).authenticate;
        (GlobalStateManager as any).authenticate = async () => ({});

        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        const uri = vscode.Uri.file('/tmp/create-race.png');
        const collaboratorBytes = Buffer.from([9, 9, 9]);
        let reconnected = false;
        let reconnects = 0;
        attachAuthenticatedSession(internals);
        internals.disposed = false;
        internals.projectId = 'project-1';
        internals.ensureConnectedForWrite = async () => undefined;
        internals._resolveUri = async () => reconnected
            ? {
                parentFolder: {_id: 'root-folder'},
                fileName: 'create-race.png',
                fileType: 'file',
                fileEntity: {
                    _id: 'collaborator-file',
                    name: 'create-race.png',
                },
            }
            : {
                parentFolder: {_id: 'root-folder'},
                fileName: 'create-race.png',
                fileType: undefined,
                fileEntity: undefined,
            };
        internals.api = {
            uploadFile: async () => ({
                type: 'error',
                status: 409,
                message: 'duplicate path',
            }),
            getFile: async () => ({
                type: 'success',
                content: collaboratorBytes,
            }),
        };
        internals.reconnect = async () => {
            reconnects += 1;
            reconnected = true;
        };
        internals.insertEntity = () => assert.fail('A rejected create must not mutate the VFS tree.');
        internals.notify = () => assert.fail('A rejected create must not emit success events.');

        try {
            await assert.rejects(
                () => vfs.writeFileFromRemoteBaseline(
                    uri,
                    Buffer.from([1, 2, 3]),
                    undefined,
                    true,
                ),
                RemoteDocumentMergeConflictError,
            );
            assert.strictEqual(reconnects, 1);
        } finally {
            (GlobalStateManager as any).authenticate = originalAuthenticate;
        }
    });

    test('does not reconnect after an explicit create rejection', async () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        let createAttempts = 0;
        let reconnects = 0;
        internals.ensureConnectedForWrite = async () => undefined;
        internals._resolveUri = async () => ({
            fileType: undefined,
            fileEntity: undefined,
        });
        internals.createFile = async () => {
            createAttempts += 1;
            throw new RemoteMutationRejectedError('explicit create rejection');
        };
        internals.reconnect = async () => {
            reconnects += 1;
        };

        await assert.rejects(
            () => vfs.writeFileFromRemoteBaseline(
                vscode.Uri.file('/tmp/rejected.tex'),
                new Uint8Array(),
                undefined,
                true,
            ),
            RemoteMutationRejectedError,
        );
        assert.strictEqual(createAttempts, 1);
        assert.strictEqual(reconnects, 0);
    });

    test('throws when Overleaf rejects a rename used by guarded remote deletion', async () => {
        const originalAuthenticate = (GlobalStateManager as any).authenticate;
        const originalShowErrorMessage = vscode.window.showErrorMessage;
        const errors: string[] = [];
        (GlobalStateManager as any).authenticate = async () => ({});
        (vscode.window as any).showErrorMessage = async (message: string) => {
            errors.push(message);
            return undefined;
        };

        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        const parentFolder = {_id: 'root-folder'};
        const oldUri = vscode.Uri.file('/tmp/old.tex');
        const newUri = vscode.Uri.file('/tmp/.sr-overleaf-delete-stage');
        attachAuthenticatedSession(internals);
        internals.disposed = false;
        internals.projectId = 'project-1';
        internals.api = {
            renameEntity: async () => ({type: 'error', message: 'rename rejected'}),
        };
        internals._resolveUri = async (uri: vscode.Uri) => uri.toString()===oldUri.toString()
            ? {
                parentFolder,
                fileName: 'old.tex',
                fileType: 'doc',
                fileEntity: {_id: 'doc-1', name: 'old.tex'},
            }
            : {
                parentFolder,
                fileName: '.sr-overleaf-delete-stage',
                fileType: undefined,
                fileEntity: undefined,
            };
        internals.removeEntity = () => assert.fail('A failed rename must not mutate the VFS tree.');
        internals.insertEntity = () => assert.fail('A failed rename must not mutate the VFS tree.');
        internals.notify = () => assert.fail('A failed rename must not emit success events.');

        try {
            await assert.rejects(
                () => internals.rename(oldUri, newUri, false),
                /rename rejected/,
            );
            assert.deepStrictEqual(errors, ['rename rejected']);
        } finally {
            (GlobalStateManager as any).authenticate = originalAuthenticate;
            (vscode.window as any).showErrorMessage = originalShowErrorMessage;
        }
    });

    test('passes the v2 project handshake through the Socket.IO query option', () => {
        const socketClient = require('socket.io-client') as {
            connect: (url: string, options: Record<string, unknown>) => unknown;
        };
        const originalConnect = socketClient.connect;
        let capturedUrl: string | undefined;
        let capturedOptions: Record<string, unknown> | undefined;
        socketClient.connect = (url, options) => {
            capturedUrl = url;
            capturedOptions = options;
            return {};
        };
        try {
            const api = new BaseAPI('https://www.overleaf.com/');
            api._initSocketV0(
                {csrfToken: 'token', cookies: 'session=cookie'},
                '?projectId=project-1&t=1234',
            );

            assert.strictEqual(capturedUrl, 'https://www.overleaf.com');
            assert.strictEqual(capturedOptions?.query, 'projectId=project-1&t=1234');
            const headers = capturedOptions?.extraHeaders as Record<string, string>;
            assert.strictEqual(headers['Origin'], 'https://www.overleaf.com');
            assert.strictEqual(headers['Cookie'], 'session=cookie');
        } finally {
            socketClient.connect = originalConnect;
        }
    });

    test('normalizes current and positional v2 joinProjectResponse payloads', () => {
        const socket = Object.create(SocketIOAPI.prototype) as SocketIOAPI;
        const project = {
            _id: 'project-1',
            rootFolder: [],
        };
        const parse = (socket as any).parseJoinProjectResponse.bind(socket);

        assert.deepStrictEqual(
            parse([{publicId: 'public-1', project}]),
            {publicId: 'public-1', project},
        );
        assert.deepStrictEqual(
            parse(['public-2', project]),
            {publicId: 'public-2', project},
        );
        assert.deepStrictEqual(
            parse([[project, 'public-3']]),
            {publicId: 'public-3', project},
        );
        assert.strictEqual(parse([{unexpected: true}]), undefined);
    });

    test('agent review disposal clears its recurring import timer', () => {
        const manager = Object.create(AgentReviewManager.prototype) as AgentReviewManager;
        const internals = manager as any;
        internals.disposed = false;
        internals.internalRestoreUntil = new Map([['file:///draft.tex', Date.now()]]);
        internals.importTimer = setInterval(() => undefined, 1000);

        manager.dispose();
        manager.dispose();

        assert.strictEqual(internals.disposed, true);
        assert.strictEqual(internals.importTimer, undefined);
        assert.strictEqual(internals.internalRestoreUntil.size, 0);
    });

    test('serializes agent review activation across Local Replica project switches', async () => {
        const manager = Object.create(AgentReviewManager.prototype) as AgentReviewManager;
        const internals = manager as any;
        const rootA = vscode.Uri.file('/tmp/agent-review-a');
        const rootB = vscode.Uri.file('/tmp/agent-review-b');
        let releaseA!: () => void;
        const pauseA = new Promise<void>(resolve => {
            releaseA = resolve;
        });
        let signalAStarted!: () => void;
        const aStarted = new Promise<void>(resolve => {
            signalAStarted = resolve;
        });
        const loadedRoots: string[] = [];
        const activeEditorRoots: string[] = [];

        internals.disposed = false;
        internals.activationGeneration = 0;
        internals.activationQueue = Promise.resolve();
        internals.importQueue = Promise.resolve();
        internals.config = {enabled: false};
        internals.internalRestoreUntil = new Map();
        internals.resolveConfig = async (root: vscode.Uri) => {
            if (root.toString()===rootA.toString()) {
                signalAStarted();
                await pauseA;
            }
            return {enabled: true};
        };
        internals.proposalStore = {
            ensureStorage: async (root: vscode.Uri) => loadedRoots.push(`storage:${root.toString()}`),
            migrateLegacy: async (root: vscode.Uri) => loadedRoots.push(`migrate:${root.toString()}`),
            load: async (root: vscode.Uri) => loadedRoots.push(`load:${root.toString()}`),
        };
        internals.workspaceInstructionManager = {
            ensure: async (root: vscode.Uri) => loadedRoots.push(`instructions:${root.toString()}`),
            cleanupOldDrafts: async () => undefined,
        };
        internals.editorProvider = {
            setActiveRoot: (root: vscode.Uri | undefined) => {
                activeEditorRoots.push(root?.toString() ?? 'undefined');
            },
        };
        internals.importAgentReviewDrafts = async () => undefined;
        internals.startImportTimer = () => undefined;

        const activateA = manager.activate(rootA);
        await aStarted;
        const activateB = manager.activate(rootB);
        releaseA();
        await Promise.all([activateA, activateB]);

        assert.strictEqual(internals.activeRoot.toString(), rootB.toString());
        assert.deepStrictEqual(
            loadedRoots,
            [
                `storage:${rootB.toString()}`,
                `migrate:${rootB.toString()}`,
                `load:${rootB.toString()}`,
                `instructions:${rootB.toString()}`,
            ],
        );
        assert.deepStrictEqual(activeEditorRoots, [rootB.toString()]);
    });

    test('finishes an in-flight Agent Review interception before loading another project store', async () => {
        const manager = Object.create(AgentReviewManager.prototype) as AgentReviewManager;
        const internals = manager as any;
        const rootAPath = await fs.promises.mkdtemp('/tmp/agent-review-push-a-');
        const rootBPath = await fs.promises.mkdtemp('/tmp/agent-review-push-b-');
        const baselineRoot = await fs.promises.mkdtemp('/tmp/agent-review-baseline-');
        const rootA = vscode.Uri.file(rootAPath);
        const rootB = vscode.Uri.file(rootBPath);
        const localUri = vscode.Uri.file(path.join(rootAPath, 'main.tex'));
        await fs.promises.writeFile(path.join(baselineRoot, 'main.tex'), 'baseline');
        let releaseProposal!: () => void;
        const proposalPaused = new Promise<void>(resolve => {
            releaseProposal = resolve;
        });
        let signalProposalStarted!: () => void;
        const proposalStarted = new Promise<void>(resolve => {
            signalProposalStarted = resolve;
        });
        const events: string[] = [];

        internals.disposed = false;
        internals.activationGeneration = 1;
        internals.activationQueue = Promise.resolve();
        internals.importQueue = Promise.resolve();
        internals.activeRoot = rootA;
        internals.config = {enabled: true};
        internals.internalRestoreUntil = new Map();
        internals.resolveConfig = async () => ({enabled: true});
        internals.saveClassifier = {
            getRecentSaveIntent: () => undefined,
        };
        internals.workspaceInstructionManager = {
            latestOpenDraft: async () => ({
                baselineRoot,
            }),
            ensure: async () => undefined,
            cleanupOldDrafts: async () => undefined,
        };
        internals.proposalStore = {
            createDirectWriteProposal: async (root: vscode.Uri) => {
                events.push(`proposal-start:${root.toString()}`);
                signalProposalStarted();
                await proposalPaused;
                events.push(`proposal-end:${root.toString()}`);
            },
            ensureStorage: async () => undefined,
            migrateLegacy: async () => undefined,
            load: async (root: vscode.Uri) => {
                events.push(`load:${root.toString()}`);
            },
        };
        internals.restoreSourceFile = async () => {
            events.push(`restore:${rootA.toString()}`);
        };
        internals.editorProvider = {
            setActiveRoot: () => undefined,
        };
        internals.importAgentReviewDrafts = async () => undefined;
        internals.startImportTimer = () => undefined;

        try {
            const interception = manager.beforeLocalReplicaPush({
                rootUri: rootA,
                localUri,
                relPath: '/main.tex',
                type: 'update',
                content: Buffer.from('agent edit'),
            });
            await proposalStarted;
            const activateB = manager.activate(rootB);
            releaseProposal();

            const decision = await interception;
            await activateB;

            assert.strictEqual(decision.kind, 'block');
            assert.strictEqual(internals.activeRoot.toString(), rootB.toString());
            assert.deepStrictEqual(events, [
                `proposal-start:${rootA.toString()}`,
                `proposal-end:${rootA.toString()}`,
                `restore:${rootA.toString()}`,
                `load:${rootB.toString()}`,
            ]);
        } finally {
            await Promise.all([
                fs.promises.rm(rootAPath, {recursive: true, force: true}),
                fs.promises.rm(rootBPath, {recursive: true, force: true}),
                fs.promises.rm(baselineRoot, {recursive: true, force: true}),
            ]);
        }
    });

    test('drains an old Agent Review import before activating a new replica root', async () => {
        const manager = Object.create(AgentReviewManager.prototype) as AgentReviewManager;
        const internals = manager as any;
        const rootA = vscode.Uri.file('/tmp/agent-review-import-a');
        const rootB = vscode.Uri.file('/tmp/agent-review-import-b');
        let releaseA!: () => void;
        const pauseA = new Promise<void>(resolve => {
            releaseA = resolve;
        });
        let signalAStarted!: () => void;
        const aStarted = new Promise<void>(resolve => {
            signalAStarted = resolve;
        });
        const importedRoots: string[] = [];
        const submittedRoots: string[] = [];

        internals.disposed = false;
        internals.activationGeneration = 1;
        internals.activationQueue = Promise.resolve();
        internals.importQueue = Promise.resolve();
        internals.activeRoot = rootA;
        internals.config = {enabled: true};
        internals.internalRestoreUntil = new Map();
        internals.resolveConfig = async () => ({enabled: true});
        internals.proposalStore = {
            ensureStorage: async () => undefined,
            migrateLegacy: async () => undefined,
            load: async () => undefined,
            importSubmittedDrafts: async (root: vscode.Uri) => {
                importedRoots.push(root.toString());
                return [];
            },
        };
        internals.workspaceInstructionManager = {
            ensure: async () => undefined,
            cleanupOldDrafts: async () => undefined,
            submittedDrafts: async (root: vscode.Uri) => {
                submittedRoots.push(root.toString());
                if (root.toString()===rootA.toString()) {
                    signalAStarted();
                    await pauseA;
                }
                return [];
            },
            markDraftImported: async () => undefined,
        };
        internals.editorProvider = {
            setActiveRoot: () => undefined,
        };
        internals.startImportTimer = () => undefined;

        const importA = manager.importAgentReviewDrafts();
        await aStarted;
        const activateB = manager.activate(rootB);
        releaseA();
        await Promise.all([importA, activateB]);

        assert.strictEqual(internals.activeRoot.toString(), rootB.toString());
        assert.deepStrictEqual(submittedRoots, [rootA.toString(), rootB.toString()]);
        assert.deepStrictEqual(importedRoots, [rootB.toString()]);
    });
});
