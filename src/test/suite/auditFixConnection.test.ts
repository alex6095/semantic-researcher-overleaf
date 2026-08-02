import * as assert from 'assert';
import * as vscode from 'vscode';
import { BaseAPI } from '../../api/base';
import { SocketIOAPI } from '../../api/socketio';
import { SocketIOAlt } from '../../api/socketioAlt';
import { VirtualFileSystem } from '../../core/remoteFileSystemProvider';
import { OUTPUT_FOLDER_NAME, ROOT_NAME, STATE_SERVERS_KEY } from '../../consts';

suite('Connection audit fixes', () => {
    const serverName = 'www.overleaf.com';
    const userId = 'user-1';
    const origin = vscode.Uri.parse(
        `${ROOT_NAME}://${serverName}/Project?user=${userId}&project=project-1`,
    );
    const documentUri = vscode.Uri.parse(
        `${ROOT_NAME}://${serverName}/Project/main.tex?user=${userId}&project=project-1`,
    );

    const attachAuthenticatedSession = (internals: any) => {
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

    // A project tree as `joinProject` hands it back: fresh entities without any
    // cached revision.
    const makeProject = (docs: Array<{_id: string, name: string}>, files: string[] = []) => ({
        _id: 'project-1',
        name: 'Project',
        // eslint-disable-next-line @typescript-eslint/naming-convention
        rootDoc_id: docs[0]?._id,
        rootFolder: [{
            _id: 'root',
            name: '',
            docs: docs.map(doc => ({...doc})),
            fileRefs: files.map(name => ({_id: `file-${name}`, name})),
            folders: [],
        }],
    });

    // Replace the `node-fetch` default export the API layer calls at request
    // time, so HTTP behaviour can be exercised without a network.
    const stubFetch = (handler: (url: string, init: any) => Promise<any>) => {
        const nodeFetch = require('node-fetch');
        const original = nodeFetch.default;
        nodeFetch.default = handler;
        return {dispose: () => { nodeFetch.default = original; }};
    };

    const fakeResponse = (status: number, options: {
        body?: string,
        buffer?: Buffer,
        headers?: {[key: string]: string},
    } = {}) => ({
        status,
        text: async () => options.body ?? '',
        buffer: async () => options.buffer ?? Buffer.alloc(0),
        headers: {
            get: (name: string) => options.headers?.[name.toLowerCase()] ?? null,
        },
    });

    const fakeSocketFactory = () => {
        const sockets: Array<{
            handlers: Map<string, Array<(...args:any[]) => void>>,
            emits: Array<{event: string, args: any[]}>,
            events: string[],
            socket: any,
        }> = [];
        const socketClient = require('socket.io-client');
        const originalConnect = socketClient.connect;
        socketClient.connect = () => {
            const handlers = new Map<string, Array<(...args:any[]) => void>>();
            const state = {handlers, emits: [] as Array<{event: string, args: any[]}>, events: [] as string[], socket: undefined as any};
            const socket = {
                emit: (event: string, ...args: any[]) => {
                    state.emits.push({event, args});
                    return socket;
                },
                on: (event: string, handler: (...args:any[]) => void) => {
                    const registered = handlers.get(event) ?? [];
                    registered.push(handler);
                    handlers.set(event, registered);
                    return socket;
                },
                removeListener: (event: string, handler: (...args:any[]) => void) => {
                    const registered = handlers.get(event) ?? [];
                    const index = registered.indexOf(handler);
                    if (index!==-1) { registered.splice(index, 1); }
                    return socket;
                },
                disconnect: () => {
                    state.events.push('disconnect');
                },
                removeAllListeners: () => {
                    state.events.push('removeAllListeners');
                    handlers.clear();
                },
            };
            state.socket = socket;
            sockets.push(state);
            return socket;
        };
        return {
            sockets,
            fire: (index: number, event: string, ...args: any[]) => {
                [...(sockets[index].handlers.get(event) ?? [])].forEach(handler => handler(...args));
            },
            dispose: () => { socketClient.connect = originalConnect; },
        };
    };

    const newSocketAPI = () => new SocketIOAPI(
        `https://${serverName}/`,
        new BaseAPI(`https://${serverName}/`),
        {csrfToken: 'token', cookies: 'session=cookie'},
        'project-1',
    );

    test('keeps the pre-reconnect merge base so a rejoin cannot delete collaborator edits', async () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const staleDocument = {
            _id: 'doc-1',
            name: 'main.tex',
            _type: 'doc',
            version: 5,
            localCache: 'title: base\nmiddle: base\nbody: base\n',
            remoteCache: 'title: base\nmiddle: base\nbody: base\n',
        };
        const rejoined = makeProject([{_id: 'doc-1', name: 'main.tex'}], ['added-offline.png']);
        // A collaborator edited a different region while the socket was down.
        const server = {content: 'title: remote\nmiddle: base\nbody: base\n', version: 6};
        const updates: any[] = [];
        const notifications: vscode.FileChangeEvent[] = [];

        internals.disposed = false;
        internals.origin = origin;
        internals.projectId = 'project-1';
        internals.retryConnection = 0;
        internals._connectionState = 'connected';
        internals.documentWriteQueues = new Map();
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals.root = {
            _id: 'project-1',
            rootFolder: [{
                _id: 'root',
                name: '',
                docs: [staleDocument],
                fileRefs: [{_id: 'file-removed', name: 'removed-offline.png'}],
                folders: [],
            }],
        };
        internals.remoteWatch = () => undefined;
        internals.ensureActiveManagers = () => undefined;
        internals.setConnectionState = () => undefined;
        internals.ensureConnectedForWrite = async () => undefined;
        internals.notify = (events: vscode.FileChangeEvent[]) => notifications.push(...events);
        internals.api = {
            getProjectSettings: async () => ({type: 'success', settings: {learnedWords: [], languages: [], compilers: []}}),
        };
        internals.socket = {
            needsReinit: false,
            init: () => undefined,
            joinProject: async () => rejoined,
            joinDoc: async () => ({
                docLines: server.content.split('\n'),
                version: server.version,
            }),
            applyOtUpdate: async (_docId: string, update: any) => {
                updates.push(update);
                const appliedVersion = server.version;
                server.version += 1;
                internals.applyRemoteDocumentUpdate({doc: 'doc-1', v: appliedVersion});
            },
        };
        internals._resolveUri = async () => {
            const rootFolder = internals.root.rootFolder[0];
            return {
                parentFolder: rootFolder,
                fileName: 'main.tex',
                fileType: 'doc',
                fileEntity: rootFolder.docs[0],
                fileId: 'doc-1',
            };
        };

        await vfs.reconnect('regression: rejoin baseline');
        assert.strictEqual(internals.root, rejoined);
        // The explorer must learn about what changed while the socket was down.
        const rejoinPaths = notifications.map(event => `${event.type}:${event.uri.path}`);
        assert.ok(rejoinPaths.includes(`${vscode.FileChangeType.Deleted}:/Project/removed-offline.png`), rejoinPaths.join(', '));
        assert.ok(rejoinPaths.includes(`${vscode.FileChangeType.Created}:/Project/added-offline.png`), rejoinPaths.join(', '));
        assert.ok(rejoinPaths.includes(`${vscode.FileChangeType.Changed}:/Project/main.tex`), rejoinPaths.join(', '));

        const written = await vfs.writeFileFromRemoteBaseline(
            documentUri,
            new TextEncoder().encode('title: base\nmiddle: base\nbody: local\n'),
        );

        assert.strictEqual(updates.length, 1);
        assert.strictEqual(
            new TextDecoder().decode(written),
            'title: remote\nmiddle: base\nbody: local\n',
            'the collaborator edit made during the outage must survive the write',
        );
        assert.strictEqual(
            (rejoined.rootFolder[0].docs[0] as any).remoteCache,
            'title: remote\nmiddle: base\nbody: local\n',
        );
        // The base has been consumed: local and remote are known equal again.
        assert.strictEqual(internals.documentMergeBaselines.has('doc-1'), false);
    });

    test('keeps the merge base when a missed OT update invalidates the document cache', () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const document = {
            _id: 'doc-1',
            name: 'main.tex',
            version: 4,
            localCache: 'base\n',
            remoteCache: 'base\n',
        };
        internals.disposed = false;
        internals.origin = origin;
        internals.documentCollaboratorRevisions = new Map();
        internals.pendingDocumentWrites = new Map();
        internals.documentInDoubtSenderVersions = new Map();
        internals.notify = () => undefined;
        internals._resolveById = () => ({fileEntity: document, path: '/main.tex'});

        internals.applyRemoteDocumentUpdate({doc: 'doc-1', v: 9, op: [{p: 0, i: 'remote'}]});

        assert.strictEqual(document.remoteCache, undefined);
        assert.strictEqual(internals.documentMergeBaselines.get('doc-1'), 'base\n');
    });

    test('clears in-doubt sender barriers that a rejoin can never acknowledge', () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        internals.disposed = false;
        internals.origin = origin;
        internals.documentInDoubtSenderVersions = new Map([['doc-1', [41]]]);
        internals.root = {
            _id: 'project-1',
            rootFolder: [{_id: 'root', name: '', docs: [], fileRefs: [], folders: []}],
        };

        internals.captureRejoinState();

        assert.strictEqual(internals.documentInDoubtSenderVersions.size, 0);
    });

    test('re-establishes the compile outputs folder after a rejoin', async () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const rejoined = makeProject([{_id: 'doc-1', name: 'main.tex'}]);
        internals.disposed = false;
        internals.origin = origin;
        internals.projectId = 'project-1';
        internals.retryConnection = 0;
        internals._connectionState = 'connected';
        internals.documentInDoubtSenderVersions = new Map();
        internals.root = makeProject([{_id: 'doc-1', name: 'main.tex'}]);
        internals.remoteWatch = () => undefined;
        internals.ensureActiveManagers = () => undefined;
        internals.setConnectionState = () => undefined;
        internals.notify = () => undefined;
        internals.lastOutputs = [{
            _id: 'outputs',
            name: 'output.pdf',
            path: 'output.pdf',
            url: '/project/project-1/user/user-1/build/build-1/output/output.pdf',
            type: 'pdf',
            build: 'build-1',
            readonly: true,
        }];
        internals.api = {
            getProjectSettings: async () => ({type: 'success', settings: {learnedWords: [], languages: [], compilers: []}}),
        };
        internals.socket = {
            needsReinit: false,
            init: () => undefined,
            joinProject: async () => rejoined,
        };

        await vfs.reconnect('regression: outputs after rejoin');

        const outputsFolder = rejoined.rootFolder[0].folders
            .find((folder: any) => folder.name===OUTPUT_FOLDER_NAME);
        assert.ok(outputsFolder, 'a rejoin must rebuild the client-side outputs folder');
        assert.deepStrictEqual(
            (outputsFolder as any).outputs.map((file: any) => file.name),
            ['output.pdf'],
        );
    });

    test('does not treat a transport handshake as a successful project join', () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const states: string[] = [];
        let handlers: any;
        internals.disposed = false;
        internals.origin = origin;
        internals.retryConnection = 2;
        internals._connectionState = 'reconnecting';
        internals.setConnectionState = (state: string) => states.push(state);
        internals.socket = {
            updateEventHandlers: (value: any) => {
                handlers = value;
                return new vscode.Disposable(() => undefined);
            },
        };

        internals.remoteWatch();
        handlers.onConnectionAccepted('public-1');

        assert.strictEqual(internals.publicId, 'public-1');
        assert.strictEqual(internals.retryConnection, 2, 'the retry budget belongs to joinProject');
        assert.deepStrictEqual(states, []);
    });

    test('waits for an in-flight rejoin before joining a document', async () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const document = {
            _id: 'doc-1',
            name: 'main.tex',
            version: undefined,
            localCache: undefined,
            remoteCache: undefined,
        };
        let joinDocCalls = 0;
        let releaseRejoin!: () => void;
        const rejoining = new Promise<void>(resolve => {
            releaseRejoin = resolve;
        });
        internals.disposed = false;
        internals.origin = origin;
        internals._connectionState = 'reconnecting';
        internals.initializing = rejoining;
        internals.documentCollaboratorRevisions = new Map();
        internals.notify = () => undefined;
        internals._resolveUri = async () => ({fileType: 'doc', fileEntity: document});
        internals.socket = {
            joinDoc: async () => {
                joinDocCalls += 1;
                return {docLines: ['joined after rejoin'], version: 3};
            },
        };

        const read = vfs.openFile(documentUri);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.strictEqual(joinDocCalls, 0, 'joinDoc on a socket that has not joined the project never gets an ack');

        releaseRejoin();
        assert.strictEqual(new TextDecoder().decode(await read), 'joined after rejoin');
        assert.strictEqual(joinDocCalls, 1);
    });

    test('reports a compile whose outputs cannot be published and keeps the project dirty', async () => {
        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        attachAuthenticatedSession(internals);
        const errors: string[] = [];
        const originalShowErrorMessage = vscode.window.showErrorMessage;
        (vscode.window as any).showErrorMessage = async (message: string) => {
            errors.push(message);
            return undefined;
        };
        internals.disposed = false;
        internals.origin = origin;
        internals.projectId = 'project-1';
        internals.isDirty = true;
        internals.root = makeProject([{_id: 'doc-1', name: 'main.tex'}]);
        internals.resolve = async () => undefined;
        internals.notify = () => undefined;
        internals.api = {
            compile: async () => ({
                type: 'success',
                compile: {status: 'success', compileGroup: 'standard', outputFiles: []},
            }),
        };

        try {
            assert.strictEqual(await vfs.compile(true), false);
            assert.strictEqual(internals.isDirty, true, 'an unusable compile result must not clear the dirty flag');
            assert.strictEqual(errors.length, 1);
            assert.match(errors[0], /without any output files/);

            // A throwing compile request must not lose the flag either.
            internals.api.compile = async () => { throw new Error('compile transport failed'); };
            await assert.rejects(() => vfs.compile(true), /compile transport failed/);
            assert.strictEqual(internals.isDirty, true);
        } finally {
            (vscode.window as any).showErrorMessage = originalShowErrorMessage;
        }
    });

    test('reports a dead socket as needing re-initialization and refuses its cached v2 record', async () => {
        const factory = fakeSocketFactory();
        try {
            const socket = newSocketAPI();
            const disconnects: number[] = [];
            socket.updateEventHandlers({onDisconnected: () => disconnects.push(1)});

            // Mid-session handshake failure: fall back to v2 and rebuild.
            factory.fire(0, 'error', new Error('client not handshaken'));
            assert.strictEqual(disconnects.length, 1, 'the teardown must drive the VFS state machine');
            assert.strictEqual(socket.needsReinit, true);

            socket.init();
            assert.strictEqual(socket.needsReinit, false);
            factory.fire(1, 'joinProjectResponse', 'public-1', {
                project: {_id: 'project-1', rootFolder: []},
            });
            const project = await socket.joinProject('project-1');
            assert.strictEqual((project as any)._id, 'project-1');

            // The socket dies without any further init: the cached record must
            // not be handed out again as if the project were still joined.
            factory.fire(1, 'disconnect');
            assert.strictEqual(disconnects.length, 2);
            assert.strictEqual(socket.needsReinit, true);
            await assert.rejects(() => socket.joinProject('project-1'), /superseded/);
        } finally {
            factory.dispose();
        }
    });

    test('disconnects before stripping listeners and re-arms them on the new socket', () => {
        const factory = fakeSocketFactory();
        try {
            const socket = newSocketAPI();
            const changes: any[] = [];
            const subscription = socket.updateEventHandlers({
                onFileChanged: (update) => changes.push(update),
            });

            socket.init();
            assert.deepStrictEqual(
                factory.sockets[0].events,
                ['disconnect', 'removeAllListeners'],
                'removing listeners first swallows the disconnect event',
            );

            factory.fire(1, 'otUpdateApplied', {doc: 'doc-1', v: 1});
            assert.strictEqual(changes.length, 1, 'handlers must follow the socket that replaced the old one');

            subscription.dispose();
            factory.fire(1, 'otUpdateApplied', {doc: 'doc-1', v: 2});
            assert.strictEqual(changes.length, 1);

            socket.init();
            factory.fire(2, 'otUpdateApplied', {doc: 'doc-1', v: 3});
            assert.strictEqual(changes.length, 1, 'a disposed handler must not be resurrected by a reconnect');
        } finally {
            factory.dispose();
        }
    });

    test('removes listeners for real in the alternative connection scheme', () => {
        const socket = Object.create(SocketIOAlt.prototype) as SocketIOAlt;
        const internals = socket as any;
        internals._eventEmitter = new (require('events').EventEmitter)();
        let applied = 0;
        const listener = () => { applied += 1; };

        (socket as any).on('otUpdateApplied', listener);
        internals._eventEmitter.emit('otUpdateApplied');
        assert.strictEqual(applied, 1);

        (socket as any).removeListener('otUpdateApplied', listener);
        internals._eventEmitter.emit('otUpdateApplied');
        assert.strictEqual(applied, 1, 'a no-op removal stacks a new handler copy on every reconnect');

        (socket as any).on('otUpdateApplied', listener);
        (socket as any).removeAllListeners();
        internals._eventEmitter.emit('otUpdateApplied');
        assert.strictEqual(applied, 1);
    });

    test('stops a 206 download loop instead of appending the same body forever', async () => {
        let calls = 0;
        const ranges: Array<string|undefined> = [];
        const stub = stubFetch(async (_url, init) => {
            calls += 1;
            ranges.push(init.headers['Range']);
            return fakeResponse(206, {buffer: Buffer.from('chunk')});
        });
        try {
            const api = new BaseAPI(`https://${serverName}/`);
            api.setIdentity({csrfToken: 'token', cookies: 'session=cookie'});

            await assert.rejects(
                () => (api as any).download('project/project-1/file/file-1'),
                /did not complete/,
            );
            assert.strictEqual(calls, 64);
            assert.strictEqual(ranges[0], undefined);
            assert.strictEqual(ranges[1], 'bytes=5-', 'a continuation must actually advance');
            assert.strictEqual(ranges[2], 'bytes=10-');
        } finally {
            stub.dispose();
        }
    });

    test('completes a ranged download once the server reports the full length', async () => {
        const bodies = [Buffer.from('first'), Buffer.from('second')];
        let calls = 0;
        const stub = stubFetch(async () => {
            const body = bodies[calls];
            calls += 1;
            return fakeResponse(206, {
                buffer: body,
                // eslint-disable-next-line @typescript-eslint/naming-convention
                headers: {'content-range': `bytes 0-${body.length-1}/11`},
            });
        });
        try {
            const api = new BaseAPI(`https://${serverName}/`);
            api.setIdentity({csrfToken: 'token', cookies: 'session=cookie'});

            const content = await (api as any).download('project/project-1/file/file-1');
            assert.strictEqual(content.toString(), 'firstsecond');
            assert.strictEqual(calls, 2);
        } finally {
            stub.dispose();
        }
    });

    test('detects an expired session centrally instead of reporting a generic error', async () => {
        const expiries: string[] = [];
        const responses = [
            // eslint-disable-next-line @typescript-eslint/naming-convention
            fakeResponse(302, {headers: {location: 'https://www.overleaf.com/login?redir=%2Fproject'}}),
            fakeResponse(403, {body: '{"message":"EBADCSRFTOKEN"}'}),
        ];
        let call = 0;
        const stub = stubFetch(async () => responses[call++]);
        try {
            const api = new BaseAPI(`https://${serverName}/`);
            api.setIdentity({csrfToken: 'token', cookies: 'session=cookie'});
            api.setSessionExpiryHandler((error) => expiries.push(error.message));

            const redirected = await (api as any).request('POST', 'project/project-1/folder', {name: 'x'});
            assert.strictEqual(redirected.type, 'error');
            assert.strictEqual(redirected.sessionExpired, true);

            const badCsrf = await (api as any).request('POST', 'project/project-1/folder', {name: 'x'});
            assert.strictEqual(badCsrf.sessionExpired, true);
            assert.strictEqual(expiries.length, 2);
            assert.match(expiries[0], /no longer valid/);
        } finally {
            stub.dispose();
        }
    });

    test('bounds every HTTP request with a timeout', async () => {
        const timeouts: Array<number|undefined> = [];
        const stub = stubFetch(async (_url, init) => {
            timeouts.push(init.timeout);
            return fakeResponse(200, {body: '{}'});
        });
        try {
            const api = new BaseAPI(`https://${serverName}/`);
            const identity = {csrfToken: 'token', cookies: 'session=cookie'};
            api.setIdentity(identity);

            await (api as any).request('GET', 'project/project-1/metadata');
            await api.compile(identity, 'project-1', 'main.tex');

            assert.strictEqual(timeouts[0], 30_000);
            assert.strictEqual(timeouts[1], 180_000, 'a compile is slow but must still be capped');
            assert.strictEqual((api as any).agent.options.timeout, 60_000);
        } finally {
            stub.dispose();
        }
    });
});
