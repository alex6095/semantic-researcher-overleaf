import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { REPLICA_SETTINGS_DIR } from '../../consts';
import {
    RemoteDocumentMergeConflictError,
    VirtualFileSystem,
} from '../../core/remoteFileSystemProvider';
import { LocalReplicaSCMProvider } from '../../scm/localReplicaSCM';
import { Events } from '../../utils/eventBus';
import * as localReplicaWorkspace from '../../utils/localReplicaWorkspace';
import { setActiveReplicaRoot } from '../../utils/localReplicaWorkspace';

interface PersistRecord {
    enabled: boolean;
    label: string;
    baseUri: string;
    settings: JSON;
}

class FakeVirtualFileSystem {
    public readonly origin: vscode.Uri;
    public readonly projectName = 'Audit Fix Test';
    public readonly serverName = 'test-server';
    public readonly _userId = 'test-user';
    public readonly projectId = 'test-project';
    public readonly connectionState = 'connected';
    private readonly connectionEmitter = new vscode.EventEmitter<string>();
    public readonly onDidChangeConnection = this.connectionEmitter.event;
    private readonly persists = new Map<string, PersistRecord>();

    constructor(
        private readonly remoteRoot: vscode.Uri,
        origin: vscode.Uri = remoteRoot,
    ) {
        this.origin = origin;
    }

    pathToUri(...parts: string[]) {
        const segments = parts.flatMap(part => part.split('/').filter(Boolean));
        return vscode.Uri.joinPath(this.remoteRoot, ...segments);
    }

    async _resolveUri(uri: vscode.Uri) {
        const relativePath = path.relative(this.remoteRoot.fsPath, uri.fsPath).split(path.sep).join('/');
        const relPath = '/' + relativePath.split('/').filter(Boolean).join('/');
        const fileName = path.basename(uri.fsPath);
        // Mirrors Overleaf: .tex entities are `doc`, everything else is `file`.
        const fileType = /\.tex$/i.test(fileName) ? 'doc' : 'file';
        return {
            fileName,
            fileType,
            fileEntity: {
                _id: relPath,
                name: fileName,
                _type: fileType,
                linkedFileData: null,
                created: new Date(0).toISOString(),
            },
        };
    }

    async ensureConnectedForWrite() {}

    async writeFileFromRemoteBaseline(
        uri: vscode.Uri,
        content: Uint8Array,
        _remoteBaseline?: Uint8Array,
        expectedRemoteMissing = false,
    ) {
        if (expectedRemoteMissing && await pathExists(uri)) {
            const remoteContent = await vscode.workspace.fs.readFile(uri);
            if (Buffer.compare(Buffer.from(remoteContent), Buffer.from(content))===0) {
                return content;
            }
            throw new RemoteDocumentMergeConflictError(
                `Overleaf path appeared while the local file was being created: ${uri.path}`,
            );
        }
        await vscode.workspace.fs.writeFile(uri, content);
        return content;
    }

    async createDirectoryIfMissing(uri: vscode.Uri) {
        if (await pathExists(uri)) {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type===vscode.FileType.Directory) { return; }
            throw new RemoteDocumentMergeConflictError(
                `Overleaf path has a different type while the local folder was being created: ${uri.path}`,
            );
        }
        await vscode.workspace.fs.createDirectory(uri);
    }

    async reconnect() {
        return {} as any;
    }

    getProjectSCMPersist(key: string): PersistRecord {
        return this.persists.get(key) ?? {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: key,
            settings: {} as JSON,
        };
    }

    setProjectSCMPersist(key: string, persist?: PersistRecord) {
        if (persist===undefined) {
            this.persists.delete(key);
        } else {
            this.persists.set(key, persist);
        }
    }

    hasProjectSCMPersist(key: string) {
        return this.persists.has(key);
    }
}

async function tempDir(prefix: string) {
    return vscode.Uri.file(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function removeUri(uri: vscode.Uri) {
    await fs.rm(uri.fsPath, {recursive: true, force: true});
}

async function writeBytes(uri: vscode.Uri, content: Uint8Array) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, content);
}

async function writeText(uri: vscode.Uri, content: string) {
    await writeBytes(uri, Buffer.from(content, 'utf-8'));
}

async function readText(uri: vscode.Uri) {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
}

async function pathExists(uri: vscode.Uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000) {
    const deadline = Date.now()+timeoutMs;
    while (!predicate()) {
        if (Date.now()>=deadline) {
            throw new Error('Timed out waiting for test condition');
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function listenSilently(port: number) {
    const server = net.createServer(socket => {
        // Accept and never reply: the ambiguous handshake case.
        socket.on('error', () => undefined);
    });
    server.unref();
    return new Promise<net.Server>((resolve, reject) => {
        server.once('error', reject);
        server.listen({host: '127.0.0.1', port, exclusive: true}, () => resolve(server));
    });
}

function closeServer(server: net.Server) {
    return new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

const createdSCMsForTest: LocalReplicaSCMProvider[] = [];

function createSCM(remoteRoot: vscode.Uri, localRoot: vscode.Uri, fakeVfs = new FakeVirtualFileSystem(remoteRoot)) {
    const scm = new LocalReplicaSCMProvider(fakeVfs as unknown as VirtualFileSystem, localRoot);
    createdSCMsForTest.push(scm);
    return scm;
}

suite('Local Replica sync audit fixes', function () {
    this.timeout(20000);

    const tempRoots: vscode.Uri[] = [];
    let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
    let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
    let originalCreateFileSystemWatcher: typeof vscode.workspace.createFileSystemWatcher;
    let originalWatcherProbeTimeoutMs: number;
    let originalWatcherHealthIntervalMs: number;
    let originalShouldUseDirectLocalWatcher: () => boolean;
    let originalNetworkInterfaces: typeof os.networkInterfaces;
    let originalOpen: typeof fs.open;
    let restoreLocalReplicaWorkspaceContext: vscode.Disposable;
    const localReplicaWorkspaceState = new Map<string, unknown>();
    const localReplicaWorkspaceSubscriptions: vscode.Disposable[] = [];
    const localReplicaWorkspaceMemento = {
        get<T>(key: string, defaultValue?: T): T | undefined {
            return localReplicaWorkspaceState.has(key)
                ? localReplicaWorkspaceState.get(key) as T
                : defaultValue;
        },
        async update(key: string, value: unknown) {
            if (value===undefined) {
                localReplicaWorkspaceState.delete(key);
            } else {
                localReplicaWorkspaceState.set(key, value);
            }
        },
        keys() {
            return [...localReplicaWorkspaceState.keys()];
        },
    } as vscode.Memento;

    setup(() => {
        localReplicaWorkspaceState.clear();
        restoreLocalReplicaWorkspaceContext = localReplicaWorkspace.configureLocalReplicaWorkspace({
            workspaceState: localReplicaWorkspaceMemento,
            subscriptions: localReplicaWorkspaceSubscriptions,
        } as unknown as vscode.ExtensionContext);
        originalShowWarningMessage = vscode.window.showWarningMessage;
        originalShowInformationMessage = vscode.window.showInformationMessage;
        originalCreateFileSystemWatcher = vscode.workspace.createFileSystemWatcher;
        originalWatcherProbeTimeoutMs = (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs;
        originalWatcherHealthIntervalMs = (LocalReplicaSCMProvider as any).watcherHealthIntervalMs;
        originalShouldUseDirectLocalWatcher = (LocalReplicaSCMProvider as any).shouldUseDirectLocalWatcher;
        originalNetworkInterfaces = os.networkInterfaces;
        originalOpen = fs.open;
        (LocalReplicaSCMProvider as any).shouldUseDirectLocalWatcher = () => false;
        (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs = 60_000;
        (LocalReplicaSCMProvider as any).watcherHealthIntervalMs = 60_000;
        (vscode.window as any).showWarningMessage = async () => undefined;
        (vscode.window as any).showInformationMessage = async () => undefined;
    });

    teardown(async () => {
        (vscode.window as any).showWarningMessage = originalShowWarningMessage;
        (vscode.window as any).showInformationMessage = originalShowInformationMessage;
        (vscode.workspace as any).createFileSystemWatcher = originalCreateFileSystemWatcher;
        (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs = originalWatcherProbeTimeoutMs;
        (LocalReplicaSCMProvider as any).watcherHealthIntervalMs = originalWatcherHealthIntervalMs;
        (LocalReplicaSCMProvider as any).shouldUseDirectLocalWatcher = originalShouldUseDirectLocalWatcher;
        (os as any).networkInterfaces = originalNetworkInterfaces;
        (fs as any).open = originalOpen;
        (LocalReplicaSCMProvider as any).syncOwnerHostIdPromise = undefined;
        await Promise.allSettled(
            createdSCMsForTest.splice(0).map(scm => scm.deactivate()),
        );
        await setActiveReplicaRoot(undefined);
        while (tempRoots.length>0) {
            await removeUri(tempRoots.pop()!);
        }
        for (const subscription of localReplicaWorkspaceSubscriptions.splice(0)) {
            subscription.dispose();
        }
        localReplicaWorkspaceState.clear();
        restoreLocalReplicaWorkspaceContext.dispose();
    });

    test('conflicts a remote delete that raced a local edit using only the manifest baseline', async () => {
        const remoteRoot = await tempDir('sr-audit-delete-manifest-remote-');
        const localRoot = await tempDir('sr-audit-delete-manifest-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'shared baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        assert.ok(internals.syncManifest.files['/main.tex'].baseContentBase64);

        // A restart keeps the manifest but not the in-memory base cache.
        delete internals.baseCache['/main.tex'];
        await writeText(localMain, 'unsaved chapter rewrite');
        await vscode.workspace.fs.delete(remoteMain);

        const event = await internals.applySync(
            'pull',
            'delete',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(event.error, 'concurrent remote delete and local edit');
        assert.strictEqual(await readText(localMain), 'unsaved chapter rewrite');
        assert.match(
            internals.syncConflicts.get('/main.tex'),
            /Overleaf deleted the file while the local saved copy was also edited/,
        );
    });

    test('conflicts a remote delete when no baseline can prove the local copy is unmodified', async () => {
        const remoteRoot = await tempDir('sr-audit-delete-nobase-remote-');
        const localRoot = await tempDir('sr-audit-delete-nobase-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        // Invalid UTF-8, so the manifest entry never carries a merge baseline.
        const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10]);
        await writeBytes(remoteImage, bytes);

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        assert.strictEqual(
            internals.syncManifest.files['/figure.png'].baseContentBase64,
            undefined,
        );

        delete internals.baseCache['/figure.png'];
        await vscode.workspace.fs.delete(remoteImage);

        const event = await internals.applySync(
            'pull',
            'delete',
            '/figure.png',
            remoteImage,
            localImage,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(event.error, 'missing remote delete baseline');
        assert.strictEqual(await pathExists(localImage), true);
        assert.match(
            internals.syncConflicts.get('/figure.png'),
            /no sync baseline is available/,
        );
    });

    test('holds a remote delete for a path that is already in conflict', async () => {
        const remoteRoot = await tempDir('sr-audit-delete-conflict-remote-');
        const localRoot = await tempDir('sr-audit-delete-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'shared baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        await writeText(localMain, 'reviewed local decision');
        await internals.markSyncConflict('/main.tex', 'held for review');
        await vscode.workspace.fs.delete(remoteMain);

        const event = await internals.applySync(
            'pull',
            'delete',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(event.error, 'unresolved sync conflict');
        assert.strictEqual(await readText(localMain), 'reviewed local decision');
        assert.ok(internals.syncConflicts.has('/main.tex'));
    });

    test('guards a non-media Overleaf file replacement by entity type, not extension', async () => {
        const remoteRoot = await tempDir('sr-audit-guarded-remote-');
        const localRoot = await tempDir('sr-audit-guarded-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteData = vscode.Uri.joinPath(remoteRoot, 'data.csv');
        const localData = vscode.Uri.joinPath(localRoot, 'data.csv');
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteData, 'id,value\n1,a\n');
        await writeText(remoteMain, 'remote baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        assert.strictEqual(
            await internals.remoteEntityNeedsGuardedReplace('/data.csv', remoteData),
            true,
        );
        assert.strictEqual(
            await internals.remoteEntityNeedsGuardedReplace('/main.tex', remoteMain),
            false,
        );
        assert.strictEqual(internals.isLikelyBinaryRelPath('/data.csv'), false);

        const originalGuardedReplace = internals.guardedReplaceRemoteBinary.bind(scm);
        const guardedPaths: string[] = [];
        internals.guardedReplaceRemoteBinary = async (...args: unknown[]) => {
            guardedPaths.push(args[0] as string);
            return originalGuardedReplace(...args);
        };
        try {
            await writeText(localData, 'id,value\n1,b\n');
            const dataPush = await internals.applySync(
                'push',
                'update',
                '/data.csv',
                localData,
                remoteData,
            ) as Events['scmSyncCompleteEvent'];
            assert.strictEqual(dataPush.outcome, 'success');
            assert.strictEqual(await readText(remoteData), 'id,value\n1,b\n');

            await writeText(localMain, 'local revision');
            const texPush = await internals.applySync(
                'push',
                'update',
                '/main.tex',
                localMain,
                remoteMain,
            ) as Events['scmSyncCompleteEvent'];
            assert.strictEqual(texPush.outcome, 'success');

            assert.deepStrictEqual(guardedPaths, ['/data.csv']);
        } finally {
            internals.guardedReplaceRemoteBinary = originalGuardedReplace;
        }
    });

    test('keeps scanning local paths after one refuses to be classified', async () => {
        const remoteRoot = await tempDir('sr-audit-scan-remote-');
        const localRoot = await tempDir('sr-audit-scan-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'refs.bib'), '@book{a}\n');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        const generation = internals.syncGeneration;
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const localRefs = vscode.Uri.joinPath(localRoot, 'refs.bib');
        await writeText(localMain, 'closed-file agent edit');

        const originalNeedsPush = internals.localTargetNeedsPush.bind(scm);
        internals.localTargetNeedsPush = async (relPath: string, uri: vscode.Uri) => {
            if (relPath==='/refs.bib') {
                throw new Error('Local Replica classification refuses symbolic links: refs.bib');
            }
            return originalNeedsPush(relPath, uri);
        };
        try {
            const changed = await internals.replayBufferedLocalEvents(
                [
                    {uri: localRefs, type: 'update'},
                    {uri: localMain, type: 'update'},
                ],
                generation,
            ) as number;

            assert.strictEqual(changed, 1);
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')),
                'closed-file agent edit',
            );
            assert.ok(internals.unscannableLocalPaths.has('/refs.bib'));
            assert.ok(internals.locallyDivergedPaths.has('/refs.bib'));
        } finally {
            internals.localTargetNeedsPush = originalNeedsPush;
        }
    });

    test('keeps an unresolved descendant conflict when its parent conflict is cleared', async () => {
        const remoteRoot = await tempDir('sr-audit-descendant-remote-');
        const localRoot = await tempDir('sr-audit-descendant-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.tex'), 'remote plot');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        const localPlot = vscode.Uri.joinPath(localRoot, 'figures', 'plot.tex');
        // The descendant is genuinely unresolved: both sides still differ.
        await writeText(localPlot, 'local plot');

        await internals.markSyncConflict('/figures', 'folder held for review');
        await internals.markSyncConflict('/figures/plot.tex', 'file held for review');

        await internals.clearSyncConflict('/figures');

        assert.strictEqual(internals.syncConflicts.has('/figures'), false);
        assert.strictEqual(internals.syncConflicts.has('/figures/plot.tex'), true);
        assert.ok(internals.syncManifest.conflicts['/figures/plot.tex']);
        assert.strictEqual(internals.touchesSyncConflict('/figures/plot.tex'), true);
    });

    test('fsyncs the content stage before installing a pulled local file', async () => {
        const remoteRoot = await tempDir('sr-audit-fsync-remote-');
        const localRoot = await tempDir('sr-audit-fsync-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        const generation = internals.syncGeneration;

        const syncedPaths: string[] = [];
        const wrappedOpen = async (...args: unknown[]) => {
            const handle = await (originalOpen as any)(...args);
            const target = String(args[0]);
            const handleSync = handle.sync.bind(handle);
            handle.sync = async () => {
                syncedPaths.push(target);
                return handleSync();
            };
            return handle;
        };
        (fs as any).open = wrappedOpen;
        assert.strictEqual(fs.open, wrappedOpen, 'fs/promises.open must be patchable');
        try {
            const current = await internals.captureLocalPathRevision('/main.tex', generation);
            const wrote = await internals.writeLocalFileIfRevision(
                '/main.tex',
                Buffer.from('pulled collaborator revision', 'utf-8'),
                current.revision,
                generation,
            ) as boolean;
            assert.strictEqual(wrote, true);
        } finally {
            (fs as any).open = originalOpen;
        }

        assert.strictEqual(
            await readText(vscode.Uri.joinPath(localRoot, 'main.tex')),
            'pulled collaborator revision',
        );
        assert.ok(
            syncedPaths.some(target => {
                const name = path.basename(target);
                return name.startsWith('.sr-overleaf-') && name.endsWith('.new');
            }),
            `content stage was never fsynced: ${syncedPaths.join(', ')}`,
        );
    });

    test('surfaces a sync intent that fails outside applySync', async () => {
        const remoteRoot = await tempDir('sr-audit-enqueue-remote-');
        const localRoot = await tempDir('sr-audit-enqueue-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        let warned = 0;
        (vscode.window as any).showWarningMessage = async () => {
            warned += 1;
            return undefined;
        };

        const result = await internals.enqueueSync(
            '/main.tex',
            async () => {
                throw new Error('injected VFS Unavailable during reconnect');
            },
            internals.syncGeneration,
        );

        assert.strictEqual(result, undefined);
        assert.ok(internals.locallyDivergedPaths.has('/main.tex'));
        assert.strictEqual(warned, 1);
    });

    test('retries and surfaces a conflict that cannot be recorded on disk', async () => {
        const remoteRoot = await tempDir('sr-audit-persist-remote-');
        const localRoot = await tempDir('sr-audit-persist-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        const originalPersist = internals.persistSyncManifest.bind(scm);
        let attempts = 0;
        internals.persistSyncManifest = async (...args: unknown[]) => {
            attempts += 1;
            if (attempts===1) {
                throw new Error('EROFS: read-only file system');
            }
            return originalPersist(...args);
        };
        try {
            await internals.markSyncConflict('/main.tex', 'transient persist failure');
            assert.strictEqual(attempts, 2);
            assert.ok(internals.syncManifest.conflicts['/main.tex']);
        } finally {
            internals.persistSyncManifest = originalPersist;
        }

        let warned = 0;
        (vscode.window as any).showWarningMessage = async () => {
            warned += 1;
            return undefined;
        };
        internals.persistSyncManifest = async () => {
            throw new Error('ENOSPC: no space left on device');
        };
        try {
            await assert.rejects(
                () => internals.markSyncConflict('/main.tex', 'persistent persist failure'),
                /ENOSPC/,
            );
            assert.ok(warned>0);
        } finally {
            internals.persistSyncManifest = originalPersist;
        }
    });

    test('probes local watcher health inside the replica tree', async () => {
        const remoteRoot = await tempDir('sr-audit-probe-remote-');
        const localRoot = await tempDir('sr-audit-probe-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs = 60;

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        const probing = internals.verifyLocalWatcherHealth(
            internals.syncGeneration,
        ) as Promise<boolean>;
        await waitUntil(() => Boolean(internals.localWatcherProbe));
        const probeUri = vscode.Uri.parse(internals.localWatcherProbe.uri);
        await probing;

        assert.strictEqual(path.dirname(probeUri.fsPath), localRoot.fsPath);
        assert.notStrictEqual(
            path.dirname(probeUri.fsPath),
            path.join(localRoot.fsPath, REPLICA_SETTINGS_DIR),
        );
        const relPath = '/' + path.basename(probeUri.fsPath);
        assert.strictEqual(internals.matchIgnorePatterns(relPath), true);
        assert.strictEqual(await pathExists(probeUri), false);
    });

    test('derives the sync owner host id from stable identity only', async () => {
        const stableInterfaces = {
            lo: [{
                address: '127.0.0.1',
                netmask: '255.0.0.0',
                family: 'IPv4' as const,
                mac: '00:00:00:00:00:00',
                internal: true,
                cidr: '127.0.0.1/8',
            }],
            eth0: [{
                address: '10.0.0.5',
                netmask: '255.255.255.0',
                family: 'IPv4' as const,
                mac: 'aa:bb:cc:dd:ee:ff',
                internal: false,
                cidr: '10.0.0.5/24',
            }],
        };
        const dockerAdded = {
            ...stableInterfaces,
            docker0: [{
                address: '172.17.0.1',
                netmask: '255.255.0.0',
                family: 'IPv4' as const,
                mac: '02:42:9a:1b:2c:3d',
                internal: false,
                cidr: '172.17.0.1/16',
            }],
        };

        (os as any).networkInterfaces = () => stableInterfaces;
        (LocalReplicaSCMProvider as any).syncOwnerHostIdPromise = undefined;
        const before = await (LocalReplicaSCMProvider as any).getSyncOwnerHostId() as string;

        (os as any).networkInterfaces = () => dockerAdded;
        (LocalReplicaSCMProvider as any).syncOwnerHostIdPromise = undefined;
        const after = await (LocalReplicaSCMProvider as any).getSyncOwnerHostId() as string;

        assert.match(before, /^[a-f0-9]{64}$/);
        assert.strictEqual(after, before);
    });

    test('treats an unidentifiable ownership peer as possibly live', async () => {
        const remoteRoot = await tempDir('sr-audit-probe-closed-remote-');
        const localRoot = await tempDir('sr-audit-probe-closed-local-');
        tempRoots.push(remoteRoot, localRoot);
        const scm = createSCM(remoteRoot, localRoot);
        const rootKey = await (scm as any).syncOwnerRootKey() as string;
        const port = (scm as any).syncOwnerPorts(rootKey)[0] as number;

        const freeProbe = await (LocalReplicaSCMProvider as any).probeSyncOwner(port);
        assert.deepStrictEqual(freeProbe, {kind: 'unrelated'});

        const chatty = net.createServer(socket => socket.end('unrelated service'));
        chatty.unref();
        await new Promise<void>((resolve, reject) => {
            chatty.once('error', reject);
            chatty.listen({host: '127.0.0.1', port, exclusive: true}, resolve);
        });
        try {
            const chattyProbe = await (LocalReplicaSCMProvider as any).probeSyncOwner(port);
            assert.deepStrictEqual(chattyProbe, {kind: 'unrelated'});
        } finally {
            await closeServer(chatty);
        }

        const silent = await listenSilently(port);
        try {
            const silentProbe = await (LocalReplicaSCMProvider as any).probeSyncOwner(port);
            assert.strictEqual(silentProbe.kind, 'ambiguous');
        } finally {
            await closeServer(silent);
        }
    });

    test('refuses activation when a silent peer holds the recorded ownership port', async () => {
        const remoteRoot = await tempDir('sr-audit-silent-owner-remote-');
        const localRoot = await tempDir('sr-audit-silent-owner-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const contender = createSCM(remoteRoot, localRoot);
        const rootKey = await (contender as any).syncOwnerRootKey() as string;
        const hostId = await (contender as any).syncOwnerHostId() as string;
        const port = (contender as any).syncOwnerPorts(rootKey)[0] as number;
        const ownerFile = vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR, 'sync-owner.json');
        await writeText(ownerFile, JSON.stringify({
            version: 4,
            token: 'a123456789abcdef0123456789abcdef',
            pid: process.pid,
            hostname: os.hostname(),
            hostId,
            projectKey: remoteRoot.toString(),
            rootKey,
            port,
            createdAt: new Date().toISOString(),
        }));

        const silent = await listenSilently(port);
        try {
            await assert.rejects(
                () => contender.triggers,
                /did not identify itself/i,
            );
            assert.strictEqual(await pathExists(ownerFile), true);
        } finally {
            await closeServer(silent);
        }
    });

    test('repairs an abandoned ownership marker whose pid was reused', async () => {
        const remoteRoot = await tempDir('sr-audit-repair-remote-');
        const localRoot = await tempDir('sr-audit-repair-local-');
        tempRoots.push(remoteRoot, localRoot);
        const scm = createSCM(remoteRoot, localRoot);
        const rootKey = await (scm as any).syncOwnerRootKey() as string;
        const hostId = await (scm as any).syncOwnerHostId() as string;
        const port = (scm as any).syncOwnerPorts(rootKey)[0] as number;
        const ownerFile = vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR, 'sync-owner.json');
        const ownerRecord = {
            version: 4,
            token: 'b123456789abcdef0123456789abcdef',
            // This pid is alive, so process.kill alone would call it a live owner
            // forever; only the released ownership port proves otherwise.
            pid: process.pid,
            hostname: os.hostname(),
            hostId,
            projectKey: remoteRoot.toString(),
            rootKey,
            port,
            createdAt: new Date().toISOString(),
        };
        await writeText(ownerFile, JSON.stringify(ownerRecord));
        (vscode.window as any).showWarningMessage = async (
            _message: string,
            _options: unknown,
            ...items: string[]
        ) => items[0];

        const live = net.createServer(socket => socket.end(JSON.stringify(ownerRecord)));
        live.unref();
        await new Promise<void>((resolve, reject) => {
            live.once('error', reject);
            live.listen({host: '127.0.0.1', port, exclusive: true}, resolve);
        });
        try {
            await assert.rejects(
                () => LocalReplicaSCMProvider.repairOwnershipMarker(localRoot),
                /may belong to a live owner/i,
            );
            assert.strictEqual(await pathExists(ownerFile), true);
        } finally {
            await closeServer(live);
        }

        assert.strictEqual(
            await LocalReplicaSCMProvider.repairOwnershipMarker(localRoot),
            true,
        );
        assert.strictEqual(await pathExists(ownerFile), false);
    });

    test('aborts a sync session disposed while ownership was being acquired', async () => {
        const remoteRoot = await tempDir('sr-audit-session-remote-');
        const localRoot = await tempDir('sr-audit-session-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        const internals = scm as any;

        const originalAcquire = internals.acquireSyncOwnership.bind(scm);
        internals.acquireSyncOwnership = async () => {
            await originalAcquire();
            // The user switched away while the ports were being probed.
            internals.deactivateSyncSession(undefined, false);
        };
        try {
            await assert.rejects(
                () => internals.beginSyncSession(),
                /disposed while ownership was being acquired/i,
            );
            assert.strictEqual(internals.syncSessionActive, false);
        } finally {
            internals.acquireSyncOwnership = originalAcquire;
        }
    });

    test('keeps an ownership marker whose port answers for this root', async () => {
        const remoteRoot = await tempDir('sr-audit-live-owner-remote-');
        const localRoot = await tempDir('sr-audit-live-owner-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const contender = createSCM(remoteRoot, localRoot);
        const rootKey = await (contender as any).syncOwnerRootKey() as string;
        const hostId = await (contender as any).syncOwnerHostId() as string;
        const ports = (contender as any).syncOwnerPorts(rootKey) as number[];
        const ownerRecord = {
            version: 4,
            token: 'c123456789abcdef0123456789abcdef',
            pid: 2_147_483_647,
            hostname: os.hostname(),
            hostId,
            projectKey: remoteRoot.toString(),
            rootKey,
            port: ports[0],
            createdAt: new Date().toISOString(),
        };
        const ownerFile = vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR, 'sync-owner.json');
        await writeText(ownerFile, JSON.stringify(ownerRecord));

        const live = net.createServer(socket => socket.end(JSON.stringify(ownerRecord)));
        live.unref();
        await new Promise<void>((resolve, reject) => {
            live.once('error', reject);
            live.listen({host: '127.0.0.1', port: ports[0], exclusive: true}, resolve);
        });
        try {
            await assert.rejects(
                () => contender.triggers,
                /already active/i,
            );
            assert.strictEqual(
                JSON.parse(await readText(ownerFile)).token,
                ownerRecord.token,
            );
        } finally {
            await closeServer(live);
        }
    });
});
