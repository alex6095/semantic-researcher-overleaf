import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClientManager } from '../../collaboration/clientManager';
import { REPLICA_SETTINGS_DIR, REPLICA_SETTINGS_FILE, STATE_SERVERS_KEY } from '../../consts';
import { VirtualFileSystem } from '../../core/remoteFileSystemProvider';
import { LocalReplicaOwnershipUnavailableError, LocalReplicaSCMProvider } from '../../scm/localReplicaSCM';
import { SCMCollectionProvider } from '../../scm/scmCollectionProvider';
import { getActiveReplicaRoot, setActiveReplicaRoot } from '../../utils/localReplicaWorkspace';
import * as localReplicaWorkspace from '../../utils/localReplicaWorkspace';

// The packaging assertions live in a plain Node script, so they are exercised
// through `require` instead of an extension-host API.
const packageRuntime = require(
    path.join(__dirname, '..', '..', '..', 'scripts', 'prepare-package-runtime.js'),
) as {
    contributedLanguageConfigurations: () => string[];
    resolveStagedRuntime: (runtimeRequire: {resolve: (request: string) => string}, request: string) => string;
    verifyStagedSocketRuntime: (socketRuntimeRoot: string) => void;
    verifyVendorAssets: (options?: {roots?: string[], files?: string[]}) => {files: number, bytes: number};
};

interface PersistRecord {
    enabled: boolean;
    label: string;
    baseUri: string;
    settings: JSON;
}

class MinimalVirtualFileSystem {
    public readonly projectName = 'Audit Fix Test';
    public readonly serverName = 'test-server';
    public readonly _userId = 'test-user';
    public readonly projectId = 'test-project';
    private readonly persists = new Map<string, PersistRecord>();

    constructor(public readonly origin: vscode.Uri) {}

    pathToUri(...parts: string[]) {
        const segments = parts.flatMap(part => part.split('/').filter(Boolean));
        return vscode.Uri.joinPath(this.origin, ...segments);
    }

    getProjectSCMPersist(key: string) {
        return this.persists.get(key) as PersistRecord;
    }

    setProjectSCMPersist(key: string, persist: PersistRecord | undefined) {
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

function createExtensionContextStub(initialSCMs: Record<string, PersistRecord> = {}): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    const serverName = 'test-server';
    state.set(STATE_SERVERS_KEY, {
        [serverName]: {
            name: serverName,
            url: 'https://example.test',
            login: {
                userId: 'test-user',
                username: 'test-user',
                identity: {} as any,
                projects: [{
                    id: 'test-project',
                    name: 'Audit Fix Test',
                    scm: initialSCMs,
                }],
            },
        },
    });
    return {
        globalState: {
            get: <T>(key: string, defaultValue?: T) => state.has(key) ? state.get(key) as T : defaultValue as T,
            update: async (key: string, value: unknown) => {
                if (value===undefined) {
                    state.delete(key);
                } else {
                    state.set(key, value);
                }
            },
        },
    } as unknown as vscode.ExtensionContext;
}

async function tempDir(prefix: string) {
    return vscode.Uri.file(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function removeUri(uri: vscode.Uri) {
    await fs.rm(uri.fsPath, {recursive: true, force: true});
}

async function writeText(uri: vscode.Uri, content: string) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
}

async function readText(uri: vscode.Uri) {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
}

function settingsUri(root: vscode.Uri) {
    return vscode.Uri.joinPath(root, REPLICA_SETTINGS_FILE);
}

async function writeReplicaSettings(root: vscode.Uri, projectUri: vscode.Uri) {
    await writeText(settingsUri(root), JSON.stringify({
        uri: projectUri.toString(),
        serverName: 'test-server',
        enableCompileNPreview: true,
        projectName: 'Audit Fix Test',
    }));
}

function setWorkspaceFoldersForTest(...roots: vscode.Uri[]) {
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        configurable: true,
        value: roots.map((uri, index) => ({
            uri,
            name: path.basename(uri.fsPath),
            index,
        })),
    });
}

suite('Audited Local Replica fix lifecycle', () => {
    const tempRoots: vscode.Uri[] = [];
    let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
    let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
    let originalShowErrorMessage: typeof vscode.window.showErrorMessage;
    let originalUpdateWorkspaceFolders: typeof vscode.workspace.updateWorkspaceFolders;
    let originalWorkspaceFoldersDescriptor: PropertyDescriptor | undefined;
    let originalVisibleTextEditorsDescriptor: PropertyDescriptor | undefined;
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
        originalShowErrorMessage = vscode.window.showErrorMessage;
        originalUpdateWorkspaceFolders = vscode.workspace.updateWorkspaceFolders;
        originalWorkspaceFoldersDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
        originalVisibleTextEditorsDescriptor = Object.getOwnPropertyDescriptor(vscode.window, 'visibleTextEditors');
    });

    teardown(async () => {
        (vscode.window as any).showWarningMessage = originalShowWarningMessage;
        (vscode.window as any).showInformationMessage = originalShowInformationMessage;
        (vscode.window as any).showErrorMessage = originalShowErrorMessage;
        (vscode.workspace as any).updateWorkspaceFolders = originalUpdateWorkspaceFolders;
        await setActiveReplicaRoot(undefined);
        if (originalWorkspaceFoldersDescriptor) {
            Object.defineProperty(vscode.workspace, 'workspaceFolders', originalWorkspaceFoldersDescriptor);
        }
        if (originalVisibleTextEditorsDescriptor) {
            Object.defineProperty(vscode.window, 'visibleTextEditors', originalVisibleTextEditorsDescriptor);
        }
        while (tempRoots.length>0) {
            await removeUri(tempRoots.pop()!);
        }
        for (const subscription of localReplicaWorkspaceSubscriptions.splice(0)) {
            subscription.dispose();
        }
        localReplicaWorkspaceState.clear();
        restoreLocalReplicaWorkspaceContext.dispose();
    });

    // ---------------------------------------------------------------- part 1

    test('creates a new Local Replica in an empty folder without prompting', async () => {
        const localRoot = await tempDir('sr-overleaf-audit-empty-');
        tempRoots.push(localRoot);
        const collection = Object.create(SCMCollectionProvider.prototype) as any;
        collection.isSameProjectLocalReplica = async () => false;
        let prompted = false;
        (vscode.window as any).showWarningMessage = async () => {
            prompted = true;
            return undefined;
        };

        const plan = await collection.resolveNewLocalReplicaPlan(localRoot);

        assert.strictEqual(prompted, false);
        assert.strictEqual(plan.options.preserveExistingLocalFiles, false);
        assert.strictEqual(plan.options.resetLocalFilesToRemote, true);
        assert.strictEqual(plan.backupEntryNames, undefined);
    });

    test('asks before replacing a non-empty folder and counts only files a reset would delete', async () => {
        const localRoot = await tempDir('sr-overleaf-audit-nonempty-');
        tempRoots.push(localRoot);
        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'in-progress manuscript');
        await writeText(vscode.Uri.joinPath(localRoot, 'chapters', 'one.tex'), 'chapter one');
        await writeText(vscode.Uri.joinPath(localRoot, 'AGENTS.md'), 'agent instructions');
        await writeText(vscode.Uri.joinPath(localRoot, '.hidden', 'note.txt'), 'kept');
        const collection = Object.create(SCMCollectionProvider.prototype) as any;
        collection.isSameProjectLocalReplica = async () => false;
        let message = '';
        let detail = '';
        let offered: string[] = [];
        (vscode.window as any).showWarningMessage = async (
            shownMessage: string,
            options: {modal?: boolean, detail?: string},
            ...items: string[]
        ) => {
            message = shownMessage;
            detail = options.detail ?? '';
            offered = items;
            assert.strictEqual(options.modal, true);
            return items[0];
        };

        const plan = await collection.resolveNewLocalReplicaPlan(localRoot);

        assert.match(message, /2 file\(s\)/);
        assert.match(detail, /Replace with Overleaf copy/);
        assert.match(detail, /Keep local files and merge/);
        assert.deepStrictEqual(offered, [
            vscode.l10n.t('Replace with Overleaf copy'),
            vscode.l10n.t('Keep local files and merge'),
        ]);
        assert.strictEqual(plan.options.preserveExistingLocalFiles, false);
        assert.strictEqual(plan.options.resetLocalFilesToRemote, true);
        assert.deepStrictEqual([...plan.backupEntryNames].sort(), ['chapters', 'main.tex']);
    });

    test('keeps and merges local files when the user declines the Overleaf copy', async () => {
        const localRoot = await tempDir('sr-overleaf-audit-merge-');
        tempRoots.push(localRoot);
        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'in-progress manuscript');
        const collection = Object.create(SCMCollectionProvider.prototype) as any;
        collection.isSameProjectLocalReplica = async () => false;
        (vscode.window as any).showWarningMessage = async (
            _message: string,
            _options: unknown,
            ...items: string[]
        ) => items[1];

        const plan = await collection.resolveNewLocalReplicaPlan(localRoot);

        assert.strictEqual(plan.options.preserveExistingLocalFiles, true);
        assert.strictEqual(plan.options.resetLocalFilesToRemote, false);
        assert.strictEqual(plan.backupEntryNames, undefined);
    });

    test('creates nothing when the non-empty folder warning is cancelled', async () => {
        const localRoot = await tempDir('sr-overleaf-audit-cancel-');
        tempRoots.push(localRoot);
        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'in-progress manuscript');
        const collection = Object.create(SCMCollectionProvider.prototype) as any;
        collection.isSameProjectLocalReplica = async () => false;
        (vscode.window as any).showWarningMessage = async () => undefined;

        assert.strictEqual(await collection.resolveNewLocalReplicaPlan(localRoot), undefined);
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'in-progress manuscript');
    });

    test('keeps an explicit caller choice and re-attaches this project without prompting', async () => {
        const localRoot = await tempDir('sr-overleaf-audit-explicit-');
        tempRoots.push(localRoot);
        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'in-progress manuscript');
        const collection = Object.create(SCMCollectionProvider.prototype) as any;
        let prompted = false;
        (vscode.window as any).showWarningMessage = async () => {
            prompted = true;
            return undefined;
        };

        collection.isSameProjectLocalReplica = async () => false;
        const explicit = await collection.resolveNewLocalReplicaPlan(localRoot, {
            preserveExistingLocalFiles: true,
        });
        assert.strictEqual(explicit.options.preserveExistingLocalFiles, true);
        assert.strictEqual(explicit.options.resetLocalFilesToRemote, undefined);

        collection.isSameProjectLocalReplica = async () => true;
        const reattached = await collection.resolveNewLocalReplicaPlan(localRoot);
        assert.strictEqual(reattached.options.preserveExistingLocalFiles, true);
        assert.strictEqual(reattached.options.resetLocalFilesToRemote, false);

        assert.strictEqual(prompted, false);
    });

    test('moves replaced local files into the replica backup folder instead of deleting them', async () => {
        const localRoot = await tempDir('sr-overleaf-audit-backup-');
        tempRoots.push(localRoot);
        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'in-progress manuscript');
        await writeText(vscode.Uri.joinPath(localRoot, 'chapters', 'one.tex'), 'chapter one');
        await writeText(vscode.Uri.joinPath(localRoot, 'AGENTS.md'), 'agent instructions');
        const collection = Object.create(SCMCollectionProvider.prototype) as any;
        const backupUri = collection.replaceableLocalFilesBackupUri(localRoot);

        await collection.backupReplaceableLocalFiles(localRoot, backupUri, ['chapters', 'main.tex']);

        assert.ok(backupUri.path.startsWith(`${localRoot.path}/${REPLICA_SETTINGS_DIR}/`));
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(backupUri, 'main.tex')),
            'in-progress manuscript',
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(backupUri, 'chapters', 'one.tex')),
            'chapter one',
        );
        // Entries a remote-authoritative reset preserves stay in place.
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(localRoot, 'AGENTS.md')),
            'agent instructions',
        );
        const remaining = (await vscode.workspace.fs.readDirectory(localRoot))
            .map(([name]) => name)
            .sort();
        assert.deepStrictEqual(remaining, [REPLICA_SETTINGS_DIR, 'AGENTS.md'].sort());
    });

    // ------------------------------------------------------ auto-discovery

    test('asks once before attaching an auto-discovered Local Replica and never adds a folder', async () => {
        const remoteRoot = await tempDir('sr-overleaf-audit-discover-remote-');
        const localRoot = await tempDir('sr-overleaf-audit-discover-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeReplicaSettings(localRoot, remoteRoot);
        setWorkspaceFoldersForTest(localRoot);
        let prompts = 0;
        let addedWorkspaceFolders = 0;
        (vscode.workspace as any).updateWorkspaceFolders = () => {
            addedWorkspaceFolders += 1;
            return true;
        };
        (vscode.window as any).showInformationMessage = async (_message: string, ...items: string[]) => {
            prompts += 1;
            return items[1];
        };

        await localReplicaWorkspace.initializeLocalReplicaWorkspace();
        assert.strictEqual(prompts, 1);
        assert.strictEqual(getActiveReplicaRoot(), undefined);

        // Remembered per root: a reload must not ask again.
        await localReplicaWorkspace.initializeLocalReplicaWorkspace();
        assert.strictEqual(prompts, 1);
        assert.strictEqual(getActiveReplicaRoot(), undefined);
        assert.strictEqual(addedWorkspaceFolders, 0);
    });

    test('attaches an auto-discovered Local Replica only after consent and restores it silently', async () => {
        const remoteRoot = await tempDir('sr-overleaf-audit-consent-remote-');
        const localRoot = await tempDir('sr-overleaf-audit-consent-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeReplicaSettings(localRoot, remoteRoot);
        setWorkspaceFoldersForTest(localRoot);
        let prompts = 0;
        let addedWorkspaceFolders = 0;
        (vscode.workspace as any).updateWorkspaceFolders = () => {
            addedWorkspaceFolders += 1;
            return true;
        };
        (vscode.window as any).showInformationMessage = async (_message: string, ...items: string[]) => {
            prompts += 1;
            return items[0];
        };

        await localReplicaWorkspace.initializeLocalReplicaWorkspace();
        assert.strictEqual(prompts, 1);
        assert.strictEqual(getActiveReplicaRoot()?.toString(), localRoot.toString());

        await localReplicaWorkspace.initializeLocalReplicaWorkspace();
        assert.strictEqual(prompts, 1);
        assert.strictEqual(getActiveReplicaRoot()?.toString(), localRoot.toString());
        assert.strictEqual(addedWorkspaceFolders, 0);
    });

    // ----------------------------------------------------------- ownership

    test('stops retrying a lost ownership race unattended and asks before taking over', async () => {
        const localRoot = await tempDir('sr-overleaf-audit-ownership-');
        tempRoots.push(localRoot);
        const scm = Object.create(LocalReplicaSCMProvider.prototype) as LocalReplicaSCMProvider;
        (scm as any).baseUri = localRoot;
        const item = {scm, enabled: true, triggers: [] as vscode.Disposable[]};
        const collection = Object.create(SCMCollectionProvider.prototype) as any;
        collection.disposed = false;
        collection.scms = [item];
        collection.ownershipRetryTimers = new Map<LocalReplicaSCMProvider, NodeJS.Timeout>();
        collection.ownershipRetryAttempts = new Map<LocalReplicaSCMProvider, number>();
        collection.ownershipTakeoverPrompts = new Set<LocalReplicaSCMProvider>();
        const limit = (SCMCollectionProvider as any).unattendedOwnershipRetryLimit as number;
        let takeoverPrompts = 0;
        (vscode.window as any).showWarningMessage = async (message: string) => {
            takeoverPrompts += 1;
            assert.match(message, /being synced by another window/);
            return undefined;
        };

        try {
            // The hand-off grace period retries silently.
            for (let attempt = 0; attempt<limit; attempt++) {
                collection.scheduleOwnershipRetry(item);
                assert.strictEqual(collection.ownershipRetryTimers.has(scm), true);
                assert.strictEqual(collection.ownershipRetryAttempts.get(scm), attempt+1);
                assert.strictEqual(takeoverPrompts, 0);
                clearTimeout(collection.ownershipRetryTimers.get(scm));
                collection.ownershipRetryTimers.delete(scm);
            }

            // Past the grace period the takeover becomes a user decision.
            collection.scheduleOwnershipRetry(item);
            assert.strictEqual(takeoverPrompts, 1);
            assert.strictEqual(collection.ownershipRetryTimers.has(scm), false);
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(collection.ownershipRetryTimers.has(scm), false);
            assert.strictEqual(collection.ownershipTakeoverPrompts.size, 0);

            // Accepting the prompt resumes the retry with a fresh budget.
            collection.scheduleOwnershipRetry(item, {attended: true});
            assert.strictEqual(collection.ownershipRetryTimers.has(scm), true);
            assert.strictEqual(collection.ownershipRetryAttempts.get(scm), 1);
        } finally {
            for (const timer of collection.ownershipRetryTimers.values()) {
                clearTimeout(timer as NodeJS.Timeout);
            }
            collection.ownershipRetryTimers.clear();
        }
    });

    // ------------------------------------------------- duplicate mappings

    test('keeps a duplicate mapping another window owns and still creates the selected replica', async () => {
        const remoteRoot = await tempDir('sr-overleaf-audit-dup-remote-');
        const localRootA = await tempDir('sr-overleaf-audit-dup-a-');
        const localRootB = await tempDir('sr-overleaf-audit-dup-b-');
        tempRoots.push(remoteRoot, localRootA, localRootB);
        await writeReplicaSettings(localRootA, remoteRoot);
        await writeReplicaSettings(localRootB, remoteRoot);
        const persistA: PersistRecord = {
            enabled: false,
            label: LocalReplicaSCMProvider.label,
            baseUri: localRootA.toString(),
            settings: {} as JSON,
        };
        const persistB: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: localRootB.toString(),
            settings: {} as JSON,
        };
        const vfs = new MinimalVirtualFileSystem(remoteRoot);
        vfs.setProjectSCMPersist(localRootA.toString(), persistA);
        vfs.setProjectSCMPersist(localRootB.toString(), persistB);
        const events: string[] = [];
        const collection = Object.create(SCMCollectionProvider.prototype) as any;
        collection.disposed = false;
        collection.scms = [];
        collection.vfs = vfs;
        collection.context = createExtensionContextStub({
            [localRootA.toString()]: persistA,
            [localRootB.toString()]: persistB,
        });
        collection.createSCM = async (_proto: unknown, baseUri: vscode.Uri) => {
            events.push(`create:${baseUri.toString()}`);
            return undefined;
        };
        collection.removeDetachedPersistedSCM = async (_scmKey: string, baseUri: vscode.Uri) => {
            events.push(`remove:${baseUri.toString()}`);
            throw new LocalReplicaOwnershipUnavailableError('another window owns this folder');
        };

        await collection.initSCMs();

        assert.deepStrictEqual(events, [
            `create:${localRootB.toString()}`,
            `remove:${localRootA.toString()}`,
        ]);
        // The other window's mapping survives a failed ownership acquisition.
        assert.strictEqual(vfs.hasProjectSCMPersist(localRootA.toString()), true);
        assert.strictEqual(vfs.hasProjectSCMPersist(localRootB.toString()), true);
    });

    test('reports a failed mapping restore instead of rejecting the compile barrier forever', async () => {
        const remoteRoot = await tempDir('sr-overleaf-audit-init-fail-');
        tempRoots.push(remoteRoot);
        const warnings: string[] = [];
        (vscode.window as any).showWarningMessage = async (message: string) => {
            warnings.push(message);
            return undefined;
        };
        const brokenContext = {
            globalState: {
                get: () => {
                    throw new Error('globalState is unavailable');
                },
                update: async () => undefined,
            },
        } as unknown as vscode.ExtensionContext;
        const collection = new SCMCollectionProvider(
            new MinimalVirtualFileSystem(remoteRoot) as unknown as VirtualFileSystem,
            brokenContext,
        );

        try {
            await (collection as any).initSCMsPromise;
            assert.strictEqual(warnings.some(message => /could not be fully restored/.test(message)), true);
            await assert.rejects(
                collection.flushLocalReplicaBeforeCompile(),
                /could not be initialized/,
            );
        } finally {
            collection.dispose();
        }
    });

    // ------------------------------------------------------- collaboration

    test('clears a collaborator decoration in the file they left', async () => {
        const remoteRoot = await tempDir('sr-overleaf-audit-cursor-');
        tempRoots.push(remoteRoot);
        const vfs = new MinimalVirtualFileSystem(remoteRoot);
        const entities: Record<string, {fileEntity: {_id: string}, path: string}> = {
            a: {fileEntity: {_id: 'a'}, path: '/a.tex'},
            b: {fileEntity: {_id: 'b'}, path: '/b.tex'},
        };
        const resolveUri = async (docPath: string) =>
            await LocalReplicaSCMProvider.pathToUri(docPath) ?? vfs.pathToUri(docPath);
        const decorationCalls: Array<{uri: string, count: number}> = [];
        const editorFor = async (docPath: string) => {
            const uri = await resolveUri(docPath);
            return {
                document: {uri},
                setDecorations: (_type: unknown, ranges: unknown[]) => {
                    decorationCalls.push({uri: uri.toString(), count: ranges.length});
                },
            };
        };
        Object.defineProperty(vscode.window, 'visibleTextEditors', {
            configurable: true,
            value: [await editorFor('/a.tex'), await editorFor('/b.tex')],
        });

        const manager = Object.create(ClientManager.prototype) as ClientManager;
        const internals = manager as any;
        internals.disposed = false;
        internals.publicId = 'self';
        internals.vfs = {
            ...vfs,
            pathToUri: (...parts: string[]) => vfs.pathToUri(...parts),
            // eslint-disable-next-line @typescript-eslint/naming-convention
            _resolveById: (id: string) => entities[id],
        };
        internals.onlineUsers = {
            c1: {
                id: 'c1',
                // eslint-disable-next-line @typescript-eslint/naming-convention
                user_id: 'u1',
                name: 'Collaborator',
                email: 'c1@example.test',
                // eslint-disable-next-line @typescript-eslint/naming-convention
                doc_id: 'a',
                row: 1,
                column: 0,
                selection: {
                    color: '#ff8000',
                    decoration: {dispose: () => undefined},
                    hoverMessage: new vscode.MarkdownString('collaborator'),
                    ranges: [],
                },
            },
        };

        await internals.updatePosition('c1', 'b', 2, 3);

        const aUri = (await resolveUri('/a.tex')).toString();
        const bUri = (await resolveUri('/b.tex')).toString();
        assert.deepStrictEqual(decorationCalls, [
            {uri: aUri, count: 0},
            {uri: bUri, count: 1},
        ]);
        assert.strictEqual(internals.onlineUsers.c1.doc_id, 'b');
    });

    test('never persists a malformed collaborator position and survives a stale jump', async () => {
        const remoteRoot = await tempDir('sr-overleaf-audit-jump-');
        tempRoots.push(remoteRoot);
        const vfs = new MinimalVirtualFileSystem(remoteRoot);
        const manager = Object.create(ClientManager.prototype) as ClientManager;
        const internals = manager as any;
        internals.disposed = false;
        internals.publicId = 'self';
        internals.vfs = {
            pathToUri: (...parts: string[]) => vfs.pathToUri(...parts),
            // eslint-disable-next-line @typescript-eslint/naming-convention
            _resolveById: () => undefined,
        };
        internals.onlineUsers = {};
        const details = {
            id: 'c1',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            user_id: 'u1',
            name: 'Collaborator',
            email: 'c1@example.test',
            // eslint-disable-next-line @typescript-eslint/naming-convention
            doc_id: 'a',
            row: 1.5,
            column: 0,
        };
        let warned = '';
        (vscode.window as any).showWarningMessage = async (message: string) => {
            warned = message;
            return undefined;
        };

        await internals.updatePosition('c1', 'a', 1.5, 0, details);
        assert.strictEqual(internals.onlineUsers.c1, undefined);

        await internals.updatePosition('c1', 'a', -1, 0, details);
        assert.strictEqual(internals.onlineUsers.c1, undefined);

        // A jump for a collaborator that just disconnected must not throw.
        await internals.jumpToUser('c1');
        assert.match(warned, /no longer online/);
    });

    test('withholds Local Replica cursor presence until a saved buffer has flushed', async () => {
        const remoteRoot = await tempDir('sr-overleaf-audit-presence-remote-');
        const localRoot = await tempDir('sr-overleaf-audit-presence-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeReplicaSettings(localRoot, remoteRoot);
        await setActiveReplicaRoot(localRoot);

        const localUri = vscode.Uri.joinPath(localRoot, 'main.tex');
        const dirtyDocument = {uri: localUri, isDirty: true} as vscode.TextDocument;
        const savedDocument = {uri: localUri, isDirty: false} as vscode.TextDocument;
        const sentPositions: Array<{docId: string, row: number, column: number}> = [];
        const flushedUris: string[] = [];
        const manager = Object.create(ClientManager.prototype) as ClientManager;
        const internals = manager as any;
        internals.disposed = false;
        internals.lastPositionUpdateAt = 0;
        internals.vfs = {
            pathToUri: (...parts: string[]) => vscode.Uri.joinPath(
                remoteRoot,
                ...parts.flatMap(part => part.split('/').filter(Boolean)),
            ),
            // eslint-disable-next-line @typescript-eslint/naming-convention
            _resolveUri: async () => ({fileEntity: {_id: 'main-doc'}}),
            flushPendingLocalPush: async (uri: vscode.Uri) => {
                flushedUris.push(uri.toString());
            },
        };
        internals.socket = {
            updatePosition: async (docId: string, row: number, column: number) => {
                sentPositions.push({docId, row, column});
            },
        };
        Object.defineProperty(vscode.window, 'visibleTextEditors', {
            configurable: true,
            value: [{
                document: savedDocument,
                selection: new vscode.Selection(11, 5, 11, 5),
            }],
        });

        internals.queuePositionUpdate(dirtyDocument, 11, 5);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        assert.deepStrictEqual(sentPositions, []);
        assert.strictEqual(internals.pendingPosition, undefined);

        await internals.publishSavedLocalReplicaPosition(savedDocument);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        assert.deepStrictEqual(flushedUris, [localUri.toString()]);
        assert.deepStrictEqual(sentPositions, [{docId: 'main-doc', row: 11, column: 5}]);
    });

    // ------------------------------------------------ replica settings compat
    test('normalizes replica settings carrying removed-feature keys without looping', async () => {
        const remoteRoot = await tempDir('sr-overleaf-audit-settings-remote-');
        const localRoot = await tempDir('sr-overleaf-audit-settings-local-');
        tempRoots.push(remoteRoot, localRoot);
        // Deliberately un-normalized, and carrying the legacy `enableAgentReview`
        // key that older builds wrote into replica folders.
        const rawSettings = JSON.stringify({
            uri: remoteRoot.toString(),
            serverName: 'test-server',
            enableCompileNPreview: false,
            enableAgentReview: true,
            projectName: 'Audit Fix Test',
        });
        await writeText(settingsUri(localRoot), rawSettings);

        // The snapshot reader answers without ever touching the file.
        const snapshot = await localReplicaWorkspace.readReplicaSettingsSnapshot(localRoot);
        assert.strictEqual(snapshot?.enableCompileNPreview, true);
        assert.strictEqual(snapshot?.enableAgentReview, undefined);
        assert.strictEqual(await readText(settingsUri(localRoot)), rawSettings);

        // The normalizing reader may rewrite once, but must then be stable:
        // a settings file that keeps changing is the rewrite loop this guards.
        await localReplicaWorkspace.readReplicaSettings(localRoot);
        const normalized = await readText(settingsUri(localRoot));
        assert.ok(!normalized.includes('enableAgentReview'));
        await localReplicaWorkspace.readReplicaSettings(localRoot);
        assert.strictEqual(await readText(settingsUri(localRoot)), normalized);
    });

    // ------------------------------------------------- packaging assertions

    test('fails packaging when a runtime assertion resolves outside the staged tree', () => {
        assert.throws(
            () => packageRuntime.resolveStagedRuntime(
                {resolve: () => path.join(os.tmpdir(), 'node_modules', 'prettier', 'index.js')},
                'prettier',
            ),
            /outside the staged runtime/,
        );
    });

    test('fails packaging when the socket.io xhr cookie hunks are missing', async () => {
        const socketRoot = await tempDir('sr-overleaf-audit-socket-');
        tempRoots.push(socketRoot);
        await writeText(
            vscode.Uri.joinPath(socketRoot, 'lib', 'socket.js'),
            [
                'function applyExtraHeaders (xhr, headers) {}',
                "applyExtraHeaders(xhr, this.options['extraHeaders']);",
                'function mergeSetCookieHeader (cookieHeader, setCookieHeader) {}',
                "self.transport.open(self.options['extraHeaders']);",
            ].join('\n'),
        );
        await writeText(
            vscode.Uri.joinPath(socketRoot, 'lib', 'transports', 'websocket.js'),
            [
                'WS.prototype.open = function (extraHeaders) {',
                '  this.websocket = new Socket(url, { headers: extraHeaders || {} });',
                '};',
            ].join('\n'),
        );

        assert.throws(
            () => packageRuntime.verifyStagedSocketRuntime(socketRoot.fsPath),
            /xhr\.js/,
        );

        await writeText(
            vscode.Uri.joinPath(socketRoot, 'lib', 'transports', 'xhr.js'),
            [
                'function applyExtraHeaders (req, headers) {}',
                'applyExtraHeaders(req, this.socket.options.extraHeaders);',
            ].join('\n'),
        );
        packageRuntime.verifyStagedSocketRuntime(socketRoot.fsPath);
    });

    test('fails packaging when a vendor tree is missing or empty', async () => {
        const vendorRoot = await tempDir('sr-overleaf-audit-vendor-');
        tempRoots.push(vendorRoot);

        assert.throws(
            () => packageRuntime.verifyVendorAssets({
                roots: [path.join(vendorRoot.fsPath, 'absent')],
                files: [],
            }),
            /Missing vendor assets/,
        );
        // An existing but empty vendor tree is just as broken in the vsix.
        assert.throws(
            () => packageRuntime.verifyVendorAssets({roots: [vendorRoot.fsPath], files: []}),
            /empty/,
        );

        // Every contributed language configuration must be a verified file.
        const configurations = packageRuntime.contributedLanguageConfigurations();
        assert.ok(configurations.length>0);
        for (const configuration of configurations) {
            assert.match(configuration, /[\\/]data[\\/]vendor[\\/]/);
        }
    });
});
