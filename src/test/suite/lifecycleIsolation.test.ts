import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { BaseAPI, SessionExpiredError } from '../../api/base';
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

    test('serializes document joins because one socket has one join/leave epoch', async () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        internals.disposed = false;
        internals._connectionState = 'connected';
        internals.documentJoinQueue = Promise.resolve();
        internals.documentCollaboratorRevisions = new Map();
        internals.isDirty = false;
        let activeJoins = 0;
        let maximumActiveJoins = 0;
        internals.socket = {
            joinDoc: async (docId: string) => {
                activeJoins += 1;
                maximumActiveJoins = Math.max(maximumActiveJoins, activeJoins);
                try {
                    await new Promise(resolve => setTimeout(resolve, 25));
                    return {docLines: [`content for ${docId}`], version: 1};
                } finally {
                    activeJoins -= 1;
                }
            },
        };
        const first = {_id: 'doc-1', name: 'one.tex'};
        const second = {_id: 'doc-2', name: 'two.tex'};

        const [firstContent, secondContent] = await Promise.all([
            internals.refreshDocumentFromServer(vscode.Uri.file('/one.tex'), first),
            internals.refreshDocumentFromServer(vscode.Uri.file('/two.tex'), second),
        ]);

        assert.strictEqual(maximumActiveJoins, 1);
        assert.strictEqual(new TextDecoder().decode(firstContent), 'content for doc-1');
        assert.strictEqual(new TextDecoder().decode(secondContent), 'content for doc-2');
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

    test('reorders delayed OT operations before updating the document cache', () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const document = {
            _id: 'doc-1',
            name: 'main.tex',
            version: 4,
            localCache: 'base',
            remoteCache: 'base',
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
        // Redis/socket delivery may hand us v+1 first. It must wait, not
        // invalidate a clean cache or apply at a fuzzy location.
        onFileChanged!({doc: 'doc-1', v: 5, op: [{p: 10, i: '\nsecond'}]});
        assert.strictEqual(document.remoteCache, 'base');
        assert.strictEqual(notifications.length, 0);

        onFileChanged!({doc: 'doc-1', v: 4, op: [{p: 0, i: 'first\n'}]});
        assert.strictEqual(document.localCache, 'first\nbase\nsecond');
        assert.strictEqual(document.remoteCache, 'first\nbase\nsecond');
        assert.strictEqual(document.version, 6);
        assert.strictEqual(notifications.length, 2);
        assert.strictEqual(internals.queuedRemoteDocumentUpdates?.has('doc-1'), false);
    });

    test('fails closed when a delayed OT predecessor never arrives', async () => {
        const previousTimeout = (VirtualFileSystem as any)
            .queuedRemoteDocumentUpdateTimeoutMs;
        (VirtualFileSystem as any).queuedRemoteDocumentUpdateTimeoutMs = 5;
        try {
            const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
            const internals = vfs as any;
            attachAuthenticatedSession(internals);
            const document = {
                _id: 'doc-timeout',
                name: 'main.tex',
                version: 4,
                localCache: 'base',
                remoteCache: 'base',
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
            onFileChanged!({doc: 'doc-timeout', v: 5, op: [{p: 0, i: 'remote'}]});
            await new Promise(resolve => setTimeout(resolve, 20));

            assert.strictEqual(document.localCache, undefined);
            assert.strictEqual(document.remoteCache, undefined);
            assert.strictEqual(notifications.length, 1);
            assert.strictEqual(notifications[0].type, vscode.FileChangeType.Changed);
        } finally {
            (VirtualFileSystem as any).queuedRemoteDocumentUpdateTimeoutMs = previousTimeout;
        }
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
            if (senderEventObserved) {
                internals.publicId = 'source-before';
            }
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

    test('downloads a coherent document snapshot through the stateless HTTP endpoint', async function () {
        this.timeout(10000);
        let requestedUrl = '';
        const server = http.createServer((request, response) => {
            requestedUrl = request.url ?? '';
            response.statusCode = 200;
            response.setHeader('Connection', 'close');
            response.end('first line\nsecond line');
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        assert.ok(address && typeof address!=='string');
        const api = new BaseAPI(`http://127.0.0.1:${address.port}/`);

        try {
            const response = await api.getDocumentSnapshot(
                {csrfToken: 'test', cookies: 'session=test'},
                'project-1',
                'doc-1',
            );
            assert.strictEqual(
                requestedUrl,
                '/project/project-1/doc/doc-1/download',
            );
            assert.strictEqual(
                new TextDecoder().decode(response.content),
                'first line\nsecond line',
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

    test('deduplicates document ids in one HTTP/2 bootstrap batch', async () => {
        const api = new BaseAPI('https://example.test/');
        let requestedDocIds: string[] = [];
        (api as any).getDocumentSnapshotsHttp2 = async (
            _identity: unknown,
            _projectId: string,
            docIds: string[],
        ) => {
            requestedDocIds = docIds;
            return new Map(docIds.map(docId => [
                docId,
                new TextEncoder().encode(`snapshot:${docId}`),
            ]));
        };

        const snapshots = await api.getDocumentSnapshots(
            {csrfToken: 'test', cookies: 'session=test'},
            'project-1',
            ['doc-1', 'doc-2', 'doc-1'],
        );

        assert.deepStrictEqual(requestedDocIds, ['doc-1', 'doc-2']);
        assert.strictEqual(
            new TextDecoder().decode(snapshots.get('doc-2')),
            'snapshot:doc-2',
        );
    });

    test('falls back to authenticated per-document downloads when HTTP/2 is unavailable', async () => {
        const api = new BaseAPI('https://example.test/');
        (api as any).getDocumentSnapshotsHttp2 = async () => {
            throw new Error('ALPN did not negotiate h2');
        };
        const requested: string[] = [];
        (api as any).getDocumentSnapshot = async (
            _identity: unknown,
            _projectId: string,
            docId: string,
        ) => {
            requested.push(docId);
            return {
                type: 'success',
                content: new TextEncoder().encode(`fallback:${docId}`),
            };
        };

        const snapshots = await api.getDocumentSnapshots(
            {csrfToken: 'test', cookies: 'session=test'},
            'project-1',
            ['doc-1', 'doc-2'],
        );

        assert.deepStrictEqual(requested.sort(), ['doc-1', 'doc-2']);
        assert.strictEqual(
            new TextDecoder().decode(snapshots.get('doc-1')),
            'fallback:doc-1',
        );
    });

    test('does not fan out fallback downloads after an HTTP/2 session expiry', async () => {
        const api = new BaseAPI('https://example.test/');
        (api as any).getDocumentSnapshotsHttp2 = async () => {
            throw new SessionExpiredError('https://example.test/', 302);
        };
        let fallbackCount = 0;
        (api as any).getDocumentSnapshot = async () => {
            fallbackCount += 1;
            throw new Error('unexpected fallback');
        };

        await assert.rejects(
            () => api.getDocumentSnapshots(
                {csrfToken: 'test', cookies: 'expired'},
                'project-1',
                ['doc-1', 'doc-2'],
            ),
            SessionExpiredError,
        );
        assert.strictEqual(fallbackCount, 0);
    });

    test('preserves mutation HTTP status for retry classification', async function () {
        this.timeout(10000);
        let requestCount = 0;
        const server = http.createServer((_request, response) => {
            requestCount += 1;
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
            assert.strictEqual(requestCount, 1);
        } finally {
            (
                server as http.Server & {closeAllConnections?: () => void}
            ).closeAllConnections?.();
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        }
    });

    test('logs in with browser cookies through the Node-compatible auth transport', async function () {
        this.timeout(10000);
        const requestedPaths: string[] = [];
        const server = http.createServer((request, response) => {
            requestedPaths.push(request.url ?? '');
            if (request.url==='/project') {
                assert.strictEqual(request.headers.cookie, 'session=browser');
                response.statusCode = 200;
                response.end([
                    '<meta name="ol-user_id" content="user-1">',
                    '<meta name="ol-usersEmail" content="user@example.test">',
                    '<meta name="ol-csrfToken" content="csrf-project">',
                ].join(''));
                return;
            }
            if (request.url==='/socket.io/socket.io.js') {
                assert.strictEqual(request.headers.cookie, 'session=browser');
                response.statusCode = 200;
                response.setHeader('Connection', 'close');
                response.setHeader('Set-Cookie', 'socket=refreshed; Path=/; HttpOnly');
                response.end('// socket client');
                return;
            }
            response.statusCode = 404;
            response.end('not found');
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        assert.ok(address && typeof address!=='string');
        const api = new BaseAPI(`http://127.0.0.1:${address.port}/`);

        try {
            const response = await api.cookiesLogin('session=browser');
            assert.strictEqual(response.type, 'success');
            assert.deepStrictEqual(response.userInfo, {
                userId: 'user-1',
                userEmail: 'user@example.test',
            });
            assert.deepStrictEqual(response.identity, {
                csrfToken: 'csrf-project',
                cookies: 'session=browser; socket=refreshed',
            });
            assert.deepStrictEqual(requestedPaths, [
                '/project',
                '/socket.io/socket.io.js',
            ]);
        } finally {
            (
                server as http.Server & {closeAllConnections?: () => void}
            ).closeAllConnections?.();
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        }
    });

    test('preserves passport login cookies across the compatible auth transport', async function () {
        this.timeout(10000);
        const requestedPaths: string[] = [];
        const server = http.createServer((request, response) => {
            requestedPaths.push(`${request.method} ${request.url}`);
            if (request.method==='GET' && request.url==='/login') {
                response.statusCode = 200;
                response.setHeader('Set-Cookie', [
                    'prelogin=one; Path=/; HttpOnly',
                    'csrf-seed=alpha; Path=/; SameSite=Lax',
                ]);
                response.end('<input name="_csrf" value="csrf-login">');
                return;
            }
            if (request.method==='POST' && request.url==='/login') {
                assert.strictEqual(request.headers.cookie, 'prelogin=one; csrf-seed=alpha');
                assert.strictEqual(request.headers['x-csrf-token'], 'csrf-login');
                assert.strictEqual(request.headers['accept-encoding'], undefined);
                let body = '';
                request.setEncoding('utf8');
                request.on('data', chunk => {
                    body += chunk;
                });
                request.on('end', () => {
                    assert.deepStrictEqual(JSON.parse(body), {
                        _csrf: 'csrf-login',
                        email: 'user@example.test',
                        password: 'password',
                    });
                    response.statusCode = 302;
                    response.setHeader('Location', `http://${request.headers.host}/project`);
                    response.setHeader('Set-Cookie', [
                        'prelogin=two; Path=/; HttpOnly',
                        'session=passport; Path=/; HttpOnly',
                        'feature=initial; Path=/',
                    ]);
                    response.end();
                });
                return;
            }
            if (request.method==='GET' && request.url==='/project') {
                assert.strictEqual(
                    request.headers.cookie,
                    'prelogin=two; csrf-seed=alpha; session=passport; feature=initial',
                );
                response.statusCode = 200;
                response.end([
                    '<meta name="ol-user_id" content="user-passport">',
                    '<meta name="ol-usersEmail" content="passport@example.test">',
                    '<meta name="ol-csrfToken" content="csrf-project">',
                ].join(''));
                return;
            }
            if (request.method==='GET' && request.url==='/socket.io/socket.io.js') {
                assert.strictEqual(
                    request.headers.cookie,
                    'prelogin=two; csrf-seed=alpha; session=passport; feature=initial',
                );
                response.statusCode = 200;
                response.setHeader('Connection', 'close');
                response.setHeader('Set-Cookie', [
                    'feature=refreshed; Path=/',
                    'socket=passport; Path=/',
                ]);
                response.end('// socket client');
                return;
            }
            response.statusCode = 404;
            response.end('not found');
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        assert.ok(address && typeof address!=='string');
        const api = new BaseAPI(`http://127.0.0.1:${address.port}/`);

        try {
            const response = await api.passportLogin('user@example.test', 'password');
            assert.strictEqual(response.type, 'success');
            assert.deepStrictEqual(response.userInfo, {
                userId: 'user-passport',
                userEmail: 'passport@example.test',
            });
            assert.deepStrictEqual(response.identity, {
                csrfToken: 'csrf-project',
                cookies: [
                    'prelogin=two',
                    'csrf-seed=alpha',
                    'session=passport',
                    'feature=refreshed',
                    'socket=passport',
                ].join('; '),
            });
            assert.deepStrictEqual(requestedPaths, [
                'GET /login',
                'POST /login',
                'GET /project',
                'GET /socket.io/socket.io.js',
            ]);
        } finally {
            (
                server as http.Server & {closeAllConnections?: () => void}
            ).closeAllConnections?.();
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        }
    });

    test('keeps passport error responses parseable without advertising compression', async function () {
        this.timeout(10000);
        const server = http.createServer((request, response) => {
            if (request.method==='GET' && request.url==='/login') {
                response.statusCode = 200;
                response.setHeader('Set-Cookie', 'prelogin=one; Path=/; HttpOnly');
                response.end('<input name="_csrf" value="csrf-login">');
                return;
            }
            if (request.method==='POST' && request.url==='/login') {
                assert.strictEqual(request.headers['accept-encoding'], undefined);
                request.resume();
                request.once('end', () => {
                    response.statusCode = 401;
                    response.setHeader('Connection', 'close');
                    response.setHeader('Content-Type', 'application/json');
                    response.end(JSON.stringify({message: {text: 'Login denied'}}));
                });
                return;
            }
            response.statusCode = 404;
            response.end('not found');
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        assert.ok(address && typeof address!=='string');
        const api = new BaseAPI(`http://127.0.0.1:${address.port}/`);

        try {
            const response = await api.passportLogin('user@example.test', 'wrong-password');
            assert.strictEqual(response.type, 'error');
            assert.strictEqual(response.message, 'Login denied');
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

    test('uses entity-preserving rename then move for a cross-folder basename change', async () => {
        const originalAuthenticate = (GlobalStateManager as any).authenticate;
        (GlobalStateManager as any).authenticate = async () => ({csrfToken: 'test-token'});

        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        const sourceParent = {_id: 'figures-folder'};
        const destinationParent = {_id: 'archive-folder'};
        const entity = {_id: 'file-1', name: 'draft.pdf'};
        const oldUri = vscode.Uri.file('/tmp/figures/draft.pdf');
        const intermediateUri = vscode.Uri.file('/tmp/figures/final.pdf');
        const newUri = vscode.Uri.file('/tmp/archive/final.pdf');
        const apiCalls: Array<{operation: string; args: unknown[]}> = [];
        const removed: Array<{parent: unknown; type: string; entity: unknown}> = [];
        const inserted: Array<{parent: unknown; type: string; entity: unknown}> = [];
        const notifications: vscode.FileChangeEvent[][] = [];
        attachAuthenticatedSession(internals);
        internals.disposed = false;
        internals.projectId = 'project-1';
        internals.api = {
            renameEntity: async (...args: unknown[]) => {
                apiCalls.push({operation: 'rename', args});
                return {type: 'success'};
            },
            moveEntity: async (...args: unknown[]) => {
                apiCalls.push({operation: 'move', args});
                return {type: 'success'};
            },
        };
        internals._resolveUri = async (uri: vscode.Uri) => {
            if (uri.toString()===oldUri.toString()) {
                return {
                    parentFolder: sourceParent,
                    fileName: 'draft.pdf',
                    fileType: 'file',
                    fileEntity: entity,
                };
            }
            if (uri.toString()===intermediateUri.toString()) {
                return {
                    parentFolder: sourceParent,
                    fileName: 'final.pdf',
                    fileType: undefined,
                    fileEntity: undefined,
                };
            }
            if (uri.toString()===newUri.toString()) {
                return {
                    parentFolder: destinationParent,
                    fileName: 'final.pdf',
                    fileType: undefined,
                    fileEntity: undefined,
                };
            }
            throw new Error(`Unexpected VFS URI: ${uri.toString()}`);
        };
        internals.removeEntity = (parent: unknown, type: string, removedEntity: unknown) => {
            removed.push({parent, type, entity: removedEntity});
        };
        internals.insertEntity = (parent: unknown, type: string, insertedEntity: unknown) => {
            inserted.push({parent, type, entity: insertedEntity});
        };
        internals.notify = (events: vscode.FileChangeEvent[]) => notifications.push(events);

        try {
            await internals.rename(
                oldUri,
                newUri,
                false,
                {id: 'file-1', type: 'file'},
            );
            assert.deepStrictEqual(
                apiCalls.map(call => [call.operation, ...call.args.slice(2)]),
                [
                    ['rename', 'file', 'file-1', 'final.pdf'],
                    ['move', 'file', 'file-1', 'archive-folder'],
                ],
            );
            assert.strictEqual(entity.name, 'final.pdf');
            assert.deepStrictEqual(removed, [{
                parent: sourceParent,
                type: 'file',
                entity,
            }]);
            assert.deepStrictEqual(inserted, [{
                parent: destinationParent,
                type: 'file',
                entity,
            }]);
            assert.deepStrictEqual(notifications, [[
                {type: vscode.FileChangeType.Deleted, uri: oldUri},
                {type: vscode.FileChangeType.Created, uri: newUri},
            ]]);
        } finally {
            (GlobalStateManager as any).authenticate = originalAuthenticate;
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

    test('falls back to a fresh v2 handshake after a v1 HTTP upgrade failure', () => {
        const socketClient = require('socket.io-client') as {
            connect: (url: string, options: Record<string, unknown>) => unknown;
        };
        const originalConnect = socketClient.connect;
        const sockets: Array<{
            handlers: Map<string, (...args:any[]) => void>;
            disconnects: number;
            socket: Record<string, unknown>;
        }> = [];
        const capturedQueries: unknown[] = [];
        socketClient.connect = (_url, options) => {
            const handlers = new Map<string, (...args:any[]) => void>();
            let disconnects = 0;
            const socket = {
                emit: () => undefined,
                on: (event: string, handler: (...args:any[]) => void) => {
                    handlers.set(event, handler);
                    return socket;
                },
                disconnect: () => {
                    disconnects += 1;
                },
                removeAllListeners: () => undefined,
            };
            const state = {
                handlers,
                get disconnects() {
                    return disconnects;
                },
                socket,
            };
            sockets.push(state);
            capturedQueries.push(options.query);
            return state.socket;
        };

        try {
            const api = new BaseAPI('https://www.overleaf.com/');
            const socket = new SocketIOAPI(
                'https://www.overleaf.com/',
                api,
                {csrfToken: 'token', cookies: 'session=cookie'},
                'project-1',
            );
            assert.strictEqual(socket.needsReinit, false);

            sockets[0].handlers.get('error')?.(new Error('Unexpected server response: 502'));
            assert.strictEqual(socket.needsReinit, true);
            assert.strictEqual(sockets[0].disconnects, 1);

            socket.init();
            assert.strictEqual(socket.needsReinit, false);
            assert.strictEqual(capturedQueries.length, 2);
            assert.strictEqual(capturedQueries[0], '');
            assert.match(String(capturedQueries[1]), /^projectId=project-1&t=\d+$/);
        } finally {
            socketClient.connect = originalConnect;
        }
    });

    test('does not exhaust retries before a changed socket scheme is attempted', async () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        internals.disposed = false;
        internals.origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project?user=user-1&project=project-1`,
        );
        internals.projectId = 'project-1';
        internals.retryConnection = 2;
        internals._connectionState = 'initial';
        internals.setConnectionState = () => undefined;
        internals.remoteWatch = () => undefined;
        internals.ensureActiveManagers = () => undefined;
        const project = {_id: 'project-1', name: 'Project', rootFolder: []};
        let needsReinit = false;
        let initCalls = 0;
        let joinCalls = 0;
        internals.socket = {
            get needsReinit() {
                return needsReinit;
            },
            init: () => {
                initCalls += 1;
                needsReinit = false;
            },
            joinProject: async () => {
                joinCalls += 1;
                if (joinCalls===1) {
                    needsReinit = true;
                    throw new Error('client not handshaken');
                }
                return project;
            },
        };
        internals.api = {
            getProjectSettings: async () => ({settings: {compiler: 'pdflatex'}}),
        };

        const initialized = await vfs.init();

        assert.strictEqual(initialized, project);
        assert.strictEqual(joinCalls, 2);
        assert.strictEqual(initCalls, 2);
        assert.strictEqual(internals.retryConnection, 0);
    });

    test('gracefully disposes an old socket before creating its replacement', () => {
        const socketClient = require('socket.io-client') as {
            connect: (url: string, options: Record<string, unknown>) => unknown;
        };
        const originalConnect = socketClient.connect;
        const sockets = [0, 1].map(() => {
            const state = {
                disconnects: 0,
                listenerRemovals: 0,
            };
            const socket = {
                emit: () => undefined,
                on: () => socket,
                disconnect: () => {
                    state.disconnects += 1;
                },
                removeAllListeners: () => {
                    state.listenerRemovals += 1;
                },
            };
            return {socket, state};
        });
        let connectionIndex = 0;
        socketClient.connect = () => sockets[connectionIndex++].socket;

        try {
            const api = new BaseAPI('https://www.overleaf.com/');
            const socket = new SocketIOAPI(
                'https://www.overleaf.com/',
                api,
                {csrfToken: 'token', cookies: 'session=cookie'},
                'project-1',
            );
            socket.init();

            assert.strictEqual(connectionIndex, 2);
            assert.deepStrictEqual(sockets[0].state, {
                disconnects: 1,
                listenerRemovals: 1,
            });
            assert.deepStrictEqual(sockets[1].state, {
                disconnects: 0,
                listenerRemovals: 0,
            });

            socket.dispose();
            assert.deepStrictEqual(sockets[1].state, {
                disconnects: 1,
                listenerRemovals: 1,
            });
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

    test('uses the official versioned joinDoc protocol when a document cache exists', async () => {
        const socket = Object.create(SocketIOAPI.prototype) as SocketIOAPI;
        const calls: unknown[][] = [];
        (socket as any).emit = async (...args: unknown[]) => {
            calls.push(args);
            return [['plain'], 8, [], {}, 'sharejs-text-ot'];
        };

        const caughtUp = await socket.joinDoc('doc-1', 6);
        assert.strictEqual(caughtUp.version, 8);
        assert.deepStrictEqual(caughtUp.docLines, ['plain']);
        assert.deepStrictEqual(calls, [[
            'joinDoc',
            'doc-1',
            6,
            {encodeRanges: true},
        ]]);

        await socket.joinDoc('doc-1');
        assert.deepStrictEqual(calls[1], [
            'joinDoc',
            'doc-1',
            {encodeRanges: true},
        ]);
    });

    test('applies a verified versioned joinDoc catch-up to the authoritative cache', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex?user=user-1&project=project-1',
        );
        const document = {
            _id: 'doc-catch-up',
            name: 'main.tex',
            version: 4,
            localCache: 'Hello',
            remoteCache: 'Hello',
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        internals.disposed = false;
        internals.documentJoinQueue = Promise.resolve();
        internals.documentCollaboratorRevisions = new Map();
        internals._connectionState = 'connected';
        internals.requireCurrentSession = () => ({});
        internals._resolveById = () => ({fileEntity: document});
        const notifications: vscode.FileChangeEvent[] = [];
        internals.notify = (events: vscode.FileChangeEvent[]) => notifications.push(...events);
        internals.isDirty = false;
        const joinVersions: Array<number | undefined> = [];
        internals.socket = {
            joinDoc: async (_docId: string, fromVersion?: number) => {
                joinVersions.push(fromVersion);
                return {
                    docLines: ['ignored full snapshot'],
                    version: 6,
                    updates: [
                        {doc: document._id, v: 4, op: [{p: 5, i: ' world'}]},
                        {doc: document._id, v: 5, op: [{p: 6, d: 'world'}, {p: 6, i: 'Overleaf'}]},
                    ],
                    type: 'sharejs-text-ot',
                };
            },
        };

        const content = await internals.refreshDocumentFromServer(uri, document);
        assert.strictEqual(new TextDecoder().decode(content), 'Hello Overleaf');
        assert.strictEqual(document.version, 6);
        assert.strictEqual(document.remoteCache, 'Hello Overleaf');
        assert.deepStrictEqual(joinVersions, [4]);
        assert.strictEqual(notifications.length, 1);
    });

    test('falls back to a full joinDoc snapshot when catch-up operations are incomplete', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex?user=user-1&project=project-1',
        );
        const document = {
            _id: 'doc-catch-up-fallback',
            name: 'main.tex',
            version: 7,
            localCache: 'base',
            remoteCache: 'base',
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        internals.disposed = false;
        internals.documentJoinQueue = Promise.resolve();
        internals.documentCollaboratorRevisions = new Map();
        internals._connectionState = 'connected';
        internals.requireCurrentSession = () => ({});
        internals._resolveById = () => ({fileEntity: document});
        internals.notify = () => undefined;
        const joinVersions: Array<number | undefined> = [];
        internals.socket = {
            joinDoc: async (_docId: string, fromVersion?: number) => {
                joinVersions.push(fromVersion);
                if (fromVersion!==undefined) {
                    return {
                        docLines: ['stale full snapshot'],
                        version: 9,
                        updates: [
                            {doc: document._id, v: 7, op: [{p: 4, i: ' remote'}]},
                        ],
                        type: 'sharejs-text-ot',
                    };
                }
                return {
                    docLines: ['canonical', 'snapshot'],
                    version: 9,
                    updates: [],
                    type: 'sharejs-text-ot',
                };
            },
        };

        const content = await internals.refreshDocumentFromServer(uri, document);
        assert.strictEqual(new TextDecoder().decode(content), 'canonical\nsnapshot');
        assert.strictEqual(document.version, 9);
        assert.strictEqual(document.remoteCache, 'canonical\nsnapshot');
        assert.deepStrictEqual(joinVersions, [7, undefined]);
    });

    test('routes otUpdateError document metadata through SocketIO listeners', () => {
        const socket = Object.create(SocketIOAPI.prototype) as SocketIOAPI;
        const internals = socket as any;
        const listeners = new Map<string, (...args: any[]) => void>();
        internals._handlers = [];
        internals.addSocketListener = (event: string, listener: (...args: any[]) => void) => {
            listeners.set(event, listener);
        };
        internals.removeSocketListener = (event: string, listener: (...args: any[]) => void) => {
            if (listeners.get(event)===listener) { listeners.delete(event); }
        };

        let receivedError: unknown;
        let receivedDocId: string | undefined;
        const disposable = socket.updateEventHandlers({
            onOtUpdateError: (error, metadata) => {
                receivedError = error;
                receivedDocId = metadata?.doc_id;
            },
        });
        const listener = listeners.get('otUpdateError');
        assert.ok(listener);
        // Overleaf's socket payload uses this snake_case wire key.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        listener!('update is too large', {doc_id: 'doc-error'});

        assert.strictEqual(receivedError, 'update is too large');
        assert.strictEqual(receivedDocId, 'doc-error');
        disposable.dispose();
        assert.strictEqual(listeners.has('otUpdateError'), false);
    });

    test('fails closed when Overleaf emits otUpdateError for a pending text write', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex?user=user-1&project=project-1',
        );
        const document = {
            _id: 'doc-ot-update-error',
            name: 'main.tex',
            version: 30,
            lastVersion: 29,
            localCache: 'title: base\n',
            remoteCache: 'title: base\n',
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
        internals._resolveById = (id: string) => id===document._id
            ? {fileEntity: document, fileType: 'doc', path: '/main.tex'}
            : undefined;
        const notifications: vscode.FileChangeEvent[] = [];
        internals.notify = (events: vscode.FileChangeEvent[]) => notifications.push(...events);

        // Overleaf's socket metadata retains its public snake_case field name.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        let onOtUpdateError: ((error: unknown, message?: {doc_id?: string; error?: string}) => void) | undefined;
        let joinCount = 0;
        internals.socket = {
            updateEventHandlers: (handlers: any) => {
                onOtUpdateError = handlers.onOtUpdateError;
                return new vscode.Disposable(() => undefined);
            },
            applyOtUpdate: async () => {
                if (!onOtUpdateError) { throw new Error('otUpdateError listener was not registered'); }
                onOtUpdateError('update is too large', {
                    // eslint-disable-next-line @typescript-eslint/naming-convention
                    doc_id: document._id,
                    error: 'update is too large',
                });
            },
            joinDoc: async () => {
                joinCount += 1;
                return {
                    docLines: ['title: base', ''],
                    version: 30,
                    updates: [],
                    type: 'sharejs-text-ot',
                };
            },
        };
        internals.remoteWatch();

        await assert.rejects(
            () => vfs.writeFileFromRemoteBaseline(
                uri,
                new TextEncoder().encode('title: local\n'),
                new TextEncoder().encode('title: base\n'),
            ),
            RemoteDocumentWriteAmbiguousError,
        );

        assert.strictEqual(joinCount, 1);
        assert.strictEqual(document.remoteCache, 'title: base\n');
        assert.strictEqual(document.localCache, 'title: base\n');
        assert.strictEqual(internals.pendingDocumentWrites.has(document._id), false);
        assert.strictEqual(internals.documentInDoubtSenderVersions.has(document._id), false);
        assert.strictEqual(notifications.some(event => event.type===vscode.FileChangeType.Changed), true);
    });

    test('replays a disconnected in-flight OT with official duplicate source IDs', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex' +
            '?user=user-1&project=project-1',
        );
        const desired = 'base\nlocal\n';
        const document = {
            _id: 'doc-duplicate-replay',
            name: 'main.tex',
            version: 70,
            lastVersion: 69,
            localCache: 'base\n',
            remoteCache: 'base\n',
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const attempts: any[] = [];
        const server = {content: 'base\n', version: 70};
        let reconnects = 0;
        internals.disposed = false;
        internals.origin = uri.with({path: '/Project'});
        internals.projectName = 'Project';
        internals.publicId = 'source-before';
        internals._connectionState = 'connected';
        internals.documentWriteQueues = new Map();
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals.ensureConnectedForWrite = async () => undefined;
        internals.reconnect = async () => {
            reconnects += 1;
            internals.publicId = 'source-after';
            internals._connectionState = 'connected';
            return {};
        };
        internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
        internals._resolveById = () => ({fileEntity: document, path: '/main.tex'});
        internals.notify = () => undefined;
        internals.socket = {
            needsReinit: false,
            isUsingAlternativeConnectionScheme: false,
            applyOtUpdate: async (_docId: string, update: any) => {
                attempts.push(update);
                if (attempts.length===1) {
                    internals._connectionState = 'reconnecting';
                    throw new Error('timeout');
                }
                assert.deepStrictEqual(
                    [...(update.dupIfSource ?? [])].sort(),
                    ['source-after', 'source-before'],
                );
                const appliedVersion = server.version;
                server.content = desired;
                server.version += 1;
                internals.applyRemoteDocumentUpdate({
                    doc: document._id,
                    v: appliedVersion,
                });
            },
            joinDoc: async () => assert.fail('A sender acknowledgement should avoid a snapshot read.'),
        };

        const written = await vfs.writeFileFromRemoteBaseline(
            uri,
            new TextEncoder().encode(desired),
            new TextEncoder().encode('base\n'),
        );

        assert.strictEqual(new TextDecoder().decode(written), desired);
        assert.strictEqual(reconnects, 1);
        assert.strictEqual(attempts.length, 2);
        assert.strictEqual(attempts[0].dupIfSource, undefined);
        assert.deepStrictEqual(attempts[0].op, attempts[1].op);
        assert.strictEqual(document.remoteCache, desired);
        assert.strictEqual(internals.documentInDoubtSenderVersions.has(document._id), false);
    });
    test('confirms a duplicate OT rejection through authoritative readback', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex' +
            '?user=user-1&project=project-1',
        );
        const desired = 'base\nlocal\n';
        const document = {
            _id: 'doc-duplicate-readback',
            name: 'main.tex',
            version: 80,
            lastVersion: 79,
            localCache: 'base\n',
            remoteCache: 'base\n',
        };
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const attempts: any[] = [];
        const server = {content: 'base\n', version: 80};
        const joinVersions: Array<number | undefined> = [];
        internals.disposed = false;
        internals.origin = uri.with({path: '/Project'});
        internals.projectName = 'Project';
        internals.publicId = 'source-before';
        internals._connectionState = 'connected';
        internals.documentJoinQueue = Promise.resolve();
        internals.documentWriteQueues = new Map();
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals.ensureConnectedForWrite = async () => undefined;
        internals.reconnect = async () => {
            internals.publicId = 'source-after';
            internals._connectionState = 'connected';
            return {};
        };
        internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
        internals._resolveById = () => ({fileEntity: document, path: '/main.tex'});
        internals.notify = () => undefined;
        internals.socket = {
            needsReinit: false,
            isUsingAlternativeConnectionScheme: false,
            applyOtUpdate: async (_docId: string, update: any) => {
                attempts.push(update);
                if (attempts.length===1) {
                    server.content = desired;
                    server.version += 1;
                    internals._connectionState = 'reconnecting';
                    throw new Error('timeout');
                }
                assert.deepStrictEqual(
                    [...(update.dupIfSource ?? [])].sort(),
                    ['source-after', 'source-before'],
                );
                throw new Error('Op already submitted');
            },
            joinDoc: async (_docId: string, fromVersion?: number) => {
                joinVersions.push(fromVersion);
                return {
                    docLines: server.content.split('\n'),
                    version: server.version,
                    updates: [],
                    type: 'sharejs-text-ot',
                };
            },
        };

        const written = await vfs.writeFileFromRemoteBaseline(
            uri,
            new TextEncoder().encode(desired),
            new TextEncoder().encode('base\n'),
        );

        assert.strictEqual(new TextDecoder().decode(written), desired);
        assert.strictEqual(attempts.length, 2);
        assert.deepStrictEqual(joinVersions, [undefined]);
        assert.strictEqual(document.version, server.version);
        assert.strictEqual(document.remoteCache, desired);
        assert.strictEqual(internals.pendingDocumentWrites.has(document._id), false);
        assert.strictEqual(internals.documentInDoubtSenderVersions.has(document._id), false);
    });
    test('uses three-way merge rather than fuzzy patching direct VFS writes', async () => {
        const uri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project/main.tex' +
            '?user=user-1&project=project-1',
        );
        const makeVfs = (document: {
            _id: string;
            name: string;
            version: number;
            lastVersion: number;
            localCache: string;
            remoteCache: string;
        }) => {
            const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
            const internals = vfs as any;
            attachAuthenticatedSession(internals);
            const updates: any[] = [];
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
                isUsingAlternativeConnectionScheme: false,
                applyOtUpdate: async (_docId: string, update: any) => {
                    updates.push(update);
                    const appliedVersion = document.version;
                    internals.applyRemoteDocumentUpdate({
                        doc: document._id,
                        v: appliedVersion,
                    });
                },
            };
            return {vfs, internals, updates};
        };

        const mergedDocument = {
            _id: 'doc-direct-merge',
            name: 'main.tex',
            version: 90,
            lastVersion: 89,
            localCache: 'title: base\nmiddle: base\nbody: base\n',
            remoteCache: 'title: remote\nmiddle: base\nbody: base\n',
        };
        const merged = makeVfs(mergedDocument);
        await merged.vfs.writeFile(
            uri,
            new TextEncoder().encode('title: base\nmiddle: base\nbody: local\n'),
            false,
            true,
        );
        assert.strictEqual(merged.updates.length, 1);
        assert.strictEqual(
            mergedDocument.remoteCache,
            'title: remote\nmiddle: base\nbody: local\n',
        );

        const conflictDocument = {
            _id: 'doc-direct-conflict',
            name: 'main.tex',
            version: 100,
            lastVersion: 99,
            localCache: 'title: base\n',
            remoteCache: 'title: remote\n',
        };
        const conflict = makeVfs(conflictDocument);
        await assert.rejects(
            () => conflict.vfs.writeFile(
                uri,
                new TextEncoder().encode('title: local\n'),
                false,
                true,
            ),
            RemoteDocumentMergeConflictError,
        );
        assert.strictEqual(conflict.updates.length, 0);
    });
});
