import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    LEGACY_REPLICA_SETTINGS_BACKUP_FILE,
    LEGACY_REPLICA_SETTINGS_FILE,
    REPLICA_SETTINGS_DIR,
    REPLICA_SETTINGS_FILE,
    ROOT_NAME,
    STATE_SERVERS_KEY,
} from '../../consts';
import { ProjectManagerProvider } from '../../core/projectManagerProvider';
import { VirtualFileSystem } from '../../core/remoteFileSystemProvider';
import { LocalReplicaSCMProvider } from '../../scm/localReplicaSCM';
import { SCMCollectionProvider } from '../../scm/scmCollectionProvider';
import { EventBus, Events } from '../../utils/eventBus';
import { getActiveReplicaRoot, pathToLocalUri, setActiveReplicaRoot } from '../../utils/localReplicaWorkspace';

interface PersistRecord {
    enabled: boolean;
    label: string;
    baseUri: string;
    settings: JSON;
}

class FakeVirtualFileSystem {
    public readonly origin: vscode.Uri;
    public readonly projectName = 'Select Folder Test';
    public readonly serverName = 'test-server';
    public readonly projectId = 'test-project';
    public readonly connectionState = 'connected';
    private readonly connectionEmitter = new vscode.EventEmitter<string>();
    public readonly onDidChangeConnection = this.connectionEmitter.event;
    private readonly persists = new Map<string, PersistRecord>();
    private readonly entityIds = new Map<string, string>();

    constructor(private readonly remoteRoot: vscode.Uri) {
        this.origin = remoteRoot;
    }

    pathToUri(...parts: string[]) {
        const segments = parts.flatMap(part => part.split('/').filter(Boolean));
        return vscode.Uri.joinPath(this.remoteRoot, ...segments);
    }

    setEntityId(relPath: string, entityId: string) {
        this.entityIds.set('/' + relPath.split('/').filter(Boolean).join('/'), entityId);
    }

    async _resolveUri(uri: vscode.Uri) {
        const relativePath = path.relative(this.remoteRoot.fsPath, uri.fsPath).split(path.sep).join('/');
        const relPath = '/' + relativePath.split('/').filter(Boolean).join('/');
        const fileName = path.basename(uri.fsPath);
        const fileType = /\.tex$/i.test(fileName) ? 'doc' : 'file';
        return {
            fileName,
            fileType,
            fileEntity: {
                _id: this.entityIds.get(relPath) ?? relPath,
                name: fileName,
                _type: fileType,
                linkedFileData: null,
                created: new Date(0).toISOString(),
            },
        };
    }

    async ensureConnectedForWrite() {}

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
}

class TestFileSystemWatcher implements vscode.FileSystemWatcher {
    ignoreCreateEvents = false;
    ignoreChangeEvents = false;
    ignoreDeleteEvents = false;

    private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
    private readonly createEmitter = new vscode.EventEmitter<vscode.Uri>();
    private readonly deleteEmitter = new vscode.EventEmitter<vscode.Uri>();

    readonly onDidChange = this.changeEmitter.event;
    readonly onDidCreate = this.createEmitter.event;
    readonly onDidDelete = this.deleteEmitter.event;

    fireChange(uri: vscode.Uri) {
        this.changeEmitter.fire(uri);
    }

    fireCreate(uri: vscode.Uri) {
        this.createEmitter.fire(uri);
    }

    fireDelete(uri: vscode.Uri) {
        this.deleteEmitter.fire(uri);
    }

    dispose() {
        this.changeEmitter.dispose();
        this.createEmitter.dispose();
        this.deleteEmitter.dispose();
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

async function readBytes(uri: vscode.Uri) {
    return Buffer.from(await vscode.workspace.fs.readFile(uri));
}

async function pathExists(uri: vscode.Uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

function settingsUri(root: vscode.Uri) {
    return vscode.Uri.joinPath(root, ...REPLICA_SETTINGS_FILE.split('/'));
}

function legacySettingsUri(root: vscode.Uri) {
    return vscode.Uri.joinPath(root, ...LEGACY_REPLICA_SETTINGS_FILE.split('/'));
}

function uriForRelPath(root: vscode.Uri, relPath: string) {
    return vscode.Uri.joinPath(root, ...relPath.split('/').filter(Boolean));
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

function createSCM(remoteRoot: vscode.Uri, localRoot: vscode.Uri, fakeVfs = new FakeVirtualFileSystem(remoteRoot)) {
    return new LocalReplicaSCMProvider(fakeVfs as unknown as VirtualFileSystem, localRoot);
}

function createExtensionContextStub(): vscode.ExtensionContext {
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
                    name: 'Select Folder Test',
                    scm: {},
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

function waitForSyncComplete(
    rootUri: vscode.Uri,
    relPath: string,
    direction: 'push' | 'pull',
    type?: 'update' | 'delete',
) {
    return new Promise<Events['scmSyncCompleteEvent']>((resolve, reject) => {
        const timer = setTimeout(() => {
            subscription.dispose();
            reject(new Error(`Timed out waiting for ${direction} ${type ?? '*'} ${relPath}`));
        }, 5000);
        const subscription = EventBus.on('scmSyncCompleteEvent', event => {
            if (
                event.rootUri.toString()===rootUri.toString()
                && event.relPath===relPath
                && event.direction===direction
                && (type===undefined || event.type===type)
            ) {
                clearTimeout(timer);
                subscription.dispose();
                resolve(event);
            }
        });
    });
}

suite('Select Project Folder Local Replica', function () {
    this.timeout(10000);

    const tempRoots: vscode.Uri[] = [];
    let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
    let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
    let originalShowErrorMessage: typeof vscode.window.showErrorMessage;
    let originalCreateFileSystemWatcher: typeof vscode.workspace.createFileSystemWatcher;
    let originalExecuteCommand: typeof vscode.commands.executeCommand;
    let originalUpdateWorkspaceFolders: typeof vscode.workspace.updateWorkspaceFolders;
    let originalWorkspaceFoldersDescriptor: PropertyDescriptor | undefined;

    setup(() => {
        originalShowWarningMessage = vscode.window.showWarningMessage;
        originalShowInformationMessage = vscode.window.showInformationMessage;
        originalShowErrorMessage = vscode.window.showErrorMessage;
        originalCreateFileSystemWatcher = vscode.workspace.createFileSystemWatcher;
        originalExecuteCommand = vscode.commands.executeCommand;
        originalUpdateWorkspaceFolders = vscode.workspace.updateWorkspaceFolders;
        originalWorkspaceFoldersDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
    });

    teardown(async () => {
        (vscode.window as any).showWarningMessage = originalShowWarningMessage;
        (vscode.window as any).showInformationMessage = originalShowInformationMessage;
        (vscode.window as any).showErrorMessage = originalShowErrorMessage;
        (vscode.workspace as any).createFileSystemWatcher = originalCreateFileSystemWatcher;
        (vscode.commands as any).executeCommand = originalExecuteCommand;
        (vscode.workspace as any).updateWorkspaceFolders = originalUpdateWorkspaceFolders;
        await setActiveReplicaRoot(undefined);
        if (originalWorkspaceFoldersDescriptor) {
            Object.defineProperty(vscode.workspace, 'workspaceFolders', originalWorkspaceFoldersDescriptor);
        }
        while (tempRoots.length>0) {
            await removeUri(tempRoots.pop()!);
        }
    });

    test('prompts before using a non-empty exact folder and can empty it', async () => {
        const localRoot = await tempDir('sr-overleaf-nonempty-');
        tempRoots.push(localRoot);
        await writeText(vscode.Uri.joinPath(localRoot, 'stale.tex'), 'stale');

        let prompted = false;
        (vscode.window as any).showWarningMessage = async (_message: string, _options: unknown, ...items: string[]) => {
            prompted = true;
            return items[0];
        };

        const validated = await LocalReplicaSCMProvider.validateExactBaseUri(localRoot.fsPath);

        assert.strictEqual(validated.fsPath, localRoot.fsPath);
        assert.strictEqual(prompted, true);
        assert.deepStrictEqual(await vscode.workspace.fs.readDirectory(localRoot), []);
    });

    test('disposes existing replica hooks before emptying a selected non-empty folder', async () => {
        const localRoot = await tempDir('sr-overleaf-before-empty-');
        tempRoots.push(localRoot);
        const staleUri = vscode.Uri.joinPath(localRoot, 'stale.tex');
        await writeText(staleUri, 'stale');

        (vscode.window as any).showWarningMessage = async (_message: string, _options: unknown, ...items: string[]) => {
            return items[0];
        };

        let callbackSawStaleFile = false;
        await LocalReplicaSCMProvider.validateExactBaseUri(localRoot.fsPath, {
            beforeEmpty: async () => {
                callbackSawStaleFile = await pathExists(staleUri);
            },
        });

        assert.strictEqual(callbackSawStaleFile, true);
        assert.strictEqual(await pathExists(staleUri), false);
    });

    test('rejects a non-empty exact folder when the user declines emptying it', async () => {
        const localRoot = await tempDir('sr-overleaf-reject-');
        tempRoots.push(localRoot);
        const staleUri = vscode.Uri.joinPath(localRoot, 'stale.tex');
        await writeText(staleUri, 'stale');

        (vscode.window as any).showWarningMessage = async (_message: string, _options: unknown, ...items: string[]) => {
            assert.deepStrictEqual(items, [vscode.l10n.t('Empty Folder and Continue')]);
            return undefined;
        };

        await assert.rejects(() => LocalReplicaSCMProvider.validateExactBaseUri(localRoot.fsPath));
        assert.strictEqual(await readText(staleUri), 'stale');
    });

    test('rejects protected exact folders before prompting to empty them', async () => {
        let prompted = false;
        const errorMessages: string[] = [];
        (vscode.window as any).showWarningMessage = async () => {
            prompted = true;
            return undefined;
        };
        (vscode.window as any).showErrorMessage = async (message: string) => {
            errorMessages.push(message);
            return undefined;
        };

        await assert.rejects(() => LocalReplicaSCMProvider.validateExactBaseUri(os.homedir()));
        if (process.platform!=='win32') {
            await assert.rejects(() => LocalReplicaSCMProvider.validateExactBaseUri('/mnt'));
        }
        assert.strictEqual(prompted, false);
        assert.ok(errorMessages.some(message => message.includes('protected home directory')));
        if (process.platform!=='win32') {
            assert.ok(errorMessages.some(message => message.includes('protected mount root')));
        }
    });

    test('rejects git repository roots before prompting to empty them', async () => {
        const repoRoot = vscode.Uri.file(path.resolve(__dirname, '..', '..', '..'));
        let prompted = false;
        const errorMessages: string[] = [];
        (vscode.window as any).showWarningMessage = async () => {
            prompted = true;
            return undefined;
        };
        (vscode.window as any).showErrorMessage = async (message: string) => {
            errorMessages.push(message);
            return undefined;
        };

        await assert.rejects(() => LocalReplicaSCMProvider.validateExactBaseUri(repoRoot.fsPath));
        assert.strictEqual(prompted, false);
        assert.ok(errorMessages.some(message => message.includes('protected Git repository root')));
    });

    test('allows dedicated subfolders under mount roots', async () => {
        const localRoot = await tempDir('sr-overleaf-mounted-dedicated-');
        const dedicatedRoot = vscode.Uri.joinPath(localRoot, 'Documents', 'Overleaf', 'Project');
        tempRoots.push(localRoot);

        let prompted = false;
        (vscode.window as any).showWarningMessage = async () => {
            prompted = true;
            return undefined;
        };

        const validated = await LocalReplicaSCMProvider.validateExactBaseUri(dedicatedRoot.fsPath);

        assert.strictEqual(validated.fsPath, dedicatedRoot.fsPath);
        assert.strictEqual(prompted, false);
    });

    test('allows project-specific subfolders under WSL-mounted user directories', async () => {
        if (process.platform==='win32') { return; }

        const protectedReason = await (LocalReplicaSCMProvider as any).getProtectedExactBaseUriReason(
            vscode.Uri.file('/mnt/c/Users/alex6095'),
        );
        const dedicatedReason = await (LocalReplicaSCMProvider as any).getProtectedExactBaseUriReason(
            vscode.Uri.file('/mnt/c/Users/alex6095/Documents/Overleaf/Project'),
        );

        assert.strictEqual(protectedReason, 'Windows user profile root');
        assert.strictEqual(dedicatedReason, undefined);
    });

    test('rejects symlink aliases to a protected workspace root', async () => {
        const parentRoot = await tempDir('sr-overleaf-symlink-parent-');
        const workspaceRoot = vscode.Uri.joinPath(parentRoot, 'workspace');
        const aliasRoot = vscode.Uri.joinPath(parentRoot, 'workspace-alias');
        tempRoots.push(parentRoot);
        await vscode.workspace.fs.createDirectory(workspaceRoot);
        try {
            await fs.symlink(workspaceRoot.fsPath, aliasRoot.fsPath, 'dir');
        } catch {
            return;
        }
        setWorkspaceFoldersForTest(workspaceRoot);

        let prompted = false;
        (vscode.window as any).showWarningMessage = async () => {
            prompted = true;
            return undefined;
        };

        const protectedReason = await (LocalReplicaSCMProvider as any).getProtectedExactBaseUriReason(aliasRoot);
        assert.strictEqual(protectedReason, 'workspace root');
        await assert.rejects(() => LocalReplicaSCMProvider.validateExactBaseUri(aliasRoot.fsPath));
        assert.strictEqual(prompted, false);
    });

    test('recognizes native Windows user profile roots', async () => {
        assert.strictEqual((LocalReplicaSCMProvider as any).isNativeWindowsUserProfileRoot('C:\\Users'), true);
        assert.strictEqual((LocalReplicaSCMProvider as any).isNativeWindowsUserProfileRoot('C:\\Users\\alex6095'), true);
        assert.strictEqual((LocalReplicaSCMProvider as any).isNativeWindowsUserProfileRoot('C:\\Users\\alex6095\\Documents\\Overleaf\\Project'), false);
    });

    test('allows reselecting a folder already configured for the same project without emptying it', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-same-project-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(settingsUri(localRoot), JSON.stringify({
            uri: remoteRoot.toString(),
            serverName: 'test-server',
            enableCompileNPreview: true,
            projectName: 'Select Folder Test',
        }));
        await writeText(vscode.Uri.joinPath(localRoot, 'stale.tex'), 'stale');

        let prompted = false;
        (vscode.window as any).showWarningMessage = async () => {
            prompted = true;
            return undefined;
        };

        const validated = await LocalReplicaSCMProvider.validateExactBaseUri(localRoot.fsPath, {
            projectUri: remoteRoot,
        });

        assert.strictEqual(validated.fsPath, localRoot.fsPath);
        assert.strictEqual(prompted, false);
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'stale.tex')), 'stale');
    });

    test('allows reselecting the current same-project workspace folder without emptying it', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-workspace-same-project-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(settingsUri(localRoot), JSON.stringify({
            uri: remoteRoot.toString(),
            serverName: 'test-server',
            enableCompileNPreview: true,
            projectName: 'Select Folder Test',
        }));
        await writeText(vscode.Uri.joinPath(localRoot, 'stale.tex'), 'stale');
        setWorkspaceFoldersForTest(localRoot);

        let prompted = false;
        (vscode.window as any).showWarningMessage = async () => {
            prompted = true;
            return undefined;
        };

        const validated = await LocalReplicaSCMProvider.validateExactBaseUri(localRoot.fsPath, {
            projectUri: remoteRoot,
        });

        assert.strictEqual(validated.fsPath, localRoot.fsPath);
        assert.strictEqual(prompted, false);
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'stale.tex')), 'stale');
    });

    test('allows same-project Git repository roots without emptying them', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-git-same-project-');
        tempRoots.push(remoteRoot, localRoot);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(localRoot, '.git'));
        await writeText(settingsUri(localRoot), JSON.stringify({
            uri: remoteRoot.toString(),
            serverName: 'test-server',
            enableCompileNPreview: true,
            projectName: 'Select Folder Test',
        }));
        await writeText(vscode.Uri.joinPath(localRoot, 'stale.tex'), 'stale');

        let prompted = false;
        (vscode.window as any).showWarningMessage = async () => {
            prompted = true;
            return undefined;
        };

        const validated = await LocalReplicaSCMProvider.validateExactBaseUri(localRoot.fsPath, {
            projectUri: remoteRoot,
        });

        assert.strictEqual(validated.fsPath, localRoot.fsPath);
        assert.strictEqual(prompted, false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, '.git')), true);
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'stale.tex')), 'stale');
    });

    test('rejects a folder configured for another project without emptying it', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const otherRemoteRoot = await tempDir('sr-overleaf-other-remote-');
        const localRoot = await tempDir('sr-overleaf-other-project-');
        tempRoots.push(remoteRoot, otherRemoteRoot, localRoot);
        await writeText(settingsUri(localRoot), JSON.stringify({
            uri: otherRemoteRoot.toString(),
            serverName: 'test-server',
            enableCompileNPreview: true,
            projectName: 'Other Project',
        }));
        await writeText(vscode.Uri.joinPath(localRoot, 'stale.tex'), 'stale');

        let prompted = false;
        (vscode.window as any).showWarningMessage = async () => {
            prompted = true;
            return undefined;
        };

        await assert.rejects(() => LocalReplicaSCMProvider.validateExactBaseUri(localRoot.fsPath, {
            projectUri: remoteRoot,
        }));
        assert.strictEqual(prompted, false);
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'stale.tex')), 'stale');
    });

    test('rejects legacy settings for another project without migrating them', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const otherRemoteRoot = await tempDir('sr-overleaf-other-remote-');
        const localRoot = await tempDir('sr-overleaf-legacy-other-project-');
        tempRoots.push(remoteRoot, otherRemoteRoot, localRoot);
        await writeText(legacySettingsUri(localRoot), JSON.stringify({
            uri: otherRemoteRoot.toString(),
            serverName: 'test-server',
            enableCompileNPreview: false,
            projectName: 'Legacy Other Project',
        }));

        await assert.rejects(() => LocalReplicaSCMProvider.validateExactBaseUri(localRoot.fsPath, {
            projectUri: remoteRoot,
        }));

        assert.strictEqual(await pathExists(legacySettingsUri(localRoot)), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR)), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, LEGACY_REPLICA_SETTINGS_BACKUP_FILE)), false);
    });

    test('rejects traversal when mapping remote paths to local replica URIs', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-public-path-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(settingsUri(localRoot), JSON.stringify({
            uri: remoteRoot.toString(),
            serverName: 'test-server',
            enableCompileNPreview: true,
            projectName: 'Select Folder Test',
        }));
        await setActiveReplicaRoot(localRoot);

        assert.strictEqual(await LocalReplicaSCMProvider.pathToUri('../escape.tex'), undefined);
        assert.strictEqual(await LocalReplicaSCMProvider.pathToUri('/safe/../escape.tex'), undefined);
        assert.strictEqual(await LocalReplicaSCMProvider.pathToUri('safe\\escape.tex'), undefined);
        const safeUri = await pathToLocalUri('/safe/main.tex', localRoot);
        assert.strictEqual(safeUri?.toString(), vscode.Uri.joinPath(localRoot, 'safe', 'main.tex').toString());
    });

    test('pulls text and media files from remote into an empty selected folder', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        const pdfBytes = Buffer.from('%PDF-1.7\nsource pdf\n', 'utf-8');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote text');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.png'), pngBytes);
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), pdfBytes);
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'main.pdf'), Buffer.from('%PDF generated\n', 'utf-8'));

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'remote text');
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(localRoot, 'figures', 'plot.png')), pngBytes);
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(localRoot, 'supplement.pdf')), pdfBytes);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'main.pdf')), false);
    });

    test('pushes local text and media edits back to remote', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote text');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), Buffer.from('%PDF old\n', 'utf-8'));

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const localPdf = vscode.Uri.joinPath(localRoot, 'supplement.pdf');
        const nextPdf = Buffer.from('%PDF new\nbinary-ish\n', 'utf-8');
        await writeText(localMain, 'local text');
        await writeBytes(localPdf, nextPdf);

        await scm.flushPendingPush(localMain);
        await scm.flushPendingPush(localPdf);

        assert.strictEqual(await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')), 'local text');
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf')), nextPdf);
    });

    test('pulls live remote text and media changes into the selected folder', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v1');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.png'), Buffer.from([1, 2, 3]));
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), Buffer.from('%PDF old\n', 'utf-8'));

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const nextPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
        const nextPdf = Buffer.from('%PDF live remote\n', 'utf-8');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote live');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.png'), nextPng);
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), nextPdf);

        const applySync = (scm as any).applySync.bind(scm);
        await applySync('pull', 'update', '/main.tex', uriForRelPath(remoteRoot, 'main.tex'), uriForRelPath(localRoot, 'main.tex'));
        await applySync('pull', 'update', '/figures/plot.png', uriForRelPath(remoteRoot, 'figures/plot.png'), uriForRelPath(localRoot, 'figures/plot.png'));
        await applySync('pull', 'update', '/supplement.pdf', uriForRelPath(remoteRoot, 'supplement.pdf'), uriForRelPath(localRoot, 'supplement.pdf'));
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(localRoot, 'figures', 'plot.png')), nextPng);

        await vscode.workspace.fs.delete(vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.png'));
        await applySync('pull', 'delete', '/figures/plot.png', uriForRelPath(remoteRoot, 'figures/plot.png'), uriForRelPath(localRoot, 'figures/plot.png'));

        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'remote live');
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(localRoot, 'supplement.pdf')), nextPdf);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'figures', 'plot.png')), false);
    });

    test('keeps replica state consistent when a remote delete arrives after the local file is already missing', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'sample.tex'), 'remote baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localSample = vscode.Uri.joinPath(localRoot, 'sample.tex');
        await vscode.workspace.fs.delete(localSample);
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(remoteRoot, 'sample.tex'));

        const applySync = (scm as any).applySync.bind(scm);
        await applySync('pull', 'delete', '/sample.tex', uriForRelPath(remoteRoot, 'sample.tex'), localSample);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'sample.tex'), 'remote baseline');
        await applySync('pull', 'update', '/sample.tex', uriForRelPath(remoteRoot, 'sample.tex'), localSample);

        assert.strictEqual(await readText(localSample), 'remote baseline');
    });

    test('does not recreate a remote file from a stale local event after a remote delete', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'sample.tex'), 'remote baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localSample = vscode.Uri.joinPath(localRoot, 'sample.tex');
        const remoteSample = vscode.Uri.joinPath(remoteRoot, 'sample.tex');
        await vscode.workspace.fs.delete(remoteSample);

        const applySync = (scm as any).applySync.bind(scm);
        await applySync('pull', 'delete', '/sample.tex', remoteSample, localSample);
        assert.strictEqual(await pathExists(localSample), false);

        await writeText(localSample, 'remote baseline');
        const staleMtime = new Date(Date.now() - 60_000);
        await fs.utimes(localSample.fsPath, staleMtime, staleMtime);
        await applySync('push', 'update', '/sample.tex', localSample, remoteSample);

        assert.strictEqual(await pathExists(remoteSample), false);
        assert.strictEqual(await pathExists(localSample), false);
    });

    test('allows an intentional same-content restore after a remote delete', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'sample.tex'), 'remote baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localSample = vscode.Uri.joinPath(localRoot, 'sample.tex');
        const remoteSample = vscode.Uri.joinPath(remoteRoot, 'sample.tex');
        const applySync = (scm as any).applySync.bind(scm);

        await vscode.workspace.fs.delete(remoteSample);
        await applySync('pull', 'delete', '/sample.tex', remoteSample, localSample);
        assert.strictEqual(await pathExists(localSample), false);

        await writeText(localSample, 'remote baseline');
        const restoredMtime = new Date(Date.now() + 60_000);
        await fs.utimes(localSample.fsPath, restoredMtime, restoredMtime);
        await applySync('push', 'update', '/sample.tex', localSample, remoteSample);

        assert.strictEqual(await readText(localSample), 'remote baseline');
        assert.strictEqual(await readText(remoteSample), 'remote baseline');
    });

    test('clears remote-delete echo state when reset pull rehydrates the same file', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'sample.tex'), 'remote baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localSample = vscode.Uri.joinPath(localRoot, 'sample.tex');
        const remoteSample = vscode.Uri.joinPath(remoteRoot, 'sample.tex');
        const applySync = (scm as any).applySync.bind(scm);

        await vscode.workspace.fs.delete(remoteSample);
        await applySync('pull', 'delete', '/sample.tex', remoteSample, localSample);
        assert.strictEqual(await pathExists(localSample), false);

        await writeText(remoteSample, 'remote baseline');
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await applySync('push', 'update', '/sample.tex', localSample, remoteSample);

        assert.strictEqual(await readText(localSample), 'remote baseline');
        assert.strictEqual(await readText(remoteSample), 'remote baseline');
    });

    test('pushes local delete and rename operations for text and media back to remote', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote text');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'notes.tex'), 'delete me');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'old.png'), Buffer.from([1, 2, 3]));
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), Buffer.from('%PDF old name\n', 'utf-8'));

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'notes.tex'));
        await vscode.workspace.fs.rename(
            vscode.Uri.joinPath(localRoot, 'supplement.pdf'),
            vscode.Uri.joinPath(localRoot, 'paper-renamed.pdf'),
            {overwrite: false},
        );
        await vscode.workspace.fs.rename(
            vscode.Uri.joinPath(localRoot, 'figures', 'old.png'),
            vscode.Uri.joinPath(localRoot, 'figures', 'new.png'),
            {overwrite: false},
        );

        const applySync = (scm as any).applySync.bind(scm);
        await applySync('push', 'delete', '/notes.tex', uriForRelPath(localRoot, 'notes.tex'), uriForRelPath(remoteRoot, 'notes.tex'));
        await applySync('push', 'delete', '/supplement.pdf', uriForRelPath(localRoot, 'supplement.pdf'), uriForRelPath(remoteRoot, 'supplement.pdf'));
        await applySync('push', 'update', '/paper-renamed.pdf', uriForRelPath(localRoot, 'paper-renamed.pdf'), uriForRelPath(remoteRoot, 'paper-renamed.pdf'));
        await applySync('push', 'delete', '/figures/old.png', uriForRelPath(localRoot, 'figures/old.png'), uriForRelPath(remoteRoot, 'figures/old.png'));
        await applySync('push', 'update', '/figures/new.png', uriForRelPath(localRoot, 'figures/new.png'), uriForRelPath(remoteRoot, 'figures/new.png'));

        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'notes.tex')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'paper-renamed.pdf')), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'figures', 'old.png')), false);
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'new.png')), Buffer.from([1, 2, 3]));
    });

    test('preserves existing local tracked edits when attaching to an existing replica', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v1');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.png'), Buffer.from([1, 2, 3]));
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), Buffer.from('%PDF old\n', 'utf-8'));

        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'local stale');
        await writeText(vscode.Uri.joinPath(localRoot, 'local-only.tex'), 'must disappear');

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v2');
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.png'));
        await vscode.workspace.fs.rename(
            vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'),
            vscode.Uri.joinPath(remoteRoot, 'paper-renamed.pdf'),
            {overwrite: false},
        );

        const restartedScm = createSCM(remoteRoot, localRoot);
        await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true});

        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'local stale');
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'figures', 'plot.png')), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'supplement.pdf')), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'paper-renamed.pdf')), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'local-only.tex')), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, '.semantic-researcher-overleaf', 'settings.json')), true);
    });

    test('refreshes unchanged local media when the remote file fingerprint changes during attach', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('/supplement.pdf', 'pdf-v1');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), Buffer.from('%PDF old\n', 'utf-8'));

        const firstScm = createSCM(remoteRoot, localRoot, fakeVfs);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const nextPdf = Buffer.from('%PDF remote v2\n', 'utf-8');
        fakeVfs.setEntityId('/supplement.pdf', 'pdf-v2');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), nextPdf);

        const restartedScm = createSCM(remoteRoot, localRoot, fakeVfs);
        await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true});

        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(localRoot, 'supplement.pdf')), nextPdf);
    });

    test('deactivates a freshly activated project when exact folder selection is cancelled', async () => {
        const projectUri = vscode.Uri.parse(`${ROOT_NAME}://test-server/Select%20Folder%20Test?user=test-user&project=test-project`);
        const activatedVfs = { origin: projectUri };
        const calls: string[] = [];
        const remoteFileSystem = {
            getActiveVFS: () => undefined,
        } as unknown as any;
        const provider = new ProjectManagerProvider({} as any, remoteFileSystem);

        (vscode.commands as any).executeCommand = async (command: string, arg?: unknown) => {
            calls.push(command);
            if (command===`${ROOT_NAME}.remoteFileSystem.activateProject`) {
                assert.strictEqual((arg as vscode.Uri).toString(), projectUri.toString());
                return activatedVfs;
            }
            if (command===`${ROOT_NAME}.projectSCM.newExactLocalReplicaSCM`) {
                return undefined;
            }
            if (command===`${ROOT_NAME}.remoteFileSystem.deactivateProject`) {
                assert.strictEqual((arg as vscode.Uri).toString(), projectUri.toString());
                return undefined;
            }
            return undefined;
        };

        await provider.selectProjectFolderLocalReplica({
            uri: projectUri.toString(),
            label: 'Select Folder Test',
        } as any);

        assert.deepStrictEqual(calls, [
            `${ROOT_NAME}.remoteFileSystem.activateProject`,
            `${ROOT_NAME}.projectSCM.newExactLocalReplicaSCM`,
            `${ROOT_NAME}.remoteFileSystem.deactivateProject`,
        ]);
    });

    test('disconnects the current live local replica without deleting local files', async () => {
        const localRoot = await tempDir('sr-overleaf-live-');
        tempRoots.push(localRoot);
        const projectUri = vscode.Uri.parse(`${ROOT_NAME}://test-server/Live%20Project?user=test-user&project=live-project`);
        await writeText(settingsUri(localRoot), JSON.stringify({
            uri: vscode.Uri.file('/tmp/live-project').toString(),
            serverName: 'test-server',
            enableCompileNPreview: true,
            projectName: 'Live Project',
        }));
        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'local content');
        await setActiveReplicaRoot(localRoot);

        const deactivated: string[] = [];
        const provider = new ProjectManagerProvider({} as any, {
            getActiveVFS: () => ({origin: projectUri, projectName: 'Live Project'}),
        } as any);
        (vscode.window as any).showWarningMessage = async (_message: string, _options: unknown, ...items: string[]) => items[0];
        (vscode.window as any).showInformationMessage = async () => undefined;
        (vscode.commands as any).executeCommand = async (command: string, arg?: unknown) => {
            if (command===`${ROOT_NAME}.remoteFileSystem.deactivateProject`) {
                deactivated.push((arg as vscode.Uri).toString());
            }
            return undefined;
        };

        const disconnected = await provider.disconnectProjectFolderLocalReplica();

        assert.strictEqual(disconnected, true);
        assert.strictEqual(getActiveReplicaRoot(), undefined);
        assert.deepStrictEqual(deactivated, [projectUri.toString()]);
        assert.strictEqual(await pathExists(settingsUri(localRoot)), true);
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'local content');
    });

    test('switches away from an active live local replica before selecting another project folder', async () => {
        const oldRoot = await tempDir('sr-overleaf-old-live-');
        tempRoots.push(oldRoot);
        const oldProjectUri = vscode.Uri.parse(`${ROOT_NAME}://test-server/Old%20Project?user=test-user&project=old-project`);
        const newProjectUri = vscode.Uri.parse(`${ROOT_NAME}://test-server/New%20Project?user=test-user&project=new-project`);
        await writeText(settingsUri(oldRoot), JSON.stringify({
            uri: vscode.Uri.file('/tmp/old-project').toString(),
            serverName: 'test-server',
            enableCompileNPreview: true,
            projectName: 'Old Project',
        }));
        setWorkspaceFoldersForTest(oldRoot);
        await setActiveReplicaRoot(oldRoot);

        const calls: string[] = [];
        const provider = new ProjectManagerProvider({} as any, {
            getActiveVFS: () => ({origin: oldProjectUri, projectName: 'Old Project'}),
        } as any);
        (vscode.window as any).showWarningMessage = async (_message: string, _options: unknown, ...items: string[]) => items[0];
        (vscode.workspace as any).updateWorkspaceFolders = (start: number, deleteCount: number) => {
            calls.push(`updateWorkspaceFolders:${start}:${deleteCount}`);
            setWorkspaceFoldersForTest(vscode.Uri.file(os.tmpdir()));
            return true;
        };
        (vscode.commands as any).executeCommand = async (command: string, arg?: unknown) => {
            calls.push(command);
            if (command===`${ROOT_NAME}.remoteFileSystem.deactivateProject`) {
                calls.push((arg as vscode.Uri).toString());
            }
            if (command===`${ROOT_NAME}.remoteFileSystem.activateProject`) {
                assert.strictEqual((arg as vscode.Uri).toString(), newProjectUri.toString());
                return { origin: newProjectUri };
            }
            if (command===`${ROOT_NAME}.projectSCM.newExactLocalReplicaSCM`) {
                return undefined;
            }
            return undefined;
        };

        await provider.selectProjectFolderLocalReplica({
            uri: newProjectUri.toString(),
            label: 'New Project',
        } as any);

        const oldDeactivateIndex = calls.indexOf(`${ROOT_NAME}.remoteFileSystem.deactivateProject`);
        const activateIndex = calls.indexOf(`${ROOT_NAME}.remoteFileSystem.activateProject`);
        assert.notStrictEqual(oldDeactivateIndex, -1);
        assert.notStrictEqual(activateIndex, -1);
        assert.ok(oldDeactivateIndex<activateIndex);
        assert.ok(calls.includes(oldProjectUri.toString()));
        assert.ok(calls.includes(newProjectUri.toString()));
        assert.ok(calls.includes('updateWorkspaceFolders:0:1'));
        assert.strictEqual(getActiveReplicaRoot(), undefined);
    });

    test('uses remote-authoritative cleanup only when resetLocalFilesToRemote is explicit', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v1');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.png'), Buffer.from([1, 2, 3]));
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), Buffer.from('%PDF old\n', 'utf-8'));

        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'local stale');
        await writeText(vscode.Uri.joinPath(localRoot, 'local-only.tex'), 'must disappear');

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v2');
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.png'));
        await vscode.workspace.fs.rename(
            vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'),
            vscode.Uri.joinPath(remoteRoot, 'paper-renamed.pdf'),
            {overwrite: false},
        );

        const restartedScm = createSCM(remoteRoot, localRoot);
        await restartedScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'remote v2');
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'figures', 'plot.png')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'supplement.pdf')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'paper-renamed.pdf')), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'local-only.tex')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, '.semantic-researcher-overleaf', 'settings.json')), true);
    });

    test('remote-authoritative reset deletes visible local-only files while preserving hidden local state', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-hidden-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote text');
        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'local stale');
        await writeText(vscode.Uri.joinPath(localRoot, 'local-only.tex'), 'delete me');
        await writeText(vscode.Uri.joinPath(localRoot, 'scratch', 'note.tex'), 'delete me too');
        await writeText(vscode.Uri.joinPath(localRoot, 'scratch', '.keep'), 'keep hidden child');
        await writeText(vscode.Uri.joinPath(localRoot, '.git', 'config'), 'keep git');
        await writeText(vscode.Uri.joinPath(localRoot, '.env'), 'keep env');
        await writeText(vscode.Uri.joinPath(localRoot, '.codex', 'instructions.md'), 'keep codex');
        await writeText(vscode.Uri.joinPath(localRoot, 'AGENTS.md'), 'keep agents');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'remote text');
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'local-only.tex')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'scratch', 'note.tex')), false);
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'scratch', '.keep')), 'keep hidden child');
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, '.git', 'config')), 'keep git');
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, '.env')), 'keep env');
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, '.codex', 'instructions.md')), 'keep codex');
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'AGENTS.md')), 'keep agents');
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, '.semantic-researcher-overleaf', 'settings.json')), true);
    });

    test('does not rerun initial pull when ensuring an already active local replica', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-active-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v1');

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const context = createExtensionContextStub();
        const collection = new SCMCollectionProvider(fakeVfs as unknown as VirtualFileSystem, context);
        const originalInitialize = LocalReplicaSCMProvider.prototype.initializeLocalReplica;
        type InitializeArgs = Parameters<LocalReplicaSCMProvider['initializeLocalReplica']>;
        let initializeCalls = 0;
        LocalReplicaSCMProvider.prototype.initializeLocalReplica = async function (
            this: LocalReplicaSCMProvider,
            ...args: InitializeArgs
        ) {
            initializeCalls += 1;
            return originalInitialize.apply(this, args);
        };

        try {
            const createSCM = (collection as any).createSCM.bind(collection);
            await createSCM(LocalReplicaSCMProvider, localRoot, true, true, {
                preserveExistingLocalFiles: false,
                resetLocalFilesToRemote: true,
            });
            assert.strictEqual(initializeCalls, 1);

            await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v2');
            (collection as any).suspendSCMsByLabel(LocalReplicaSCMProvider.label, localRoot);
            await createSCM(LocalReplicaSCMProvider, localRoot, true, true, {
                preserveExistingLocalFiles: false,
                resetLocalFilesToRemote: true,
            });

            assert.strictEqual(initializeCalls, 1);
            assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'remote v1');
        } finally {
            LocalReplicaSCMProvider.prototype.initializeLocalReplica = originalInitialize;
            collection.dispose();
        }
    });

    test('blocks remote-derived paths that would escape the selected folder', async () => {
        const parentRoot = await tempDir('sr-overleaf-confinement-');
        const remoteRoot = vscode.Uri.joinPath(parentRoot, 'remote');
        const localRoot = vscode.Uri.joinPath(parentRoot, 'local');
        const outsideUri = vscode.Uri.joinPath(parentRoot, 'escape.tex');
        tempRoots.push(parentRoot);
        await vscode.workspace.fs.createDirectory(remoteRoot);
        await vscode.workspace.fs.createDirectory(localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'safe.tex'), 'safe');

        const scm = createSCM(remoteRoot, localRoot);
        await (scm as any).applySync(
            'pull',
            'update',
            '/../escape.tex',
            vscode.Uri.joinPath(remoteRoot, 'safe.tex'),
            outsideUri,
        );

        assert.strictEqual(await pathExists(outsideUri), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'escape.tex')), false);
    });

    test('syncs remote and local changes through file system watchers', async () => {
        const remoteRoot = await tempDir('sr-overleaf-watch-remote-');
        const remoteEventRoot = await tempDir('sr-overleaf-watch-event-');
        const localRoot = await tempDir('sr-overleaf-watch-local-');
        tempRoots.push(remoteRoot, remoteEventRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v1');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), Buffer.from('%PDF old\n', 'utf-8'));

        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };

        const scm = createSCM(remoteRoot, localRoot);
        const triggers = await scm.triggers;
        try {
            const vfsWatcher = watchers[0];
            const localWatcher = watchers[1];
            assert.ok(vfsWatcher);
            assert.ok(localWatcher);

            const remoteEventRelPath = `/${path.basename(remoteEventRoot.fsPath)}/remote-watch.tex`;
            const remoteEventUri = vscode.Uri.joinPath(remoteEventRoot, 'remote-watch.tex');
            const pullWait = waitForSyncComplete(localRoot, remoteEventRelPath, 'pull', 'update');
            await writeText(remoteEventUri, 'remote watcher event');
            vfsWatcher.fireChange(remoteEventUri);
            const pullEvent = await pullWait;
            assert.strictEqual(pullEvent.outcome, 'success');
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(localRoot, path.basename(remoteEventRoot.fsPath), 'remote-watch.tex')),
                'remote watcher event',
            );

            const pushWait = waitForSyncComplete(localRoot, '/main.tex', 'push', 'update');
            await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'local v3');
            localWatcher.fireChange(vscode.Uri.joinPath(localRoot, 'main.tex'));
            const pushEvent = await pushWait;
            assert.strictEqual(pushEvent.outcome, 'success');
            assert.strictEqual(await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')), 'local v3');

            const deleteWait = waitForSyncComplete(localRoot, '/supplement.pdf', 'push', 'delete');
            const createWait = waitForSyncComplete(localRoot, '/paper-renamed.pdf', 'push', 'update');
            await vscode.workspace.fs.rename(
                vscode.Uri.joinPath(localRoot, 'supplement.pdf'),
                vscode.Uri.joinPath(localRoot, 'paper-renamed.pdf'),
                {overwrite: false},
            );
            localWatcher.fireDelete(vscode.Uri.joinPath(localRoot, 'supplement.pdf'));
            localWatcher.fireCreate(vscode.Uri.joinPath(localRoot, 'paper-renamed.pdf'));
            const deleteEvent = await deleteWait;
            const createEvent = await createWait;
            assert.strictEqual(deleteEvent.outcome, 'success');
            assert.strictEqual(createEvent.outcome, 'success');
            assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf')), false);
            assert.deepStrictEqual(
                await readBytes(vscode.Uri.joinPath(remoteRoot, 'paper-renamed.pdf')),
                Buffer.from('%PDF old\n', 'utf-8'),
            );
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });
});
