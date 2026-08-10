import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    LEGACY_REPLICA_SETTINGS_BACKUP_FILE,
    LEGACY_REPLICA_SETTINGS_FILE,
    REPLICA_REMOVAL_TOMBSTONE_FILE,
    REPLICA_SETTINGS_DIR,
    REPLICA_SETTINGS_FILE,
    ROOT_NAME,
    STATE_SERVERS_KEY,
} from '../../consts';
import { ProjectManagerProvider } from '../../core/projectManagerProvider';
import {
    RemoteDocumentMergeConflictError,
    RemoteDocumentWriteAmbiguousError,
    VFSConnectionState,
    VirtualFileSystem,
} from '../../core/remoteFileSystemProvider';
import {
    LocalReplicaSCMProvider,
    isLocalReplicaCompileOutputPath,
    matchesLocalReplicaIgnorePattern,
} from '../../scm/localReplicaSCM';
import { SCMCollectionProvider } from '../../scm/scmCollectionProvider';
import { EventBus, Events } from '../../utils/eventBus';
import { getActiveReplicaRoot, pathToLocalUri, setActiveReplicaRoot } from '../../utils/localReplicaWorkspace';
import * as localReplicaWorkspace from '../../utils/localReplicaWorkspace';

interface PersistRecord {
    enabled: boolean;
    label: string;
    baseUri: string;
    settings: JSON;
}

interface FakeRemoteEntityState {
    entityIds: Map<string, string>;
    entityTypes: Map<string, 'doc' | 'file' | 'folder'>;
    nextEntityId: number;
}

class FakeVirtualFileSystem {
    public readonly origin: vscode.Uri;
    public readonly projectName = 'Select Folder Test';
    public readonly serverName = 'test-server';
    public readonly _userId = 'test-user';
    public readonly projectId = 'test-project';
    public connectionState: VFSConnectionState = 'connected';
    private readonly connectionEmitter = new vscode.EventEmitter<VFSConnectionState>();
    public readonly onDidChangeConnection = this.connectionEmitter.event;
    private static readonly remoteEntityStates = new Map<string, FakeRemoteEntityState>();
    private readonly persists = new Map<string, PersistRecord>();
    private readonly entityState: FakeRemoteEntityState;
    private get entityIds() { return this.entityState.entityIds; }
    private get entityTypes() { return this.entityState.entityTypes; }

    setConnectionState(state: VFSConnectionState) {
        this.connectionState = state;
        this.connectionEmitter.fire(state);
    }

    constructor(
        private readonly remoteRoot: vscode.Uri,
        origin: vscode.Uri = remoteRoot,
    ) {
        const stateKey = remoteRoot.toString();
        let entityState = FakeVirtualFileSystem.remoteEntityStates.get(stateKey);
        if (!entityState) {
            entityState = {
                entityIds: new Map(),
                entityTypes: new Map(),
                nextEntityId: 1,
            };
            FakeVirtualFileSystem.remoteEntityStates.set(stateKey, entityState);
        }
        this.entityState = entityState;
        this.origin = origin;
    }

    private getOrCreateEntityId(relPath: string): string {
        // The project root is the VFS's stable parent sentinel. It is not a
        // remotely replaceable entity, so preserve the established '/' contract
        // while path entities retain independent IDs across test reactivation.
        if (relPath==='/') {
            // Default to the VFS project-root sentinel, but retain an explicit
            // test replacement so guarded parent-ID races remain observable.
            const existingRoot = this.entityIds.get(relPath);
            if (existingRoot!==undefined) { return existingRoot; }
            this.entityIds.set(relPath, '/');
            this.entityTypes.set(relPath, 'folder');
            return '/';
        }
        const existing = this.entityIds.get(relPath);
        if (existing!==undefined) { return existing; }
        const entityId = 'fake-entity-' + this.entityState.nextEntityId++;
        this.entityIds.set(relPath, entityId);
        return entityId;
    }

    pathToUri(...parts: string[]) {
        const segments = parts.flatMap(part => part.split('/').filter(Boolean));
        return vscode.Uri.joinPath(this.remoteRoot, ...segments);
    }

    private relativeKey(uri: vscode.Uri): string {
        const relativePath = path.relative(this.remoteRoot.fsPath, uri.fsPath).split(path.sep).join('/');
        return '/' + relativePath.split('/').filter(Boolean).join('/');
    }

    setEntityId(relPath: string, entityId: string) {
        this.entityIds.set('/' + relPath.split('/').filter(Boolean).join('/'), entityId);
    }

    async _resolveUri(uri: vscode.Uri) {
        const relPath = this.relativeKey(uri);
        const fileName = path.basename(uri.fsPath);
        let isDirectory = false;
        let exists = false;
        try {
            isDirectory = (await vscode.workspace.fs.stat(uri)).type===vscode.FileType.Directory;
            exists = true;
        } catch {
            isDirectory = false;
        }
        const detectedFileType: 'doc' | 'file' | 'folder' = isDirectory
            ? 'folder'
            : /\.tex$/i.test(fileName) ? 'doc' : 'file';
        const parentRelPath = relPath==='/' ? '/' : path.posix.dirname(relPath);
        let fileType = detectedFileType;
        if (exists) {
            fileType = this.entityTypes.get(relPath) ?? detectedFileType;
            this.getOrCreateEntityId(relPath);
            this.getOrCreateEntityId(parentRelPath);
            this.entityTypes.set(relPath, fileType);
            this.entityTypes.set(parentRelPath, 'folder');
        }
        return {
            parentFolder: {
                _id: this.entityIds.get(parentRelPath) ?? parentRelPath,
                name: path.posix.basename(parentRelPath),
                _type: 'folder',
            },
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

    _resolveById(entityId: string) {
        for (const [relPath, id] of this.entityIds) {
            if (id!==entityId) { continue; }
            const fileName = path.posix.basename(relPath);
            const fileType = this.entityTypes.get(relPath)
                ?? (relPath==='/' || !path.extname(fileName)
                    ? 'folder'
                    : (/\.tex$/i.test(fileName) ? 'doc' : 'file'));
            return {
                parentFolder: {
                    _id: this.entityIds.get(path.posix.dirname(relPath))
                        ?? path.posix.dirname(relPath),
                    name: path.posix.basename(path.posix.dirname(relPath)),
                    _type: 'folder',
                },
                fileEntity: {
                    _id: id,
                    name: fileName,
                    _type: fileType,
                    linkedFileData: null,
                    created: new Date(0).toISOString(),
                },
                fileType,
                path: relPath,
            };
        }
        return undefined;
    }

    async rename(
        oldUri: vscode.Uri,
        newUri: vscode.Uri,
        force: boolean,
        expectedEntity?: {id: string; type: 'doc' | 'file' | 'folder'; parentId?: string},
    ) {
        const oldKey = this.relativeKey(oldUri);
        let actualType: 'doc' | 'file' | 'folder';
        try {
            await vscode.workspace.fs.stat(oldUri);
            actualType = (await this._resolveUri(oldUri)).fileType;
        } catch {
            throw vscode.FileSystemError.FileNotFound(oldUri);
        }
        if (
            expectedEntity
            && (
                (this.entityIds.get(oldKey) ?? oldKey)!==expectedEntity.id
                || actualType!==expectedEntity.type
                || (
                    expectedEntity.parentId!==undefined
                    && (this.entityIds.get(path.posix.dirname(oldKey)) ?? path.posix.dirname(oldKey))!==expectedEntity.parentId
                )
            )
        ) {
            throw vscode.FileSystemError.Unavailable('unexpected remote entity');
        }
        if (!force && await pathExists(newUri)) {
            throw vscode.FileSystemError.FileExists(newUri);
        }
        await vscode.workspace.fs.rename(oldUri, newUri, {overwrite: force});
        const newKey = this.relativeKey(newUri);
        const movedIds = [...this.entityIds.entries()]
            .filter(([key]) => key===oldKey || key.startsWith(oldKey+'/'));
        const movedTypes = [...this.entityTypes.entries()]
            .filter(([key]) => key===oldKey || key.startsWith(oldKey+'/'));
        for (const [key, id] of movedIds) {
            this.entityIds.delete(key);
            this.entityIds.set(newKey + key.slice(oldKey.length), id);
        }
        for (const [key, type] of movedTypes) {
            this.entityTypes.delete(key);
            this.entityTypes.set(newKey + key.slice(oldKey.length), type);
        }
        if (movedIds.length===0) {
            this.getOrCreateEntityId(newKey);
            this.entityTypes.set(newKey, actualType);
        }
    }

    async remove(
        uri: vscode.Uri,
        recursive: boolean,
        expectedEntity?: {id: string; type: 'doc' | 'file' | 'folder'; parentId?: string},
    ) {
        const resolved = await this._resolveUri(uri);
        if (
            expectedEntity
            && (
                resolved.fileType!==expectedEntity.type
                || resolved.fileEntity._id!==expectedEntity.id
                || (
                    expectedEntity.parentId!==undefined
                    && resolved.parentFolder._id!==expectedEntity.parentId
                )
            )
        ) {
            throw vscode.FileSystemError.Unavailable('unexpected remote entity');
        }
        if (!await pathExists(uri)) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        await vscode.workspace.fs.delete(uri, {recursive});
        const key = this.relativeKey(uri);
        for (const pathKey of [...this.entityIds.keys()]) {
            if (pathKey===key || pathKey.startsWith(key+'/')) {
                this.entityIds.delete(pathKey);
                this.entityTypes.delete(pathKey);
            }
        }
    }

    async ensureConnectedForWrite() {}

    async createFileIfMissing(
        uri: vscode.Uri,
        content: Uint8Array,
        expectedParentId?: string,
    ) {
        const current = await this._resolveUri(uri);
        const parentId = current.parentFolder._id;
        if (expectedParentId!==undefined && parentId!==expectedParentId) {
            throw new RemoteDocumentMergeConflictError(
                'Overleaf parent folder changed before the local file create: ' + uri.path,
            );
        }
        if (await pathExists(uri)) {
            if (current.fileType!=='doc' && current.fileType!=='file') {
                throw new RemoteDocumentMergeConflictError(
                    'Overleaf path has a different type while the local file was being created: ' + uri.path,
                );
            }
            return {
                created: false,
                entityId: current.fileEntity._id,
                entityType: current.fileType,
                parentId,
            };
        }
        await this.writeFileFromRemoteBaseline(uri, content, undefined, true);
        const created = await this._resolveUri(uri);
        if (
            (created.fileType!=='doc' && created.fileType!=='file')
            || !created.fileEntity?._id
        ) {
            throw new Error('Fake VFS did not create a regular file entity.');
        }
        return {
            created: true,
            entityId: created.fileEntity._id,
            entityType: created.fileType,
            parentId,
        };
    }
    async writeFileFromRemoteBaseline(
        uri: vscode.Uri,
        content: Uint8Array,
        _remoteBaseline?: Uint8Array,
        expectedRemoteMissing = false,
        expectedEntity?: {id: string; type: 'doc' | 'file'; parentId?: string},
    ) {
        const assertExpectedEntity = async () => {
            if (!expectedEntity) { return; }
            const resolved = await this._resolveUri(uri);
            if (
                resolved.fileType!==expectedEntity.type
                || resolved.fileEntity._id!==expectedEntity.id
                || (
                    expectedEntity.parentId!==undefined
                    && resolved.parentFolder._id!==expectedEntity.parentId
                )
            ) {
                throw new RemoteDocumentMergeConflictError(
                    'unexpected remote entity while writing: ' + uri.path,
                );
            }
        };
        await assertExpectedEntity();
        if (expectedRemoteMissing && await pathExists(uri)) {
            const remoteContent = await vscode.workspace.fs.readFile(uri);
            if (Buffer.compare(Buffer.from(remoteContent), Buffer.from(content))===0) {
                return content;
            }
            throw new RemoteDocumentMergeConflictError(
                `Overleaf path appeared while the local file was being created: ${uri.path}`,
            );
        }
        await assertExpectedEntity();
        await vscode.workspace.fs.writeFile(uri, content);
        return content;
    }

    async createDirectoryIfMissing(uri: vscode.Uri) {
        if (await pathExists(uri)) {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type===vscode.FileType.Directory) {
                const resolved = await this._resolveUri(uri);
                return {
                    created: false,
                    entityId: resolved.fileEntity._id,
                    parentId: resolved.parentFolder._id,
                };
            }
            throw new RemoteDocumentMergeConflictError(
                `Overleaf path has a different type while the local folder was being created: ${uri.path}`,
            );
        }
        await vscode.workspace.fs.createDirectory(uri);
        const resolved = await this._resolveUri(uri);
        return {
            created: true,
            entityId: resolved.fileEntity._id,
            parentId: resolved.parentFolder._id,
        };
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2000) {
    const deadline = Date.now()+timeoutMs;
    while (!predicate()) {
        if (Date.now()>=deadline) {
            throw new Error('Timed out waiting for test condition');
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

async function waitUntilAsync(
    predicate: () => Promise<boolean>,
    timeoutMs = 2000,
) {
    const deadline = Date.now()+timeoutMs;
    while (!await predicate()) {
        if (Date.now()>=deadline) {
            throw new Error('Timed out waiting for asynchronous test condition');
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

async function readText(uri: vscode.Uri) {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
}

async function readBytes(uri: vscode.Uri) {
    return Buffer.from(await vscode.workspace.fs.readFile(uri));
}

function sha1(content: Uint8Array | string) {
    return crypto.createHash('sha1').update(content).digest('hex');
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

async function writeReplicaSettings(root: vscode.Uri, projectUri: vscode.Uri) {
    await writeText(settingsUri(root), JSON.stringify({
        uri: projectUri.toString(),
        serverName: 'test-server',
        enableCompileNPreview: true,
        projectName: 'Select Folder Test',
    }));
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
    const scm = new LocalReplicaSCMProvider(fakeVfs as unknown as VirtualFileSystem, localRoot);
    createdSCMsForTest.push(scm);
    return scm;
}

const createdSCMsForTest: LocalReplicaSCMProvider[] = [];

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
                    name: 'Select Folder Test',
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

    test('matches protected, LaTeX, and brace ignore globs without brace expansion', () => {
        assert.strictEqual(
            matchesLocalReplicaIgnorePattern('/chapter/.cache/state.json', '**/.*/**'),
            true,
        );
        assert.strictEqual(
            matchesLocalReplicaIgnorePattern('/chapter/main.aux', '**/*.aux'),
            true,
        );
        assert.strictEqual(
            matchesLocalReplicaIgnorePattern('/figures/plot.png', '**/*.{png,jpg}'),
            true,
        );
        assert.strictEqual(
            matchesLocalReplicaIgnorePattern('/figures/plot.pdf', '**/*.{png,jpg}'),
            false,
        );
    });

    const tempRoots: vscode.Uri[] = [];
    let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
    let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
    let originalShowErrorMessage: typeof vscode.window.showErrorMessage;
    let originalShowQuickPick: typeof vscode.window.showQuickPick;
    test('filters configured extension output folders, not source PDF filenames', () => {
        assert.strictEqual(isLocalReplicaCompileOutputPath('/.output/output.pdf'), true);
        assert.strictEqual(isLocalReplicaCompileOutputPath('/main.pdf'), false);
        assert.strictEqual(isLocalReplicaCompileOutputPath('/output.pdf'), false);
        assert.strictEqual(
            isLocalReplicaCompileOutputPath('/build/output.pdf', 'build'),
            true,
        );
        assert.strictEqual(
            isLocalReplicaCompileOutputPath('/rebuild/output.pdf', 'build'),
            false,
        );
        assert.strictEqual(
            isLocalReplicaCompileOutputPath('/build/output.pdf', '../build'),
            false,
        );
    });

    let originalShowTextDocument: typeof vscode.window.showTextDocument;
    let originalCreateWebviewPanel: typeof vscode.window.createWebviewPanel;
    let originalCreateFileSystemWatcher: typeof vscode.workspace.createFileSystemWatcher;
    let originalExecuteCommand: typeof vscode.commands.executeCommand;
    let originalUpdateWorkspaceFolders: typeof vscode.workspace.updateWorkspaceFolders;
    let originalWorkspaceFoldersDescriptor: PropertyDescriptor | undefined;
    let originalActiveTextEditorDescriptor: PropertyDescriptor | undefined;
    let originalWatcherProbeTimeoutMs: number;
    let originalWatcherHealthIntervalMs: number;
    let originalFallbackScanIntervalMs: number;
    let originalShouldUseDirectLocalWatcher: () => boolean;
    let originalCreateDirectLocalWatcher: unknown;
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

    async function createFolderDeleteConflictFixture(prefix: string) {
        const remoteRoot = await tempDir('sr-overleaf-' + prefix + '-remote-');
        const localRoot = await tempDir('sr-overleaf-' + prefix + '-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteFolder = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const remoteImage = vscode.Uri.joinPath(remoteFolder, 'figures', 'a.png');
        const remotePdf = vscode.Uri.joinPath(remoteFolder, 'paper.pdf');
        const localFolder = vscode.Uri.joinPath(localRoot, 'chapter');
        const localImage = vscode.Uri.joinPath(localFolder, 'figures', 'a.png');
        const localPdf = vscode.Uri.joinPath(localFolder, 'paper.pdf');
        const localZip = vscode.Uri.joinPath(localFolder, 'local-only.zip');
        const remoteImageContent = Buffer.from([1, 2, 3]);
        const remotePdfContent = Buffer.from([4, 5, 6]);
        const localPdfContent = Buffer.from([7, 8, 9]);
        const localZipContent = Buffer.from([10, 11, 12]);
        await writeBytes(remoteImage, remoteImageContent);
        await writeBytes(remotePdf, remotePdfContent);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(remoteFolder, 'empty'));
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localPdf, localPdfContent);
        await vscode.workspace.fs.delete(localImage);
        await writeBytes(localZip, localZipContent);
        await vscode.workspace.fs.delete(remoteFolder, {recursive: true});

        const conflict = await (scm as any).applySync(
            'pull',
            'delete',
            '/chapter',
            remoteFolder,
            localFolder,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflict.outcome, 'blocked');
        assert.ok((scm as any).syncConflicts.has('/chapter'));
        return {
            scm,
            remoteRoot,
            localRoot,
            remoteFolder,
            localFolder,
            localPdf,
            localZip,
            localPdfContent,
            localZipContent,
        };
    }

    async function createFolderReplacementConflictFixture(prefix: string) {
        const remoteRoot = await tempDir('sr-overleaf-' + prefix + '-remote-');
        const localRoot = await tempDir('sr-overleaf-' + prefix + '-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteFolder = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const remoteImage = vscode.Uri.joinPath(remoteFolder, 'figures', 'a.png');
        const remotePdf = vscode.Uri.joinPath(remoteFolder, 'paper.pdf');
        const localFolder = vscode.Uri.joinPath(localRoot, 'chapter');
        const localPdf = vscode.Uri.joinPath(localFolder, 'paper.pdf');
        const localZip = vscode.Uri.joinPath(localFolder, 'local-only.zip');
        const remoteImageContent = Buffer.from([1, 2, 3]);
        const remotePdfContent = Buffer.from([4, 5, 6]);
        const localPdfContent = Buffer.from([7, 8, 9]);
        const localZipContent = Buffer.from([10, 11, 12]);
        await writeBytes(remoteImage, remoteImageContent);
        await writeBytes(remotePdf, remotePdfContent);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(remoteFolder, 'empty'));
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeBytes(localPdf, localPdfContent);
        await writeBytes(localZip, localZipContent);
        await vscode.workspace.fs.delete(remoteFolder, {recursive: true});
        const replacementTex = vscode.Uri.joinPath(remoteFolder, 'remote.tex');
        const replacementImage = vscode.Uri.joinPath(remoteFolder, 'figures', 'new.png');
        const replacementTexContent = 'remote canonical replacement';
        const replacementImageContent = Buffer.from([31, 32, 33, 34]);
        await writeText(replacementTex, replacementTexContent);
        await writeBytes(replacementImage, replacementImageContent);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(remoteFolder, 'new-empty'));
        fakeVfs.setEntityId('/chapter', 'replacement-folder-id');
        fakeVfs.setEntityId('/chapter/remote.tex', 'replacement-document-id');
        fakeVfs.setEntityId('/chapter/figures', 'replacement-figures-id');
        fakeVfs.setEntityId('/chapter/figures/new.png', 'replacement-image-id');
        fakeVfs.setEntityId('/chapter/new-empty', 'replacement-empty-id');
        const remoteState = await (scm as any).captureRemotePathRevision('/chapter');
        await (scm as any).markSyncConflict(
            '/chapter',
            'test remote folder replacement conflict',
            undefined,
            undefined,
            remoteState,
        );
        assert.ok((scm as any).syncConflicts.has('/chapter'));
        return {
            scm,
            fakeVfs,
            remoteRoot,
            localRoot,
            remoteFolder,
            localFolder,
            localPdf,
            localZip,
            localPdfContent,
            localZipContent,
            replacementTex,
            replacementImage,
            replacementTexContent,
            replacementImageContent,
        };
    }

    async function createBinaryConflictFixture(
        prefix: string,
        relativePath = 'figure.png',
    ) {
        const remoteRoot = await tempDir('sr-overleaf-' + prefix + '-remote-');
        const localRoot = await tempDir('sr-overleaf-' + prefix + '-local-');
        tempRoots.push(remoteRoot, localRoot);
        const relPath = '/' + relativePath.split('/').filter(Boolean).join('/');
        const segments = relPath.split('/').filter(Boolean);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, ...segments);
        const localImage = vscode.Uri.joinPath(localRoot, ...segments);
        const baseline = Buffer.from([1, 2, 3]);
        const localContent = Buffer.from([4, 5, 6]);
        const remoteContent = Buffer.from([7, 8, 9]);
        await writeBytes(remoteImage, baseline);
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, localContent);
        await writeBytes(remoteImage, remoteContent);
        const conflict = await (scm as any).applySync(
            'pull',
            'update',
            relPath,
            remoteImage,
            localImage,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflict.outcome, 'blocked');
        assert.ok((scm as any).syncConflicts.has(relPath));
        return {
            scm,
            relPath,
            remoteRoot,
            localRoot,
            remoteImage,
            localImage,
            localContent,
            remoteContent,
        };
    }


    async function createTextConflictFixture(
        prefix: string,
        relativePath = 'main.tex',
    ) {
        const remoteRoot = await tempDir('sr-overleaf-' + prefix + '-remote-');
        const localRoot = await tempDir('sr-overleaf-' + prefix + '-local-');
        tempRoots.push(remoteRoot, localRoot);
        const relPath = '/' + relativePath.split('/').filter(Boolean).join('/');
        const segments = relPath.split('/').filter(Boolean);
        const remoteFile = vscode.Uri.joinPath(remoteRoot, ...segments);
        const localFile = vscode.Uri.joinPath(localRoot, ...segments);
        const baseContent = '\\title{Base}\\nBody: base\\n';
        const localContent = '\\title{Local}\\nBody: base\\n';
        const remoteContent = '\\title{Remote}\\nBody: base\\n';
        await writeText(remoteFile, baseContent);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localFile, localContent);
        await writeText(remoteFile, remoteContent);
        const conflict = await (scm as any).applySync(
            'pull',
            'update',
            relPath,
            remoteFile,
            localFile,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflict.outcome, 'blocked');
        assert.ok((scm as any).syncConflicts.has(relPath));
        const conflictEntry = (scm as any).syncManifest.conflicts[relPath];
        assert.strictEqual(conflictEntry.mergeBaseRevision, sha1(baseContent));
        assert.strictEqual(conflictEntry.mergeRemoteEntity.type, 'doc');
        return {
            scm,
            fakeVfs,
            relPath,
            remoteRoot,
            localRoot,
            remoteFile,
            localFile,
            baseContent,
            localContent,
            remoteContent,
        };
    }

    setup(() => {
        localReplicaWorkspaceState.clear();
        restoreLocalReplicaWorkspaceContext = localReplicaWorkspace.configureLocalReplicaWorkspace({
            workspaceState: localReplicaWorkspaceMemento,
            subscriptions: localReplicaWorkspaceSubscriptions,
        } as unknown as vscode.ExtensionContext);
        originalShowWarningMessage = vscode.window.showWarningMessage;
        originalShowInformationMessage = vscode.window.showInformationMessage;
        originalShowErrorMessage = vscode.window.showErrorMessage;
        originalShowQuickPick = vscode.window.showQuickPick;
        originalShowTextDocument = vscode.window.showTextDocument;
        originalCreateWebviewPanel = vscode.window.createWebviewPanel;
        originalCreateFileSystemWatcher = vscode.workspace.createFileSystemWatcher;
        originalExecuteCommand = vscode.commands.executeCommand;
        originalUpdateWorkspaceFolders = vscode.workspace.updateWorkspaceFolders;
        originalWorkspaceFoldersDescriptor = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
        originalActiveTextEditorDescriptor = Object.getOwnPropertyDescriptor(vscode.window, 'activeTextEditor');
        originalWatcherProbeTimeoutMs = (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs;
        originalWatcherHealthIntervalMs = (LocalReplicaSCMProvider as any).watcherHealthIntervalMs;
        originalFallbackScanIntervalMs = (LocalReplicaSCMProvider as any).fallbackScanIntervalMs;
        originalShouldUseDirectLocalWatcher = (LocalReplicaSCMProvider as any).shouldUseDirectLocalWatcher;
        originalCreateDirectLocalWatcher = (LocalReplicaSCMProvider as any).createDirectLocalWatcher;
        (LocalReplicaSCMProvider as any).shouldUseDirectLocalWatcher = () => false;
        (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs = 60_000;
        (LocalReplicaSCMProvider as any).watcherHealthIntervalMs = 60_000;
    });

    teardown(async () => {
        (vscode.window as any).showWarningMessage = originalShowWarningMessage;
        (vscode.window as any).showInformationMessage = originalShowInformationMessage;
        (vscode.window as any).showErrorMessage = originalShowErrorMessage;
        (vscode.window as any).showQuickPick = originalShowQuickPick;
        (vscode.window as any).showTextDocument = originalShowTextDocument;
        (vscode.window as any).createWebviewPanel = originalCreateWebviewPanel;
        (vscode.workspace as any).createFileSystemWatcher = originalCreateFileSystemWatcher;
        (vscode.commands as any).executeCommand = originalExecuteCommand;
        (vscode.workspace as any).updateWorkspaceFolders = originalUpdateWorkspaceFolders;
        (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs = originalWatcherProbeTimeoutMs;
        (LocalReplicaSCMProvider as any).watcherHealthIntervalMs = originalWatcherHealthIntervalMs;
        (LocalReplicaSCMProvider as any).fallbackScanIntervalMs = originalFallbackScanIntervalMs;
        (LocalReplicaSCMProvider as any).shouldUseDirectLocalWatcher = originalShouldUseDirectLocalWatcher;
        (LocalReplicaSCMProvider as any).createDirectLocalWatcher = originalCreateDirectLocalWatcher;
        await Promise.allSettled(
            createdSCMsForTest.splice(0).map(scm => scm.deactivate()),
        );
        await setActiveReplicaRoot(undefined);
        if (originalWorkspaceFoldersDescriptor) {
            Object.defineProperty(vscode.workspace, 'workspaceFolders', originalWorkspaceFoldersDescriptor);
        }
        if (originalActiveTextEditorDescriptor) {
            Object.defineProperty(vscode.window, 'activeTextEditor', originalActiveTextEditorDescriptor);
        } else {
            delete (vscode.window as any).activeTextEditor;
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
        const repoRoot = vscode.Uri.file(
            process.env.VSCODE_TEST_REPOSITORY_ROOT
                ? path.resolve(process.env.VSCODE_TEST_REPOSITORY_ROOT)
                : path.resolve(__dirname, '..', '..', '..'),
        );
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

    test('treats an Overleaf project rename as the same Local Replica project', async () => {
        const localRoot = await tempDir('sr-overleaf-renamed-project-');
        tempRoots.push(localRoot);
        const oldProjectUri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Old%20Name?user=user-1&project=project-1',
        );
        const renamedProjectUri = oldProjectUri.with({path: '/Renamed Project'});
        await writeReplicaSettings(localRoot, oldProjectUri);
        await writeText(vscode.Uri.joinPath(localRoot, 'stale.tex'), 'stale');

        let prompted = false;
        (vscode.window as any).showWarningMessage = async () => {
            prompted = true;
            return undefined;
        };

        const validated = await LocalReplicaSCMProvider.validateExactBaseUri(localRoot.fsPath, {
            projectUri: renamedProjectUri,
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
        const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
        const csvBytes = Buffer.from('seed,metric\n1,0.91\n', 'utf-8');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote text');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.png'), pngBytes);
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), pdfBytes);
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'main.pdf'), pdfBytes);
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'output.pdf'), pdfBytes);
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'archive', 'source.zip'), zipBytes);
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'data', 'metrics.csv'), csvBytes);
        await writeBytes(
            vscode.Uri.joinPath(remoteRoot, '.output', 'output.pdf'),
            Buffer.from('%PDF extension output\n', 'utf-8'),
        );

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'remote text');
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(localRoot, 'figures', 'plot.png')), pngBytes);
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(localRoot, 'supplement.pdf')), pdfBytes);
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(localRoot, 'main.pdf')), pdfBytes);
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(localRoot, 'output.pdf')), pdfBytes);
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(localRoot, 'archive', 'source.zip')), zipBytes);
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(localRoot, 'data', 'metrics.csv')), csvBytes);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, '.output', 'output.pdf')), false);
    });

    test('pushes local text and media edits back to remote', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote text');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf'), Buffer.from('%PDF old\n', 'utf-8'));
        const localZip = vscode.Uri.joinPath(localRoot, 'archive', 'source.zip');
        const localCsv = vscode.Uri.joinPath(localRoot, 'data', 'metrics.csv');
        const localNamedMainPdf = vscode.Uri.joinPath(localRoot, 'main.pdf');
        const localNamedOutputPdf = vscode.Uri.joinPath(localRoot, 'output.pdf');
        const localExtensionOutput = vscode.Uri.joinPath(localRoot, '.output', 'output.pdf');

        const scm = createSCM(remoteRoot, localRoot);
        const nextZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 4, 5, 6]);
        const nextCsv = Buffer.from('seed,metric\n2,0.97\n', 'utf-8');
        const nextNamedMainPdf = Buffer.from('%PDF named main source\n', 'utf-8');
        const nextNamedOutputPdf = Buffer.from('%PDF named output source\n', 'utf-8');
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeBytes(localZip, nextZip);
        await writeBytes(localCsv, nextCsv);
        await writeBytes(localNamedMainPdf, nextNamedMainPdf);
        await writeBytes(localNamedOutputPdf, nextNamedOutputPdf);
        await writeBytes(localExtensionOutput, Buffer.from('%PDF local extension output\n', 'utf-8'));
        const localPdf = vscode.Uri.joinPath(localRoot, 'supplement.pdf');
        const nextPdf = Buffer.from('%PDF new\nbinary-ish\n', 'utf-8');
        await writeText(localMain, 'local text');
        await scm.flushPendingPush(localZip);
        await scm.flushPendingPush(localCsv);
        await scm.flushPendingPush(localNamedMainPdf);
        await scm.flushPendingPush(localNamedOutputPdf);
        await scm.flushPendingPush(localExtensionOutput);
        await writeBytes(localPdf, nextPdf);

        await scm.flushPendingPush(localMain);
        await scm.flushPendingPush(localPdf);
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(remoteRoot, 'archive', 'source.zip')), nextZip);
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(remoteRoot, 'data', 'metrics.csv')), nextCsv);
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(remoteRoot, 'main.pdf')), nextNamedMainPdf);
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(remoteRoot, 'output.pdf')), nextNamedOutputPdf);
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(remoteRoot, '.output', 'output.pdf')),
            false,
        );

        assert.strictEqual(await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')), 'local text');
        assert.deepStrictEqual(await readBytes(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf')), nextPdf);
    });

    test('persists an ambiguous document acknowledgement as a conflict without retrying', async () => {
        const remoteRoot = await tempDir('sr-overleaf-ambiguous-remote-');
        const localRoot = await tempDir('sr-overleaf-ambiguous-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'remote baseline');

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'local revision');

        let writeCount = 0;
        fakeVfs.writeFileFromRemoteBaseline = async () => {
            writeCount += 1;
            throw new RemoteDocumentWriteAmbiguousError('ambiguous OT acknowledgement');
        };
        const result = await (scm as any).applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(result.outcome, 'blocked');
        assert.strictEqual(writeCount, 1);
        assert.strictEqual(await readText(remoteMain), 'remote baseline');
        assert.match((scm as any).syncConflicts.get('/main.tex'), /ambiguous OT acknowledgement/);
        assert.ok((scm as any).syncManifest.conflicts['/main.tex']);
    });

    test('does not suppress a legitimate local revert to an older pushed digest', async () => {
        const remoteRoot = await tempDir('sr-overleaf-echo-revert-remote-');
        const localRoot = await tempDir('sr-overleaf-echo-revert-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'base');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(localMain, 'state A');
        const firstPush = await (scm as any).applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(firstPush.outcome, 'success');

        await writeText(remoteMain, 'state B');
        const collaboratorPull = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(collaboratorPull.outcome, 'success');
        assert.strictEqual(await readText(localMain), 'state B');

        await writeText(localMain, 'state A');
        const revertPush = await (scm as any).applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(revertPush.outcome, 'success');
        assert.strictEqual(await readText(remoteMain), 'state A');
    });

    test('retries identical media bytes after an upload failure', async () => {
        const remoteRoot = await tempDir('sr-overleaf-media-retry-remote-');
        const localRoot = await tempDir('sr-overleaf-media-retry-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        await writeBytes(remoteImage, Buffer.from([1, 2, 3]));
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const changedBytes = Buffer.from([9, 8, 7, 6]);
        await writeBytes(localImage, changedBytes);

        const originalCreateFileWithRetry = (scm as any).createFileWithRetry.bind(scm);
        let failUpload = true;
        (scm as any).createFileWithRetry = async (...args: unknown[]) => {
            if (failUpload) {
                throw new Error('simulated media upload failure');
            }
            return originalCreateFileWithRetry(...args);
        };

        try {
            const failed = await (scm as any).applySync(
                'push',
                'update',
                '/figure.png',
                localImage,
                remoteImage,
            ) as Events['scmSyncCompleteEvent'];
            assert.strictEqual(failed.outcome, 'error');
            assert.deepStrictEqual(await readBytes(remoteImage), Buffer.from([1, 2, 3]));

            failUpload = false;
            const retried = await (scm as any).applySync(
                'push',
                'update',
                '/figure.png',
                localImage,
                remoteImage,
            ) as Events['scmSyncCompleteEvent'];
            assert.strictEqual(retried.outcome, 'success');
            assert.deepStrictEqual(await readBytes(remoteImage), changedBytes);
        } finally {
            (scm as any).createFileWithRetry = originalCreateFileWithRetry;
        }
    });

    test('restores binary bytes when the replacement rename response is lost', async () => {
        const remoteRoot = await tempDir('sr-overleaf-media-rename-loss-remote-');
        const localRoot = await tempDir('sr-overleaf-media-rename-loss-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const baseline = Buffer.from([1, 2, 3]);
        await writeBytes(remoteImage, baseline);
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, Buffer.from([9, 8, 7]));

        const originalRename = (scm as any).renameRemotePathForDelete.bind(scm);
        let loseResponse = true;
        (scm as any).renameRemotePathForDelete = async (...args: unknown[]) => {
            await originalRename(...args);
            if (loseResponse) {
                loseResponse = false;
                throw new Error('simulated lost binary staging response');
            }
        };

        const result = await (scm as any).applySync(
            'push',
            'update',
            '/figure.png',
            localImage,
            remoteImage,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(result.outcome, 'error');
        assert.deepStrictEqual(await readBytes(remoteImage), baseline);
        const remoteEntries = await vscode.workspace.fs.readDirectory(remoteRoot);
        assert.deepStrictEqual(
            remoteEntries.filter(([name]) => name.startsWith('.sr-overleaf-replace-')),
            [],
        );
    });

    test('accepts a binary upload whose success response is lost', async () => {
        const remoteRoot = await tempDir('sr-overleaf-media-upload-loss-remote-');
        const localRoot = await tempDir('sr-overleaf-media-upload-loss-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const replacement = Buffer.from([9, 8, 7, 6]);
        await writeBytes(remoteImage, Buffer.from([1, 2, 3]));
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, replacement);

        const originalPushWithRetry = (scm as any).pushWithRetry.bind(scm);
        let loseResponse = true;
        (scm as any).pushWithRetry = async (...args: unknown[]) => {
            const result = await originalPushWithRetry(...args);
            if (loseResponse) {
                loseResponse = false;
                throw new Error('simulated lost binary upload response');
            }
            return result;
        };

        const result = await (scm as any).applySync(
            'push',
            'update',
            '/figure.png',
            localImage,
            remoteImage,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(result.outcome, 'success');
        assert.deepStrictEqual(await readBytes(remoteImage), replacement);
        const remoteEntries = await vscode.workspace.fs.readDirectory(remoteRoot);
        assert.deepStrictEqual(
            remoteEntries.filter(([name]) => name.startsWith('.sr-overleaf-replace-')),
            [],
        );
    });

    test('does not retry an explicitly rejected remote create', async () => {
        const remoteRoot = await tempDir('sr-overleaf-create-rejected-remote-');
        const localRoot = await tempDir('sr-overleaf-create-rejected-local-');
        tempRoots.push(remoteRoot, localRoot);

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const localFile = vscode.Uri.joinPath(localRoot, 'rejected.tex');
        const remoteFile = vscode.Uri.joinPath(remoteRoot, 'rejected.tex');
        await writeText(localFile, 'local content');

        let attempts = 0;
        fakeVfs.writeFileFromRemoteBaseline = async () => {
            attempts += 1;
            const error = new Error('explicit remote create rejection') as Error & {
                retryable: boolean;
            };
            error.retryable = false;
            throw error;
        };

        const result = await (scm as any).applySync(
            'push',
            'update',
            '/rejected.tex',
            localFile,
            remoteFile,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(result.outcome, 'error');
        assert.strictEqual(attempts, 1);
        assert.strictEqual(await pathExists(remoteFile), false);
        assert.strictEqual((scm as any).locallyDivergedPaths.has('/rejected.tex'), true);
    });

    test('retains delete state after failure and retries it at the compile barrier', async () => {
        const remoteRoot = await tempDir('sr-overleaf-delete-retry-remote-');
        const localRoot = await tempDir('sr-overleaf-delete-retry-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteNote = vscode.Uri.joinPath(remoteRoot, 'note.tex');
        const localNote = vscode.Uri.joinPath(localRoot, 'note.tex');
        await writeText(remoteNote, 'delete me');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localNote);

        const originalWithRetry = (scm as any).withRetry.bind(scm);
        let failDelete = true;
        (scm as any).withRetry = async (
            label: 'push' | 'pull',
            relPath: string,
            task: () => Promise<unknown>,
            options?: unknown,
        ) => {
            if (failDelete && label==='push') {
                throw new Error('simulated remote delete failure');
            }
            return originalWithRetry(label, relPath, task, options);
        };

        try {
            const failed = await (scm as any).applySync(
                'push',
                'delete',
                '/note.tex',
                localNote,
                remoteNote,
            ) as Events['scmSyncCompleteEvent'];
            assert.strictEqual(failed.outcome, 'error');
            assert.strictEqual(await pathExists(remoteNote), true);
            assert.ok((scm as any).syncManifest.files['/note.tex']);
            assert.ok((scm as any).baseCache['/note.tex']);

            failDelete = false;
            const flush = await scm.flushBeforeCompile([]);
            assert.strictEqual(flush.failedCount, 0);
            assert.strictEqual(await pathExists(remoteNote), false);
            assert.strictEqual((scm as any).syncManifest.files['/note.tex'], undefined);
        } finally {
            (scm as any).withRetry = originalWithRetry;
        }
    });

    test('cancels an in-flight retry when the Local Replica is deactivated', async () => {
        const remoteRoot = await tempDir('sr-overleaf-cancel-retry-remote-');
        const localRoot = await tempDir('sr-overleaf-cancel-retry-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'local edit');

        const originalRetryDelays = (LocalReplicaSCMProvider as any).pushRetryDelays;
        (LocalReplicaSCMProvider as any).pushRetryDelays = [100];
        try {
            const syncPromise = (scm as any).applySync(
                'push',
                'update',
                '/main.tex',
                localMain,
                remoteMain,
            ) as Promise<Events['scmSyncCompleteEvent']>;
            setTimeout(() => scm.deactivate(), 10);
            const event = await syncPromise;

            assert.strictEqual(event.outcome, 'error');
            assert.match(event.error ?? '', /no longer active/i);
            assert.strictEqual(await readText(remoteMain), 'remote baseline');
        } finally {
            (LocalReplicaSCMProvider as any).pushRetryDelays = originalRetryDelays;
        }
    });

    test('does not let an old operation adopt a newly activated sync generation', async () => {
        const remoteRoot = await tempDir('sr-overleaf-generation-remote-');
        const localRoot = await tempDir('sr-overleaf-generation-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'old session edit');

        const originalPullRemoteFile = (scm as any).pullRemoteFile.bind(scm);
        let releasePausedPull!: () => void;
        const pausedPull = new Promise<void>(resolve => {
            releasePausedPull = resolve;
        });
        let resolvePullStarted!: () => void;
        const pullStarted = new Promise<void>(resolve => {
            resolvePullStarted = resolve;
        });
        let pauseOnce = true;
        (scm as any).pullRemoteFile = async (...args: unknown[]) => {
            if (pauseOnce) {
                pauseOnce = false;
                resolvePullStarted();
                await pausedPull;
                return Buffer.from('remote baseline');
            }
            return originalPullRemoteFile(...args);
        };

        try {
            const oldOperation = (scm as any).applySync(
                'push',
                'update',
                '/main.tex',
                localMain,
                remoteMain,
            ) as Promise<Events['scmSyncCompleteEvent']>;
            await pullStarted;
            scm.deactivate();
            await (scm as any).beginSyncSession();
            releasePausedPull();

            const event = await oldOperation;

            assert.strictEqual(event.outcome, 'error');
            assert.match(event.error ?? '', /no longer active/i);
            assert.strictEqual(await readText(remoteMain), 'remote baseline');
        } finally {
            (scm as any).pullRemoteFile = originalPullRemoteFile;
            scm.deactivate();
        }
    });

    test('waits for an already-started old-generation write before reactivation', async () => {
        const remoteRoot = await tempDir('sr-overleaf-generation-io-remote-');
        const localRoot = await tempDir('sr-overleaf-generation-io-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'old session write');

        let releaseWrite!: () => void;
        const pausedWrite = new Promise<void>(resolve => {
            releaseWrite = resolve;
        });
        let signalWriteStarted!: () => void;
        const writeStarted = new Promise<void>(resolve => {
            signalWriteStarted = resolve;
        });
        let remoteWriteFinished = false;

        try {
            const oldGeneration = (scm as any).syncGeneration;
            const oldWrite = (scm as any).runSessionIO(oldGeneration, async () => {
                signalWriteStarted();
                await pausedWrite;
                await writeText(remoteMain, 'old session write');
                remoteWriteFinished = true;
            }) as Promise<void>;
            await writeStarted;

            scm.deactivate();
            let reactivated = false;
            const reactivation = (scm as any).beginSyncSession().then(() => {
                reactivated = true;
                assert.strictEqual(remoteWriteFinished, true);
            });
            await new Promise(resolve => setTimeout(resolve, 25));
            assert.strictEqual(reactivated, false);

            releaseWrite();
            await oldWrite;
            await reactivation;

            assert.strictEqual(reactivated, true);
            assert.strictEqual(await readText(remoteMain), 'old session write');
        } finally {
            releaseWrite();
            scm.deactivate();
        }
    });

    test('does not let an old compile scan push into a newly activated session', async () => {
        const remoteRoot = await tempDir('sr-overleaf-generation-compile-remote-');
        const localRoot = await tempDir('sr-overleaf-generation-compile-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'old compile scan edit');

        const originalNeedsPush = (scm as any).localTargetNeedsPush.bind(scm);
        let switchedGeneration = false;
        (scm as any).localTargetNeedsPush = async (...args: unknown[]) => {
            const result = await originalNeedsPush(...args);
            if (!switchedGeneration) {
                switchedGeneration = true;
                scm.deactivate();
                await (scm as any).beginSyncSession();
            }
            return result;
        };
        try {
            await assert.rejects(
                () => scm.flushBeforeCompile([localMain]),
                /no longer active/i,
            );
            assert.strictEqual(await readText(remoteMain), 'remote baseline');
        } finally {
            (scm as any).localTargetNeedsPush = originalNeedsPush;
            scm.deactivate();
        }
    });

    test('does not let an old failed-pull retry write into a newly activated session', async () => {
        const remoteRoot = await tempDir('sr-overleaf-generation-retry-remote-');
        const localRoot = await tempDir('sr-overleaf-generation-retry-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(remoteMain, 'new remote content');
        (scm as any).failedInitialPulls.add('/main.tex');

        const originalPullRemoteFile = (scm as any).pullRemoteFile.bind(scm);
        (scm as any).pullRemoteFile = async () => {
            (scm as any).deactivateSyncSession(undefined, false);
            await (scm as any).beginSyncSession();
            return Buffer.from('new remote content');
        };
        try {
            const result = await scm.retryFailedInitialPulls();

            assert.deepStrictEqual(result.recovered, []);
            assert.strictEqual(await readText(localMain), 'remote baseline');
        } finally {
            (scm as any).pullRemoteFile = originalPullRemoteFile;
            scm.deactivate();
        }
    });

    test('does not let an old manifest load replace a new session baseline', async () => {
        const remoteRoot = await tempDir('sr-overleaf-generation-manifest-remote-');
        const localRoot = await tempDir('sr-overleaf-generation-manifest-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const originalReadSyncManifestFile = (scm as any).readSyncManifestFile.bind(scm);
        let releaseRead!: () => void;
        const pausedRead = new Promise<void>(resolve => {
            releaseRead = resolve;
        });
        let signalReadStarted!: () => void;
        const readStarted = new Promise<void>(resolve => {
            signalReadStarted = resolve;
        });
        let pauseOnce = true;
        (scm as any).readSyncManifestFile = async () => {
            if (pauseOnce) {
                pauseOnce = false;
                signalReadStarted();
                await pausedRead;
            }
            return originalReadSyncManifestFile();
        };

        try {
            const oldGeneration = (scm as any).syncGeneration;
            const oldLoad = (scm as any).loadSyncManifest(oldGeneration) as Promise<void>;
            await readStarted;
            scm.deactivate();
            await (scm as any).beginSyncSession();

            const newManifest = {
                version: 2,
                projectUri: (scm as any).syncManifest.projectUri,
                files: {['/new-session.tex']: {updatedAt: 'new'}},
                directories: {},
            };
            (scm as any).syncManifest = newManifest;
            releaseRead();

            await assert.rejects(oldLoad, /no longer active/i);
            assert.strictEqual((scm as any).syncManifest, newManifest);
            assert.ok((scm as any).syncManifest.files['/new-session.tex']);
        } finally {
            releaseRead();
            (scm as any).readSyncManifestFile = originalReadSyncManifestFile;
            scm.deactivate();
        }
    });

    test('does not let an old startup conflict read mutate a new sync session', async () => {
        const remoteRoot = await tempDir('sr-overleaf-generation-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-generation-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeReplicaSettings(localRoot, remoteRoot);
        await writeText(vscode.Uri.joinPath(localRoot, 'stale.tex'), 'legacy local copy');
        const scm = createSCM(remoteRoot, localRoot);
        const originalRead = (scm as any).readLocalFileInSession.bind(scm);
        let releaseRead!: () => void;
        const pausedRead = new Promise<void>(resolve => {
            releaseRead = resolve;
        });
        let signalReadStarted!: () => void;
        const readStarted = new Promise<void>(resolve => {
            signalReadStarted = resolve;
        });
        (scm as any).readLocalFileInSession = async (
            relPath: string,
            generation: number,
        ) => {
            const content = await originalRead(relPath, generation);
            if (relPath==='/stale.tex') {
                signalReadStarted();
                await pausedRead;
            }
            return content;
        };

        try {
            const oldInitialization = scm.initializeLocalReplica({
                preserveExistingLocalFiles: true,
            });
            await readStarted;
            scm.deactivate();
            await (scm as any).beginSyncSession();
            const newConflicts = new Map([['/new-session.tex', 'new session marker']]);
            (scm as any).syncConflicts = newConflicts;
            releaseRead();

            assert.strictEqual(await oldInitialization, false);
            assert.strictEqual((scm as any).syncConflicts, newConflicts);
            assert.deepStrictEqual([...newConflicts.keys()], ['/new-session.tex']);
            assert.strictEqual(
                await pathExists(vscode.Uri.joinPath(remoteRoot, 'stale.tex')),
                false,
            );
        } finally {
            releaseRead();
            (scm as any).readLocalFileInSession = originalRead;
            scm.deactivate();
        }
    });

    test('does not let a stale conflict revision read contaminate a new session', async () => {
        const remoteRoot = await tempDir('sr-overleaf-generation-mark-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-generation-mark-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const oldGeneration = (scm as any).syncGeneration as number;
        const originalCapture = (scm as any).captureLocalPathRevision.bind(scm);
        let releaseCapture!: () => void;
        const capturePaused = new Promise<void>(resolve => {
            releaseCapture = resolve;
        });
        let signalCaptureStarted!: () => void;
        const captureStarted = new Promise<void>(resolve => {
            signalCaptureStarted = resolve;
        });
        let pauseOnce = true;
        (scm as any).captureLocalPathRevision = async (...args: unknown[]) => {
            const revision = await originalCapture(...args);
            if (pauseOnce) {
                pauseOnce = false;
                signalCaptureStarted();
                await capturePaused;
            }
            return revision;
        };

        try {
            const oldMark = (scm as any).markSyncConflict(
                '/main.tex',
                'old session conflict',
                undefined,
                oldGeneration,
            ) as Promise<void>;
            await captureStarted;
            scm.deactivate();
            await (scm as any).beginSyncSession();
            const newConflicts = new Map([['/new-session.tex', 'new session marker']]);
            const newDigests = new Map([['/new-session.tex', sha1('new session marker')]]);
            (scm as any).syncConflicts = newConflicts;
            (scm as any).conflictLocalDigests = newDigests;
            releaseCapture();

            await assert.rejects(oldMark, /no longer active/i);
            assert.strictEqual((scm as any).syncConflicts, newConflicts);
            assert.strictEqual((scm as any).conflictLocalDigests, newDigests);
        } finally {
            releaseCapture();
            (scm as any).captureLocalPathRevision = originalCapture;
            scm.deactivate();
        }
    });

    test('flushes pending local watcher events before compile', async () => {
        const remoteRoot = await tempDir('sr-overleaf-precompile-remote-');
        const localRoot = await tempDir('sr-overleaf-precompile-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v1');

        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };

        const scm = createSCM(remoteRoot, localRoot);
        const triggers = await scm.triggers;
        try {
            const localWatcher = watchers[1];
            assert.ok(localWatcher);

            const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
            await writeText(localMain, 'local pending before compile');
            localWatcher.fireChange(localMain);
            await new Promise(resolve => setTimeout(resolve, 20));

            const result = await scm.flushBeforeCompile([]);

            assert.strictEqual(result.pendingCount, 1);
            assert.strictEqual(result.failedCount, 0);
            assert.strictEqual(result.blockedCount, 0);
            assert.strictEqual(await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')), 'local pending before compile');
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('orders pending parent directories before nested file uploads', async () => {
        const remoteRoot = await tempDir('sr-overleaf-pending-hierarchy-remote-');
        const localRoot = await tempDir('sr-overleaf-pending-hierarchy-local-');
        tempRoots.push(remoteRoot, localRoot);

        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };

        const scm = createSCM(remoteRoot, localRoot);
        const triggers = await scm.triggers;
        try {
            const localWatcher = watchers[1];
            assert.ok(localWatcher);
            const localDirectory = vscode.Uri.joinPath(localRoot, 'new-section');
            const localFile = vscode.Uri.joinPath(localDirectory, 'nested.tex');
            await writeText(localFile, 'nested source');

            localWatcher.fireCreate(localFile);
            localWatcher.fireCreate(localDirectory);
            await new Promise(resolve => setTimeout(resolve, 20));

            const result = await scm.flushBeforeCompile([]);

            assert.strictEqual(result.failedCount, 0);
            assert.strictEqual(result.pendingCount, 2);
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteRoot, 'new-section', 'nested.tex')),
                'nested source',
            );
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('flushes an explicitly saved source document without relying on watcher events', async () => {
        const remoteRoot = await tempDir('sr-overleaf-open-doc-remote-');
        const localRoot = await tempDir('sr-overleaf-open-doc-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'content', '06_appendix.tex'), 'remote appendix');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localAppendix = vscode.Uri.joinPath(localRoot, 'content', '06_appendix.tex');
        await writeText(localAppendix, 'local appendix before compile');
        await vscode.workspace.openTextDocument(localAppendix);

        const result = await scm.flushBeforeCompile([localAppendix]);

        assert.strictEqual(result.failedCount, 0);
        assert.strictEqual(result.blockedCount, 0);
        assert.strictEqual(result.attemptedCount, 1);
        assert.strictEqual(await readText(vscode.Uri.joinPath(remoteRoot, 'content', '06_appendix.tex')), 'local appendix before compile');
    });

    test('keeps the healthy save path free of reconnects and operation journals', async () => {
        const remoteRoot = await tempDir('sr-overleaf-fast-save-remote-');
        const localRoot = await tempDir('sr-overleaf-fast-save-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        let reconnectCount = 0;
        (fakeVfs as any).reconnect = async () => {
            reconnectCount += 1;
            return {} as any;
        };
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        let operationJournalCount = 0;
        const originalCreateOperation = (scm as any).createLocalOperationRecord.bind(scm);
        (scm as any).createLocalOperationRecord = async (...args: unknown[]) => {
            operationJournalCount += 1;
            return originalCreateOperation(...args);
        };

        await writeText(localMain, 'saved edit');
        const result = await scm.flushBeforeCompile([localMain]);

        assert.strictEqual(result.failedCount, 0);
        assert.strictEqual(result.blockedCount, 0);
        assert.strictEqual(await readText(remoteMain), 'saved edit');
        assert.strictEqual(reconnectCount, 0);
        assert.strictEqual(operationJournalCount, 0);
    });

    test('accepts matching remote readback without a redundant save-triggered push', async () => {
        const remoteRoot = await tempDir('sr-overleaf-save-readback-remote-');
        const localRoot = await tempDir('sr-overleaf-save-readback-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(localMain, 'saved text already delivered');
        await writeText(remoteMain, 'saved text already delivered');
        const originalPushWithRetry = (scm as any).pushWithRetry.bind(scm);
        let redundantPushCount = 0;
        (scm as any).pushWithRetry = async () => {
            redundantPushCount += 1;
            throw new Error('redundant remote write');
        };
        try {
            const result = await scm.flushBeforeCompile([localMain]);

            assert.strictEqual(result.failedCount, 0);
            assert.strictEqual(result.blockedCount, 0);
            assert.strictEqual(result.attemptedCount, 1);
            assert.strictEqual(redundantPushCount, 0);
            assert.strictEqual(await readText(remoteMain), 'saved text already delivered');
        } finally {
            (scm as any).pushWithRetry = originalPushWithRetry;
        }
    });

    test('force-reverts a restored clean editor without invoking a normal save', async () => {
        const remoteRoot = await tempDir('sr-overleaf-open-refresh-remote-');
        const localRoot = await tempDir('sr-overleaf-open-refresh-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'fresh pulled disk text');

        let editorText = 'stale restored editor text';
        let editorVersion = 1;
        let saveCount = 0;
        let revertCount = 0;
        const document = {
            uri: localMain,
            fileName: localMain.fsPath,
            get isDirty() { return false; },
            get version() { return editorVersion; },
            getText: () => editorText,
            save: async () => {
                saveCount += 1;
                return true;
            },
        } as unknown as vscode.TextDocument;
        const editor = {
            document,
            viewColumn: vscode.ViewColumn.One,
            selection: new vscode.Selection(0, 0, 0, 0),
        } as unknown as vscode.TextEditor;
        Object.defineProperty(vscode.window, 'activeTextEditor', {
            configurable: true,
            value: editor,
        });
        (vscode.window as any).showTextDocument = async () => editor;
        (vscode.commands as any).executeCommand = async (command: string) => {
            if (command==='workbench.action.files.revert') {
                revertCount += 1;
                editorText = await readText(localMain);
                editorVersion += 1;
            }
        };

        const refreshed = await (scm as any).refreshCleanOpenReplicaDocumentsFromDisk(
            (scm as any).syncGeneration,
            [document],
        );

        assert.deepStrictEqual(refreshed, ['/main.tex']);
        assert.strictEqual(editorText, 'fresh pulled disk text');
        assert.strictEqual(revertCount, 1);
        assert.strictEqual(saveCount, 0);
    });

    test('reloads the newest disk bytes when an agent writes during clean-editor refresh', async () => {
        const remoteRoot = await tempDir('sr-overleaf-open-refresh-race-remote-');
        const localRoot = await tempDir('sr-overleaf-open-refresh-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'first pulled disk text');

        let editorText = 'stale restored editor text';
        let editorVersion = 1;
        let injectedAgentWrite = false;
        const document = {
            uri: localMain,
            fileName: localMain.fsPath,
            get isDirty() { return false; },
            get version() { return editorVersion; },
            getText: () => editorText,
        } as unknown as vscode.TextDocument;
        const editor = {
            document,
            viewColumn: vscode.ViewColumn.One,
            selection: new vscode.Selection(0, 0, 0, 0),
        } as unknown as vscode.TextEditor;
        Object.defineProperty(vscode.window, 'activeTextEditor', {
            configurable: true,
            value: editor,
        });
        (vscode.window as any).showTextDocument = async () => {
            if (!injectedAgentWrite) {
                injectedAgentWrite = true;
                await writeText(localMain, 'newest agent disk text');
            }
            return editor;
        };
        (vscode.commands as any).executeCommand = async (command: string) => {
            if (command==='workbench.action.files.revert') {
                editorText = await readText(localMain);
                editorVersion += 1;
            }
        };

        const refreshed = await (scm as any).refreshCleanOpenReplicaDocumentsFromDisk(
            (scm as any).syncGeneration,
            [document],
        );

        assert.deepStrictEqual(refreshed, ['/main.tex']);
        assert.strictEqual(editorText, 'newest agent disk text');
        assert.strictEqual(await readText(localMain), 'newest agent disk text');
        assert.strictEqual(
            (scm as any).shouldPropagate(
                'push',
                'update',
                '/main.tex',
                Buffer.from('newest agent disk text'),
            ),
            true,
        );
    });

    test('never reverts an unrelated editor when focus changes during clean-editor refresh', async () => {
        const remoteRoot = await tempDir('sr-overleaf-open-refresh-focus-remote-');
        const localRoot = await tempDir('sr-overleaf-open-refresh-focus-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const unrelatedUri = vscode.Uri.joinPath(localRoot, 'notes.tex');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        await writeText(unrelatedUri, 'unsaved unrelated text');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'new disk text');

        const targetDocument = {
            uri: localMain,
            fileName: localMain.fsPath,
            isDirty: false,
            version: 1,
            getText: () => 'stale target editor',
        } as unknown as vscode.TextDocument;
        const unrelatedDocument = {
            uri: unrelatedUri,
            fileName: unrelatedUri.fsPath,
            isDirty: true,
            version: 2,
            getText: () => 'unsaved unrelated text',
        } as unknown as vscode.TextDocument;
        const targetEditor = {
            document: targetDocument,
            viewColumn: vscode.ViewColumn.One,
            selection: new vscode.Selection(0, 0, 0, 0),
        } as unknown as vscode.TextEditor;
        const unrelatedEditor = {
            document: unrelatedDocument,
            viewColumn: vscode.ViewColumn.Two,
            selection: new vscode.Selection(0, 0, 0, 0),
        } as unknown as vscode.TextEditor;
        Object.defineProperty(vscode.window, 'activeTextEditor', {
            configurable: true,
            value: unrelatedEditor,
        });
        (vscode.window as any).showTextDocument = async () => targetEditor;
        let revertCount = 0;
        (vscode.commands as any).executeCommand = async (command: string) => {
            if (command==='workbench.action.files.revert') {
                revertCount += 1;
            }
        };

        const refreshed = await (scm as any).refreshCleanOpenReplicaDocumentsFromDisk(
            (scm as any).syncGeneration,
            [targetDocument],
        );

        assert.deepStrictEqual(refreshed, []);
        assert.strictEqual(revertCount, 0);
        assert.strictEqual(unrelatedDocument.isDirty, true);
    });

    test('bootstraps text documents in parallel and waits for socket verification before compile', async () => {
        const remoteRoot = await tempDir('sr-overleaf-http-bootstrap-remote-');
        const localRoot = await tempDir('sr-overleaf-http-bootstrap-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter.tex');
        await writeText(remoteMain, 'main snapshot');
        await writeText(remoteChapter, 'chapter snapshot');

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot) as FakeVirtualFileSystem & {
            downloadDocumentSnapshot(uri: vscode.Uri): Promise<Uint8Array>;
        };
        let activeSnapshots = 0;
        let maximumActiveSnapshots = 0;
        fakeVfs.downloadDocumentSnapshot = async uri => {
            activeSnapshots += 1;
            maximumActiveSnapshots = Math.max(maximumActiveSnapshots, activeSnapshots);
            try {
                await new Promise(resolve => setTimeout(resolve, 25));
                return await vscode.workspace.fs.readFile(uri);
            } finally {
                activeSnapshots -= 1;
            }
        };

        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        assert.ok(maximumActiveSnapshots>=2, 'document snapshots were fetched sequentially');
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'main snapshot');
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'chapter.tex')), 'chapter snapshot');
        assert.deepStrictEqual(
            [...(scm as any).pendingInitialDocumentSubscriptions].sort(),
            ['/chapter.tex', '/main.tex'],
        );
        let flushSettled = false;
        const pendingFlush = scm.flushBeforeCompile([]).finally(() => {
            flushSettled = true;
        });
        await new Promise(resolve => setTimeout(resolve, 75));
        assert.strictEqual(flushSettled, false);
        await (scm as any).verifyInitialDocumentSubscriptions();
        assert.strictEqual((scm as any).pendingInitialDocumentSubscriptions.size, 0);
        const result = await pendingFlush;
        assert.strictEqual(result.blockedCount, 0);
        assert.strictEqual(result.failedCount, 0);

        const internals = scm as any;
        internals.precompileStartupReadinessWaitMs = 20;
        internals.pendingInitialDocumentSubscriptions.add('/main.tex');
        await assert.rejects(
            scm.flushBeforeCompile([]),
            /initial Overleaf document subscription is still being verified/i,
        );
        internals.pendingInitialDocumentSubscriptions.clear();
    });

    test('uses one document snapshot batch for initial text bootstrap', async () => {
        const remoteRoot = await tempDir('sr-overleaf-http-batch-remote-');
        const localRoot = await tempDir('sr-overleaf-http-batch-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'main batch snapshot');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'chapter.tex'), 'chapter batch snapshot');

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot) as FakeVirtualFileSystem & {
            downloadDocumentSnapshots(uris: vscode.Uri[]): Promise<Map<string, Uint8Array>>;
            downloadDocumentSnapshot(uri: vscode.Uri): Promise<Uint8Array>;
        };
        let batchCount = 0;
        fakeVfs.downloadDocumentSnapshots = async uris => {
            batchCount += 1;
            return new Map(await Promise.all(uris
                .filter(uri => uri.path.endsWith('.tex'))
                .map(async uri => [
                    uri.toString(),
                    await vscode.workspace.fs.readFile(uri),
                ] as const)));
        };
        fakeVfs.downloadDocumentSnapshot = async () => {
            throw new Error('per-document bootstrap should not run after a complete batch');
        };

        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        assert.strictEqual(batchCount, 1);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(localRoot, 'main.tex')),
            'main batch snapshot',
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(localRoot, 'chapter.tex')),
            'chapter batch snapshot',
        );
        assert.deepStrictEqual(
            [...(scm as any).pendingInitialDocumentSubscriptions].sort(),
            ['/chapter.tex', '/main.tex'],
        );
    });

    test('detects closed local source edits before compile without watcher events', async () => {
        const remoteRoot = await tempDir('sr-overleaf-closed-source-remote-');
        const localRoot = await tempDir('sr-overleaf-closed-source-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'content', '06_appendix.tex'), 'remote appendix');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localAppendix = vscode.Uri.joinPath(localRoot, 'content', '06_appendix.tex');
        await writeText(localAppendix, 'closed local appendix before compile');

        const result = await scm.flushBeforeCompile([]);

        assert.strictEqual(result.failedCount, 0);
        assert.strictEqual(result.blockedCount, 0);
        assert.strictEqual(result.sourceScanCount, 1);
        assert.strictEqual(await readText(vscode.Uri.joinPath(remoteRoot, 'content', '06_appendix.tex')), 'closed local appendix before compile');
    });

    test('does not bless newer local metadata when an agent edits during a push', async () => {
        const remoteRoot = await tempDir('sr-overleaf-push-race-remote-');
        const localRoot = await tempDir('sr-overleaf-push-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'first saved edit');

        const originalPushWithRetry = (scm as any).pushWithRetry.bind(scm);
        let injectedAgentWrite = false;
        (scm as any).pushWithRetry = async (
            _relPath: string,
            toUri: vscode.Uri,
            content: Uint8Array,
        ) => {
            await vscode.workspace.fs.writeFile(toUri, content);
            if (!injectedAgentWrite) {
                injectedAgentWrite = true;
                await writeText(localMain, 'newer closed agent edit');
            }
            return content;
        };
        try {
            await assert.rejects(
                scm.flushBeforeCompile([localMain]),
                /precompile flush failed:.*local file is still being written/i,
            );

            const manifest = (scm as any).syncManifest as {
                files: Record<string, unknown>;
                pendingOperations: Record<string, {
                    kind: string;
                    localRevision: string;
                    targetEntity?: unknown;
                    parentEntity?: unknown;
                }>;
            };
            assert.strictEqual(manifest.files['/main.tex'], undefined);
            const retained = manifest.pendingOperations['/main.tex'];
            assert.strictEqual(retained.kind, 'update');
            assert.strictEqual(retained.localRevision, sha1('first saved edit'));
            assert.ok(retained.targetEntity);
            assert.ok(retained.parentEntity);
            assert.strictEqual(await readText(remoteMain), 'first saved edit');

            (scm as any).pushWithRetry = originalPushWithRetry;
            await scm.flushBeforeCompile([]);

            assert.strictEqual(await readText(remoteMain), 'newer closed agent edit');
        } finally {
            (scm as any).pushWithRetry = originalPushWithRetry;
        }
    });

    test('serializes manifest publication so an older snapshot cannot win', async () => {
        const remoteRoot = await tempDir('sr-overleaf-manifest-publish-remote-');
        const localRoot = await tempDir('sr-overleaf-manifest-publish-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const manifestUri = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-manifest.json',
        );
        const manifest = (scm as any).syncManifest;
        const entry = (digest: string) => ({
            remoteFingerprint: `content:${digest}`,
            localSize: 1,
            localMtime: 1,
            localDigest: digest,
            updatedAt: new Date().toISOString(),
        });
        const originalRunSessionIO = (scm as any).runSessionIO.bind(scm);
        let releaseFirstRename!: () => void;
        const pausedFirstRename = new Promise<void>(resolve => {
            releaseFirstRename = resolve;
        });
        let signalFirstRename!: () => void;
        const firstRenameStarted = new Promise<void>(resolve => {
            signalFirstRename = resolve;
        });
        let pauseFirstManifestRename = true;
        let manifestIoCount = 0;
        (scm as any).runSessionIO = async (
            generation: number,
            task: () => Promise<unknown>,
        ) => {
            manifestIoCount += 1;
            if (pauseFirstManifestRename && manifestIoCount===3) {
                pauseFirstManifestRename = false;
                signalFirstRename();
                await pausedFirstRename;
            }
            return originalRunSessionIO(generation, task);
        };

        try {
            manifest.files['/older.tex'] = entry('older');
            (scm as any).markSyncManifestDirty();
            const firstPublish = (scm as any).persistSyncManifest() as Promise<void>;
            await firstRenameStarted;

            manifest.files['/newer.tex'] = entry('newer');
            (scm as any).markSyncManifestDirty();
            const secondPublish = (scm as any).persistSyncManifest() as Promise<void>;
            await new Promise(resolve => setTimeout(resolve, 25));
            releaseFirstRename();
            await Promise.all([firstPublish, secondPublish]);

            const persisted = JSON.parse(await readText(manifestUri));
            assert.ok(persisted.files['/older.tex']);
            assert.ok(persisted.files['/newer.tex']);
            assert.strictEqual((scm as any).syncManifestDirty, false);
        } finally {
            releaseFirstRename();
            (scm as any).runSessionIO = originalRunSessionIO;
        }
    });

    test('detects closed local media edits before compile without watcher events', async () => {
        const remoteRoot = await tempDir('sr-overleaf-closed-media-remote-');
        const localRoot = await tempDir('sr-overleaf-closed-media-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.png');
        await writeBytes(remoteImage, Buffer.from([1, 2, 3]));
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const changedImage = Buffer.from([9, 8, 7, 6]);
        await writeBytes(vscode.Uri.joinPath(localRoot, 'figures', 'plot.png'), changedImage);
        const result = await scm.flushBeforeCompile([]);

        assert.strictEqual(result.failedCount, 0);
        assert.strictEqual(result.blockedCount, 0);
        assert.strictEqual(result.sourceScanCount, 1);
        assert.deepStrictEqual(await readBytes(remoteImage), changedImage);
    });

    test('content-checks closed media even when size and mtime are unchanged', async () => {
        const remoteRoot = await tempDir('sr-overleaf-media-metadata-remote-');
        const localRoot = await tempDir('sr-overleaf-media-metadata-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figures', 'plot.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figures', 'plot.png');
        await writeBytes(remoteImage, Buffer.from([1, 2, 3, 4]));
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const originalStat = await fs.stat(localImage.fsPath);
        const changedImage = Buffer.from([9, 8, 7, 6]);
        await writeBytes(localImage, changedImage);
        await fs.utimes(localImage.fsPath, originalStat.atime, originalStat.mtime);

        const originalReadLocalFile = (scm as any).readLocalFile.bind(scm);
        let localMediaReadCount = 0;
        (scm as any).readLocalFile = async (uri: vscode.Uri) => {
            if (uri.toString()===localImage.toString()) {
                localMediaReadCount += 1;
            }
            return originalReadLocalFile(uri);
        };
        try {
            const result = await scm.flushBeforeCompile([]);
            assert.strictEqual(result.attemptedCount, 1);
            assert.ok(localMediaReadCount>=1);
            assert.deepStrictEqual(await readBytes(remoteImage), changedImage);
        } finally {
            (scm as any).readLocalFile = originalReadLocalFile;
        }
    });

    test('syncs missed empty-directory additions and deletions before compile', async () => {
        const remoteRoot = await tempDir('sr-overleaf-compile-dir-remote-');
        const localRoot = await tempDir('sr-overleaf-compile-dir-local-');
        tempRoots.push(remoteRoot, localRoot);

        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(remoteRoot, 'remove-empty'));
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'remove-empty'));
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(localRoot, 'new-empty', 'nested'));
        const result = await scm.flushBeforeCompile([]);

        assert.strictEqual(result.failedCount, 0);
        assert.strictEqual(result.blockedCount, 0);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'remove-empty')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'new-empty', 'nested')), true);
    });

    test('does not push an open unsaved source buffer during a manual compile flush', async () => {
        const remoteRoot = await tempDir('sr-overleaf-unsaved-remote-');
        const localRoot = await tempDir('sr-overleaf-unsaved-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        await writeText(remoteMain, 'saved baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const document = await vscode.workspace.openTextDocument(localMain);
        const editor = await vscode.window.showTextDocument(document);
        await editor.edit(builder => builder.replace(
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            'unsaved buffer',
        ));

        try {
            const result = await scm.flushBeforeCompile([]);
            assert.strictEqual(result.attemptedCount, 0);
            assert.strictEqual(document.isDirty, true);
            assert.strictEqual(await readText(remoteMain), 'saved baseline');
            assert.strictEqual(await readText(localMain), 'saved baseline');
        } finally {
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
    });

    test('detects closed local source deletes before compile without watcher events', async () => {
        const remoteRoot = await tempDir('sr-overleaf-closed-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-closed-delete-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteAppendix = vscode.Uri.joinPath(remoteRoot, 'content', '06_appendix.tex');
        await writeText(remoteAppendix, 'remote appendix');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'content', '06_appendix.tex'));

        const result = await scm.flushBeforeCompile([]);

        assert.strictEqual(result.failedCount, 0);
        assert.strictEqual(result.blockedCount, 0);
        assert.strictEqual(result.sourceScanDeleteCount, 1);
        assert.strictEqual(await pathExists(remoteAppendix), false);
    });

    test('accepts a compile scan when an earlier queued delete already synchronized it', async () => {
        const remoteRoot = await tempDir('sr-overleaf-queued-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-queued-delete-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localMain);

        const internals = scm as any;
        let releasePriorSync!: () => void;
        const priorSync = new Promise<void>(resolve => {
            releasePriorSync = resolve;
        });
        internals.syncQueues.set('/main.tex', priorSync);

        const flushPromise = scm.flushBeforeCompile([]);
        await waitUntil(() => internals.syncQueues.get('/main.tex')!==priorSync);
        internals.clearReplicaState('/main.tex');
        await vscode.workspace.fs.delete(remoteMain);
        releasePriorSync();

        const result = await flushPromise;
        assert.strictEqual(result.failedCount, 0);
        assert.strictEqual(result.blockedCount, 0);
        assert.strictEqual(result.attemptedCount, 1);
        assert.strictEqual(await pathExists(remoteMain), false);
    });

    test('cancels compile instead of treating a transient local read failure as deletion', async () => {
        const remoteRoot = await tempDir('sr-overleaf-local-read-failure-remote-');
        const localRoot = await tempDir('sr-overleaf-local-read-failure-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const originalReadLocalFile = (scm as any).readLocalFile.bind(scm);
        (scm as any).readLocalFile = async (uri: vscode.Uri) => {
            if (uri.toString()===localMain.toString()) {
                throw Object.assign(new Error('simulated local EACCES'), {code: 'EACCES'});
            }
            return originalReadLocalFile(uri);
        };
        try {
            await assert.rejects(
                () => scm.flushBeforeCompile([localMain]),
                /EACCES/,
            );
            assert.strictEqual(await readText(remoteMain), 'remote baseline');
        } finally {
            (scm as any).readLocalFile = originalReadLocalFile;
        }
    });

    test('does not synthesize source deletes when precompile source scan is incomplete', async () => {
        const remoteRoot = await tempDir('sr-overleaf-scan-fail-remote-');
        const localRoot = await tempDir('sr-overleaf-scan-fail-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteAppendix = vscode.Uri.joinPath(remoteRoot, 'content', '06_appendix.tex');
        await writeText(remoteAppendix, 'remote appendix');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'content'), {recursive: true});
        (scm as any).collectChangedLocalTargets = async (
            _dirUri: vscode.Uri,
            dirRelPath: string,
            _localFilePaths: Set<string>,
            _localDirectoryPaths: Set<string>,
            _forcedTargets: Map<string, vscode.Uri>,
            result: { failedCount: number; failures: string[] },
        ) => {
            result.failedCount += 1;
            result.failures.push(`${dirRelPath}: simulated scan failure`);
        };

        await assert.rejects(
            () => scm.flushBeforeCompile([]),
            /simulated scan failure/,
        );
        assert.strictEqual(await pathExists(remoteAppendix), true);
    });

    test('blocks a remote file update without replacing a dirty editor backing file', async () => {
        const remoteRoot = await tempDir('sr-overleaf-dirty-pull-update-remote-');
        const localRoot = await tempDir('sr-overleaf-dirty-pull-update-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const baseline = 'shared baseline';
        const remoteUpdate = 'Overleaf collaborator update';
        await writeText(remoteMain, baseline);
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const document = await vscode.workspace.openTextDocument(localMain);
        const editor = await vscode.window.showTextDocument(document);
        const edited = await editor.edit(builder => builder.replace(
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            'unsaved editor buffer',
        ));
        assert.strictEqual(edited, true);
        assert.strictEqual(document.isDirty, true);
        await writeText(remoteMain, remoteUpdate);

        try {
            const event = await (scm as any).applySync(
                'pull',
                'update',
                '/main.tex',
                remoteMain,
                localMain,
            ) as Events['scmSyncCompleteEvent'];

            assert.strictEqual(event.outcome, 'blocked');
            assert.strictEqual(document.isDirty, true);
            assert.strictEqual(document.getText(), 'unsaved editor buffer');
            assert.strictEqual(await readText(localMain), baseline);
            assert.strictEqual(await readText(remoteMain), remoteUpdate);
            const conflict = (scm as any).syncManifest.conflicts['/main.tex'];
            assert.strictEqual(conflict.remoteKind, 'file');
            assert.strictEqual(
                conflict.remoteRevision,
                crypto.createHash('sha1').update(remoteUpdate).digest('hex'),
            );
            assert.ok((scm as any).syncConflicts.has('/main.tex'));
            assert.strictEqual(await scm.resolveConflictWithLocalState('/main.tex'), false);
            assert.strictEqual(await readText(remoteMain), remoteUpdate);
            assert.strictEqual(await readText(localMain), baseline);
            assert.ok((scm as any).syncConflicts.has('/main.tex'));
        } finally {
            if (document.isDirty) {
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }
        }
    });

    test('blocks a remote file delete without removing a dirty editor backing file', async () => {
        const remoteRoot = await tempDir('sr-overleaf-dirty-pull-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-dirty-pull-delete-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const baseline = 'shared baseline';
        await writeText(remoteMain, baseline);
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const document = await vscode.workspace.openTextDocument(localMain);
        const editor = await vscode.window.showTextDocument(document);
        const edited = await editor.edit(builder => builder.replace(
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            'unsaved editor buffer',
        ));
        assert.strictEqual(edited, true);
        assert.strictEqual(document.isDirty, true);
        await vscode.workspace.fs.delete(remoteMain);

        try {
            const event = await (scm as any).applySync(
                'pull',
                'delete',
                '/main.tex',
                remoteMain,
                localMain,
            ) as Events['scmSyncCompleteEvent'];

            assert.strictEqual(event.outcome, 'blocked');
            assert.strictEqual(document.isDirty, true);
            assert.strictEqual(document.getText(), 'unsaved editor buffer');
            assert.strictEqual(await readText(localMain), baseline);
            assert.strictEqual(await pathExists(remoteMain), false);
            const conflict = (scm as any).syncManifest.conflicts['/main.tex'];
            assert.strictEqual(conflict.remoteKind, 'missing');
            assert.strictEqual(conflict.remoteRevision, '\0');
            assert.ok((scm as any).syncConflicts.has('/main.tex'));
        } finally {
            if (document.isDirty) {
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }
        }
    });

    test('keeps a dirty editor backing file when a queued remote delete is delivered', async () => {
        const remoteRoot = await tempDir('sr-overleaf-dirty-watcher-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-dirty-watcher-delete-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const baseline = 'shared baseline';
        await writeText(remoteMain, baseline);
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(remoteMain);
        const eventUri = vscode.Uri.parse(
            ROOT_NAME + '://test-server/Select%20Folder%20Test/main.tex'
                + '?user=test-user&project=test-project',
        );
        const originalRemoteTargetEventType = (scm as any)
            .remoteTargetEventType.bind(scm);
        (scm as any).remoteTargetEventType = async (uri: vscode.Uri) => {
            assert.strictEqual(uri.toString(), eventUri.toString());
            return 'delete';
        };
        const pulled = waitForSyncComplete(localRoot, '/main.tex', 'pull', 'delete');
        (scm as any).syncFromVFS(eventUri, 'delete');

        const document = await vscode.workspace.openTextDocument(localMain);
        const editor = await vscode.window.showTextDocument(document);
        const edited = await editor.edit(builder => builder.replace(
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            'unsaved editor buffer',
        ));
        assert.strictEqual(edited, true);
        assert.strictEqual(document.isDirty, true);

        try {
            const event = await pulled;
            assert.strictEqual(event.outcome, 'blocked');
            assert.strictEqual(document.isDirty, true);
            assert.strictEqual(document.getText(), 'unsaved editor buffer');
            assert.strictEqual(await readText(localMain), baseline);
            assert.strictEqual(await pathExists(remoteMain), false);
            assert.strictEqual(
                (scm as any).syncManifest.conflicts['/main.tex'].remoteKind,
                'missing',
            );
        } finally {
            (scm as any).remoteTargetEventType = originalRemoteTargetEventType;
            if (document.isDirty) {
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }
        }
    });

    test('blocks a remote folder delete while a descendant editor is dirty', async () => {
        const remoteRoot = await tempDir('sr-overleaf-dirty-pull-folder-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-dirty-pull-folder-delete-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const remoteDraft = vscode.Uri.joinPath(remoteChapter, 'draft.tex');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        const localDraft = vscode.Uri.joinPath(localChapter, 'draft.tex');
        const baseline = 'shared draft';
        await writeText(remoteDraft, baseline);
        await writeText(vscode.Uri.joinPath(remoteChapter, 'figure.png'), 'remote figure');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const document = await vscode.workspace.openTextDocument(localDraft);
        const editor = await vscode.window.showTextDocument(document);
        const edited = await editor.edit(builder => builder.insert(
            new vscode.Position(0, 0),
            '% unsaved editor buffer\n',
        ));
        assert.strictEqual(edited, true);
        assert.strictEqual(document.isDirty, true);
        await vscode.workspace.fs.delete(remoteChapter, {recursive: true});

        try {
            const event = await (scm as any).applySync(
                'pull',
                'delete',
                '/chapter',
                remoteChapter,
                localChapter,
            ) as Events['scmSyncCompleteEvent'];

            assert.strictEqual(event.outcome, 'blocked');
            assert.strictEqual(document.isDirty, true);
            assert.strictEqual(await readText(localDraft), baseline);
            assert.strictEqual(await pathExists(vscode.Uri.joinPath(localChapter, 'figure.png')), true);
            assert.strictEqual(await pathExists(remoteChapter), false);
            const conflict = (scm as any).syncManifest.conflicts['/chapter'];
            assert.strictEqual(conflict.remoteKind, 'missing');
            assert.strictEqual(conflict.remoteRevision, '\0');
            assert.ok((scm as any).syncConflicts.has('/chapter'));
        } finally {
            if (document.isDirty) {
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }
        }
    });

    test('preserves agent disk bytes and a dirty editor buffer when an outbound merge is written back', async () => {
        const remoteRoot = await tempDir('sr-overleaf-dirty-push-merge-remote-');
        const localRoot = await tempDir('sr-overleaf-dirty-push-merge-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const baseline = '% header\nagent: base\nmiddle one\nmiddle two\nremote: base\n';
        const agentDisk = '% header\nagent: updated\nmiddle one\nmiddle two\nremote: base\n';
        const collaborator = '% header\nagent: base\nmiddle one\nmiddle two\nremote: updated\n';
        const dirtyBuffer = '% unsaved editor buffer\nagent: base\nmiddle one\nmiddle two\nremote: base\n';
        await writeText(remoteMain, baseline);
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const document = await vscode.workspace.openTextDocument(localMain);
        const editor = await vscode.window.showTextDocument(document);
        const edited = await editor.edit(builder => builder.replace(
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
            dirtyBuffer,
        ));
        assert.strictEqual(edited, true);
        assert.strictEqual(document.isDirty, true);

        // Simulate an agent/shell changing the saved working tree while the
        // human still owns an unsaved editor buffer. The remote collaborator
        // changes a different hunk, so the normal saved-state logic will
        // build a merged remote revision and try to write it back locally.
        await fs.writeFile(localMain.fsPath, agentDisk, 'utf8');
        await writeText(remoteMain, collaborator);

        try {
            const event = await (scm as any).applySync(
                'push',
                'update',
                '/main.tex',
                localMain,
                remoteMain,
            ) as Events['scmSyncCompleteEvent'];

            assert.strictEqual(event.outcome, 'blocked');
            assert.strictEqual(document.isDirty, true);
            assert.strictEqual(document.getText(), dirtyBuffer);
            assert.strictEqual(await readText(localMain), agentDisk);
            const mergedRemote = await readText(remoteMain);
            assert.ok(mergedRemote.includes('agent: updated'));
            assert.ok(mergedRemote.includes('remote: updated'));
            const conflict = (scm as any).syncManifest.conflicts['/main.tex'];
            assert.strictEqual(conflict.remoteKind, 'file');
            assert.strictEqual(
                conflict.remoteRevision,
                crypto.createHash('sha1').update(mergedRemote).digest('hex'),
            );
            assert.ok((scm as any).syncConflicts.has('/main.tex'));
        } finally {
            if (document.isDirty) {
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }
        }
    });

    test('queues a forced push when pull sees local-diverged content', async () => {
        const remoteRoot = await tempDir('sr-overleaf-diverged-remote-');
        const localRoot = await tempDir('sr-overleaf-diverged-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        await writeText(remoteMain, 'remote v1');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(localMain, 'local diverged v2');

        const pushWait = waitForSyncComplete(localRoot, '/main.tex', 'push', 'update');
        const pullEvent = await (scm as any).applySync('pull', 'update', '/main.tex', remoteMain, localMain);
        const pushEvent = await pushWait;

        assert.strictEqual(pullEvent.outcome, 'suppressed');
        assert.strictEqual(pushEvent.outcome, 'success');
        assert.strictEqual(await readText(remoteMain), 'local diverged v2');
    });

    test('precompile forced push still respects failed initial pull guard', async () => {
        const remoteRoot = await tempDir('sr-overleaf-guard-remote-');
        const localRoot = await tempDir('sr-overleaf-guard-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v1');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(localMain, 'local should not clobber remote');
        (scm as any).failedInitialPulls.add('/main.tex');

        await assert.rejects(
            () => scm.flushBeforeCompile([localMain]),
            /initial pull failed/,
        );
        assert.strictEqual(await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')), 'remote v1');
    });

    test('keeps an unverified local copy quarantined after a live remote delete', async () => {
        const remoteRoot = await tempDir('sr-overleaf-quarantine-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-quarantine-delete-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'unverified local copy');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        (scm as any).failedInitialPulls.add('/main.tex');
        (scm as any).initialPullStatus = 'partial';
        await vscode.workspace.fs.delete(remoteMain);

        const event = await (scm as any).applySync(
            'pull',
            'delete',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'suppressed');
        assert.strictEqual((scm as any).failedInitialPulls.has('/main.tex'), true);
        assert.strictEqual((scm as any).syncConflicts.has('/main.tex'), true);
        assert.strictEqual(await readText(localMain), 'unverified local copy');
        await assert.rejects(() => scm.flushBeforeCompile([]), /never verified|sync conflict/i);
        assert.strictEqual(await pathExists(remoteMain), false);
    });

    test('clears failed-pull quarantine after a successful live authoritative pull', async () => {
        const remoteRoot = await tempDir('sr-overleaf-quarantine-recover-remote-');
        const localRoot = await tempDir('sr-overleaf-quarantine-recover-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        (scm as any).failedInitialPulls.add('/main.tex');
        (scm as any).initialPullStatus = 'partial';
        await writeText(remoteMain, 'authoritative recovered content');

        const event = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual((scm as any).failedInitialPulls.has('/main.tex'), false);
        assert.strictEqual((scm as any).initialPullStatus, 'complete');
        assert.strictEqual(await readText(localMain), 'authoritative recovered content');
    });

    test('retains failed-pull quarantine when the live pull cannot update local disk', async () => {
        const remoteRoot = await tempDir('sr-overleaf-quarantine-write-fail-remote-');
        const localRoot = await tempDir('sr-overleaf-quarantine-write-fail-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        (scm as any).failedInitialPulls.add('/main.tex');
        (scm as any).initialPullStatus = 'partial';
        await writeText(remoteMain, 'remote update that cannot land');

        const originalRunSessionIO = (scm as any).runSessionIO.bind(scm);
        let failNextWrite = true;
        (scm as any).runSessionIO = async (
            generation: number,
            task: () => Promise<unknown>,
        ) => {
            if (failNextWrite) {
                failNextWrite = false;
                throw new Error('simulated local write failure');
            }
            return originalRunSessionIO(generation, task);
        };
        try {
            const event = await (scm as any).applySync(
                'pull',
                'update',
                '/main.tex',
                remoteMain,
                localMain,
            ) as Events['scmSyncCompleteEvent'];

            assert.strictEqual(event.outcome, 'error');
            assert.strictEqual((scm as any).failedInitialPulls.has('/main.tex'), true);
            assert.strictEqual(await readText(localMain), 'baseline');
        } finally {
            (scm as any).runSessionIO = originalRunSessionIO;
        }
    });

    test('allows a new partial-pull toast while ignoring an older generation action', async () => {
        const remoteRoot = await tempDir('sr-overleaf-stale-toast-remote-');
        const localRoot = await tempDir('sr-overleaf-stale-toast-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        (scm as any).failedInitialPulls.add('/old-session.tex');
        (scm as any).initialPullStatus = 'partial';

        const choiceResolvers: Array<(choice: string | undefined) => void> = [];
        (vscode.window as any).showWarningMessage = () => new Promise<string | undefined>(resolve => {
            choiceResolvers.push(resolve);
        });
        let retryCount = 0;
        (scm as any).retryFailedInitialPulls = async () => {
            retryCount += 1;
            return {recovered: [], stillFailed: []};
        };

        const oldGeneration = (scm as any).syncGeneration;
        (scm as any).surfacePartialPullToast(oldGeneration);
        scm.deactivate();
        await (scm as any).beginSyncSession();
        (scm as any).failedInitialPulls.clear();
        (scm as any).failedInitialPulls.add('/new-session.tex');
        (scm as any).initialPullStatus = 'partial';
        const newGeneration = (scm as any).syncGeneration;
        (scm as any).surfacePartialPullToast(newGeneration);

        assert.strictEqual(choiceResolvers.length, 2);
        choiceResolvers[0](vscode.l10n.t('Retry Pull'));
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.strictEqual(retryCount, 0);
        assert.strictEqual((scm as any).failedInitialPulls.has('/new-session.tex'), true);
        assert.strictEqual((scm as any).partialPullToastGeneration, newGeneration);

        choiceResolvers[1](undefined);
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.strictEqual((scm as any).partialPullToastGeneration, undefined);
    });

    test('disposes buffered sync watchers when the initial project pull is cancelled', async () => {
        const remoteRoot = await tempDir('sr-overleaf-cancelled-pull-remote-');
        const localRoot = await tempDir('sr-overleaf-cancelled-pull-local-');
        tempRoots.push(remoteRoot, localRoot);

        const scm = createSCM(remoteRoot, localRoot);
        let watcherCreateCount = 0;
        (vscode.workspace as any).createFileSystemWatcher = () => {
            watcherCreateCount += 1;
            return new TestFileSystemWatcher();
        };
        (scm as any).overwrite = async () => undefined;

        await assert.rejects(
            () => (scm as any).initWatch(),
            /initial pull did not complete/,
        );

        assert.strictEqual(watcherCreateCount, 2);
        assert.strictEqual((scm as any).syncSessionActive, false);
        assert.strictEqual((scm as any).vfsWatcher, undefined);
        assert.strictEqual((scm as any).localWatcher, undefined);
    });

    test('rechecks restored clean editors after both sync watchers are armed', async () => {
        const remoteRoot = await tempDir('sr-overleaf-post-watch-refresh-remote-');
        const localRoot = await tempDir('sr-overleaf-post-watch-refresh-local-');
        tempRoots.push(remoteRoot, localRoot);

        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };
        const scm = createSCM(remoteRoot, localRoot);
        (scm as any).initializeLocalReplica = async () => true;
        let refreshCount = 0;
        (scm as any).refreshCleanOpenReplicaDocumentsFromDisk = async () => {
            refreshCount += 1;
            assert.strictEqual(watchers.length, 2);
            assert.ok((scm as any).vfsWatcher);
            assert.ok((scm as any).localWatcher);
            return [];
        };

        const disposables = await (scm as any).initWatch() as vscode.Disposable[];
        try {
            assert.strictEqual(refreshCount, 1);
        } finally {
            disposables.forEach(disposable => disposable.dispose());
        }
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

    test('accepts linked Overleaf entities only for remote pull stat classification', () => {
        const linkedFileStat: vscode.FileStat = {
            type: vscode.FileType.File | vscode.FileType.SymbolicLink,
            ctime: 0,
            mtime: 0,
            size: 8,
        };
        const linkedDirectoryStat: vscode.FileStat = {
            ...linkedFileStat,
            type: vscode.FileType.Directory | vscode.FileType.SymbolicLink,
        };
        const isSyncStatType = (LocalReplicaSCMProvider as any).isSyncStatType.bind(
            LocalReplicaSCMProvider,
        );

        assert.strictEqual(isSyncStatType(linkedFileStat, vscode.FileType.File, true), true);
        assert.strictEqual(isSyncStatType(linkedDirectoryStat, vscode.FileType.Directory, true), true);
        assert.strictEqual(isSyncStatType(linkedFileStat, vscode.FileType.File, false), false);
        assert.strictEqual(isSyncStatType(linkedDirectoryStat, vscode.FileType.Directory, false), false);
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

    test('clears descendant state when a remote folder delete arrives after the local folder is already missing', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-delete-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'nested', 'sample.tex'), 'remote baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await vscode.workspace.fs.delete(localChapter, {recursive: true});
        await vscode.workspace.fs.delete(remoteChapter, {recursive: true});

        const childPath = '/chapter/nested/sample.tex';
        const pendingTimer = setTimeout(() => undefined, 5000);
        (scm as any).bypassCache.set(childPath, [
            {date: Date.now(), hash: 'push'},
            {date: Date.now(), hash: 'pull'},
        ]);
        (scm as any).failedInitialPulls.add(childPath);
        (scm as any).remoteDeleteTombstones.set(childPath, {digest: 'old'});
        (scm as any).pendingLocalEvents.set(childPath, {
            timer: pendingTimer,
            firstEventAt: Date.now(),
            latestType: 'delete',
            latestUri: vscode.Uri.joinPath(localChapter, 'nested', 'sample.tex'),
        });
        (scm as any).pendingVfsEvents.set(childPath, {
            timer: pendingTimer,
            firstEventAt: Date.now(),
            latestType: 'delete',
            latestUri: vscode.Uri.joinPath(remoteChapter, 'nested', 'sample.tex'),
        });

        const applySync = (scm as any).applySync.bind(scm);
        await applySync('pull', 'delete', '/chapter', remoteChapter, localChapter);

        const baseCache = (scm as any).baseCache as Record<string, Uint8Array>;
        const manifest = (scm as any).syncManifest as {
            files: Record<string, unknown>;
            directories: Record<string, unknown>;
        };
        assert.deepStrictEqual(
            Object.keys(baseCache).filter(path => path.startsWith('/chapter/')),
            [],
        );
        assert.deepStrictEqual(
            Object.keys(manifest.files).filter(path => path.startsWith('/chapter/')),
            [],
        );
        assert.deepStrictEqual(
            Object.keys(manifest.directories).filter(path => path==='/chapter' || path.startsWith('/chapter/')),
            [],
        );
        assert.strictEqual((scm as any).bypassCache.has(childPath), false);
        assert.strictEqual((scm as any).failedInitialPulls.has(childPath), false);
        assert.strictEqual((scm as any).remoteDeleteTombstones.has(childPath), false);
        assert.strictEqual((scm as any).pendingLocalEvents.has(childPath), false);
        assert.strictEqual((scm as any).pendingVfsEvents.has(childPath), false);
    });

    test('does not suppress a remote folder delete with an older folder update echo', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-echo-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-echo-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteFolder = vscode.Uri.joinPath(remoteRoot, 'remote-folder');
        const localFolder = vscode.Uri.joinPath(localRoot, 'remote-folder');
        await vscode.workspace.fs.createDirectory(remoteFolder);

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        assert.strictEqual(await pathExists(localFolder), true);

        assert.strictEqual(
            (scm as any).shouldPropagate(
                'pull',
                'update',
                '/remote-folder',
                undefined,
            ),
            true,
        );
        await vscode.workspace.fs.delete(remoteFolder, {recursive: true});

        const applySync = (scm as any).applySync.bind(scm);
        const event = await applySync(
            'pull',
            'delete',
            '/remote-folder',
            remoteFolder,
            localFolder,
        );

        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(await pathExists(localFolder), false);
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
        const event = await applySync('push', 'update', '/sample.tex', localSample, remoteSample);

        // The property this test exists for is unchanged: the stale copy must not
        // resurrect the file on Overleaf. What changed is what happens to the
        // local copy. A restore tool preserving the deleted revision's timestamp
        // and a person re-creating the file by hand leave identical evidence, so
        // deleting on that evidence was choosing a winner silently. The ambiguity
        // is now surfaced as a conflict and the local copy is preserved.
        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(await pathExists(remoteSample), false);
        assert.strictEqual(await pathExists(localSample), true);
        assert.strictEqual((scm as any).syncConflicts.has('/sample.tex'), true);
    });

    test('allows an intentional same-content restore after the remote-delete conflict window', async () => {
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
        const tombstone = (scm as any).remoteDeleteTombstones.get('/sample.tex') as {
            deletedAt: number;
        };
        tombstone.deletedAt = Date.now()
            -(scm.constructor as any).remoteDeleteConflictWindowMs
            -1;
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

    test('preserves the Overleaf entity for a watcher-observed local media rename', async () => {
        const remoteRoot = await tempDir('sr-overleaf-local-move-remote-');
        const localRoot = await tempDir('sr-overleaf-local-move-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteOld = vscode.Uri.joinPath(remoteRoot, 'figures', 'draft.pdf');
        const remoteNew = vscode.Uri.joinPath(remoteRoot, 'figures', 'final.pdf');
        const localOld = vscode.Uri.joinPath(localRoot, 'figures', 'draft.pdf');
        const localNew = vscode.Uri.joinPath(localRoot, 'figures', 'final.pdf');
        const pdf = Buffer.from('%PDF-1.7 local rename\\n', 'utf-8');
        await writeBytes(remoteOld, pdf);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('figures/draft.pdf', 'file-original-entity');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.rename(localOld, localNew, {overwrite: false});
        // These are the same entry point used by the local watcher after it
        // observes an unlink/create pair. The source event is intentionally
        // delivered first so the short candidate hold is exercised.
        await (scm as any).syncToVFS(localOld, 'delete');
        await (scm as any).syncToVFS(localNew, 'update');
        await new Promise<void>(resolve => setTimeout(resolve, 400));
        await (scm as any).drainPendingSyncWork();

        assert.strictEqual(await pathExists(remoteOld), false);
        assert.deepStrictEqual(await readBytes(remoteNew), pdf);
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteNew)).fileEntity._id,
            'file-original-entity',
        );
        assert.strictEqual((scm as any).syncManifest.files['/figures/draft.pdf'], undefined);
        assert.strictEqual(
            (scm as any).syncManifest.files['/figures/final.pdf'].remoteEntity.id,
            'file-original-entity',
        );
        assert.deepStrictEqual((scm as any).syncManifest.pendingOperations, {});
    });


    test('keeps a journaled file move conflicted when its source parent is replaced at the rename boundary', async () => {
        const remoteRoot = await tempDir('sr-overleaf-file-move-source-parent-race-remote-');
        const localRoot = await tempDir('sr-overleaf-file-move-source-parent-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'drafts', 'draft.pdf');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final.pdf');
        const localSource = vscode.Uri.joinPath(localRoot, 'drafts', 'draft.pdf');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final.pdf');
        const pdf = Buffer.from('%PDF-1.7 source parent race\\n', 'utf-8');
        await writeBytes(remoteSource, pdf);
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('drafts', 'file-source-parent-original');
        fakeVfs.setEntityId('archive', 'file-destination-parent-original');
        fakeVfs.setEntityId('drafts/draft.pdf', 'file-source-parent-race-entity');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
        const sourceRelPath = '/drafts/draft.pdf';
        const destinationRelPath = '/archive/final.pdf';
        const sourceEntry = scm.syncManifest.files[sourceRelPath];
        const sourceState = await scm.captureRemotePathRevision(sourceRelPath);
        const parentProof = await scm.capturePendingLocalFileMoveParentProof(
            sourceRelPath,
            destinationRelPath,
            sourceEntry,
        );
        const record = await scm.journalPendingLocalFileMove(
            sourceRelPath,
            destinationRelPath,
            sourceEntry,
            sourceState,
            parentProof,
        );
        assert.strictEqual(record.sourceParentEntity.id, 'file-source-parent-original');

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let renameAttempted = 0;
        fakeVfs.rename = async (...args: Parameters<FakeVirtualFileSystem['rename']>) => {
            renameAttempted += 1;
            // This models a collaborator replacing /drafts after the client
            // inspected the move but before the request's entity guard runs.
            fakeVfs.setEntityId('drafts', 'file-source-parent-collaborator');
            return originalRename(...args);
        };
        try {
            const outcome = await scm.executePendingLocalFileMove(
                sourceRelPath,
                record,
                await readBytes(localDestination),
            );

            assert.strictEqual(outcome, 'conflict');
            assert.strictEqual(renameAttempted, 1);
            assert.deepStrictEqual(await readBytes(remoteSource), pdf);
            assert.strictEqual(await pathExists(remoteDestination), false);
            assert.match(scm.syncConflicts.get(destinationRelPath), /local move|Overleaf changed/i);
            const pending = scm.syncManifest.pendingOperations[sourceRelPath];
            assert.strictEqual(pending.kind, 'move');
            assert.strictEqual(pending.sourceParentEntity.id, 'file-source-parent-original');
        } finally {
            fakeVfs.rename = originalRename;
        }
    });

    test('blocks a journaled file move before rename when its destination parent is replaced', async () => {
        const remoteRoot = await tempDir('sr-overleaf-file-move-destination-parent-race-remote-');
        const localRoot = await tempDir('sr-overleaf-file-move-destination-parent-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'drafts', 'draft.pdf');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final.pdf');
        const localSource = vscode.Uri.joinPath(localRoot, 'drafts', 'draft.pdf');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final.pdf');
        const pdf = Buffer.from('%PDF-1.7 destination parent race\\n', 'utf-8');
        await writeBytes(remoteSource, pdf);
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('drafts', 'file-source-parent-original');
        fakeVfs.setEntityId('archive', 'file-destination-parent-original');
        fakeVfs.setEntityId('drafts/draft.pdf', 'file-destination-parent-race-entity');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
        const sourceRelPath = '/drafts/draft.pdf';
        const destinationRelPath = '/archive/final.pdf';
        const sourceEntry = scm.syncManifest.files[sourceRelPath];
        const parentProof = await scm.capturePendingLocalFileMoveParentProof(
            sourceRelPath,
            destinationRelPath,
            sourceEntry,
        );
        const record = await scm.journalPendingLocalFileMove(
            sourceRelPath,
            destinationRelPath,
            sourceEntry,
            await scm.captureRemotePathRevision(sourceRelPath),
            parentProof,
        );
        assert.strictEqual(record.destinationParentEntity.id, 'file-destination-parent-original');

        const originalEnsureConnectedForWrite = fakeVfs.ensureConnectedForWrite.bind(fakeVfs);
        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let destinationParentPreflight = 0;
        let renameAttempted = 0;
        fakeVfs.ensureConnectedForWrite = async () => {
            await originalEnsureConnectedForWrite();
            if (destinationParentPreflight===0) {
                destinationParentPreflight += 1;
                // Change the parent after the ordinary inspection but before
                // the new execution-time destination-parent proof.
                fakeVfs.setEntityId('archive', 'file-destination-parent-collaborator');
            }
        };
        fakeVfs.rename = async (...args: Parameters<FakeVirtualFileSystem['rename']>) => {
            renameAttempted += 1;
            return originalRename(...args);
        };
        try {
            const outcome = await scm.executePendingLocalFileMove(
                sourceRelPath,
                record,
                await readBytes(localDestination),
            );

            assert.strictEqual(outcome, 'conflict');
            assert.strictEqual(destinationParentPreflight, 1);
            assert.strictEqual(renameAttempted, 0);
            assert.deepStrictEqual(await readBytes(remoteSource), pdf);
            assert.strictEqual(await pathExists(remoteDestination), false);
            assert.match(scm.syncConflicts.get(destinationRelPath), /local move|Overleaf changed/i);
            const pending = scm.syncManifest.pendingOperations[sourceRelPath];
            assert.strictEqual(pending.kind, 'move');
            assert.strictEqual(pending.destinationParentEntity.id, 'file-destination-parent-original');
        } finally {
            fakeVfs.ensureConnectedForWrite = originalEnsureConnectedForWrite;
            fakeVfs.rename = originalRename;
        }
    });

    test('keeps a journaled folder move conflicted when its source parent is replaced at the rename boundary', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-move-source-parent-race-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-move-source-parent-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'chapters', 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'chapters', 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'folder source parent race');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('chapters', 'folder-source-parent-original');
        fakeVfs.setEntityId('archive', 'folder-destination-parent-original');
        fakeVfs.setEntityId('chapters/draft', 'folder-source-parent-race-entity');
        fakeVfs.setEntityId('chapters/draft/main.tex', 'folder-source-parent-race-child');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
        const sourceRelPath = '/chapters/draft';
        const destinationRelPath = '/archive/final';
        const sourceEntry = scm.syncManifest.directories[sourceRelPath];
        const destinationState = await scm.captureLocalPathRevision(destinationRelPath);
        const record = await scm.journalPendingLocalDirectoryMove(
            sourceRelPath,
            destinationRelPath,
            sourceEntry,
            destinationState.revision,
            scm.syncManifest.directories['/archive'].remoteEntity,
        );
        assert.strictEqual(record.sourceParentEntity.id, 'folder-source-parent-original');

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let renameAttempted = 0;
        fakeVfs.rename = async (...args: Parameters<FakeVirtualFileSystem['rename']>) => {
            renameAttempted += 1;
            fakeVfs.setEntityId('chapters', 'folder-source-parent-collaborator');
            return originalRename(...args);
        };
        try {
            const outcome = await scm.executePendingLocalDirectoryMove(sourceRelPath, record);

            assert.strictEqual(outcome, 'conflict');
            assert.strictEqual(renameAttempted, 1);
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteSource, 'main.tex')),
                'folder source parent race',
            );
            assert.strictEqual(await pathExists(remoteDestination), false);
            assert.match(scm.syncConflicts.get(destinationRelPath), /folder move|Overleaf changed/i);
            const pending = scm.syncManifest.pendingOperations[sourceRelPath];
            assert.strictEqual(pending.kind, 'directory-move');
            assert.strictEqual(pending.sourceParentEntity.id, 'folder-source-parent-original');
        } finally {
            fakeVfs.rename = originalRename;
        }
    });

    test('blocks a journaled folder move before rename when its destination parent is replaced', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-move-destination-parent-race-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-move-destination-parent-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'chapters', 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'chapters', 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'folder destination parent race');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('chapters', 'folder-source-parent-original');
        fakeVfs.setEntityId('archive', 'folder-destination-parent-original');
        fakeVfs.setEntityId('chapters/draft', 'folder-destination-parent-race-entity');
        fakeVfs.setEntityId('chapters/draft/main.tex', 'folder-destination-parent-race-child');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
        const sourceRelPath = '/chapters/draft';
        const destinationRelPath = '/archive/final';
        const sourceEntry = scm.syncManifest.directories[sourceRelPath];
        const destinationState = await scm.captureLocalPathRevision(destinationRelPath);
        const record = await scm.journalPendingLocalDirectoryMove(
            sourceRelPath,
            destinationRelPath,
            sourceEntry,
            destinationState.revision,
            scm.syncManifest.directories['/archive'].remoteEntity,
        );
        assert.strictEqual(record.destinationParentEntity.id, 'folder-destination-parent-original');

        const originalEnsureConnectedForWrite = fakeVfs.ensureConnectedForWrite.bind(fakeVfs);
        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let destinationParentPreflight = 0;
        let renameAttempted = 0;
        fakeVfs.ensureConnectedForWrite = async () => {
            await originalEnsureConnectedForWrite();
            if (destinationParentPreflight===0) {
                destinationParentPreflight += 1;
                // Change the parent after the ordinary inspection but before
                // the new execution-time destination-parent proof.
                fakeVfs.setEntityId('archive', 'folder-destination-parent-collaborator');
            }
        };
        fakeVfs.rename = async (...args: Parameters<FakeVirtualFileSystem['rename']>) => {
            renameAttempted += 1;
            return originalRename(...args);
        };
        try {
            const outcome = await scm.executePendingLocalDirectoryMove(sourceRelPath, record);

            assert.strictEqual(outcome, 'conflict');
            assert.strictEqual(destinationParentPreflight, 1);
            assert.strictEqual(renameAttempted, 0);
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteSource, 'main.tex')),
                'folder destination parent race',
            );
            assert.strictEqual(await pathExists(remoteDestination), false);
            assert.match(scm.syncConflicts.get(destinationRelPath), /folder move|Overleaf changed/i);
            const pending = scm.syncManifest.pendingOperations[sourceRelPath];
            assert.strictEqual(pending.kind, 'directory-move');
            assert.strictEqual(pending.destinationParentEntity.id, 'folder-destination-parent-original');
        } finally {
            fakeVfs.ensureConnectedForWrite = originalEnsureConnectedForWrite;
            fakeVfs.rename = originalRename;
        }
    });


    test('upgrades a trusted legacy file move with recorded folder parents before applying it', async () => {
        const remoteRoot = await tempDir('sr-overleaf-legacy-file-move-upgrade-remote-');
        const localRoot = await tempDir('sr-overleaf-legacy-file-move-upgrade-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'drafts', 'draft.tex');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final.tex');
        const localSource = vscode.Uri.joinPath(localRoot, 'drafts', 'draft.tex');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final.tex');
        await writeText(remoteSource, 'legacy parent proof');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('drafts', 'legacy-source-parent');
        fakeVfs.setEntityId('archive', 'legacy-destination-parent');
        fakeVfs.setEntityId('drafts/draft.tex', 'legacy-file-entity');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
        const sourceRelPath = '/drafts/draft.tex';
        const destinationRelPath = '/archive/final.tex';
        const sourceEntry = scm.syncManifest.files[sourceRelPath];
        const parentProof = await scm.capturePendingLocalFileMoveParentProof(
            sourceRelPath,
            destinationRelPath,
            sourceEntry,
        );
        const record = await scm.journalPendingLocalFileMove(
            sourceRelPath,
            destinationRelPath,
            sourceEntry,
            await scm.captureRemotePathRevision(sourceRelPath),
            parentProof,
        );
        const legacyRecord = {
            ...record,
            version: 2,
            sourceParentEntity: undefined,
            destinationParentEntity: undefined,
        };
        scm.syncManifest.pendingOperations[sourceRelPath] = legacyRecord;
        delete scm.syncManifest.files[sourceRelPath].parentEntity;

        const outcome = await scm.executePendingLocalFileMove(
            sourceRelPath,
            legacyRecord,
            await readBytes(localDestination),
        );

        assert.strictEqual(outcome, 'accepted');
        assert.strictEqual(await pathExists(remoteSource), false);
        assert.strictEqual(await readText(remoteDestination), 'legacy parent proof');
        assert.deepStrictEqual(scm.syncManifest.pendingOperations, {});
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteDestination)).fileEntity._id,
            'legacy-file-entity',
        );
    });

    test('keeps an identity-less legacy file move conflicted when trusted parent proof is unavailable', async () => {
        const remoteRoot = await tempDir('sr-overleaf-legacy-file-move-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-legacy-file-move-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'drafts', 'draft.tex');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final.tex');
        const localSource = vscode.Uri.joinPath(localRoot, 'drafts', 'draft.tex');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final.tex');
        await writeText(remoteSource, 'legacy proof unavailable');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('drafts', 'legacy-unproven-source-parent');
        fakeVfs.setEntityId('archive', 'legacy-unproven-destination-parent');
        fakeVfs.setEntityId('drafts/draft.tex', 'legacy-unproven-file');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
        const sourceRelPath = '/drafts/draft.tex';
        const destinationRelPath = '/archive/final.tex';
        const sourceEntry = scm.syncManifest.files[sourceRelPath];
        const parentProof = await scm.capturePendingLocalFileMoveParentProof(
            sourceRelPath,
            destinationRelPath,
            sourceEntry,
        );
        const record = await scm.journalPendingLocalFileMove(
            sourceRelPath,
            destinationRelPath,
            sourceEntry,
            await scm.captureRemotePathRevision(sourceRelPath),
            parentProof,
        );
        const legacyRecord = {
            ...record,
            version: 2,
            sourceParentEntity: undefined,
            destinationParentEntity: undefined,
        };
        scm.syncManifest.pendingOperations[sourceRelPath] = legacyRecord;
        delete scm.syncManifest.files[sourceRelPath].parentEntity;
        delete scm.syncManifest.directories['/drafts'].remoteEntity;
        delete scm.syncManifest.directories['/archive'].remoteEntity;

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let renameAttempted = 0;
        fakeVfs.rename = async (...args: Parameters<FakeVirtualFileSystem['rename']>) => {
            renameAttempted += 1;
            return originalRename(...args);
        };
        try {
            const outcome = await scm.executePendingLocalFileMove(
                sourceRelPath,
                legacyRecord,
                await readBytes(localDestination),
            );

            assert.strictEqual(outcome, 'conflict');
            assert.strictEqual(renameAttempted, 0);
            assert.strictEqual(await readText(remoteSource), 'legacy proof unavailable');
            assert.strictEqual(await pathExists(remoteDestination), false);
            assert.match(scm.syncConflicts.get(destinationRelPath), /legacy local move lacks trusted/i);
            assert.strictEqual(
                scm.syncManifest.pendingOperations[sourceRelPath].version,
                2,
            );
        } finally {
            fakeVfs.rename = originalRename;
        }
    });

    test('preserves folder and child entity IDs for a watcher-observed local cross-folder rename', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-local-folder-move-remote-');
        const localRoot = await tempDir('sr-overleaf-local-folder-move-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'folder move baseline');
        await writeBytes(vscode.Uri.joinPath(remoteSource, 'figure.png'), Buffer.from([4, 2, 4]));
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-draft-entity');
        fakeVfs.setEntityId('archive', 'folder-archive-entity');
        fakeVfs.setEntityId('draft/main.tex', 'doc-draft-main-entity');
        fakeVfs.setEntityId('draft/figure.png', 'file-draft-figure-entity');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
        // Deliver the unlink first: the source must be held until the matching
        // directory create proves the same local inode and full tree.
        await scm.syncToVFS(localSource, 'delete');
        await scm.syncToVFS(localDestination, 'update');
        await new Promise<void>(resolve => setTimeout(resolve, 700));
        await scm.drainPendingSyncWork();

        assert.strictEqual(await pathExists(remoteSource), false);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteDestination, 'main.tex')),
            'folder move baseline',
        );
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(remoteDestination, 'figure.png')),
            Buffer.from([4, 2, 4]),
        );
        assert.strictEqual((await fakeVfs._resolveUri(remoteDestination)).fileEntity._id, 'folder-draft-entity');
        assert.strictEqual(
            (await fakeVfs._resolveUri(vscode.Uri.joinPath(remoteDestination, 'main.tex'))).fileEntity._id,
            'doc-draft-main-entity',
        );
        assert.strictEqual(
            (await fakeVfs._resolveUri(vscode.Uri.joinPath(remoteDestination, 'figure.png'))).fileEntity._id,
            'file-draft-figure-entity',
        );
        assert.strictEqual(scm.syncManifest.directories['/draft'], undefined);
        assert.strictEqual(
            scm.syncManifest.directories['/archive/final'].remoteEntity.id,
            'folder-draft-entity',
        );
        assert.strictEqual(
            scm.syncManifest.directories['/archive/final'].parentEntity.id,
            'folder-archive-entity',
        );
        assert.strictEqual(
            scm.syncManifest.files['/archive/final/main.tex'].remoteEntity.id,
            'doc-draft-main-entity',
        );
        assert.deepStrictEqual(scm.syncManifest.pendingOperations, {});
    });


    test('claims a folder move before a child watcher event becomes a standalone operation', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-folder-move-child-first-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-move-child-first-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        const localChild = vscode.Uri.joinPath(localDestination, 'nested', 'main.tex');
        await writeText(vscode.Uri.joinPath(remoteSource, 'nested', 'main.tex'), 'child-first folder move');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-child-first-source');
        fakeVfs.setEntityId('draft/nested', 'folder-child-first-nested');
        fakeVfs.setEntityId('draft/nested/main.tex', 'doc-child-first-main');
        fakeVfs.setEntityId('archive', 'folder-child-first-archive');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        let fileMoveJournals = 0;
        const originalJournalFileMove = scm.journalPendingLocalFileMove.bind(scm);
        scm.journalPendingLocalFileMove = async (...args: unknown[]) => {
            fileMoveJournals += 1;
            return originalJournalFileMove(...args);
        };
        try {
            await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
            // Real local watchers may deliver a descendant Change/Create before
            // either the root destination or source unlink. It must claim the
            // enclosing inode/tree move rather than journal a file mutation.
            await scm.syncToVFS(localChild, 'update');
            await scm.syncToVFS(localSource, 'delete');
            await scm.syncToVFS(localDestination, 'update');
            await new Promise<void>(resolve => setTimeout(resolve, 900));
            await scm.drainPendingSyncWork();
        } finally {
            scm.journalPendingLocalFileMove = originalJournalFileMove;
        }

        assert.strictEqual(fileMoveJournals, 0);
        assert.strictEqual(await pathExists(remoteSource), false);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteDestination, 'nested', 'main.tex')),
            'child-first folder move',
        );
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteDestination)).fileEntity._id,
            'folder-child-first-source',
        );
        assert.strictEqual(
            (await fakeVfs._resolveUri(vscode.Uri.joinPath(remoteDestination, 'nested'))).fileEntity._id,
            'folder-child-first-nested',
        );
        assert.strictEqual(
            (await fakeVfs._resolveUri(vscode.Uri.joinPath(remoteDestination, 'nested', 'main.tex'))).fileEntity._id,
            'doc-child-first-main',
        );
        assert.strictEqual(scm.syncManifest.directories['/draft'], undefined);
        assert.strictEqual(scm.syncManifest.files['/draft/nested/main.tex'], undefined);
        assert.strictEqual(
            scm.syncManifest.directories['/archive/final'].remoteEntity.id,
            'folder-child-first-source',
        );
        assert.strictEqual(
            scm.syncManifest.files['/archive/final/nested/main.tex'].remoteEntity.id,
            'doc-child-first-main',
        );
        assert.deepStrictEqual(scm.syncManifest.pendingOperations, {});
        assert.strictEqual(scm.syncConflicts.has('/archive/final'), false);
    });


    test('defers transient remote folder-move events until the local journal finalizes', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-folder-move-remote-echo-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-move-remote-echo-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        await writeText(
            vscode.Uri.joinPath(remoteSource, 'nested', 'main.tex'),
            'remote echo fence',
        );
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-remote-echo-source');
        fakeVfs.setEntityId('draft/nested', 'folder-remote-echo-nested');
        fakeVfs.setEntityId('draft/nested/main.tex', 'doc-remote-echo-main');
        fakeVfs.setEntityId('archive', 'folder-remote-echo-archive');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        // A stale conflicted move may have the same root-level intermediate
        // basename. It is retained as evidence but cannot fence the live move.
        scm.syncManifest.pendingOperations['/stale'] = {
            id: 'stale-conflicted-folder-move',
            kind: 'directory-move',
            destinationRelPath: '/stale-archive/final',
        };
        scm.syncConflicts.set('/stale-archive/final', 'stale test conflict');

        const remoteEventUri = (relPath: string) => vscode.Uri.parse(
            ROOT_NAME + '://test-server/Select%20Folder%20Test/' + relPath +
            '?user=test-user&project=test-project',
        );
        const originalRemoteTargetEventType = scm.remoteTargetEventType.bind(scm);
        scm.remoteTargetEventType = async (uri: vscode.Uri) => {
            if (uri.path.includes('/final')) { return 'delete'; }
            return originalRemoteTargetEventType(uri);
        };
        const originalApplySync = scm.applySync.bind(scm);
        let pullBeforeFinalization = 0;
        let finalized = false;
        scm.applySync = async (...args: unknown[]) => {
            if (args[0]==='pull' && !finalized) {
                pullBeforeFinalization += 1;
            }
            return originalApplySync(...args);
        };
        const originalFinalize = scm.finalizeAcceptedLocalDirectoryMove.bind(scm);
        scm.finalizeAcceptedLocalDirectoryMove = async (...args: unknown[]) => {
            assert.strictEqual(pullBeforeFinalization, 0);
            const result = await originalFinalize(...args);
            finalized = true;
            return result;
        };
        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let injected = false;
        fakeVfs.rename = async (...args: Parameters<FakeVirtualFileSystem['rename']>) => {
            if (!injected) {
                injected = true;
                // The first server operation renames /draft to the temporary
                // old-parent path /final before moving it under /archive.
                // It and its child path must not become pull work while the
                // folder-move journal is still proving the final entity.
                assert.ok(scm.pendingDirectoryMoveCoveringRemoteEvent('/draft/nested'));
                assert.ok(scm.pendingDirectoryMoveCoveringRemoteEvent('/archive/final/nested'));
                const intermediateFence = scm.pendingDirectoryMoveCoveringRemoteEvent('/final/nested');
                assert.strictEqual(intermediateFence?.sourceRelPath, '/draft');
                scm.syncFromVFS(remoteEventUri('final'), 'update');
                scm.syncFromVFS(remoteEventUri('final/nested'), 'update');
                scm.syncFromVFS(remoteEventUri('final/nested/main.tex'), 'update');
                delete scm.syncManifest.pendingOperations['/stale'];
                scm.syncConflicts.delete('/stale-archive/final');
                await new Promise<void>(resolve => setTimeout(resolve, 400));
            }
            return originalRename(...args);
        };
        try {
            await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
            await scm.syncToVFS(localSource, 'delete');
            await scm.syncToVFS(localDestination, 'update');
            await new Promise<void>(resolve => setTimeout(resolve, 1_000));
            await scm.drainPendingSyncWork();
        } finally {
            fakeVfs.rename = originalRename;
            scm.finalizeAcceptedLocalDirectoryMove = originalFinalize;
            scm.applySync = originalApplySync;
            scm.remoteTargetEventType = originalRemoteTargetEventType;
        }

        assert.strictEqual(injected, true);
        assert.strictEqual(finalized, true);
        assert.strictEqual(pullBeforeFinalization, 0);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'final')), false);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteDestination, 'nested', 'main.tex')),
            'remote echo fence',
        );
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteDestination)).fileEntity._id,
            'folder-remote-echo-source',
        );
        assert.deepStrictEqual(scm.syncManifest.pendingOperations, {});
        assert.strictEqual(scm.syncConflicts.has('/archive/final'), false);
        assert.strictEqual(scm.deferredRemoteEventsDuringDirectoryMove.size, 0);
    });


    test('fences a debounced remote folder-move echo after its journal appears and reclassifies it on conflict', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-folder-move-debounce-fence-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-move-debounce-fence-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(
            vscode.Uri.joinPath(remoteRoot, 'draft', 'nested', 'main.tex'),
            'debounced remote echo',
        );
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(remoteRoot, 'archive'));
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-debounce-source');
        fakeVfs.setEntityId('draft/nested', 'folder-debounce-nested');
        fakeVfs.setEntityId('draft/nested/main.tex', 'doc-debounce-main');
        fakeVfs.setEntityId('archive', 'folder-debounce-archive');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const remoteEventUri = vscode.Uri.parse(
            ROOT_NAME + '://test-server/Select%20Folder%20Test/final/nested/main.tex' +
            '?user=test-user&project=test-project',
        );
        const originalRemoteTargetEventType = scm.remoteTargetEventType.bind(scm);
        const originalApplySync = scm.applySync.bind(scm);
        let pullCalls = 0;
        scm.remoteTargetEventType = async () => 'delete';
        scm.applySync = async (...args: unknown[]) => {
            if (args[0]==='pull') {
                pullCalls += 1;
            }
            return undefined;
        };
        try {
            // This socket event precedes the local move journal and is already
            // debounced. The timer must re-check the journal before it turns
            // into stale pull work.
            scm.syncFromVFS(remoteEventUri, 'update');
            assert.strictEqual(
                scm.pendingVfsEvents.has('/final/nested/main.tex'),
                true,
            );

            const sourceEntry = scm.syncManifest.directories['/draft'];
            const destinationParent = scm.syncManifest.directories['/archive'].remoteEntity;
            const sourceRevision = scm.manifestDirectoryRevision('/draft');
            assert.ok(sourceEntry);
            assert.ok(destinationParent);
            assert.ok(sourceRevision);
            const record = await scm.journalPendingLocalDirectoryMove(
                '/draft',
                '/archive/final',
                sourceEntry,
                sourceRevision,
                destinationParent,
            );

            await new Promise<void>(resolve => setTimeout(resolve, 450));
            assert.strictEqual(pullCalls, 0);
            const deferred = scm.deferredRemoteEventsDuringDirectoryMove
                .get('/final/nested/main.tex');
            assert.strictEqual(deferred?.operationId, record.id);
            assert.strictEqual(deferred?.sourceRelPath, '/draft');
            assert.strictEqual(deferred?.destinationRelPath, '/archive/final');

            // Once the move becomes a durable conflict, its tag is released
            // and the same remote event is reclassified. It cannot remain in
            // the map to be replayed by a later /final intermediate move.
            await scm.markSyncConflict(
                '/archive/final',
                'test-only folder move conflict',
            );
            await new Promise<void>(resolve => setTimeout(resolve, 450));
            assert.strictEqual(
                scm.deferredRemoteEventsDuringDirectoryMove.size,
                0,
            );
            assert.strictEqual(pullCalls, 1);
        } finally {
            scm.applySync = originalApplySync;
            scm.remoteTargetEventType = originalRemoteTargetEventType;
        }
    });


    test('defers child watcher events until local parent folders are replicated', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-recursive-create-remote-');
        const localRoot = await tempDir('sr-overleaf-recursive-create-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localTree = vscode.Uri.joinPath(localRoot, 'generated');
        const localNested = vscode.Uri.joinPath(localTree, 'nested');
        const localChild = vscode.Uri.joinPath(localNested, 'main.tex');
        const remoteNested = vscode.Uri.joinPath(remoteRoot, 'generated', 'nested');
        const remoteChild = vscode.Uri.joinPath(remoteNested, 'main.tex');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.createDirectory(localNested);
        await writeText(localChild, 'recursive local create');
        let childPushBeforeParent = false;
        const originalApplySync = scm.applySync.bind(scm);
        scm.applySync = async (...args: unknown[]) => {
            if (
                args[0]==='push'
                && args[2]==='/generated/nested/main.tex'
                && !(await pathExists(remoteNested))
            ) {
                childPushBeforeParent = true;
            }
            return originalApplySync(...args);
        };
        try {
            // File-system watcher ordering is intentionally child-first.
            await scm.syncToVFS(localChild, 'update');
            await scm.syncToVFS(localNested, 'update');
            await scm.syncToVFS(localTree, 'update');
            await new Promise<void>(resolve => setTimeout(resolve, 1_200));
            await scm.drainPendingSyncWork();
        } finally {
            scm.applySync = originalApplySync;
        }

        assert.strictEqual(childPushBeforeParent, false);
        assert.strictEqual(await readText(remoteChild), 'recursive local create');
        assert.deepStrictEqual(scm.syncManifest.pendingOperations, {});
        assert.strictEqual(scm.syncConflicts.has('/generated'), false);
        assert.strictEqual(scm.syncConflicts.has('/generated/nested/main.tex'), false);
    });

    test('keeps an accepted folder move journal when a conflict arrives before final rekey', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-folder-move-final-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-move-final-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'finalization fence');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-final-conflict-source');
        fakeVfs.setEntityId('archive', 'folder-final-conflict-parent');
        fakeVfs.setEntityId('draft/main.tex', 'doc-final-conflict-child');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const originalFinalize = scm.finalizeAcceptedLocalDirectoryMove.bind(scm);
        let injected = false;
        scm.finalizeAcceptedLocalDirectoryMove = async (...args: unknown[]) => {
            if (!injected) {
                injected = true;
                await scm.markSyncConflict(
                    '/draft/main.tex',
                    'test conflict injected at accepted folder-move finalization',
                );
            }
            return originalFinalize(...args);
        };
        try {
            await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
            await scm.syncToVFS(localSource, 'delete');
            await scm.syncToVFS(localDestination, 'update');
            await new Promise<void>(resolve => setTimeout(resolve, 700));
            await scm.drainPendingSyncWork();
        } finally {
            scm.finalizeAcceptedLocalDirectoryMove = originalFinalize;
        }

        assert.strictEqual(injected, true);
        assert.strictEqual(await pathExists(remoteSource), false);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteDestination, 'main.tex')),
            'finalization fence',
        );
        assert.strictEqual(await pathExists(localSource), false);
        assert.strictEqual(await pathExists(localDestination), true);
        assert.strictEqual(
            scm.syncManifest.pendingOperations['/draft'].kind,
            'directory-move',
        );
        assert.ok(scm.syncManifest.directories['/draft']);
        assert.strictEqual(scm.syncManifest.directories['/archive/final'], undefined);
        assert.ok(scm.syncConflicts.has('/draft/main.tex'));
        assert.ok(scm.syncManifest.conflicts['/draft/main.tex']);

        await scm.deactivate();
        const restarted = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(
            restarted.syncManifest.pendingOperations['/draft'].kind,
            'directory-move',
        );
        assert.ok(restarted.syncManifest.directories['/draft']);
        assert.strictEqual(restarted.syncManifest.directories['/archive/final'], undefined);
        assert.ok(restarted.syncConflicts.has('/draft/main.tex'));
        assert.ok(restarted.syncManifest.conflicts['/draft/main.tex']);
    });

    test('replays a journaled local folder move on reconnect without another watcher event', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-local-folder-move-reconnect-remote-');
        const localRoot = await tempDir('sr-overleaf-local-folder-move-reconnect-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'reconnect folder move');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-reconnect-source');
        fakeVfs.setEntityId('archive', 'folder-reconnect-parent');
        fakeVfs.setEntityId('draft/main.tex', 'doc-reconnect-child');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const triggers = await scm.triggers;
        const originalCapture = scm.captureRemotePathRevision.bind(scm);
        let unavailable = true;
        scm.captureRemotePathRevision = async (...args: unknown[]) => {
            if (unavailable) {
                throw new Error('simulated unavailable Overleaf folder-move proof');
            }
            return originalCapture(...args);
        };
        try {
            fakeVfs.setConnectionState('disconnected');
            await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
            await scm.syncToVFS(localSource, 'delete');
            await scm.syncToVFS(localDestination, 'update');
            await new Promise<void>(resolve => setTimeout(resolve, 700));
            await scm.drainPendingSyncWork();

            const pending = scm.syncManifest.pendingOperations['/draft'];
            assert.strictEqual(pending.kind, 'directory-move');
            assert.strictEqual(await pathExists(remoteSource), true);
            assert.strictEqual(await pathExists(remoteDestination), false);
            assert.strictEqual(scm.status.status, 'offline');

            unavailable = false;
            fakeVfs.setConnectionState('connected');
            await waitUntil(() => (
                scm.syncManifest.pendingOperations['/draft']===undefined
                && scm.status.status==='idle'
            ));
            assert.strictEqual(await pathExists(remoteSource), false);
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteDestination, 'main.tex')),
                'reconnect folder move',
            );
            assert.strictEqual((await fakeVfs._resolveUri(remoteDestination)).fileEntity._id, 'folder-reconnect-source');
            assert.strictEqual(
                (await fakeVfs._resolveUri(vscode.Uri.joinPath(remoteDestination, 'main.tex'))).fileEntity._id,
                'doc-reconnect-child',
            );
        } finally {
            scm.captureRemotePathRevision = originalCapture;
            triggers.forEach((trigger: vscode.Disposable) => trigger.dispose());
        }
    });

    test('replays a journaled local folder move after restart before initial reconciliation', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-local-folder-move-restart-remote-');
        const localRoot = await tempDir('sr-overleaf-local-folder-move-restart-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'restart folder move');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-restart-source');
        fakeVfs.setEntityId('archive', 'folder-restart-parent');
        fakeVfs.setEntityId('draft/main.tex', 'doc-restart-child');
        const firstScm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const originalRename = fakeVfs.rename.bind(fakeVfs);
        fakeVfs.rename = async () => {
            throw new Error('simulated transient folder move transport failure');
        };
        await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
        await firstScm.syncToVFS(localSource, 'delete');
        await firstScm.syncToVFS(localDestination, 'update');
        await new Promise<void>(resolve => setTimeout(resolve, 700));
        await firstScm.drainPendingSyncWork();

        const pending = firstScm.syncManifest.pendingOperations['/draft'];
        assert.strictEqual(pending.kind, 'directory-move');
        assert.strictEqual(await pathExists(remoteSource), true);
        assert.strictEqual(await pathExists(remoteDestination), false);
        await firstScm.deactivate();
        fakeVfs.rename = originalRename;

        const restartedScm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true});
        assert.strictEqual(await pathExists(remoteSource), false);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteDestination, 'main.tex')),
            'restart folder move',
        );
        assert.strictEqual((await fakeVfs._resolveUri(remoteDestination)).fileEntity._id, 'folder-restart-source');
        assert.strictEqual(
            (await fakeVfs._resolveUri(vscode.Uri.joinPath(remoteDestination, 'main.tex'))).fileEntity._id,
            'doc-restart-child',
        );
        assert.deepStrictEqual(restartedScm.syncManifest.pendingOperations, {});
    });

    test('preserves both folder trees when a local folder move destination is occupied remotely', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-local-folder-move-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-local-folder-move-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'local source folder');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-conflict-source');
        fakeVfs.setEntityId('archive', 'folder-conflict-parent');
        fakeVfs.setEntityId('draft/main.tex', 'doc-conflict-source');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        // A collaborator creates the destination after the authoritative
        // baseline. The local inode still proves a move intent, but that must
        // not overwrite or move the collaborator's unrelated folder.
        await writeText(vscode.Uri.joinPath(remoteDestination, 'remote.tex'), 'collaborator folder');
        fakeVfs.setEntityId('archive/final', 'folder-conflict-collaborator');
        fakeVfs.setEntityId('archive/final/remote.tex', 'doc-conflict-collaborator');
        await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
        await scm.syncToVFS(localSource, 'delete');
        await scm.syncToVFS(localDestination, 'update');
        await new Promise<void>(resolve => setTimeout(resolve, 700));
        await scm.drainPendingSyncWork();

        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteSource, 'main.tex')),
            'local source folder',
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteDestination, 'remote.tex')),
            'collaborator folder',
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(localDestination, 'main.tex')),
            'local source folder',
        );
        assert.match(scm.syncConflicts.get('/archive/final'), /local folder move/i);
        assert.strictEqual(scm.syncManifest.pendingOperations['/draft'].kind, 'directory-move');
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteDestination)).fileEntity._id,
            'folder-conflict-collaborator',
        );
    });

    test('defers a local folder move while a child operation is unresolved', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-local-folder-move-pending-child-remote-');
        const localRoot = await tempDir('sr-overleaf-local-folder-move-pending-child-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'pending child baseline');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-pending-child-source');
        fakeVfs.setEntityId('archive', 'folder-pending-child-parent');
        fakeVfs.setEntityId('draft/main.tex', 'doc-pending-child');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const childEntry = scm.syncManifest.files['/draft/main.tex'];
        await scm.journalPendingFilePushOperation(
            '/draft/main.tex',
            'update',
            childEntry.localDigest,
            {kind: 'file', revision: childEntry.localDigest},
        );
        await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
        await scm.syncToVFS(localSource, 'delete');
        await scm.syncToVFS(localDestination, 'update');
        await new Promise<void>(resolve => setTimeout(resolve, 900));
        await scm.drainPendingSyncWork();

        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteSource, 'main.tex')),
            'pending child baseline',
        );
        assert.strictEqual(await pathExists(remoteDestination), false);
        assert.strictEqual(scm.syncManifest.pendingOperations['/draft/main.tex'].kind, 'update');
        assert.strictEqual(scm.syncManifest.pendingOperations['/draft'], undefined);
        assert.match(scm.syncConflicts.get('/archive/final'), /descendant operation/i);
    });

    test('pushes a folder child written by an agent while its local folder move is in flight', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-local-folder-move-advanced-remote-');
        const localRoot = await tempDir('sr-overleaf-local-folder-move-advanced-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        const localChild = vscode.Uri.joinPath(localDestination, 'main.tex');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'baseline before move');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-advanced-source');
        fakeVfs.setEntityId('archive', 'folder-advanced-parent');
        fakeVfs.setEntityId('draft/main.tex', 'doc-advanced-child');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let enterMove: () => void = () => undefined;
        let releaseMove: () => void = () => undefined;
        const moveEntered = new Promise<void>(resolve => { enterMove = resolve; });
        const moveRelease = new Promise<void>(resolve => { releaseMove = resolve; });
        let heldOnce = false;
        fakeVfs.rename = async (...args: Parameters<FakeVirtualFileSystem['rename']>) => {
            if (!heldOnce && args[3]?.type==='folder') {
                heldOnce = true;
                enterMove();
                await moveRelease;
            }
            return originalRename(...args);
        };

        try {
            await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
            await scm.syncToVFS(localSource, 'delete');
            const destinationSync = scm.syncToVFS(localDestination, 'update');
            await moveEntered;
            await writeText(localChild, 'agent changed this child during the move');
            releaseMove();
            await destinationSync;
            await scm.drainPendingSyncWork();

            await waitUntilAsync(async () => (
                await readText(vscode.Uri.joinPath(remoteDestination, 'main.tex'))
                ==='agent changed this child during the move'
            ));
            assert.strictEqual(
                (await fakeVfs._resolveUri(remoteDestination)).fileEntity._id,
                'folder-advanced-source',
            );
            assert.strictEqual(
                (await fakeVfs._resolveUri(vscode.Uri.joinPath(remoteDestination, 'main.tex'))).fileEntity._id,
                'doc-advanced-child',
            );
            assert.deepStrictEqual(scm.syncManifest.pendingOperations, {});
        } finally {
            releaseMove();
            fakeVfs.rename = originalRename;
        }
    });

    test('blocks a same-tree remote folder replacement before a local folder move is submitted', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-local-folder-move-replacement-remote-');
        const localRoot = await tempDir('sr-overleaf-local-folder-move-replacement-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'same tree');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-original-source');
        fakeVfs.setEntityId('archive', 'folder-replacement-parent');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
        // The tree digest is deliberately unchanged, but this represents a
        // collaborator replacing /draft with a different folder entity.
        fakeVfs.setEntityId('draft', 'folder-replacement-source');
        await scm.syncToVFS(localSource, 'delete');
        await scm.syncToVFS(localDestination, 'update');
        await new Promise<void>(resolve => setTimeout(resolve, 700));
        await scm.drainPendingSyncWork();

        assert.strictEqual(await readText(vscode.Uri.joinPath(remoteSource, 'main.tex')), 'same tree');
        assert.strictEqual(await readText(vscode.Uri.joinPath(localDestination, 'main.tex')), 'same tree');
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteSource)).fileEntity._id,
            'folder-replacement-source',
        );
        assert.match(scm.syncConflicts.get('/archive/final'), /local folder move/i);
        assert.strictEqual(scm.syncManifest.pendingOperations['/draft'].kind, 'directory-move');
    });

    test('resumes a folder move after only its remote rename half was applied', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-local-folder-move-intermediate-remote-');
        const localRoot = await tempDir('sr-overleaf-local-folder-move-intermediate-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteIntermediate = vscode.Uri.joinPath(remoteRoot, 'final');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'half-applied folder move');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-half-applied-source');
        fakeVfs.setEntityId('archive', 'folder-half-applied-parent');
        fakeVfs.setEntityId('draft/main.tex', 'doc-half-applied-child');
        const firstScm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let interruptedAfterRename = true;
        fakeVfs.rename = async (
            oldUri: vscode.Uri,
            newUri: vscode.Uri,
            force: boolean,
            expectedEntity?: {id: string; type: 'doc' | 'file' | 'folder'; parentId?: string},
        ) => {
            if (interruptedAfterRename) {
                interruptedAfterRename = false;
                await originalRename(oldUri, remoteIntermediate, force, expectedEntity);
                throw new Error('simulated transport loss after remote folder rename');
            }
            await originalRename(oldUri, newUri, force, expectedEntity);
        };

        try {
            await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
            await firstScm.syncToVFS(localSource, 'delete');
            await firstScm.syncToVFS(localDestination, 'update');
            await new Promise<void>(resolve => setTimeout(resolve, 700));
            await firstScm.drainPendingSyncWork();

            assert.strictEqual(await pathExists(remoteSource), false);
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteIntermediate, 'main.tex')),
                'half-applied folder move',
            );
            assert.strictEqual(await pathExists(remoteDestination), false);
            assert.strictEqual(firstScm.syncManifest.pendingOperations['/draft'].kind, 'directory-move');
            assert.strictEqual(firstScm.syncConflicts.get('/archive/final'), undefined);

            fakeVfs.rename = originalRename;
            await firstScm.deactivate();
            const restartedScm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true});
            assert.strictEqual(await pathExists(remoteIntermediate), false);
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteDestination, 'main.tex')),
                'half-applied folder move',
            );
            assert.strictEqual(
                (await fakeVfs._resolveUri(remoteDestination)).fileEntity._id,
                'folder-half-applied-source',
            );
            assert.strictEqual(
                (await fakeVfs._resolveUri(vscode.Uri.joinPath(remoteDestination, 'main.tex'))).fileEntity._id,
                'doc-half-applied-child',
            );
            assert.deepStrictEqual(restartedScm.syncManifest.pendingOperations, {});
        } finally {
            fakeVfs.rename = originalRename;
        }
    });

    test('replays a child watcher event captured during folder-move finalization', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-local-folder-move-finalization-remote-');
        const localRoot = await tempDir('sr-overleaf-local-folder-move-finalization-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'draft');
        const remoteArchive = vscode.Uri.joinPath(remoteRoot, 'archive');
        const remoteDestination = vscode.Uri.joinPath(remoteArchive, 'final');
        const localSource = vscode.Uri.joinPath(localRoot, 'draft');
        const localDestination = vscode.Uri.joinPath(localRoot, 'archive', 'final');
        const localChild = vscode.Uri.joinPath(localDestination, 'main.tex');
        await writeText(vscode.Uri.joinPath(remoteSource, 'main.tex'), 'baseline before finalization');
        await vscode.workspace.fs.createDirectory(remoteArchive);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft', 'folder-finalization-source');
        fakeVfs.setEntityId('archive', 'folder-finalization-parent');
        fakeVfs.setEntityId('draft/main.tex', 'doc-finalization-child');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs) as any;
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const originalFinalize = scm.finalizeAcceptedLocalDirectoryMove.bind(scm);
        let releaseFinalization: () => void = () => undefined;
        const finalizationGate = new Promise<void>(resolve => { releaseFinalization = resolve; });
        let signalFinalization: () => void = () => undefined;
        const finalizationReached = new Promise<void>(resolve => { signalFinalization = resolve; });
        scm.finalizeAcceptedLocalDirectoryMove = async (...args: unknown[]) => {
            signalFinalization();
            await finalizationGate;
            return originalFinalize(...args);
        };

        try {
            await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});
            await scm.syncToVFS(localSource, 'delete');
            const destinationSync = scm.syncToVFS(localDestination, 'update');
            await finalizationReached;

            await writeText(localChild, 'agent changed after folder-move verification');
            await scm.syncToVFS(localChild, 'update');
            await waitUntil(
                () => scm.deferredLocalEventsDuringDirectoryMove.has('/archive/final/main.tex'),
                3_000,
            );
            releaseFinalization();
            await destinationSync;
            await scm.drainPendingSyncWork();
            await waitUntilAsync(async () => (
                await readText(vscode.Uri.joinPath(remoteDestination, 'main.tex'))
                ==='agent changed after folder-move verification'
            ));

            assert.strictEqual(
                (await fakeVfs._resolveUri(remoteDestination)).fileEntity._id,
                'folder-finalization-source',
            );
            assert.strictEqual(
                (await fakeVfs._resolveUri(vscode.Uri.joinPath(remoteDestination, 'main.tex'))).fileEntity._id,
                'doc-finalization-child',
            );
            assert.strictEqual(scm.deferredLocalEventsDuringDirectoryMove.size, 0);
        } finally {
            releaseFinalization();
            scm.finalizeAcceptedLocalDirectoryMove = originalFinalize;
        }
    });

    test('releases a held local delete when no exact rename destination arrives', async () => {
        const remoteRoot = await tempDir('sr-overleaf-local-delete-release-remote-');
        const localRoot = await tempDir('sr-overleaf-local-delete-release-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteFile = vscode.Uri.joinPath(remoteRoot, 'obsolete.pdf');
        const localFile = vscode.Uri.joinPath(localRoot, 'obsolete.pdf');
        await writeBytes(remoteFile, Buffer.from('%PDF-1.7 obsolete\\n', 'utf-8'));
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('obsolete.pdf', 'file-delete-entity');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(localFile);
        await (scm as any).syncToVFS(localFile, 'delete');
        await new Promise<void>(resolve => setTimeout(resolve, 1_000));
        await (scm as any).drainPendingSyncWork();

        assert.strictEqual(await pathExists(remoteFile), false);
        assert.deepStrictEqual((scm as any).syncManifest.pendingOperations, {});
    });

    test('sends the exact file and parent identities for a normal guarded local delete', async () => {
        const remoteRoot = await tempDir('sr-overleaf-file-delete-guard-positive-remote-');
        const localRoot = await tempDir('sr-overleaf-file-delete-guard-positive-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteFile = vscode.Uri.joinPath(remoteRoot, 'obsolete.pdf');
        const localFile = vscode.Uri.joinPath(localRoot, 'obsolete.pdf');
        await writeBytes(remoteFile, Buffer.from('%PDF-1.7 guarded delete\\n', 'utf-8'));
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('', 'file-delete-positive-parent');
        fakeVfs.setEntityId('obsolete.pdf', 'file-delete-positive-target');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localFile);

        const renameExpectedEntities: unknown[] = [];
        const removeExpectedEntities: unknown[] = [];
        const originalRename = fakeVfs.rename.bind(fakeVfs);
        const originalRemove = fakeVfs.remove.bind(fakeVfs);
        (fakeVfs as any).rename = async (...args: any[]) => {
            renameExpectedEntities.push(args[3]);
            return (originalRename as any)(...args);
        };
        (fakeVfs as any).remove = async (...args: any[]) => {
            removeExpectedEntities.push(args[2]);
            return (originalRemove as any)(...args);
        };

        const event = await (scm as any).applySync(
            'push', 'delete', '/obsolete.pdf', localFile, remoteFile,
        ) as Events['scmSyncCompleteEvent'];

        const expectedEntity = {
            id: 'file-delete-positive-target',
            type: 'file',
            parentId: 'file-delete-positive-parent',
        };
        assert.strictEqual(event.outcome, 'success');
        assert.deepStrictEqual(renameExpectedEntities, [expectedEntity]);
        assert.deepStrictEqual(removeExpectedEntities, [expectedEntity]);
        assert.strictEqual(await pathExists(remoteFile), false);
        assert.deepStrictEqual((scm as any).syncManifest.pendingOperations, {});
    });

    test('blocks a local file delete when a same-byte collaborator entity replaces it at the guarded stage', async () => {
        const remoteRoot = await tempDir('sr-overleaf-file-delete-entity-race-remote-');
        const localRoot = await tempDir('sr-overleaf-file-delete-entity-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteFile = vscode.Uri.joinPath(remoteRoot, 'obsolete.pdf');
        const localFile = vscode.Uri.joinPath(localRoot, 'obsolete.pdf');
        const baseline = Buffer.from('%PDF-1.7 same bytes\\n', 'utf-8');
        await writeBytes(remoteFile, baseline);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('', 'file-delete-parent-original');
        fakeVfs.setEntityId('obsolete.pdf', 'file-delete-original');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localFile);

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let replacementInjected = false;
        let guardedRenameObserved = false;
        (fakeVfs as any).rename = async (...args: any[]) => {
            const [targetUri, _stagingUri, _force, expectedEntity] = args;
            if (
                !replacementInjected
                && targetUri.toString()===remoteFile.toString()
                && expectedEntity?.id==='file-delete-original'
            ) {
                guardedRenameObserved = true;
                replacementInjected = true;
                await vscode.workspace.fs.delete(remoteFile);
                await writeBytes(remoteFile, baseline);
                fakeVfs.setEntityId('obsolete.pdf', 'file-delete-collaborator');
            }
            return (originalRename as any)(...args);
        };

        const event = await (scm as any).applySync(
            'push', 'delete', '/obsolete.pdf', localFile, remoteFile,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(guardedRenameObserved, true);
        assert.strictEqual(replacementInjected, true);
        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(await pathExists(remoteFile), true);
        assert.deepStrictEqual(await readBytes(remoteFile), baseline);
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteFile)).fileEntity._id,
            'file-delete-collaborator',
        );
        assert.strictEqual((scm as any).syncConflicts.has('/obsolete.pdf'), true);
        const pending = (scm as any).syncManifest.pendingOperations['/obsolete.pdf'];
        assert.strictEqual(pending.kind, 'delete');
        assert.deepStrictEqual(pending.targetEntity, {id: 'file-delete-original', type: 'file'});
        assert.deepStrictEqual(pending.parentEntity, {id: 'file-delete-parent-original', type: 'folder'});
    });

    test('keeps both entities when guarded delete recovery finds a same-byte collaborator target', async () => {
        const remoteRoot = await tempDir('sr-overleaf-file-delete-recovery-entity-race-remote-');
        const localRoot = await tempDir('sr-overleaf-file-delete-recovery-entity-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const baseline = 'same bytes across recovery\\n';
        await writeText(remoteMain, baseline);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('', 'file-delete-recovery-parent');
        fakeVfs.setEntityId('main.tex', 'file-delete-recovery-original');
        const firstScm = createSCM(remoteRoot, localRoot, fakeVfs);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const firstInternals = firstScm as any;
        const originalSyncToVFS = firstInternals.syncToVFS;
        firstInternals.syncToVFS = () => Promise.resolve();
        await vscode.workspace.fs.delete(localMain);
        const generation = firstInternals.syncGeneration as number;
        const expected = await firstInternals.captureRemotePathRevision('/main.tex', generation);
        const identity = await firstInternals.resolveRemoteFilePathIdentity(remoteMain);
        assert.ok(identity);
        const pending = await firstInternals.journalPendingFilePushOperation(
            '/main.tex',
            'delete',
            '\0',
            expected,
            identity,
            generation,
        );
        const operationId = firstInternals.remoteDeleteOperationId(
            '/main.tex',
            expected.revision,
            'file-delete-recovery-original',
        );
        const stagingRelPath = firstInternals.remoteDeleteStagingPath(
            '/main.tex',
            expected.revision,
            'file-delete-recovery-original',
        );
        const stagingUri = fakeVfs.pathToUri(stagingRelPath);
        await firstInternals.createRemoteDeleteOperationRecord({
            version: 2,
            id: operationId,
            relPath: '/main.tex',
            stagingRelPath,
            expectedRevision: expected.revision,
            fileGuard: {
                targetEntity: {id: 'file-delete-recovery-original', type: 'doc'},
                parentEntity: {id: 'file-delete-recovery-parent', type: 'folder'},
                pendingOperationId: pending.id,
            },
            createdAt: new Date().toISOString(),
        });
        await fakeVfs.rename(remoteMain, stagingUri, false, {
            id: 'file-delete-recovery-original',
            type: 'doc',
            parentId: 'file-delete-recovery-parent',
        });
        await writeText(remoteMain, baseline);
        fakeVfs.setEntityId('main.tex', 'file-delete-recovery-collaborator');
        firstInternals.syncToVFS = originalSyncToVFS;
        firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot, fakeVfs);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );

        assert.strictEqual((restartedScm as any).syncConflicts.has('/main.tex'), true);
        assert.strictEqual(await readText(remoteMain), baseline);
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteMain)).fileEntity._id,
            'file-delete-recovery-collaborator',
        );
        assert.strictEqual(await readText(stagingUri), baseline);
        assert.strictEqual(
            (await fakeVfs._resolveUri(stagingUri)).fileEntity._id,
            'file-delete-recovery-original',
        );
        const restartedPending = (restartedScm as any).syncManifest.pendingOperations['/main.tex'];
        assert.strictEqual(restartedPending.kind, 'delete');
        assert.deepStrictEqual(restartedPending.targetEntity, {
            id: 'file-delete-recovery-original',
            type: 'doc',
        });
        const journalRoot = vscode.Uri.joinPath(
            localRoot, REPLICA_SETTINGS_DIR, 'remote-delete-operations',
        );
        const journalEntries = await vscode.workspace.fs.readDirectory(journalRoot);
        assert.strictEqual(journalEntries.filter(([name]) => name.endsWith('.json')).length, 1);
    });

    test('replays a locally moved file after its initial Overleaf proof is unavailable', async () => {
        const remoteRoot = await tempDir('sr-overleaf-local-move-offline-proof-remote-');
        const localRoot = await tempDir('sr-overleaf-local-move-offline-proof-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteOld = vscode.Uri.joinPath(remoteRoot, 'draft.pdf');
        const remoteNew = vscode.Uri.joinPath(remoteRoot, 'final.pdf');
        const localOld = vscode.Uri.joinPath(localRoot, 'draft.pdf');
        const localNew = vscode.Uri.joinPath(localRoot, 'final.pdf');
        const pdf = Buffer.from('%PDF-1.7 offline move proof\\n', 'utf-8');
        await writeBytes(remoteOld, pdf);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft.pdf', 'file-offline-move-entity');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const triggers = await scm.triggers;
        try {
            const internals = scm as any;
            const originalCapture = internals.captureRemotePathRevision.bind(scm);
            let unavailable = true;
            internals.captureRemotePathRevision = async (...args: unknown[]) => {
                if (unavailable) {
                    throw new Error('simulated unavailable Overleaf move proof');
                }
                return originalCapture(...args);
            };

            fakeVfs.setConnectionState('disconnected');
            await vscode.workspace.fs.rename(localOld, localNew, {overwrite: false});
            await internals.syncToVFS(localOld, 'delete');
            await internals.syncToVFS(localNew, 'update');
            await waitUntil(() => (
                internals.syncManifest.pendingOperations['/draft.pdf']!==undefined
            ), 3_000);
            await internals.drainPendingSyncWork();

            const pendingMove = internals.syncManifest.pendingOperations['/draft.pdf'];
            assert.strictEqual(pendingMove.kind, 'move');
            assert.strictEqual(await pathExists(remoteOld), true);
            assert.strictEqual(await pathExists(remoteNew), false);
            assert.strictEqual(scm.status.status, 'offline');

            unavailable = false;
            fakeVfs.setConnectionState('connected');
            await waitUntil(() => (
                internals.syncManifest.pendingOperations['/draft.pdf']===undefined
                && scm.status.status==='idle'
            ));
            assert.strictEqual(await pathExists(remoteOld), false);
            assert.deepStrictEqual(await readBytes(remoteNew), pdf);
            assert.strictEqual(
                (await fakeVfs._resolveUri(remoteNew)).fileEntity._id,
                'file-offline-move-entity',
            );
            assert.strictEqual(scm.status.status, 'idle');
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('keeps a delayed binary local move from racing its held source delete', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-local-move-delayed-source-remote-');
        const localRoot = await tempDir('sr-overleaf-local-move-delayed-source-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteOld = vscode.Uri.joinPath(remoteRoot, 'draft.png');
        const remoteNew = vscode.Uri.joinPath(remoteRoot, 'final.png');
        const localOld = vscode.Uri.joinPath(localRoot, 'draft.png');
        const localNew = vscode.Uri.joinPath(localRoot, 'final.png');
        const png = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x00,
        ]);
        await writeBytes(remoteOld, png);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('', 'delayed-move-root');
        fakeVfs.setEntityId('draft.png', 'delayed-move-file');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const internals = scm as any;
        const originalExecute = internals.executePendingLocalFileMove.bind(scm);
        let executeEntered = false;
        internals.executePendingLocalFileMove = async (...args: unknown[]) => {
            executeEntered = true;
            await new Promise<void>(resolve => setTimeout(resolve, 800));
            return originalExecute(...args);
        };
        try {
            await vscode.workspace.fs.rename(localOld, localNew, {overwrite: false});
            const sourceSync = internals.syncToVFS(localOld, 'delete');
            const destinationSync = internals.syncToVFS(localNew, 'update');
            await waitUntil(() => executeEntered, 3_000);
            const persistedMove = internals.syncManifest.pendingOperations['/draft.png'];
            assert.strictEqual(persistedMove.kind, 'move');
            assert.strictEqual(persistedMove.version, 3);
            assert.strictEqual(await pathExists(remoteOld), true);
            // This deliberately outlasts the 500ms delete-candidate timer.
            // The intent must already be on disk before remote execution
            // waits, otherwise an ordinary delete can overwrite the move.
            await new Promise<void>(resolve => setTimeout(resolve, 650));
            await Promise.all([sourceSync, destinationSync]);
            await internals.drainPendingSyncWork();

            assert.strictEqual(await pathExists(remoteOld), false);
            assert.deepStrictEqual(await readBytes(remoteNew), png);
            assert.strictEqual(
                (await fakeVfs._resolveUri(remoteNew)).fileEntity._id,
                'delayed-move-file',
            );
            assert.strictEqual(internals.syncConflicts.get('/draft.png'), undefined);
            assert.strictEqual(internals.syncConflicts.get('/final.png'), undefined);
            assert.deepStrictEqual(internals.syncManifest.pendingOperations, {});
        } finally {
            internals.executePendingLocalFileMove = originalExecute;
        }
    });

    test('replays a prepared local move after restart creates its new destination parent', async () => {
        const remoteRoot = await tempDir('sr-overleaf-prepared-move-restart-remote-');
        const localRoot = await tempDir('sr-overleaf-prepared-move-restart-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteOld = vscode.Uri.joinPath(remoteRoot, 'draft.png');
        const remoteParent = vscode.Uri.joinPath(remoteRoot, 'generated');
        const remoteNew = vscode.Uri.joinPath(remoteParent, 'draft.png');
        const localOld = vscode.Uri.joinPath(localRoot, 'draft.png');
        const localParent = vscode.Uri.joinPath(localRoot, 'generated');
        const localNew = vscode.Uri.joinPath(localParent, 'draft.png');
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x11, 0x22, 0x33]);
        await writeBytes(remoteOld, png);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('', 'prepared-move-root');
        fakeVfs.setEntityId('draft.png', 'prepared-move-original');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.createDirectory(localParent);
        await vscode.workspace.fs.rename(localOld, localNew, {overwrite: false});
        const internals = scm as any;
        const record = await internals.journalPendingLocalFileMoveBeforeRemoteProof(
            '/draft.png',
            '/generated/draft.png',
            internals.syncManifest.files['/draft.png'],
        );
        assert.strictEqual(record.kind, 'move');
        assert.strictEqual(record.version, 4);
        assert.strictEqual(record.phase, 'awaiting-destination-parent');
        assert.strictEqual(await pathExists(remoteParent), false);

        const manifestUri = vscode.Uri.joinPath(
            localRoot, REPLICA_SETTINGS_DIR, 'sync-manifest.json',
        );
        const persisted = JSON.parse(await readText(manifestUri));
        assert.strictEqual(persisted.pendingOperations['/draft.png'].version, 4);
        await scm.deactivate();
        const restartedScm = createSCM(remoteRoot, localRoot, fakeVfs);
        const restartedInternals = restartedScm as any;
        const originalOverwrite = restartedInternals.overwrite.bind(restartedScm);
        const originalExecute = restartedInternals.executePendingLocalFileMove.bind(restartedScm);
        let pendingVersionAtOverwrite: number | undefined;
        let moveOutcome: string | undefined;
        restartedInternals.overwrite = async (...args: unknown[]) => {
            pendingVersionAtOverwrite = restartedInternals.syncManifest
                ?.pendingOperations['/draft.png']?.version;
            return originalOverwrite(...args);
        };
        restartedInternals.executePendingLocalFileMove = async (...args: unknown[]) => {
            moveOutcome = await originalExecute(...args);
            return moveOutcome;
        };
        try {
            assert.strictEqual(
                await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
                true,
            );
        } finally {
            restartedInternals.overwrite = originalOverwrite;
            restartedInternals.executePendingLocalFileMove = originalExecute;
        }
        assert.strictEqual(pendingVersionAtOverwrite, 4);
        assert.strictEqual(moveOutcome, 'accepted', restartedInternals.syncConflicts.get('/generated/draft.png'));

        assert.strictEqual(await pathExists(remoteOld), false);
        assert.strictEqual(await pathExists(remoteParent), true);
        assert.deepStrictEqual(await readBytes(remoteNew), png);
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteNew)).fileEntity._id,
            'prepared-move-original',
        );
        assert.deepStrictEqual((restartedScm as any).syncManifest.pendingOperations, {});
        assert.strictEqual((restartedScm as any).syncConflicts.get('/generated/draft.png'), undefined);
    });

    test('keeps a prepared local move conflicted when its Overleaf source advances before restart', async () => {
        const remoteRoot = await tempDir('sr-overleaf-prepared-move-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-prepared-move-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteOld = vscode.Uri.joinPath(remoteRoot, 'draft.png');
        const remoteNew = vscode.Uri.joinPath(remoteRoot, 'generated', 'draft.png');
        const localOld = vscode.Uri.joinPath(localRoot, 'draft.png');
        const localParent = vscode.Uri.joinPath(localRoot, 'generated');
        const localNew = vscode.Uri.joinPath(localParent, 'draft.png');
        const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa]);
        const collaborator = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xbb]);
        await writeBytes(remoteOld, original);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('', 'prepared-move-conflict-root');
        fakeVfs.setEntityId('draft.png', 'prepared-move-conflict-original');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.createDirectory(localParent);
        await vscode.workspace.fs.rename(localOld, localNew, {overwrite: false});
        const internals = scm as any;
        const record = await internals.journalPendingLocalFileMoveBeforeRemoteProof(
            '/draft.png',
            '/generated/draft.png',
            internals.syncManifest.files['/draft.png'],
        );
        assert.strictEqual(record.version, 4);
        await writeBytes(remoteOld, collaborator);
        fakeVfs.setEntityId('draft.png', 'prepared-move-conflict-collaborator');

        await scm.deactivate();
        const restartedScm = createSCM(remoteRoot, localRoot, fakeVfs);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );

        assert.deepStrictEqual(await readBytes(remoteOld), collaborator);
        assert.strictEqual(await pathExists(remoteNew), false);
        assert.deepStrictEqual(await readBytes(localNew), original);
        assert.match(
            (restartedScm as any).syncConflicts.get('/generated/draft.png'),
            /prepared local move|Overleaf changed/i,
        );
        const pending = (restartedScm as any).syncManifest.pendingOperations['/draft.png'];
        assert.strictEqual(pending.kind, 'move');
        assert.strictEqual(pending.version, 4);
    });

    test('keeps a new-parent file move durable while guarded mkdir outlasts its source-delete hold', async function () {
        this.timeout(20_000);
        const remoteRoot = await tempDir('sr-overleaf-prepared-move-parent-remote-');
        const localRoot = await tempDir('sr-overleaf-prepared-move-parent-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteOld = vscode.Uri.joinPath(remoteRoot, 'draft.png');
        const remoteParent = vscode.Uri.joinPath(remoteRoot, 'generated');
        const remoteNew = vscode.Uri.joinPath(remoteParent, 'draft.png');
        const localOld = vscode.Uri.joinPath(localRoot, 'draft.png');
        const localParent = vscode.Uri.joinPath(localRoot, 'generated');
        const localNew = vscode.Uri.joinPath(localParent, 'draft.png');
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x44, 0x55]);
        await writeBytes(remoteOld, png);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('', 'prepared-move-parent-root');
        fakeVfs.setEntityId('draft.png', 'prepared-move-parent-original');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.createDirectory(localParent);
        const internals = scm as any;
        const originalCreateDirectory = fakeVfs.createDirectoryIfMissing.bind(fakeVfs);
        let releaseCreate: (() => void) | undefined;
        let enterCreate: (() => void) | undefined;
        const createEntered = new Promise<void>(resolve => { enterCreate = resolve; });
        const createRelease = new Promise<void>(resolve => { releaseCreate = resolve; });
        fakeVfs.createDirectoryIfMissing = async uri => {
            if (uri.toString()===remoteParent.toString()) {
                enterCreate?.();
                await createRelease;
            }
            return originalCreateDirectory(uri);
        };
        try {
            await vscode.workspace.fs.rename(localOld, localNew, {overwrite: false});
            const sourceSync = internals.syncToVFS(localOld, 'delete');
            const destinationSync = internals.syncToVFS(localNew, 'update');
            await createEntered;

            const prepared = internals.syncManifest.pendingOperations['/draft.png'];
            assert.strictEqual(prepared.kind, 'move');
            assert.strictEqual(prepared.version, 4);
            assert.strictEqual(prepared.phase, 'awaiting-destination-parent');
            await new Promise<void>(resolve => setTimeout(resolve, 650));
            assert.strictEqual(await pathExists(remoteOld), true);
            assert.strictEqual(await pathExists(remoteNew), false);
            assert.strictEqual(
                internals.syncManifest.pendingOperations['/draft.png'].version,
                4,
            );

            releaseCreate?.();
            await Promise.all([sourceSync, destinationSync]);
            await internals.drainPendingSyncWork();

            assert.strictEqual(await pathExists(remoteOld), false);
            assert.strictEqual(await pathExists(remoteParent), true);
            assert.deepStrictEqual(await readBytes(remoteNew), png);
            assert.strictEqual(
                (await fakeVfs._resolveUri(remoteNew)).fileEntity._id,
                'prepared-move-parent-original',
            );
            assert.deepStrictEqual(internals.syncManifest.pendingOperations, {});
            assert.strictEqual(internals.syncConflicts.get('/generated/draft.png'), undefined);
        } finally {
            releaseCreate?.();
            fakeVfs.createDirectoryIfMissing = originalCreateDirectory;
        }
    });
    test('replays a journaled local move after its remote mutation is deferred', async () => {
        const remoteRoot = await tempDir('sr-overleaf-local-move-replay-remote-');
        const localRoot = await tempDir('sr-overleaf-local-move-replay-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteOld = vscode.Uri.joinPath(remoteRoot, 'draft.pdf');
        const remoteNew = vscode.Uri.joinPath(remoteRoot, 'final.pdf');
        const localOld = vscode.Uri.joinPath(localRoot, 'draft.pdf');
        const localNew = vscode.Uri.joinPath(localRoot, 'final.pdf');
        const pdf = Buffer.from('%PDF-1.7 replay\\n', 'utf-8');
        await writeBytes(remoteOld, pdf);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft.pdf', 'file-replay-entity');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        fakeVfs.rename = async () => {
            throw new Error('simulated transient rename transport failure');
        };
        await vscode.workspace.fs.rename(localOld, localNew, {overwrite: false});
        await (scm as any).syncToVFS(localOld, 'delete');
        await (scm as any).syncToVFS(localNew, 'update');
        await new Promise<void>(resolve => setTimeout(resolve, 400));
        await (scm as any).drainPendingSyncWork();

        const pendingMove = (scm as any).syncManifest.pendingOperations['/draft.pdf'];
        assert.strictEqual(pendingMove.kind, 'move');
        assert.strictEqual(await pathExists(remoteOld), true);
        assert.strictEqual(await pathExists(remoteNew), false);

        await scm.deactivate();
        fakeVfs.rename = originalRename;
        const restartedScm = createSCM(remoteRoot, localRoot, fakeVfs);
        await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true});

        assert.strictEqual(await pathExists(remoteOld), false);
        assert.deepStrictEqual(await readBytes(remoteNew), pdf);
        assert.strictEqual((await fakeVfs._resolveUri(remoteNew)).fileEntity._id, 'file-replay-entity');
        assert.deepStrictEqual((restartedScm as any).syncManifest.pendingOperations, {});
    });

    test('resumes a cross-folder move after only its remote rename half was applied', async () => {
        const remoteRoot = await tempDir('sr-overleaf-local-move-intermediate-remote-');
        const localRoot = await tempDir('sr-overleaf-local-move-intermediate-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteOld = vscode.Uri.joinPath(remoteRoot, 'figures', 'draft.pdf');
        const remoteIntermediate = vscode.Uri.joinPath(remoteRoot, 'figures', 'final.pdf');
        const remoteNew = vscode.Uri.joinPath(remoteRoot, 'archive', 'final.pdf');
        const localOld = vscode.Uri.joinPath(localRoot, 'figures', 'draft.pdf');
        const localNew = vscode.Uri.joinPath(localRoot, 'archive', 'final.pdf');
        const pdf = Buffer.from('%PDF-1.7 two step replay\n', 'utf-8');
        await writeBytes(remoteOld, pdf);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(remoteRoot, 'archive'));
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('figures/draft.pdf', 'file-two-step-entity');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let interruptedAfterRename = true;
        fakeVfs.rename = async (
            oldUri: vscode.Uri,
            newUri: vscode.Uri,
            force: boolean,
            expectedEntity?: {id: string; type: 'doc' | 'file' | 'folder'; parentId?: string},
        ) => {
            if (interruptedAfterRename) {
                interruptedAfterRename = false;
                await originalRename(oldUri, remoteIntermediate, force, expectedEntity);
                throw new Error('simulated transport loss after remote rename');
            }
            await originalRename(oldUri, newUri, force, expectedEntity);
        };

        await vscode.workspace.fs.rename(localOld, localNew, {overwrite: false});
        await (scm as any).syncToVFS(localOld, 'delete');
        await (scm as any).syncToVFS(localNew, 'update');
        await new Promise<void>(resolve => setTimeout(resolve, 400));
        await (scm as any).drainPendingSyncWork();

        assert.strictEqual(await pathExists(remoteOld), false);
        assert.deepStrictEqual(await readBytes(remoteIntermediate), pdf);
        assert.strictEqual(await pathExists(remoteNew), false);
        assert.strictEqual((scm as any).syncConflicts.get('/archive/final.pdf'), undefined);
        assert.strictEqual(
            (scm as any).syncManifest.pendingOperations['/figures/draft.pdf'].kind,
            'move',
        );

        fakeVfs.rename = originalRename;
        await scm.deactivate();
        const restartedScm = createSCM(remoteRoot, localRoot, fakeVfs);
        await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true});

        assert.strictEqual(await pathExists(remoteOld), false);
        assert.strictEqual(await pathExists(remoteIntermediate), false);
        assert.deepStrictEqual(await readBytes(remoteNew), pdf);
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteNew)).fileEntity._id,
            'file-two-step-entity',
        );
        assert.deepStrictEqual((restartedScm as any).syncManifest.pendingOperations, {});
    });

    test('preserves both sides when a local move destination is occupied remotely', async () => {
        const remoteRoot = await tempDir('sr-overleaf-local-move-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-local-move-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteOld = vscode.Uri.joinPath(remoteRoot, 'draft.pdf');
        const remoteNew = vscode.Uri.joinPath(remoteRoot, 'final.pdf');
        const localOld = vscode.Uri.joinPath(localRoot, 'draft.pdf');
        const localNew = vscode.Uri.joinPath(localRoot, 'final.pdf');
        const sourcePdf = Buffer.from('%PDF-1.7 source\\n', 'utf-8');
        const remotePdf = Buffer.from('%PDF-1.7 collaborator\\n', 'utf-8');
        await writeBytes(remoteOld, sourcePdf);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('draft.pdf', 'file-source-entity');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        // A collaborator creates the target after the authoritative baseline.
        await writeBytes(remoteNew, remotePdf);
        fakeVfs.setEntityId('final.pdf', 'file-collaborator-entity');
        await vscode.workspace.fs.rename(localOld, localNew, {overwrite: false});
        await (scm as any).syncToVFS(localOld, 'delete');
        await (scm as any).syncToVFS(localNew, 'update');
        await new Promise<void>(resolve => setTimeout(resolve, 400));
        await (scm as any).drainPendingSyncWork();

        assert.deepStrictEqual(await readBytes(remoteOld), sourcePdf);
        assert.deepStrictEqual(await readBytes(remoteNew), remotePdf);
        assert.deepStrictEqual(await readBytes(localNew), sourcePdf);
        assert.match((scm as any).syncConflicts.get('/final.pdf'), /local move/i);
        assert.strictEqual((scm as any).syncManifest.pendingOperations['/draft.pdf'].kind, 'move');
    });

    test('three-way merges non-overlapping offline text edits on restart', async () => {
        const remoteRoot = await tempDir('sr-overleaf-merge-restart-remote-');
        const localRoot = await tempDir('sr-overleaf-merge-restart-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'title: base\nbody: base\nfooter: base\n');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(localMain, 'title: local\nbody: base\nfooter: base\n');
        await writeText(remoteMain, 'title: base\nbody: base\nfooter: remote\n');
        const restartedScm = createSCM(remoteRoot, localRoot);
        await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true});

        const expected = 'title: local\nbody: base\nfooter: remote\n';
        assert.strictEqual(await readText(localMain), expected);
        assert.strictEqual(await readText(remoteMain), expected);
        const flush = await restartedScm.flushBeforeCompile([]);
        assert.strictEqual(flush.blockedCount, 0);
    });

    test('journals an interrupted local update until restart reconciliation receives an acknowledgement', async () => {
        const remoteRoot = await tempDir('sr-overleaf-pending-update-remote-');
        const localRoot = await tempDir('sr-overleaf-pending-update-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'offline local update');
        (firstScm as any).pushWithRetry = async () => {
            throw new Error('simulated offline write');
        };

        const event = await (firstScm as any).applySync(
            'push', 'update', '/main.tex', localMain, remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(event.outcome, 'error');
        assert.strictEqual(await readText(remoteMain), 'baseline');

        const manifestUri = vscode.Uri.joinPath(
            localRoot, REPLICA_SETTINGS_DIR, 'sync-manifest.json',
        );
        const interruptedManifest = JSON.parse(await readText(manifestUri));
        const pending = interruptedManifest.pendingOperations['/main.tex'];
        assert.strictEqual(interruptedManifest.version, 16);
        assert.strictEqual(pending.kind, 'update');
        assert.strictEqual(pending.localKind, 'file');
        assert.strictEqual(pending.localRevision, sha1('offline local update'));
        assert.strictEqual(pending.remoteKind, 'file');
        assert.strictEqual(pending.remoteRevision, sha1('baseline'));

        await firstScm.deactivate();
        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await readText(localMain), 'offline local update');
        assert.strictEqual(await readText(remoteMain), 'offline local update');
        const recoveredManifest = JSON.parse(await readText(manifestUri));
        assert.deepStrictEqual(recoveredManifest.pendingOperations, {});
        assert.strictEqual((restartedScm as any).locallyDivergedPaths.has('/main.tex'), false);
    });

    test('keeps a journaled offline update unresolved when Overleaf changed the same text', async () => {
        const remoteRoot = await tempDir('sr-overleaf-pending-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-pending-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'title: baseline\nbody: baseline\n');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'title: local\nbody: baseline\n');
        (firstScm as any).pushWithRetry = async () => {
            throw new Error('simulated offline write');
        };

        const interrupted = await (firstScm as any).applySync(
            'push', 'update', '/main.tex', localMain, remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(interrupted.outcome, 'error');
        await firstScm.deactivate();
        await writeText(remoteMain, 'title: Overleaf collaborator\nbody: baseline\n');

        const manifestUri = vscode.Uri.joinPath(
            localRoot, REPLICA_SETTINGS_DIR, 'sync-manifest.json',
        );
        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );

        assert.strictEqual(
            await readText(localMain),
            'title: local\nbody: baseline\n',
        );
        assert.strictEqual(
            await readText(remoteMain),
            'title: Overleaf collaborator\nbody: baseline\n',
        );
        await assert.rejects(
            () => restartedScm.flushBeforeCompile([]),
            /both changed|sync conflict|concurrent edits/i,
        );
        const conflictManifest = JSON.parse(await readText(manifestUri));
        assert.strictEqual(
            conflictManifest.pendingOperations['/main.tex'].kind,
            'update',
        );
        assert.strictEqual(
            conflictManifest.pendingOperations['/main.tex'].localRevision,
            sha1('title: local\nbody: baseline\n'),
        );
        assert.strictEqual((restartedScm as any).locallyDivergedPaths.has('/main.tex'), true);
    });

    test('journals an interrupted local delete until restart reconciliation applies it', async () => {
        const remoteRoot = await tempDir('sr-overleaf-pending-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-pending-delete-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localMain);
        const originalPushRetryDelays = (LocalReplicaSCMProvider as any).pushRetryDelays;
        (LocalReplicaSCMProvider as any).pushRetryDelays = [0];
        (firstScm as any).atomicDeleteRemotePathIfRevision = async () => {
            throw new Error('simulated offline delete');
        };
        let event: Events['scmSyncCompleteEvent'];
        try {
            event = await (firstScm as any).applySync(
                'push', 'delete', '/main.tex', localMain, remoteMain,
            ) as Events['scmSyncCompleteEvent'];
        } finally {
            (LocalReplicaSCMProvider as any).pushRetryDelays = originalPushRetryDelays;
        }
        assert.strictEqual(event.outcome, 'error');
        assert.strictEqual(await readText(remoteMain), 'baseline');

        const manifestUri = vscode.Uri.joinPath(
            localRoot, REPLICA_SETTINGS_DIR, 'sync-manifest.json',
        );
        const interruptedManifest = JSON.parse(await readText(manifestUri));
        const pending = interruptedManifest.pendingOperations['/main.tex'];
        assert.strictEqual(pending.kind, 'delete');
        assert.strictEqual(pending.localKind, 'missing');
        assert.strictEqual(pending.localRevision, '\0');
        assert.strictEqual(pending.remoteKind, 'file');

        await firstScm.deactivate();
        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await pathExists(remoteMain), false);
        const recoveredManifest = JSON.parse(await readText(manifestUri));
        assert.deepStrictEqual(recoveredManifest.pendingOperations, {});
        assert.strictEqual((restartedScm as any).locallyDivergedPaths.has('/main.tex'), false);
    });

    test('rejects malformed guarded file-move journal proofs', async () => {
        const remoteRoot = await tempDir('sr-overleaf-move-journal-schema-remote-');
        const localRoot = await tempDir('sr-overleaf-move-journal-schema-local-');
        tempRoots.push(remoteRoot, localRoot);
        const scm = createSCM(remoteRoot, localRoot);
        const now = '2026-08-11T00:00:00.000Z';
        const prepared = {
            version: 4,
            id: 'a'.repeat(32),
            kind: 'move',
            localKind: 'file',
            localRevision: sha1('local bytes'),
            destinationRelPath: '/generated/main.tex',
            sourceEntity: {id: 'doc-main', type: 'doc'},
            sourceLocalIdentity: {dev: '1', ino: '2'},
            sourceParentEntity: {id: 'folder-root', type: 'folder'},
            sourceRemoteKind: 'file',
            sourceRemoteRevision: sha1('accepted remote bytes'),
            phase: 'awaiting-destination-parent',
            createdAt: now,
            updatedAt: now,
        };
        const isValid = (entry: unknown) => (
            scm as any
        ).isValidSyncManifestPendingMoveOperation(entry);

        assert.strictEqual(isValid(prepared), true);
        assert.strictEqual(isValid({
            ...prepared,
            sourceRemoteRevision: 'directory:' + sha1('not a file proof'),
        }), false);
        assert.strictEqual(isValid({...prepared, phase: undefined}), false);

        const guarded = {
            ...prepared,
            version: 3,
            destinationParentEntity: {id: 'folder-generated', type: 'folder'},
            phase: undefined,
        };
        assert.strictEqual(isValid(guarded), true);
        assert.strictEqual(isValid({
            ...guarded,
            phase: 'awaiting-destination-parent',
        }), false);

        const legacy = {
            ...guarded,
            version: 2,
            sourceParentEntity: undefined,
            destinationParentEntity: undefined,
        };
        assert.strictEqual(isValid(legacy), true);
        assert.strictEqual(isValid({
            ...legacy,
            phase: 'awaiting-destination-parent',
        }), false);
    });

    test('migrates a version 2 manifest to the version 16 guarded-move schema', async () => {
        const remoteRoot = await tempDir('sr-overleaf-manifest-v3-remote-');
        const localRoot = await tempDir('sr-overleaf-manifest-v3-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const manifestUri = vscode.Uri.joinPath(
            localRoot, REPLICA_SETTINGS_DIR, 'sync-manifest.json',
        );
        const legacyManifest = JSON.parse(await readText(manifestUri));
        legacyManifest.version = 2;
        delete legacyManifest.pendingOperations;
        delete legacyManifest.textMergeResolutions;
        delete legacyManifest.textMergeResolutionHistory;
        await writeText(manifestUri, JSON.stringify(legacyManifest));

        await firstScm.deactivate();
        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        const migratedManifest = JSON.parse(await readText(manifestUri));
        assert.strictEqual(migratedManifest.version, 16);
        assert.deepStrictEqual(migratedManifest.pendingOperations, {});
        assert.deepStrictEqual(migratedManifest.textMergeResolutions, {});
        assert.deepStrictEqual(migratedManifest.textMergeResolutionHistory, []);
    });

    test('migrates a v10 file-resolution manifest without losing its file state', async () => {
        const remoteRoot = await tempDir('sr-overleaf-manifest-v10-remote-');
        const localRoot = await tempDir('sr-overleaf-manifest-v10-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const manifestUri = vscode.Uri.joinPath(
            localRoot, REPLICA_SETTINGS_DIR, 'sync-manifest.json',
        );
        const legacyManifest = JSON.parse(await readText(manifestUri));
        legacyManifest.version = 10;
        delete legacyManifest.folderConflictResolutions;
        delete legacyManifest.folderConflictResolutionHistory;
        delete legacyManifest.textMergeResolutions;
        delete legacyManifest.textMergeResolutionHistory;
        await writeText(manifestUri, JSON.stringify(legacyManifest));

        await firstScm.deactivate();
        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        const migratedManifest = JSON.parse(await readText(manifestUri));
        assert.strictEqual(migratedManifest.version, 16);
        assert.deepStrictEqual(migratedManifest.folderConflictResolutions, {});
        assert.deepStrictEqual(migratedManifest.folderConflictResolutionHistory, []);
        assert.deepStrictEqual(migratedManifest.textMergeResolutions, {});
        assert.deepStrictEqual(migratedManifest.textMergeResolutionHistory, []);
        assert.ok(migratedManifest.files['/main.tex']);
    });

    test('records remote entity, parent, and stable local inode identities in manifest v16', async () => {
        const remoteRoot = await tempDir('sr-overleaf-manifest-identity-remote-');
        const localRoot = await tempDir('sr-overleaf-manifest-identity-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figure.png'), Buffer.from([7, 8, 9]));
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('main.tex', 'doc-main');
        fakeVfs.setEntityId('figure.png', 'file-figure');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        assert.strictEqual(
            await scm.initializeLocalReplica({resetLocalFilesToRemote: true}),
            true,
        );
        const manifest = JSON.parse(await readText(vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-manifest.json',
        )));
        assert.strictEqual(manifest.version, 16);
        assert.deepStrictEqual(manifest.files['/main.tex'].remoteEntity, {id: 'doc-main', type: 'doc'});
        assert.deepStrictEqual(manifest.files['/figure.png'].remoteEntity, {id: 'file-figure', type: 'file'});
        const rootParentId = (await fakeVfs._resolveUri(
            vscode.Uri.joinPath(remoteRoot, 'main.tex'),
        )).parentFolder._id;
        assert.deepStrictEqual(
            manifest.files['/main.tex'].parentEntity,
            {id: rootParentId, type: 'folder'},
        );
        assert.deepStrictEqual(
            manifest.files['/figure.png'].parentEntity,
            {id: rootParentId, type: 'folder'},
        );
        for (const entry of [
            manifest.files['/main.tex'],
            manifest.files['/figure.png'],
        ]) {
            assert.match(entry.localIdentity.dev, /^\d+$/);
            assert.match(entry.localIdentity.ino, /^[1-9]\d*$/);
        }
    });

    test('replays a journaled local update after a live reconnect without another watcher event', async () => {
        const remoteRoot = await tempDir('sr-overleaf-live-reconnect-update-remote-');
        const localRoot = await tempDir('sr-overleaf-live-reconnect-update-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        const triggers = await scm.triggers;
        try {
            let offlineWarnings = 0;
            (vscode.window as any).showWarningMessage = () => {
                offlineWarnings += 1;
                return Promise.resolve(undefined);
            };
            const internals = scm as any;
            await writeText(localMain, 'offline local update');
            let pushAttempts = 0;
            const originalPushWithRetry = internals.pushWithRetry.bind(scm);
            internals.pushWithRetry = async () => {
                pushAttempts += 1;
                throw new Error('simulated offline write');
            };
            fakeVfs.setConnectionState('disconnected');
            const interrupted = await internals.applySync(
                'push', 'update', '/main.tex', localMain, remoteMain,
            ) as Events['scmSyncCompleteEvent'];
            assert.strictEqual(interrupted.outcome, 'error');
            assert.strictEqual(scm.status.status, 'offline');
            assert.strictEqual(offlineWarnings, 0);
            assert.strictEqual(
                internals.syncManifest.pendingOperations['/main.tex'].kind,
                'update',
            );

            fakeVfs.setConnectionState('reconnecting');
            assert.strictEqual(scm.status.status, 'pending');
            assert.match(scm.status.message ?? '', /Reconciling/);

            internals.pushWithRetry = async (...args: unknown[]) => {
                pushAttempts += 1;
                return originalPushWithRetry(...args);
            };
            const replay = waitForSyncComplete(localRoot, '/main.tex', 'push', 'update');
            fakeVfs.setConnectionState('connected');
            // A second connection notification while replay is in flight must
            // share the same single-flight upload.
            fakeVfs.setConnectionState('connected');
            const recovered = await replay;
            assert.strictEqual(recovered.outcome, 'success');
            await waitUntil(() => internals.syncManifest.pendingOperations['/main.tex']===undefined);
            assert.strictEqual(await readText(remoteMain), 'offline local update');
            assert.strictEqual(scm.status.status, 'idle');
            assert.strictEqual(pushAttempts, 2);
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('replays a journaled local delete after a live reconnect without another watcher event', async () => {
        const remoteRoot = await tempDir('sr-overleaf-live-reconnect-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-live-reconnect-delete-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        const triggers = await scm.triggers;
        const originalPushRetryDelays = (LocalReplicaSCMProvider as any).pushRetryDelays;
        try {
            const internals = scm as any;
            let deleteAttempts = 0;
            const originalAtomicDelete = internals.atomicDeleteRemotePathIfRevision.bind(scm);
            (LocalReplicaSCMProvider as any).pushRetryDelays = [0];
            internals.atomicDeleteRemotePathIfRevision = async () => {
                deleteAttempts += 1;
                throw new Error('simulated offline delete');
            };
            await vscode.workspace.fs.delete(localMain);
            fakeVfs.setConnectionState('disconnected');
            const interrupted = await internals.applySync(
                'push', 'delete', '/main.tex', localMain, remoteMain,
            ) as Events['scmSyncCompleteEvent'];
            assert.strictEqual(interrupted.outcome, 'error');
            assert.strictEqual(scm.status.status, 'offline');
            assert.strictEqual(
                internals.syncManifest.pendingOperations['/main.tex'].kind,
                'delete',
            );

            internals.atomicDeleteRemotePathIfRevision = async (...args: unknown[]) => {
                deleteAttempts += 1;
                return originalAtomicDelete(...args);
            };
            const replay = waitForSyncComplete(localRoot, '/main.tex', 'push', 'delete');
            fakeVfs.setConnectionState('connected');
            const recovered = await replay;
            assert.strictEqual(recovered.outcome, 'success');
            await waitUntil(() => internals.syncManifest.pendingOperations['/main.tex']===undefined);
            assert.strictEqual(await pathExists(remoteMain), false);
            assert.strictEqual(scm.status.status, 'idle');
            assert.strictEqual(deleteAttempts, 2);
        } finally {
            (LocalReplicaSCMProvider as any).pushRetryDelays = originalPushRetryDelays;
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('keeps a live-reconnect journal and surfaces a conflict when Overleaf advanced', async () => {
        const remoteRoot = await tempDir('sr-overleaf-live-reconnect-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-live-reconnect-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'section: baseline\n');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        const triggers = await scm.triggers;
        try {
            const internals = scm as any;
            await writeText(localMain, 'section: local\n');
            internals.pushWithRetry = async () => {
                throw new Error('simulated offline write');
            };
            fakeVfs.setConnectionState('disconnected');
            const interrupted = await internals.applySync(
                'push', 'update', '/main.tex', localMain, remoteMain,
            ) as Events['scmSyncCompleteEvent'];
            assert.strictEqual(interrupted.outcome, 'error');
            await writeText(remoteMain, 'section: Overleaf collaborator\n');

            const originalPushWithRetry = LocalReplicaSCMProvider.prototype['pushWithRetry'];
            internals.pushWithRetry = originalPushWithRetry.bind(scm);
            const replay = waitForSyncComplete(localRoot, '/main.tex', 'push', 'update');
            fakeVfs.setConnectionState('connected');
            const recovered = await replay;
            assert.strictEqual(recovered.outcome, 'blocked');
            assert.strictEqual(await readText(localMain), 'section: local\n');
            assert.strictEqual(await readText(remoteMain), 'section: Overleaf collaborator\n');
            assert.strictEqual(internals.syncConflicts.has('/main.tex'), true);
            assert.strictEqual(
                internals.syncManifest.pendingOperations['/main.tex'].kind,
                'update',
            );
            assert.strictEqual(scm.status.status, 'need-attention');
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('acknowledges a journal only after an authoritative pull confirms its exact intent', async () => {
        const remoteRoot = await tempDir('sr-overleaf-pull-ack-remote-');
        const localRoot = await tempDir('sr-overleaf-pull-ack-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        const generation = internals.syncGeneration as number;
        const remoteBeforeAcknowledgement = await internals.captureRemotePathRevision(
            '/main.tex',
            generation,
        );
        await writeText(localMain, 'accepted but response lost');
        await internals.journalPendingFilePushOperation(
            '/main.tex',
            'update',
            sha1('accepted but response lost'),
            remoteBeforeAcknowledgement,
            generation,
        );
        await writeText(remoteMain, 'accepted but response lost');

        const pulled = await internals.applySync(
            'pull', 'update', '/main.tex', remoteMain, localMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(pulled.outcome, 'success');
        assert.strictEqual(internals.syncManifest.pendingOperations['/main.tex'], undefined);
        assert.strictEqual(scm.status.status, 'idle');
    });

    test('does not acknowledge a same-byte pending update after its Overleaf entity is replaced', async () => {
        const remoteRoot = await tempDir('sr-overleaf-pending-update-entity-race-remote-');
        const localRoot = await tempDir('sr-overleaf-pending-update-entity-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const acceptedBytes = 'same bytes but unacknowledged\\n';
        await writeText(remoteMain, 'baseline\\n');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('', 'pending-update-parent-original');
        fakeVfs.setEntityId('main.tex', 'pending-update-original');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const internals = scm as any;
        const generation = internals.syncGeneration as number;
        await writeText(localMain, acceptedBytes);
        const remoteBeforeAcknowledgement = await internals.captureRemotePathRevision(
            '/main.tex',
            generation,
        );
        const remoteIdentityBeforeAcknowledgement = await internals.resolveRemoteFilePathIdentity(
            remoteMain,
        );
        assert.ok(remoteIdentityBeforeAcknowledgement);
        await internals.journalPendingFilePushOperation(
            '/main.tex',
            'update',
            sha1(acceptedBytes),
            remoteBeforeAcknowledgement,
            remoteIdentityBeforeAcknowledgement,
            generation,
        );
        await writeText(remoteMain, acceptedBytes);
        fakeVfs.setEntityId('main.tex', 'pending-update-collaborator');

        await internals.reconcilePendingFilePushOperations(generation);

        assert.strictEqual(await readText(localMain), acceptedBytes);
        assert.strictEqual(await readText(remoteMain), acceptedBytes);
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteMain)).fileEntity._id,
            'pending-update-collaborator',
        );
        const pending = internals.syncManifest.pendingOperations['/main.tex'];
        assert.strictEqual(pending.kind, 'update');
        assert.deepStrictEqual(pending.targetEntity, {id: 'pending-update-original', type: 'doc'});
        assert.deepStrictEqual(pending.parentEntity, {id: 'pending-update-parent-original', type: 'folder'});
        assert.strictEqual(internals.syncConflicts.has('/main.tex'), true);
    });

    test('quarantines one-sided legacy replica files, media, and folders without a manifest', async () => {
        const remoteRoot = await tempDir('sr-overleaf-legacy-baseline-remote-');
        const localRoot = await tempDir('sr-overleaf-legacy-baseline-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeReplicaSettings(localRoot, remoteRoot);
        await writeText(vscode.Uri.joinPath(localRoot, 'stale.tex'), 'deleted remotely while offline');
        await writeBytes(vscode.Uri.joinPath(localRoot, 'stale.png'), Buffer.from([1, 2, 3]));
        await writeText(vscode.Uri.joinPath(localRoot, 'local-folder', 'main.tex'), 'local folder');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'remote-only.tex'), 'deleted locally while offline');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'remote-only.pdf'), Buffer.from('%PDF remote\n'));
        await writeText(vscode.Uri.joinPath(remoteRoot, 'remote-folder', 'main.tex'), 'remote folder');

        const firstScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await firstScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );

        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'stale.tex')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'stale.png')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'local-folder')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'remote-only.tex')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'remote-only.pdf')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'remote-folder')), false);
        await assert.rejects(
            () => firstScm.flushBeforeCompile([]),
            /no trusted sync baseline/i,
        );

        const manifestUri = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-manifest.json',
        );
        assert.strictEqual(JSON.parse(await readText(manifestUri)).baselineComplete, false);

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'stale.tex')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'remote-only.tex')), false);
        await assert.rejects(
            () => restartedScm.flushBeforeCompile([]),
            /no trusted sync baseline/i,
        );
    });

    test('treats an invalid legacy sync manifest as an unavailable baseline', async () => {
        const remoteRoot = await tempDir('sr-overleaf-invalid-baseline-remote-');
        const localRoot = await tempDir('sr-overleaf-invalid-baseline-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeReplicaSettings(localRoot, remoteRoot);
        await writeText(
            vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR, 'sync-manifest.json'),
            '{"version":2,"broken":',
        );
        await writeText(vscode.Uri.joinPath(localRoot, 'stale.tex'), 'must not upload');

        const scm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await scm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'stale.tex')), false);
        await assert.rejects(
            () => scm.flushBeforeCompile([]),
            /no trusted sync baseline/i,
        );
    });

    test('rejects JSON-valid manifests with invalid baseline types or entries', async () => {
        const cases: Array<[string, (projectUri: string) => unknown]> = [
            ['baseline-type', projectUri => ({
                version: 2,
                projectUri,
                baselineComplete: 'false',
                files: {},
                directories: {},
                conflicts: {},
            })],
            ['malformed-entry', projectUri => ({
                version: 2,
                projectUri,
                baselineComplete: true,
                files: {
                    ['/stale.tex']: {
                        remoteFingerprint: `content:${sha1('must not upload')}`,
                        localSize: 15,
                        localMtime: 1,
                        localDigest: 'not-a-sha1',
                        updatedAt: new Date().toISOString(),
                    },
                },
                directories: {},
                conflicts: {},
            })],
            ['malformed-identity', projectUri => ({
                version: 4,
                projectUri,
                baselineComplete: true,
                files: {
                    ['/stale.tex']: {
                        remoteFingerprint: `content:${sha1('must not upload')}`,
                        localSize: 15,
                        localMtime: 1,
                        localDigest: sha1('must not upload'),
                        remoteEntity: {id: 'doc-stale', type: 'folder'},
                        localIdentity: {dev: '0', ino: '0'},
                        updatedAt: new Date().toISOString(),
                    },
                },
                directories: {},
                conflicts: {},
                pendingOperations: {},
            })],
        ];

        for (const [name, manifestFactory] of cases) {
            const remoteRoot = await tempDir(`sr-overleaf-invalid-${name}-remote-`);
            const localRoot = await tempDir(`sr-overleaf-invalid-${name}-local-`);
            tempRoots.push(remoteRoot, localRoot);
            await writeReplicaSettings(localRoot, remoteRoot);
            await writeText(vscode.Uri.joinPath(localRoot, 'stale.tex'), 'must not upload');
            const manifestUri = vscode.Uri.joinPath(
                localRoot,
                REPLICA_SETTINGS_DIR,
                'sync-manifest.json',
            );
            await writeText(manifestUri, JSON.stringify(manifestFactory(remoteRoot.toString())));

            const scm = createSCM(remoteRoot, localRoot);
            assert.strictEqual(
                await scm.initializeLocalReplica({preserveExistingLocalFiles: true}),
                true,
            );
            assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'stale.tex')), false);
            await assert.rejects(
                () => scm.flushBeforeCompile([]),
                /no trusted sync baseline/i,
            );
            assert.strictEqual(JSON.parse(await readText(manifestUri)).baselineComplete, false);
        }
    });

    test('establishes a trusted legacy baseline when text and media bytes are identical', async () => {
        const remoteRoot = await tempDir('sr-overleaf-identical-legacy-remote-');
        const localRoot = await tempDir('sr-overleaf-identical-legacy-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeReplicaSettings(localRoot, remoteRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'same text');
        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'same text');
        const media = Buffer.from([9, 8, 7, 6]);
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figure.png'), media);
        await writeBytes(vscode.Uri.joinPath(localRoot, 'figure.png'), media);

        const scm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await scm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        const manifest = JSON.parse(await readText(vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-manifest.json',
        )));
        assert.strictEqual(manifest.baselineComplete, true);
        assert.ok(manifest.files['/main.tex']);
        assert.ok(manifest.files['/figure.png']);
        const flush = await scm.flushBeforeCompile([]);
        assert.strictEqual(flush.blockedCount, 0);
    });

    test('keeps the baseline incomplete until every failed initial pull is resolved', async () => {
        const remoteRoot = await tempDir('sr-overleaf-partial-baseline-remote-');
        const localRoot = await tempDir('sr-overleaf-partial-baseline-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        await writeText(remoteMain, 'remote content');

        const scm = createSCM(remoteRoot, localRoot);
        const originalPullRemoteFile = (scm as any).pullRemoteFile.bind(scm);
        (scm as any).pullRemoteFile = async () => {
            throw new Error('simulated initial download failure');
        };
        assert.strictEqual(
            await scm.initializeLocalReplica({resetLocalFilesToRemote: true}),
            true,
        );
        const manifestUri = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-manifest.json',
        );
        assert.strictEqual(JSON.parse(await readText(manifestUri)).baselineComplete, false);
        assert.strictEqual((scm as any).failedInitialPulls.has('/main.tex'), true);

        (scm as any).pullRemoteFile = originalPullRemoteFile;
        const retried = await scm.retryFailedInitialPulls();
        assert.deepStrictEqual(retried.stillFailed, []);
        assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'remote content');
        assert.strictEqual(JSON.parse(await readText(manifestUri)).baselineComplete, true);
    });

    test('still uploads local-only files from a newly selected folder', async () => {
        const remoteRoot = await tempDir('sr-overleaf-fresh-baseline-remote-');
        const localRoot = await tempDir('sr-overleaf-fresh-baseline-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'fresh local project');
        const scm = createSCM(remoteRoot, localRoot);

        assert.strictEqual(
            await scm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')),
            'fresh local project',
        );
        const manifest = JSON.parse(await readText(vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-manifest.json',
        )));
        assert.strictEqual(manifest.baselineComplete, true);
    });


    test('journals and verifies a local file create by authoritative entity id', async () => {
        const remoteRoot = await tempDir('sr-overleaf-file-create-journal-remote-');
        const localRoot = await tempDir('sr-overleaf-file-create-journal-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localFile = vscode.Uri.joinPath(localRoot, 'draft.tex');
        const remoteFile = vscode.Uri.joinPath(remoteRoot, 'draft.tex');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localFile, 'guarded local create');

        const originalCreate = fakeVfs.createFileIfMissing.bind(fakeVfs);
        let enteredCreate!: () => void;
        let releaseCreate!: () => void;
        const createEntered = new Promise<void>(resolve => { enteredCreate = resolve; });
        const release = new Promise<void>(resolve => { releaseCreate = resolve; });
        fakeVfs.createFileIfMissing = async (uri, content, parentId) => {
            enteredCreate();
            await release;
            return originalCreate(uri, content, parentId);
        };

        const sync = (scm as any).applySync(
            'push', 'update', '/draft.tex', localFile, remoteFile,
        ) as Promise<Events['scmSyncCompleteEvent']>;
        await createEntered;
        const pending = (scm as any).syncManifest.pendingOperations['/draft.tex'];
        assert.strictEqual(pending.kind, 'create');
        assert.strictEqual(pending.remoteKind, 'missing');
        assert.strictEqual(pending.remoteRevision, '\0');
        assert.deepStrictEqual(pending.parentEntity, {id: '/', type: 'folder'});
        assert.strictEqual(pending.createdEntity, undefined);
        assert.strictEqual(await pathExists(remoteFile), false);

        releaseCreate();
        const event = await sync;
        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(await readText(remoteFile), 'guarded local create');
        assert.strictEqual((scm as any).syncManifest.pendingOperations['/draft.tex'], undefined);
        const createdRemote = await fakeVfs._resolveUri(remoteFile);
        assert.deepStrictEqual((scm as any).syncManifest.files['/draft.tex'].remoteEntity, {
            id: createdRemote.fileEntity._id, type: 'doc',
        });
    });


    test('replays a journaled local file create after a live reconnect without another watcher event', async () => {
        const remoteRoot = await tempDir('sr-overleaf-file-create-reconnect-remote-');
        const localRoot = await tempDir('sr-overleaf-file-create-reconnect-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localFile = vscode.Uri.joinPath(localRoot, 'offline.tex');
        const remoteFile = vscode.Uri.joinPath(remoteRoot, 'offline.tex');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const triggers = await scm.triggers;
        try {
            await writeText(localFile, 'queued file create');
            const internals = scm as any;
            const localState = await internals.captureLocalPathRevision('/offline.tex');
            await internals.journalPendingLocalFileCreate(
                '/offline.tex', localState.revision, {id: '/', type: 'folder'},
            );

            fakeVfs.setConnectionState('disconnected');
            assert.strictEqual(scm.status.status, 'offline');
            fakeVfs.setConnectionState('connected');

            await waitUntil(() => (
                internals.syncManifest.pendingOperations['/offline.tex']===undefined
                && scm.status.status==='idle'
            ));
            assert.strictEqual(await readText(remoteFile), 'queued file create');
            const createdRemote = await fakeVfs._resolveUri(remoteFile);
            assert.deepStrictEqual(internals.syncManifest.files['/offline.tex'].remoteEntity, {
                id: createdRemote.fileEntity._id, type: 'doc',
            });
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });
    test('replays an acknowledged local file create after restart by exact entity id', async () => {
        const remoteRoot = await tempDir('sr-overleaf-file-create-replay-remote-');
        const localRoot = await tempDir('sr-overleaf-file-create-replay-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localFile = vscode.Uri.joinPath(localRoot, 'appendix.tex');
        const remoteFile = vscode.Uri.joinPath(remoteRoot, 'appendix.tex');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localFile, 'created before restart');

        const internals = scm as any;
        const localState = await internals.captureLocalPathRevision('/appendix.tex');
        const pending = await internals.journalPendingLocalFileCreate(
            '/appendix.tex',
            localState.revision,
            {id: '/', type: 'folder'},
        );
        await writeText(remoteFile, 'created before restart');
        fakeVfs.setEntityId('appendix.tex', 'doc-appendix-created');
        await internals.markPendingLocalFileCreateEntity(
            '/appendix.tex',
            pending,
            {id: 'doc-appendix-created', type: 'doc'},
        );
        scm.deactivate();

        const restarted = createSCM(remoteRoot, localRoot, fakeVfs);
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(
            (restarted as any).syncManifest.pendingOperations['/appendix.tex'],
            undefined,
        );
        assert.deepStrictEqual(
            (restarted as any).syncManifest.files['/appendix.tex'].remoteEntity,
            {id: 'doc-appendix-created', type: 'doc'},
        );
    });

    test('conflicts on a same-byte remote file after an unacknowledged local create', async () => {
        const remoteRoot = await tempDir('sr-overleaf-file-create-ambiguous-remote-');
        const localRoot = await tempDir('sr-overleaf-file-create-ambiguous-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localFile = vscode.Uri.joinPath(localRoot, 'results.tex');
        const remoteFile = vscode.Uri.joinPath(remoteRoot, 'results.tex');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localFile, 'identical collaborator bytes');

        const internals = scm as any;
        const localState = await internals.captureLocalPathRevision('/results.tex');
        await internals.journalPendingLocalFileCreate(
            '/results.tex', localState.revision, {id: '/', type: 'folder'},
        );
        await writeText(remoteFile, 'identical collaborator bytes');
        fakeVfs.setEntityId('results.tex', 'doc-collaborator');
        await internals.reconcilePendingFilePushOperations();

        assert.match(
            internals.syncConflicts.get('/results.tex'),
            /unacknowledged local create|identity is not proven/i,
        );
        assert.strictEqual(
            internals.syncManifest.pendingOperations['/results.tex'].kind,
            'create',
        );
        assert.strictEqual(await readText(localFile), 'identical collaborator bytes');
        assert.strictEqual(await readText(remoteFile), 'identical collaborator bytes');
    });

    test('conflicts when a pending local file create parent is replaced', async () => {
        const remoteRoot = await tempDir('sr-overleaf-file-create-parent-remote-');
        const localRoot = await tempDir('sr-overleaf-file-create-parent-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteFolder = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localFolder = vscode.Uri.joinPath(localRoot, 'chapter');
        const remoteFile = vscode.Uri.joinPath(remoteFolder, 'new.tex');
        const localFile = vscode.Uri.joinPath(localFolder, 'new.tex');
        await vscode.workspace.fs.createDirectory(remoteFolder);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('chapter', 'folder-parent-a');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localFile, 'new local child');

        const internals = scm as any;
        const localState = await internals.captureLocalPathRevision('/chapter/new.tex');
        await internals.journalPendingLocalFileCreate(
            '/chapter/new.tex',
            localState.revision,
            {id: 'folder-parent-a', type: 'folder'},
        );
        await vscode.workspace.fs.delete(remoteFolder, {recursive: true});
        await vscode.workspace.fs.createDirectory(remoteFolder);
        fakeVfs.setEntityId('chapter', 'folder-parent-b');
        await internals.reconcilePendingFilePushOperations();

        assert.match(internals.syncConflicts.get('/chapter/new.tex'), /parent folder changed/i);
        assert.strictEqual(
            internals.syncManifest.pendingOperations['/chapter/new.tex'].kind,
            'create',
        );
        assert.strictEqual(await pathExists(remoteFile), false);
    });

    test('replays an agent-advanced local file create with the latest bytes', async () => {
        const remoteRoot = await tempDir('sr-overleaf-file-create-advance-remote-');
        const localRoot = await tempDir('sr-overleaf-file-create-advance-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localFile = vscode.Uri.joinPath(localRoot, 'agent.tex');
        const remoteFile = vscode.Uri.joinPath(remoteRoot, 'agent.tex');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localFile, 'agent revision one');

        const internals = scm as any;
        const localState = await internals.captureLocalPathRevision('/agent.tex');
        await internals.journalPendingLocalFileCreate(
            '/agent.tex', localState.revision, {id: '/', type: 'folder'},
        );
        await writeText(localFile, 'agent revision two');
        await internals.reconcilePendingFilePushOperations();

        assert.strictEqual(internals.syncConflicts.get('/agent.tex'), undefined);
        assert.strictEqual(internals.syncManifest.pendingOperations['/agent.tex'], undefined);
        assert.strictEqual(await readText(remoteFile), 'agent revision two');
        assert.strictEqual(await readText(localFile), 'agent revision two');
    });
    test('journals and verifies a local folder create by authoritative entity id', async () => {
        const remoteRoot = await tempDir('sr-overleaf-mkdir-journal-remote-');
        const localRoot = await tempDir('sr-overleaf-mkdir-journal-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localFolder = vscode.Uri.joinPath(localRoot, 'figures');
        const remoteFolder = vscode.Uri.joinPath(remoteRoot, 'figures');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.createDirectory(localFolder);

        const originalCreate = fakeVfs.createDirectoryIfMissing.bind(fakeVfs);
        let enteredCreate!: () => void;
        let releaseCreate!: () => void;
        const createEntered = new Promise<void>(resolve => { enteredCreate = resolve; });
        const release = new Promise<void>(resolve => { releaseCreate = resolve; });
        fakeVfs.createDirectoryIfMissing = async uri => {
            enteredCreate();
            await release;
            return originalCreate(uri);
        };

        const sync = (scm as any).applySync(
            'push',
            'update',
            '/figures',
            localFolder,
            remoteFolder,
        ) as Promise<Events['scmSyncCompleteEvent']>;
        await createEntered;
        const pending = (scm as any).syncManifest.pendingOperations['/figures'];
        assert.strictEqual(pending.kind, 'mkdir');
        assert.strictEqual(pending.remoteKind, 'missing');
        assert.strictEqual(pending.parentEntity.id, '/');
        assert.strictEqual(await pathExists(remoteFolder), false);

        releaseCreate();
        const event = await sync;
        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(await pathExists(remoteFolder), true);
        assert.strictEqual((scm as any).syncManifest.pendingOperations['/figures'], undefined);
        const directoryEntry = (scm as any).syncManifest.directories['/figures'];
        const createdRemote = await fakeVfs._resolveUri(remoteFolder);
        assert.deepStrictEqual(directoryEntry.remoteEntity, {
            id: createdRemote.fileEntity._id,
            type: 'folder',
        });
        assert.deepStrictEqual(directoryEntry.parentEntity, {id: '/', type: 'folder'});
        assert.match(directoryEntry.localIdentity.dev, /^\d+$/);
        assert.match(directoryEntry.localIdentity.ino, /^[1-9]\d*$/);
    });

    test('replays a journaled local folder create on reconnect without another watcher event', async () => {
        const remoteRoot = await tempDir('sr-overleaf-mkdir-reconnect-remote-');
        const localRoot = await tempDir('sr-overleaf-mkdir-reconnect-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localFolder = vscode.Uri.joinPath(localRoot, 'generated');
        const remoteFolder = vscode.Uri.joinPath(remoteRoot, 'generated');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const triggers = await scm.triggers;
        try {
            await vscode.workspace.fs.createDirectory(localFolder);
            const internals = scm as any;
            const localState = await internals.captureLocalPathRevision('/generated');
            await internals.journalPendingLocalDirectoryCreate(
                '/generated',
                localState.revision,
                {id: '/', type: 'folder'},
            );

            fakeVfs.setConnectionState('disconnected');
            assert.strictEqual(scm.status.status, 'offline');
            fakeVfs.setConnectionState('connected');

            await waitUntil(() => (
                internals.syncManifest.pendingOperations['/generated']===undefined
                && scm.status.status==='idle'
            ));
            assert.strictEqual(await pathExists(remoteFolder), true);
            const createdRemote = await fakeVfs._resolveUri(remoteFolder);
            assert.deepStrictEqual(internals.syncManifest.directories['/generated'].remoteEntity, {
                id: createdRemote.fileEntity._id,
                type: 'folder',
            });
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('replays an acknowledged local folder create after restart', async () => {
        const remoteRoot = await tempDir('sr-overleaf-mkdir-replay-remote-');
        const localRoot = await tempDir('sr-overleaf-mkdir-replay-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localFolder = vscode.Uri.joinPath(localRoot, 'appendix');
        const remoteFolder = vscode.Uri.joinPath(remoteRoot, 'appendix');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.createDirectory(localFolder);

        const internals = scm as any;
        const localState = await internals.captureLocalPathRevision('/appendix');
        const pending = await internals.journalPendingLocalDirectoryCreate(
            '/appendix',
            localState.revision,
            {id: '/', type: 'folder'},
        );
        await vscode.workspace.fs.createDirectory(remoteFolder);
        const createdRemote = await fakeVfs._resolveUri(remoteFolder);
        await internals.markPendingLocalDirectoryCreateEntity(
            '/appendix',
            pending,
            {id: createdRemote.fileEntity._id, type: 'folder'},
        );
        await scm.deactivate();

        const restarted = createSCM(remoteRoot, localRoot, fakeVfs);
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual((restarted as any).syncManifest.pendingOperations['/appendix'], undefined);
        assert.deepStrictEqual((restarted as any).syncManifest.directories['/appendix'].remoteEntity, {
            id: createdRemote.fileEntity._id,
            type: 'folder',
        });
        assert.deepStrictEqual((restarted as any).syncManifest.directories['/appendix'].parentEntity, {
            id: '/',
            type: 'folder',
        });
    });

    test('conflicts when an unacknowledged local folder create name appears remotely', async () => {
        const remoteRoot = await tempDir('sr-overleaf-mkdir-ambiguous-remote-');
        const localRoot = await tempDir('sr-overleaf-mkdir-ambiguous-local-');
        tempRoots.push(remoteRoot, localRoot);

        const localFolder = vscode.Uri.joinPath(localRoot, 'results');
        const remoteFolder = vscode.Uri.joinPath(remoteRoot, 'results');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.createDirectory(localFolder);

        const internals = scm as any;
        const localState = await internals.captureLocalPathRevision('/results');
        await internals.journalPendingLocalDirectoryCreate(
            '/results',
            localState.revision,
            {id: '/', type: 'folder'},
        );
        // Simulate a collaborator's same-name folder appearing after our request
        // was journaled but before the server acknowledged it.
        await vscode.workspace.fs.createDirectory(remoteFolder);
        await internals.reconcilePendingFilePushOperations();

        assert.match(
            internals.syncConflicts.get('/results'),
            /unacknowledged local create/,
        );
        assert.strictEqual(internals.syncManifest.pendingOperations['/results'].kind, 'mkdir');
        assert.strictEqual(await pathExists(localFolder), true);
        assert.strictEqual(await pathExists(remoteFolder), true);
    });

    test('three-way merges a pull-first live collaboration race', async () => {
        const remoteRoot = await tempDir('sr-overleaf-merge-pull-remote-');
        const localRoot = await tempDir('sr-overleaf-merge-pull-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'title: base\nbody: base\nfooter: base\n');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(localMain, 'title: local\nbody: base\nfooter: base\n');
        await writeText(remoteMain, 'title: base\nbody: base\nfooter: remote\n');
        const event = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];

        const expected = 'title: local\nbody: base\nfooter: remote\n';
        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(await readText(localMain), expected);
        assert.strictEqual(await readText(remoteMain), expected);
    });

    test('preserves both sides of file-directory replacements during restart', async () => {
        const fileToDirectoryRemote = await tempDir('sr-overleaf-file-dir-remote-');
        const fileToDirectoryLocal = await tempDir('sr-overleaf-file-dir-local-');
        tempRoots.push(fileToDirectoryRemote, fileToDirectoryLocal);
        const remoteSwap = vscode.Uri.joinPath(fileToDirectoryRemote, 'swap');
        const localSwap = vscode.Uri.joinPath(fileToDirectoryLocal, 'swap');
        await writeText(remoteSwap, 'file baseline');
        const firstFileScm = createSCM(fileToDirectoryRemote, fileToDirectoryLocal);
        await firstFileScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        firstFileScm.deactivate();
        await vscode.workspace.fs.delete(remoteSwap);
        await writeText(vscode.Uri.joinPath(remoteSwap, 'remote-child.tex'), 'remote folder child');

        const restartedFileScm = createSCM(fileToDirectoryRemote, fileToDirectoryLocal);
        assert.strictEqual(
            await restartedFileScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await readText(localSwap), 'file baseline');
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteSwap, 'remote-child.tex')),
            'remote folder child',
        );
        await assert.rejects(
            () => restartedFileScm.flushBeforeCompile([]),
            /Overleaf contains a folder/i,
        );

        const directoryToFileRemote = await tempDir('sr-overleaf-dir-file-remote-');
        const directoryToFileLocal = await tempDir('sr-overleaf-dir-file-local-');
        tempRoots.push(directoryToFileRemote, directoryToFileLocal);
        const remoteChapter = vscode.Uri.joinPath(directoryToFileRemote, 'chapter');
        const localChapter = vscode.Uri.joinPath(directoryToFileLocal, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'local-child.tex'), 'folder baseline');
        const firstDirectoryScm = createSCM(directoryToFileRemote, directoryToFileLocal);
        await firstDirectoryScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        firstDirectoryScm.deactivate();
        await vscode.workspace.fs.delete(remoteChapter, {recursive: true});
        await writeText(remoteChapter, 'remote replacement file');

        const restartedDirectoryScm = createSCM(directoryToFileRemote, directoryToFileLocal);
        assert.strictEqual(
            await restartedDirectoryScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(localChapter, 'local-child.tex')),
            'folder baseline',
        );
        assert.strictEqual(await readText(remoteChapter), 'remote replacement file');
        await assert.rejects(
            () => restartedDirectoryScm.flushBeforeCompile([]),
            /Overleaf contains a file/i,
        );
    });

    test('three-way merges a push-first live collaboration race', async () => {
        const remoteRoot = await tempDir('sr-overleaf-merge-push-remote-');
        const localRoot = await tempDir('sr-overleaf-merge-push-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'title: base\nbody: base\nfooter: base\n');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(localMain, 'title: local\nbody: base\nfooter: base\n');
        await writeText(remoteMain, 'title: base\nbody: base\nfooter: remote\n');
        const event = await (scm as any).applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];

        const expected = 'title: local\nbody: base\nfooter: remote\n';
        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(await readText(localMain), expected);
        assert.strictEqual(await readText(remoteMain), expected);
    });

    test('blocks a live local delete when Overleaf edited the file', async () => {
        const remoteRoot = await tempDir('sr-overleaf-delete-push-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-delete-push-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'base');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(localMain);
        await writeText(remoteMain, 'remote edit');
        const event = await (scm as any).applySync(
            'push',
            'delete',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(await pathExists(localMain), false);
        assert.strictEqual(await readText(remoteMain), 'remote edit');
        await assert.rejects(
            () => scm.flushBeforeCompile([]),
            /local copy was deleted while the Overleaf copy was also edited/i,
        );
        assert.strictEqual(await readText(remoteMain), 'remote edit');
    });

    test('blocks a live Overleaf delete when the local saved file was edited', async () => {
        const remoteRoot = await tempDir('sr-overleaf-delete-pull-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-delete-pull-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'base');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(localMain, 'local edit');
        await vscode.workspace.fs.delete(remoteMain);
        const event = await (scm as any).applySync(
            'pull',
            'delete',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(await readText(localMain), 'local edit');
        assert.strictEqual(await pathExists(remoteMain), false);
        await assert.rejects(
            () => scm.flushBeforeCompile([]),
            /Overleaf deleted the file while the local saved copy was also edited/i,
        );
        assert.strictEqual(await readText(localMain), 'local edit');
    });

    test('preserves both copies when local and remote text changed during restart', async () => {
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
        assert.strictEqual(await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')), 'remote v2');
        await assert.rejects(
            () => restartedScm.flushBeforeCompile([]),
            /both changed|sync conflict|concurrent edits/i,
        );
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'figures', 'plot.png')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'supplement.pdf')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'paper-renamed.pdf')), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'local-only.tex')), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'local-only.tex')), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, '.semantic-researcher-overleaf', 'settings.json')), true);
    });

    test('preserves both binary copies when local and remote media changed on restart', async () => {
        const remoteRoot = await tempDir('sr-overleaf-binary-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-binary-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        fakeVfs.setEntityId('/figure.png', 'image-v1');
        await writeBytes(remoteImage, Buffer.from([1, 2, 3]));
        const firstScm = createSCM(remoteRoot, localRoot, fakeVfs);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const localBytes = Buffer.from([4, 5, 6]);
        const remoteBytes = Buffer.from([7, 8, 9]);
        await writeBytes(localImage, localBytes);
        await writeBytes(remoteImage, remoteBytes);
        fakeVfs.setEntityId('/figure.png', 'image-v2');
        const restartedScm = createSCM(remoteRoot, localRoot, fakeVfs);
        await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true});

        assert.deepStrictEqual(await readBytes(localImage), localBytes);
        assert.deepStrictEqual(await readBytes(remoteImage), remoteBytes);
        await assert.rejects(
            () => restartedScm.flushBeforeCompile([]),
            /binary\/media|concurrent edits conflict/i,
        );
    });

    test('reconciles offline media additions, edits, and deletes in both directions on restart', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-');
        tempRoots.push(remoteRoot, localRoot);

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'changed.png'), Buffer.from([1, 2, 3]));
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'local-delete.pdf'), Buffer.from('%PDF delete\n'));
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'remote-delete.png'), Buffer.from([7, 8, 9]));

        const firstScm = createSCM(remoteRoot, localRoot, fakeVfs);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const changedBytes = Buffer.from([4, 5, 6, 7]);
        const localOnlyBytes = Buffer.from([10, 11, 12]);
        const remoteOnlyBytes = Buffer.from('%PDF remote only\n');
        await writeBytes(vscode.Uri.joinPath(localRoot, 'figures', 'changed.png'), changedBytes);
        await writeBytes(vscode.Uri.joinPath(localRoot, 'offline', 'local-only.png'), localOnlyBytes);
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'figures', 'local-delete.pdf'));
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(remoteRoot, 'figures', 'remote-delete.png'));
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'remote-only.pdf'), remoteOnlyBytes);

        const restartedScm = createSCM(remoteRoot, localRoot, fakeVfs);
        await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true});

        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'changed.png')),
            changedBytes,
        );
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(remoteRoot, 'offline', 'local-only.png')),
            localOnlyBytes,
        );
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(remoteRoot, 'figures', 'local-delete.pdf')),
            false,
        );
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(localRoot, 'figures', 'remote-delete.png')),
            false,
        );
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(localRoot, 'remote-only.pdf')),
            remoteOnlyBytes,
        );
    });

    test('reconciles empty and populated folder changes in both directions on restart', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-restart-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-restart-local-');
        tempRoots.push(remoteRoot, localRoot);

        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(remoteRoot, 'local-delete-empty'));
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(remoteRoot, 'remote-delete-empty'));
        await writeText(vscode.Uri.joinPath(remoteRoot, 'local-delete-populated', 'main.tex'), 'baseline');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'remote-delete-populated', 'main.tex'), 'baseline');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'local-delete-empty'));
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'local-delete-populated'), {recursive: true});
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(remoteRoot, 'remote-delete-empty'));
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(remoteRoot, 'remote-delete-populated'), {recursive: true});
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(localRoot, 'local-added', 'nested-empty'));
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(remoteRoot, 'remote-added', 'nested-empty'));

        const restartedScm = createSCM(remoteRoot, localRoot);
        await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true});

        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'local-delete-empty')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'local-delete-populated')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'remote-delete-empty')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'remote-delete-populated')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'local-added', 'nested-empty')), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'remote-added', 'nested-empty')), true);
    });

    test('blocks a recursive folder delete when the other side changed its contents', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'chapter', 'main.tex');
        await writeText(remoteMain, 'baseline');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'chapter'), {recursive: true});
        await writeText(remoteMain, 'remote collaborator edit');
        const restartedScm = createSCM(remoteRoot, localRoot);
        await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true});

        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'chapter')), false);
        assert.strictEqual(await readText(remoteMain), 'remote collaborator edit');
        await assert.rejects(
            () => restartedScm.flushBeforeCompile([]),
            /folder was deleted|sync conflict/i,
        );
    });
    test('blocks a remote folder delete while a child journal operation remains unresolved', async () => {
        const remoteRoot = await tempDir('sr-overleaf-pending-child-pull-remote-');
        const localRoot = await tempDir('sr-overleaf-pending-child-pull-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        const remoteChild = vscode.Uri.joinPath(remoteChapter, 'main.tex');
        const localChild = vscode.Uri.joinPath(localChapter, 'main.tex');
        await writeText(remoteChild, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        const generation = internals.syncGeneration as number;
        const remoteBeforeDelete = await internals.captureRemotePathRevision(
            '/chapter/main.tex', generation,
        );
        await internals.journalPendingFilePushOperation(
            '/chapter/main.tex',
            'update',
            sha1('baseline'),
            remoteBeforeDelete,
            generation,
        );
        await vscode.workspace.fs.delete(remoteChapter, {recursive: true});

        const event = await internals.applySync(
            'pull', 'delete', '/chapter', remoteChapter, localChapter,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(event.error, 'unresolved descendant local operation');
        assert.strictEqual(await readText(localChild), 'baseline');
        assert.strictEqual(
            internals.syncManifest.pendingOperations['/chapter/main.tex'].kind,
            'update',
        );
    });

    test('blocks a local folder delete while a child move destination remains unresolved', async () => {
        const remoteRoot = await tempDir('sr-overleaf-pending-child-push-remote-');
        const localRoot = await tempDir('sr-overleaf-pending-child-push-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'outside.tex');
        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await writeText(remoteSource, 'baseline');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'chapter baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        const generation = internals.syncGeneration as number;
        const sourceEntry = internals.syncManifest.files['/outside.tex'];
        const sourceRemoteState = await internals.captureRemotePathRevision(
            '/outside.tex', generation,
        );
        const parentProof = await internals.capturePendingLocalFileMoveParentProof(
            '/outside.tex',
            '/chapter/moved.tex',
            sourceEntry,
            generation,
        );
        await internals.journalPendingLocalFileMove(
            '/outside.tex',
            '/chapter/moved.tex',
            sourceEntry,
            sourceRemoteState,
            parentProof,
            generation,
        );
        await vscode.workspace.fs.delete(localChapter, {recursive: true});

        const event = await internals.applySync(
            'push', 'delete', '/chapter', localChapter, remoteChapter,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(event.error, 'unresolved descendant local operation');
        assert.strictEqual(await readText(vscode.Uri.joinPath(remoteChapter, 'main.tex')), 'chapter baseline');
        assert.strictEqual(
            internals.syncManifest.pendingOperations['/outside.tex'].kind,
            'move',
        );
    });


    test('preflights a recursive folder delete before deleting any unchanged sibling', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-atomic-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-atomic-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteA = vscode.Uri.joinPath(remoteRoot, 'chapter', 'a.tex');
        const remoteB = vscode.Uri.joinPath(remoteRoot, 'chapter', 'b.tex');
        await writeText(remoteA, 'a baseline');
        await writeText(remoteB, 'b baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'chapter'), {recursive: true});
        await writeText(remoteB, 'b collaborator edit');

        await assert.rejects(
            () => scm.flushBeforeCompile([]),
            /folder was deleted|sync conflict/i,
        );
        assert.strictEqual(await readText(remoteA), 'a baseline');
        assert.strictEqual(await readText(remoteB), 'b collaborator edit');
    });

    test('blocks local folder deletion when it would remove ignored Overleaf descendants', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-ignore-push-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-ignore-push-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'chapter', 'main.tex');
        const remoteIgnored = vscode.Uri.joinPath(remoteRoot, 'chapter', '.keep');
        await writeText(remoteMain, 'baseline');
        await writeText(remoteIgnored, 'remote ignored content');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'chapter'), {recursive: true});

        await assert.rejects(
            () => scm.flushBeforeCompile([]),
            /ignored Overleaf content must be preserved/i,
        );
        assert.strictEqual(await readText(remoteMain), 'baseline');
        assert.strictEqual(await readText(remoteIgnored), 'remote ignored content');
    });

    test('blocks Overleaf folder deletion when it would remove ignored local descendants', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-ignore-pull-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-ignore-pull-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        const localMain = vscode.Uri.joinPath(localChapter, 'main.tex');
        const localIgnored = vscode.Uri.joinPath(localChapter, '.keep');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localIgnored, 'local ignored content');

        await vscode.workspace.fs.delete(remoteChapter, {recursive: true});
        const event = await (scm as any).applySync(
            'pull',
            'delete',
            '/chapter',
            remoteChapter,
            localChapter,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.match(event.error ?? '', /ignored local content/i);
        assert.strictEqual(await readText(localMain), 'baseline');
        assert.strictEqual(await readText(localIgnored), 'local ignored content');
    });

    test('blocks an Overleaf folder deletion when local contents cannot be inspected', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-inspection-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-inspection-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(remoteChapter, {recursive: true});

        const originalCollect = (scm as any).collectLocalReplicaSnapshot.bind(scm);
        (scm as any).collectLocalReplicaSnapshot = async (
            directoryUri: vscode.Uri,
            directoryRelPath: string,
        ) => {
            if (directoryRelPath==='/chapter') {
                throw new Error('temporary local directory inspection failure');
            }
            return originalCollect(directoryUri, directoryRelPath);
        };
        try {
            const event = await (scm as any).applySync(
                'pull',
                'delete',
                '/chapter',
                remoteChapter,
                localChapter,
            ) as Events['scmSyncCompleteEvent'];

            assert.strictEqual(event.outcome, 'error');
            assert.match(event.error ?? '', /inspection failure/);
            assert.strictEqual(await pathExists(localChapter), true);
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(localChapter, 'main.tex')),
                'baseline',
            );
        } finally {
            (scm as any).collectLocalReplicaSnapshot = originalCollect;
        }
    });

    test('clears a parent folder conflict after its final changed child is reconciled', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-resolve-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-resolve-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'chapter', 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'chapter', 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'chapter'), {recursive: true});
        await writeText(remoteMain, 'collaborator edit');
        await assert.rejects(() => scm.flushBeforeCompile([]), /sync conflict|folder was deleted/i);
        assert.ok((scm as any).syncConflicts.has('/chapter'));

        await writeText(localMain, 'collaborator edit');
        const result = await scm.flushBeforeCompile([localMain]);

        assert.strictEqual(result.blockedCount, 0);
        assert.strictEqual((scm as any).syncConflicts.size, 0);
        assert.strictEqual(await readText(remoteMain), 'collaborator edit');
    });

    test('lets a closed-file edit resolve an existing text conflict before compile', async () => {
        const remoteRoot = await tempDir('sr-overleaf-closed-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-closed-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(localMain, 'local conflicting edit');
        await writeText(remoteMain, 'remote collaborator edit');
        const conflictEvent = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflictEvent.outcome, 'blocked');
        assert.ok((scm as any).syncConflicts.has('/main.tex'));

        await writeText(localMain, 'agent-authored final resolution');
        const result = await scm.flushBeforeCompile([]);

        assert.strictEqual(result.blockedCount, 0);
        assert.strictEqual((scm as any).syncConflicts.size, 0);
        assert.strictEqual(await readText(remoteMain), 'agent-authored final resolution');
        const manifestUri = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-manifest.json',
        );
        assert.strictEqual(
            JSON.parse(await readText(manifestUri)).conflicts['/main.tex'],
            undefined,
        );

        scm.deactivate();
        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual((restartedScm as any).syncConflicts.size, 0);
    });

    test('lets an explicit local-state decision preserve a deleted file', async () => {
        const remoteRoot = await tempDir('sr-overleaf-delete-resolve-remote-');
        const localRoot = await tempDir('sr-overleaf-delete-resolve-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(localMain);
        await writeText(remoteMain, 'remote collaborator edit');
        const conflict = await (scm as any).applySync(
            'push',
            'delete',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflict.outcome, 'blocked');
        assert.strictEqual((scm as any).syncConflicts.has('/main.tex'), true);

        assert.strictEqual(
            await scm.resolveConflictWithLocalState('/main.tex'),
            true,
        );
        assert.strictEqual(await pathExists(remoteMain), false);
        assert.strictEqual((scm as any).syncConflicts.has('/main.tex'), false);
    });

    test('lets an explicit local-state decision preserve a deleted folder', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-delete-resolve-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-delete-resolve-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteFolder = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localFolder = vscode.Uri.joinPath(localRoot, 'chapter');
        const remoteMain = vscode.Uri.joinPath(remoteFolder, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(localFolder, {recursive: true});
        await writeText(remoteMain, 'remote collaborator edit');
        const conflict = await (scm as any).applySync(
            'push',
            'delete',
            '/chapter',
            localFolder,
            remoteFolder,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflict.outcome, 'blocked');
        assert.strictEqual((scm as any).syncConflicts.has('/chapter'), true);

        assert.strictEqual(
            await scm.resolveConflictWithLocalState('/chapter'),
            true,
        );
        assert.strictEqual(await pathExists(remoteFolder), false);
        assert.strictEqual((scm as any).syncConflicts.has('/chapter'), false);
    });

    test('requires proof hydration before an explicit local deletion resolves a legacy conflict', async () => {
        const remoteRoot = await tempDir('sr-overleaf-delete-proof-remote-');
        const localRoot = await tempDir('sr-overleaf-delete-proof-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await vscode.workspace.fs.delete(localMain);
        await writeText(remoteMain, 'remote collaborator edit');
        const conflict = await (scm as any).applySync(
            'push',
            'delete',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflict.outcome, 'blocked');
        const entry = (scm as any).syncManifest.conflicts['/main.tex'];
        delete entry.remoteKind;
        delete entry.remoteRevision;

        assert.strictEqual(
            await scm.resolveConflictWithLocalState('/main.tex'),
            false,
        );
        assert.strictEqual(await pathExists(remoteMain), true);
        const hydrated = (scm as any).syncManifest.conflicts['/main.tex'];
        assert.strictEqual(hydrated.remoteKind, 'file');
        assert.strictEqual(hydrated.remoteRevision, sha1('remote collaborator edit'));

        assert.strictEqual(
            await scm.resolveConflictWithLocalState('/main.tex'),
            true,
        );
        assert.strictEqual(await pathExists(remoteMain), false);
        assert.strictEqual((scm as any).syncConflicts.has('/main.tex'), false);
    });

    test('lets a new watcher revision resolve an exact file conflict immediately', async () => {
        const remoteRoot = await tempDir('sr-overleaf-live-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-live-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(localMain, 'local conflicting edit');
        await writeText(remoteMain, 'remote collaborator edit');
        const conflictEvent = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflictEvent.outcome, 'blocked');

        await writeText(localMain, 'agent-authored final resolution');
        const pushEvent = await (scm as any).applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(pushEvent.outcome, 'success');
        assert.strictEqual(await readText(remoteMain), 'agent-authored final resolution');
        assert.strictEqual((scm as any).syncConflicts.size, 0);
        const manifestUri = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-manifest.json',
        );
        assert.strictEqual(
            JSON.parse(await readText(manifestUri)).conflicts['/main.tex'],
            undefined,
        );
    });

    test('preserves a second remote edit before accepting a later local conflict resolution', async () => {
        const remoteRoot = await tempDir('sr-overleaf-advanced-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-advanced-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(localMain, 'local conflicting edit');
        await writeText(remoteMain, 'first remote collaborator edit');
        const conflictEvent = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflictEvent.outcome, 'blocked');

        await writeText(remoteMain, 'second remote collaborator edit');
        await writeText(localMain, 'first local resolution attempt');
        const blockedPush = await (scm as any).applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(blockedPush.outcome, 'blocked');
        assert.strictEqual(await readText(remoteMain), 'second remote collaborator edit');
        assert.strictEqual(await readText(localMain), 'first local resolution attempt');
        assert.ok((scm as any).syncConflicts.has('/main.tex'));
        const conflict = (scm as any).syncManifest.conflicts['/main.tex'];
        assert.strictEqual(conflict.remoteKind, 'file');
        assert.strictEqual(conflict.remoteRevision, sha1('second remote collaborator edit'));
        assert.strictEqual(conflict.localDigest, sha1('first local resolution attempt'));

        await writeText(localMain, 'final local resolution after reviewing remote');
        const resolvedPush = await (scm as any).applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(resolvedPush.outcome, 'success');
        assert.strictEqual(
            await readText(remoteMain),
            'final local resolution after reviewing remote',
        );
        assert.strictEqual((scm as any).syncConflicts.size, 0);
    });

    test('does not overwrite a second remote binary revision during conflict resolution', async () => {
        const remoteRoot = await tempDir('sr-overleaf-binary-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-binary-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        await writeBytes(remoteImage, Buffer.from([1, 2, 3]));
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeBytes(localImage, Buffer.from([4, 5, 6]));
        await writeBytes(remoteImage, Buffer.from([7, 8, 9]));
        const conflictEvent = await (scm as any).applySync(
            'pull',
            'update',
            '/figure.png',
            remoteImage,
            localImage,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflictEvent.outcome, 'blocked');

        const secondRemote = Buffer.from([10, 11, 12]);
        await writeBytes(remoteImage, secondRemote);
        await writeBytes(localImage, Buffer.from([13, 14, 15]));
        const blockedPush = await (scm as any).applySync(
            'push',
            'update',
            '/figure.png',
            localImage,
            remoteImage,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(blockedPush.outcome, 'blocked');
        assert.deepStrictEqual(await readBytes(remoteImage), secondRemote);
        assert.ok((scm as any).syncConflicts.has('/figure.png'));
        assert.strictEqual(
            (scm as any).syncManifest.conflicts['/figure.png'].remoteRevision,
            sha1(secondRemote),
        );
    });

    test('keeps both folder trees when accepting a verified Overleaf folder deletion', async () => {
        const fixture = await createFolderDeleteConflictFixture('folder-keep-both-delete');

        const result = await fixture.scm.resolveMissingFolderConflictWithOverleafState(
            '/chapter',
            true,
        );

        assert.strictEqual(result.resolved, true);
        assert.match(
            result.artifactRelPath!,
            /^\/\.semantic-researcher-overleaf\/conflicts\/[a-f0-9]{32}\/artifact\/chapter$/,
        );
        assert.strictEqual(await pathExists(fixture.localFolder), false);
        assert.strictEqual(await pathExists(fixture.remoteFolder), false);
        const artifact = uriForRelPath(fixture.localRoot, result.artifactRelPath!);
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(artifact, 'paper.pdf')),
            fixture.localPdfContent,
        );
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(artifact, 'local-only.zip')),
            fixture.localZipContent,
        );
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(artifact, 'figures', 'a.png')),
            false,
        );
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(artifact, 'empty')),
            true,
        );
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/chapter'), false);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'],
            undefined,
        );
        const history = (fixture.scm as any).syncManifest.folderConflictResolutionHistory;
        assert.strictEqual(history.at(-1).choice, 'keep-both');
        assert.strictEqual(history.at(-1).outcome, 'completed');
    });

    test('uses a private retained guard when accepting a verified Overleaf folder deletion', async () => {
        const fixture = await createFolderDeleteConflictFixture('folder-keep-overleaf-delete');

        const result = await fixture.scm.resolveMissingFolderConflictWithOverleafState(
            '/chapter',
            false,
        );

        assert.strictEqual(result.resolved, true);
        assert.strictEqual(result.artifactRelPath, undefined);
        assert.strictEqual(await pathExists(fixture.localFolder), false);
        assert.strictEqual(await pathExists(fixture.remoteFolder), false);
        const history = (fixture.scm as any).syncManifest.folderConflictResolutionHistory;
        const guard = history.at(-1).guardRelPath;
        assert.match(
            guard,
            /^\/\.semantic-researcher-overleaf\/conflicts\/[a-f0-9]{32}\/guard\/chapter$/,
        );
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(fixture.localRoot, guard + '/paper.pdf')),
            fixture.localPdfContent,
        );
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/chapter'), false);
    });

    test('recovers a folder Keep Both deletion after its canonical phase persistence is interrupted', async () => {
        const fixture = await createFolderDeleteConflictFixture('folder-keep-both-restart');
        const originalSetPhase = (fixture.scm as any)
            .setFolderConflictResolutionPhase.bind(fixture.scm);
        (fixture.scm as any).setFolderConflictResolutionPhase = (
            ...args: unknown[]
        ) => args[1]==='canonical-applied'
            ? false
            : originalSetPhase(...args);

        let result: any;
        try {
            result = await fixture.scm.resolveMissingFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
        } finally {
            (fixture.scm as any).setFolderConflictResolutionPhase = originalSetPhase;
        }

        assert.strictEqual(result.resolved, false);
        assert.strictEqual(await pathExists(fixture.localFolder), false);
        const interrupted = (fixture.scm as any).syncManifest
            .folderConflictResolutions['/chapter'];
        assert.strictEqual(interrupted.phase, 'local-preserved');
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(
                fixture.localRoot,
                interrupted.artifactRelPath + '/paper.pdf',
            )),
            fixture.localPdfContent,
        );

        await fixture.scm.deactivate();
        const restarted = createSCM(fixture.remoteRoot, fixture.localRoot);
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await pathExists(fixture.localFolder), false);
        assert.strictEqual(await pathExists(fixture.remoteFolder), false);
        assert.strictEqual((restarted as any).syncConflicts.has('/chapter'), false);
        assert.strictEqual(
            (restarted as any).syncManifest.folderConflictResolutions['/chapter'],
            undefined,
        );
        assert.strictEqual(
            (restarted as any).syncManifest.folderConflictResolutionHistory.at(-1).outcome,
            'completed',
        );
    });

    test('recovers a folder deletion when local preservation phase persistence is interrupted', async () => {
        for (const preserveLocal of [true, false]) {
            const fixture = await createFolderDeleteConflictFixture(
                'folder-delete-preserve-phase-' + (preserveLocal ? 'both' : 'overleaf'),
            );
            const originalSetPhase = (fixture.scm as any)
                .setFolderConflictResolutionPhase.bind(fixture.scm);
            (fixture.scm as any).setFolderConflictResolutionPhase = (
                ...args: unknown[]
            ) => args[1]==='local-preserved'
                ? false
                : originalSetPhase(...args);

            let result: any;
            try {
                result = await fixture.scm.resolveMissingFolderConflictWithOverleafState(
                    '/chapter',
                    preserveLocal,
                );
            } finally {
                (fixture.scm as any).setFolderConflictResolutionPhase = originalSetPhase;
            }

            assert.strictEqual(result.resolved, false, String(preserveLocal));
            const interrupted = (fixture.scm as any).syncManifest
                .folderConflictResolutions['/chapter'];
            assert.strictEqual(interrupted.phase, 'prepared', String(preserveLocal));
            assert.strictEqual(await pathExists(fixture.localFolder), false, String(preserveLocal));
            assert.strictEqual(await pathExists(fixture.remoteFolder), false, String(preserveLocal));
            const storedRelPath = preserveLocal
                ? interrupted.artifactRelPath
                : interrupted.guardRelPath;
            assert.deepStrictEqual(
                await readBytes(uriForRelPath(
                    fixture.localRoot,
                    storedRelPath + '/paper.pdf',
                )),
                fixture.localPdfContent,
                String(preserveLocal),
            );
            const persisted = JSON.parse(Buffer.from(
                await vscode.workspace.fs.readFile((fixture.scm as any).syncManifestUri),
            ).toString('utf8'));
            assert.strictEqual(
                persisted.folderConflictResolutions['/chapter'].phase,
                'prepared',
                String(preserveLocal),
            );

            await fixture.scm.deactivate();
            const restarted = createSCM(fixture.remoteRoot, fixture.localRoot);
            assert.strictEqual(
                await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
                true,
                String(preserveLocal),
            );
            assert.strictEqual(await pathExists(fixture.localFolder), false, String(preserveLocal));
            assert.strictEqual(await pathExists(fixture.remoteFolder), false, String(preserveLocal));
            assert.deepStrictEqual(
                await readBytes(uriForRelPath(
                    fixture.localRoot,
                    storedRelPath + '/paper.pdf',
                )),
                fixture.localPdfContent,
                String(preserveLocal),
            );
            assert.strictEqual((restarted as any).syncConflicts.has('/chapter'), false);
            assert.strictEqual(
                (restarted as any).syncManifest.folderConflictResolutions['/chapter'],
                undefined,
                String(preserveLocal),
            );
            const history = (restarted as any).syncManifest.folderConflictResolutionHistory.at(-1);
            assert.strictEqual(history.choice, preserveLocal ? 'keep-both' : 'keep-overleaf');
            assert.strictEqual(history.outcome, 'completed');
        }
    });

    test('defers missing-folder conflict resolution before local mutation when a child operation is pending', async () => {
        const fixture = await createFolderDeleteConflictFixture('folder-keep-both-pending');
        (fixture.scm as any).syncManifest.pendingOperations['/chapter/paper.pdf'] = {
            id: 'pending-folder-child',
            kind: 'update',
        };

        const result = await fixture.scm.resolveMissingFolderConflictWithOverleafState(
            '/chapter',
            true,
        );

        assert.strictEqual(result.resolved, false);
        assert.strictEqual(await pathExists(fixture.localFolder), true);
        assert.deepStrictEqual(await readBytes(fixture.localPdf), fixture.localPdfContent);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'],
            undefined,
        );
    });

    test('keeps both full folder trees when accepting a verified Overleaf folder replacement', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-replacement-keep-both');

        const result = await fixture.scm.resolveFolderConflictWithOverleafState(
            '/chapter',
            true,
        );

        assert.strictEqual(result.resolved, true);
        const artifact = uriForRelPath(fixture.localRoot, result.artifactRelPath!);
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(artifact, 'paper.pdf')),
            fixture.localPdfContent,
        );
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(artifact, 'local-only.zip')),
            fixture.localZipContent,
        );
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(artifact, 'empty')), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'paper.pdf')), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'local-only.zip')), false);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
            fixture.replacementTexContent,
        );
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(fixture.localFolder, 'figures', 'new.png')),
            fixture.replacementImageContent,
        );
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'new-empty')),
            true,
        );
        assert.strictEqual(
            await readText(fixture.replacementTex),
            fixture.replacementTexContent,
        );
        assert.deepStrictEqual(
            await readBytes(fixture.replacementImage),
            fixture.replacementImageContent,
        );
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/chapter'), false);
        assert.ok((fixture.scm as any).syncManifest.directories['/chapter']);
        assert.ok((fixture.scm as any).syncManifest.directories['/chapter/figures']);
        assert.ok((fixture.scm as any).syncManifest.files['/chapter/remote.tex']);
        assert.strictEqual((fixture.scm as any).syncManifest.files['/chapter/paper.pdf'], undefined);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutionHistory.at(-1).outcome,
            'completed',
        );
    });

    test('uses a private retained guard when accepting a verified Overleaf folder replacement', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-replacement-keep-overleaf');

        const result = await fixture.scm.resolveFolderConflictWithOverleafState(
            '/chapter',
            false,
        );

        assert.strictEqual(result.resolved, true);
        assert.strictEqual(result.artifactRelPath, undefined);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
            fixture.replacementTexContent,
        );
        const history = (fixture.scm as any).syncManifest.folderConflictResolutionHistory;
        const guard = history.at(-1).guardRelPath;
        assert.match(
            guard,
            /^\/\.semantic-researcher-overleaf\/conflicts\/[a-f0-9]{32}\/guard\/chapter$/,
        );
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(fixture.localRoot, guard + '/paper.pdf')),
            fixture.localPdfContent,
        );
        assert.deepStrictEqual(
            await readBytes(fixture.replacementImage),
            fixture.replacementImageContent,
        );
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/chapter'), false);
    });

    test('recovers a folder replacement after its canonical phase persistence is interrupted', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-replacement-restart');
        const originalSetPhase = (fixture.scm as any)
            .setFolderConflictResolutionPhase.bind(fixture.scm);
        (fixture.scm as any).setFolderConflictResolutionPhase = (
            ...args: unknown[]
        ) => args[1]==='canonical-applied'
            ? false
            : originalSetPhase(...args);

        let result: any;
        try {
            result = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
        } finally {
            (fixture.scm as any).setFolderConflictResolutionPhase = originalSetPhase;
        }

        assert.strictEqual(result.resolved, false);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
            fixture.replacementTexContent,
        );
        const interrupted = (fixture.scm as any).syncManifest
            .folderConflictResolutions['/chapter'];
        assert.strictEqual(interrupted.phase, 'local-preserved');
        assert.strictEqual(
            await pathExists(uriForRelPath(fixture.localRoot, interrupted.stageRelPath)),
            false,
        );
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(
                fixture.localRoot,
                interrupted.artifactRelPath + '/paper.pdf',
            )),
            fixture.localPdfContent,
        );

        await fixture.scm.deactivate();
        const restarted = createSCM(
            fixture.remoteRoot,
            fixture.localRoot,
            fixture.fakeVfs,
        );
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
            fixture.replacementTexContent,
        );
        assert.strictEqual((restarted as any).syncConflicts.has('/chapter'), false);
        assert.strictEqual(
            (restarted as any).syncManifest.folderConflictResolutions['/chapter'],
            undefined,
        );
        assert.strictEqual(
            (restarted as any).syncManifest.folderConflictResolutionHistory.at(-1).outcome,
            'completed',
        );
    });

    test('recovers a folder replacement when local preservation phase persistence is interrupted', async () => {
        for (const preserveLocal of [true, false]) {
            const fixture = await createFolderReplacementConflictFixture(
                'folder-replacement-preserve-phase-' + (preserveLocal ? 'both' : 'overleaf'),
            );
            const originalSetPhase = (fixture.scm as any)
                .setFolderConflictResolutionPhase.bind(fixture.scm);
            (fixture.scm as any).setFolderConflictResolutionPhase = (
                ...args: unknown[]
            ) => args[1]==='local-preserved'
                ? false
                : originalSetPhase(...args);

            let result: any;
            try {
                result = await fixture.scm.resolveFolderConflictWithOverleafState(
                    '/chapter',
                    preserveLocal,
                );
            } finally {
                (fixture.scm as any).setFolderConflictResolutionPhase = originalSetPhase;
            }

            assert.strictEqual(result.resolved, false, String(preserveLocal));
            const interrupted = (fixture.scm as any).syncManifest
                .folderConflictResolutions['/chapter'];
            assert.strictEqual(interrupted.phase, 'remote-staged', String(preserveLocal));
            assert.strictEqual(await pathExists(fixture.localFolder), false, String(preserveLocal));
            const storedRelPath = preserveLocal
                ? interrupted.artifactRelPath
                : interrupted.guardRelPath;
            assert.deepStrictEqual(
                await readBytes(uriForRelPath(
                    fixture.localRoot,
                    storedRelPath + '/paper.pdf',
                )),
                fixture.localPdfContent,
                String(preserveLocal),
            );

            await fixture.scm.deactivate();
            const restarted = createSCM(
                fixture.remoteRoot,
                fixture.localRoot,
                fixture.fakeVfs,
            );
            assert.strictEqual(
                await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
                true,
                String(preserveLocal),
            );
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
                fixture.replacementTexContent,
                String(preserveLocal),
            );
            assert.strictEqual((restarted as any).syncConflicts.has('/chapter'), false);
            assert.strictEqual(
                (restarted as any).syncManifest.folderConflictResolutions['/chapter'],
                undefined,
                String(preserveLocal),
            );
            const history = (restarted as any).syncManifest.folderConflictResolutionHistory.at(-1);
            assert.strictEqual(history.choice, preserveLocal ? 'keep-both' : 'keep-overleaf');
            assert.strictEqual(history.outcome, 'completed');
        }
    });

    test('blocks a partial prepared remote folder stage on restart without moving the canonical local tree', async () => {
        const fixture = await createFolderReplacementConflictFixture(
            'folder-replacement-prepared-partial-stage',
        );
        const originalStage = (fixture.scm as any)
            .stageFolderConflictRemoteDirectory.bind(fixture.scm);
        (fixture.scm as any).stageFolderConflictRemoteDirectory = async (
            record: any,
        ) => {
            await writeText(uriForRelPath(
                fixture.localRoot,
                record.stageRelPath + '/partial.tex',
            ), 'interrupted protected stage');
            return false;
        };
        let initial: any;
        try {
            initial = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
        } finally {
            (fixture.scm as any).stageFolderConflictRemoteDirectory = originalStage;
        }
        assert.strictEqual(initial.resolved, false);
        const record = (fixture.scm as any).syncManifest
            .folderConflictResolutions['/chapter'];
        assert.strictEqual(record.phase, 'prepared');
        const localInode = (await fs.lstat(fixture.localFolder.fsPath)).ino;
        assert.deepStrictEqual(await readBytes(fixture.localPdf), fixture.localPdfContent);
        assert.strictEqual(
            await pathExists(uriForRelPath(
                fixture.localRoot,
                record.stageRelPath + '/partial.tex',
            )),
            true,
        );

        await fixture.scm.deactivate();
        const restarted = createSCM(
            fixture.remoteRoot,
            fixture.localRoot,
            fixture.fakeVfs,
        );
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        const blocked = (restarted as any).syncManifest
            .folderConflictResolutions['/chapter'];
        assert.strictEqual(blocked.phase, 'blocked');
        assert.strictEqual((await fs.lstat(fixture.localFolder.fsPath)).ino, localInode);
        assert.deepStrictEqual(await readBytes(fixture.localPdf), fixture.localPdfContent);
        assert.strictEqual(
            await pathExists(uriForRelPath(
                fixture.localRoot,
                record.stageRelPath + '/partial.tex',
            )),
            true,
        );
        assert.strictEqual(await readText(fixture.replacementTex), fixture.replacementTexContent);
        assert.ok((restarted as any).syncConflicts.has('/chapter'));
    });

    test('blocks a tampered remote folder stage before moving the canonical local tree', async () => {
        const fixture = await createFolderReplacementConflictFixture(
            'folder-replacement-stage-tamper',
        );
        const originalPreserve = (fixture.scm as any)
            .preserveFolderConflictLocalTree.bind(fixture.scm);
        (fixture.scm as any).preserveFolderConflictLocalTree = async () => false;
        try {
            const staged = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
            assert.strictEqual(staged.resolved, false);
        } finally {
            (fixture.scm as any).preserveFolderConflictLocalTree = originalPreserve;
        }

        const record = (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'];
        assert.strictEqual(record.phase, 'remote-staged');
        assert.strictEqual(await pathExists(fixture.localFolder), true);
        const localInodeBefore = (await fs.lstat(fixture.localFolder.fsPath)).ino;
        await writeText(uriForRelPath(
            fixture.localRoot,
            record.stageRelPath + '/tampered.tex',
        ), 'metadata tamper');

        assert.strictEqual(
            await (fixture.scm as any).reconcilePersistedFolderConflictResolutionTransactions(),
            0,
        );
        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'].phase,
            'blocked',
        );
        assert.strictEqual(
            (await fs.lstat(fixture.localFolder.fsPath)).ino,
            localInodeBefore,
        );
        assert.deepStrictEqual(await readBytes(fixture.localPdf), fixture.localPdfContent);
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
            false,
        );
        assert.strictEqual(
            await pathExists(uriForRelPath(fixture.localRoot, record.artifactRelPath)),
            false,
        );
        assert.strictEqual(await readText(fixture.replacementTex), fixture.replacementTexContent);
        assert.ok((fixture.scm as any).syncConflicts.has('/chapter'));
    });

    test('preserves the local artifact and blocks a tampered stage after local preservation restart', async () => {
        const fixture = await createFolderReplacementConflictFixture(
            'folder-replacement-local-preserved-stage-tamper',
        );
        const originalInstall = (fixture.scm as any)
            .installStagedFolderConflictTree.bind(fixture.scm);
        (fixture.scm as any).installStagedFolderConflictTree = async () => false;
        try {
            const initial = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
            assert.strictEqual(initial.resolved, false);
        } finally {
            (fixture.scm as any).installStagedFolderConflictTree = originalInstall;
        }

        const record = (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'];
        assert.strictEqual(record.phase, 'local-preserved');
        assert.strictEqual(await pathExists(fixture.localFolder), false);
        await writeText(uriForRelPath(
            fixture.localRoot,
            record.stageRelPath + '/tampered.tex',
        ), 'metadata tamper after local preservation');
        await fixture.scm.deactivate();

        const restarted = createSCM(
            fixture.remoteRoot,
            fixture.localRoot,
            fixture.fakeVfs,
        );
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        const blocked = (restarted as any).syncManifest
            .folderConflictResolutions['/chapter'];
        assert.strictEqual(blocked.phase, 'blocked');
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(
                fixture.localRoot,
                record.artifactRelPath + '/paper.pdf',
            )),
            fixture.localPdfContent,
        );
        assert.strictEqual(
            await pathExists(uriForRelPath(
                fixture.localRoot,
                record.stageRelPath + '/tampered.tex',
            )),
            true,
        );
        assert.strictEqual(await readText(fixture.replacementTex), fixture.replacementTexContent);
        assert.ok((restarted as any).syncConflicts.has('/chapter'));
        if (await pathExists(fixture.localFolder)) {
            assert.strictEqual(
                await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'paper.pdf')),
                false,
            );
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
                fixture.replacementTexContent,
            );
        }
    });

    test('rebuilds a missing remote folder stage before preserving the local tree', async () => {
        const fixture = await createFolderReplacementConflictFixture(
            'folder-replacement-stage-rebuild',
        );
        const originalPreserve = (fixture.scm as any)
            .preserveFolderConflictLocalTree.bind(fixture.scm);
        (fixture.scm as any).preserveFolderConflictLocalTree = async () => false;
        try {
            const staged = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
            assert.strictEqual(staged.resolved, false);
        } finally {
            (fixture.scm as any).preserveFolderConflictLocalTree = originalPreserve;
        }

        const record = (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'];
        assert.strictEqual(record.phase, 'remote-staged');
        await vscode.workspace.fs.delete(
            uriForRelPath(fixture.localRoot, record.stageRelPath),
            {recursive: true},
        );
        assert.strictEqual(
            await (fixture.scm as any).reconcilePersistedFolderConflictResolutionTransactions(),
            1,
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
            fixture.replacementTexContent,
        );
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(
                fixture.localRoot,
                record.artifactRelPath + '/paper.pdf',
            )),
            fixture.localPdfContent,
        );
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/chapter'), false);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'],
            undefined,
        );
    });

    test('recovers a folder replacement when remote-stage phase persistence is interrupted', async () => {
        const fixture = await createFolderReplacementConflictFixture(
            'folder-replacement-stage-phase-persist',
        );
        const originalPersist = (fixture.scm as any)
            .persistSyncManifest.bind(fixture.scm);
        let interrupted = false;
        (fixture.scm as any).persistSyncManifest = async (...args: unknown[]) => {
            const record = (fixture.scm as any).syncManifest
                .folderConflictResolutions['/chapter'];
            if (!interrupted && record?.phase==='remote-staged') {
                interrupted = true;
                throw new Error('simulated remote-stage phase persistence interruption');
            }
            return originalPersist(...args);
        };

        try {
            const result = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
            assert.strictEqual(result.resolved, false);
        } finally {
            (fixture.scm as any).persistSyncManifest = originalPersist;
        }

        assert.strictEqual(interrupted, true);
        const interruptedRecord = (fixture.scm as any).syncManifest
            .folderConflictResolutions['/chapter'];
        assert.strictEqual(interruptedRecord.phase, 'remote-staged');
        assert.strictEqual(await pathExists(fixture.localFolder), true);
        assert.deepStrictEqual(await readBytes(fixture.localPdf), fixture.localPdfContent);
        await fixture.scm.deactivate();
        const restarted = createSCM(
            fixture.remoteRoot,
            fixture.localRoot,
            fixture.fakeVfs,
        );
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
            fixture.replacementTexContent,
        );
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(
                fixture.localRoot,
                interruptedRecord.artifactRelPath + '/paper.pdf',
            )),
            fixture.localPdfContent,
        );
        assert.strictEqual((restarted as any).syncConflicts.has('/chapter'), false);
        assert.strictEqual(
            (restarted as any).syncManifest.folderConflictResolutions['/chapter'],
            undefined,
        );
    });

    test('defers a persisted folder replacement during a transient reconciliation failure', async () => {
        const fixture = await createFolderReplacementConflictFixture(
            'folder-replacement-reconcile-deferred',
        );
        const originalSetPhase = (fixture.scm as any)
            .setFolderConflictResolutionPhase.bind(fixture.scm);
        (fixture.scm as any).setFolderConflictResolutionPhase = (
            ...args: unknown[]
        ) => args[1]==='local-preserved'
            ? false
            : originalSetPhase(...args);
        try {
            const initial = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
            assert.strictEqual(initial.resolved, false);
        } finally {
            (fixture.scm as any).setFolderConflictResolutionPhase = originalSetPhase;
        }
        const originalVerify = (fixture.scm as any)
            .verifyFolderConflictResolutionRemoteState.bind(fixture.scm);
        (fixture.scm as any).verifyFolderConflictResolutionRemoteState = async () => {
            throw new Error('simulated transient remote folder proof failure');
        };
        try {
            assert.strictEqual(
                await (fixture.scm as any).reconcilePersistedFolderConflictResolutionTransactions(),
                0,
            );
        } finally {
            (fixture.scm as any).verifyFolderConflictResolutionRemoteState = originalVerify;
        }

        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'].phase,
            'remote-staged',
        );
        assert.ok((fixture.scm as any).syncConflicts.has('/chapter'));
        assert.strictEqual(await pathExists(fixture.localFolder), false);
        assert.strictEqual(
            await (fixture.scm as any).reconcilePersistedFolderConflictResolutionTransactions(),
            1,
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
            fixture.replacementTexContent,
        );
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/chapter'), false);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'],
            undefined,
        );
    });

    test('replays a durable folder replacement decision on reconnect without another watcher event', async () => {
        const fixture = await createFolderReplacementConflictFixture(
            'folder-replacement-reconnect',
        );
        const triggers = await fixture.scm.triggers;
        const originalSetPhase = (fixture.scm as any)
            .setFolderConflictResolutionPhase.bind(fixture.scm);
        (fixture.scm as any).setFolderConflictResolutionPhase = (
            ...args: unknown[]
        ) => args[1]==='local-preserved'
            ? false
            : originalSetPhase(...args);
        try {
            const interrupted = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
            assert.strictEqual(interrupted.resolved, false);
        } finally {
            (fixture.scm as any).setFolderConflictResolutionPhase = originalSetPhase;
        }

        try {
            fixture.fakeVfs.setConnectionState('disconnected');
            fixture.fakeVfs.setConnectionState('connected');
            const replay = (fixture.scm as any).folderConflictResolutionReplay?.promise;
            assert.ok(replay);
            fixture.fakeVfs.setConnectionState('connected');
            assert.strictEqual((fixture.scm as any).folderConflictResolutionReplay?.promise, replay);
            await replay;
            await waitUntil(() => (
                !(fixture.scm as any).syncConflicts.has('/chapter')
                && (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter']
                    ===undefined
            ));
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
                fixture.replacementTexContent,
            );
            const history = (fixture.scm as any).syncManifest.folderConflictResolutionHistory.at(-1);
            assert.strictEqual(history.outcome, 'completed');
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('keeps the local tree and blocks when the verified remote folder identity is replaced during staging', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-replacement-identity-race');
        const originalCopy = (fixture.scm as any)
            .copyRemoteFolderConflictTreeToStage.bind(fixture.scm);
        (fixture.scm as any).copyRemoteFolderConflictTreeToStage = async (
            ...args: unknown[]
        ) => {
            await originalCopy(...args);
            fixture.fakeVfs.setEntityId('/chapter', 'replacement-folder-id-after-stage');
        };

        let result: any;
        try {
            result = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
        } finally {
            (fixture.scm as any).copyRemoteFolderConflictTreeToStage = originalCopy;
        }

        assert.strictEqual(result.resolved, false);
        assert.deepStrictEqual(await readBytes(fixture.localPdf), fixture.localPdfContent);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')), false);
        assert.strictEqual(
            await readText(fixture.replacementTex),
            fixture.replacementTexContent,
        );
        assert.ok((fixture.scm as any).syncConflicts.has('/chapter'));
        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'].phase,
            'blocked',
        );
    });

    test('defers a remote folder replacement before swapping when a watcher event arrives during staging', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-replacement-fence');
        const originalStage = (fixture.scm as any)
            .stageFolderConflictRemoteDirectory.bind(fixture.scm);
        (fixture.scm as any).stageFolderConflictRemoteDirectory = async (
            ...args: unknown[]
        ) => {
            const staged = await originalStage(...args);
            (fixture.scm as any).deferFolderConflictResolutionEvent(
                'remote',
                '/chapter',
                {latestType: 'update', latestUri: fixture.remoteFolder},
                (fixture.scm as any).syncGeneration,
            );
            return staged;
        };

        let result: any;
        try {
            result = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
        } finally {
            (fixture.scm as any).stageFolderConflictRemoteDirectory = originalStage;
        }

        assert.strictEqual(result.resolved, false);
        assert.deepStrictEqual(await readBytes(fixture.localPdf), fixture.localPdfContent);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')), false);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'].phase,
            'remote-staged',
        );
        assert.ok((fixture.scm as any).syncConflicts.has('/chapter'));
    });

    test('defers a remote folder replacement before staging when a directory move intersects it', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-replacement-pending-move');
        (fixture.scm as any).syncManifest.pendingOperations['/outside'] = {
            id: 'pending-folder-move',
            kind: 'directory-move',
            destinationRelPath: '/chapter/incoming',
        };

        const result = await fixture.scm.resolveFolderConflictWithOverleafState(
            '/chapter',
            true,
        );

        assert.strictEqual(result.resolved, false);
        assert.deepStrictEqual(await readBytes(fixture.localPdf), fixture.localPdfContent);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')), false);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'],
            undefined,
        );
        assert.strictEqual(
            await readText(fixture.replacementTex),
            fixture.replacementTexContent,
        );
    });

    test('defers a remote folder replacement while a local descendant editor is dirty', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-replacement-dirty-child');
        const localDraft = vscode.Uri.joinPath(fixture.localFolder, 'draft.tex');
        await writeText(localDraft, 'saved local draft');
        const document = await vscode.workspace.openTextDocument(localDraft);
        const editor = await vscode.window.showTextDocument(document);
        const edited = await editor.edit(builder => {
            builder.insert(new vscode.Position(0, 0), '% unsaved local edit\\n');
        });
        assert.strictEqual(edited, true);
        assert.strictEqual(document.isDirty, true);

        try {
            const result = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );

            assert.strictEqual(result.resolved, false);
            assert.strictEqual(document.isDirty, true);
            assert.deepStrictEqual(await readBytes(fixture.localPdf), fixture.localPdfContent);
            assert.strictEqual(
                await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
                false,
            );
            assert.strictEqual(
                (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'],
                undefined,
            );
            assert.strictEqual(await readText(fixture.replacementTex), fixture.replacementTexContent);
        } finally {
            if (document.isDirty) {
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }
        }
    });

    test('defers a remote folder replacement when either tree contains ignored content', async () => {
        for (const side of ['local', 'remote'] as const) {
            const fixture = await createFolderReplacementConflictFixture(
                'folder-replacement-ignored-' + side,
            );
            const ignored = vscode.Uri.joinPath(
                side==='local' ? fixture.localFolder : fixture.remoteFolder,
                '.output',
                'transient.log',
            );
            await writeText(ignored, side + ' ignored content');
            if (side==='remote') {
                const remoteState = await (fixture.scm as any).captureRemotePathRevision('/chapter');
                await (fixture.scm as any).markSyncConflict(
                    '/chapter',
                    'test remote folder replacement with ignored descendant',
                    undefined,
                    undefined,
                    remoteState,
                );
            }

            const result = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );

            assert.strictEqual(result.resolved, false, side);
            assert.deepStrictEqual(await readBytes(fixture.localPdf), fixture.localPdfContent, side);
            assert.strictEqual(
                await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
                false,
                side,
            );
            assert.strictEqual(
                (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'],
                undefined,
                side,
            );
            assert.strictEqual(await pathExists(ignored), true, side);
        }
    });

    test('preserves a newer local tree when it advances while the remote replacement is staged', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-replacement-local-advance');
        const newerLocalPdf = Buffer.from([90, 91, 92]);
        const originalStage = (fixture.scm as any)
            .stageFolderConflictRemoteDirectory.bind(fixture.scm);
        (fixture.scm as any).stageFolderConflictRemoteDirectory = async (
            ...args: unknown[]
        ) => {
            const staged = await originalStage(...args);
            await writeBytes(fixture.localPdf, newerLocalPdf);
            return staged;
        };

        let result: any;
        try {
            result = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
        } finally {
            (fixture.scm as any).stageFolderConflictRemoteDirectory = originalStage;
        }

        assert.strictEqual(result.resolved, false);
        assert.deepStrictEqual(await readBytes(fixture.localPdf), newerLocalPdf);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')), false);
        assert.ok((fixture.scm as any).syncConflicts.has('/chapter'));
        assert.notStrictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutionHistory.at(-1)?.outcome,
            'completed',
        );
    });

    test('preserves a prompt same-path local recreation before a remote folder replacement swap', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-replacement-local-recreate');
        const originalPreserve = (fixture.scm as any)
            .preserveFolderConflictLocalTree.bind(fixture.scm);
        const recreated = vscode.Uri.joinPath(fixture.localFolder, 'recreated.tex');
        (fixture.scm as any).preserveFolderConflictLocalTree = async (
            ...args: unknown[]
        ) => {
            const preserved = await originalPreserve(...args);
            if (preserved) {
                await writeText(recreated, 'prompt local recreation');
            }
            return preserved;
        };

        let result: any;
        try {
            result = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
        } finally {
            (fixture.scm as any).preserveFolderConflictLocalTree = originalPreserve;
        }

        assert.strictEqual(result.resolved, false);
        assert.strictEqual(await readText(recreated), 'prompt local recreation');
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')), false);
        const record = (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'];
        assert.ok(record);
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(
                fixture.localRoot,
                record.artifactRelPath + '/paper.pdf',
            )),
            fixture.localPdfContent,
        );
        assert.strictEqual(await readText(fixture.replacementTex), fixture.replacementTexContent);
        assert.ok((fixture.scm as any).syncConflicts.has('/chapter'));
    });

    test('keeps both recoverable trees when Overleaf advances after canonical folder installation', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-replacement-remote-advance');
        const originalRebuild = (fixture.scm as any)
            .rebuildFolderConflictCanonicalManifest.bind(fixture.scm);
        const advancedRemoteText = 'remote advanced after canonical installation';
        (fixture.scm as any).rebuildFolderConflictCanonicalManifest = async (
            ...args: unknown[]
        ) => {
            const rebuilt = await originalRebuild(...args);
            await writeText(fixture.replacementTex, advancedRemoteText);
            return rebuilt;
        };

        let result: any;
        try {
            result = await fixture.scm.resolveFolderConflictWithOverleafState(
                '/chapter',
                true,
            );
        } finally {
            (fixture.scm as any).rebuildFolderConflictCanonicalManifest = originalRebuild;
        }

        assert.strictEqual(result.resolved, false);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(fixture.localFolder, 'remote.tex')),
            fixture.replacementTexContent,
        );
        assert.strictEqual(await readText(fixture.replacementTex), advancedRemoteText);
        const record = (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'];
        assert.ok(record);
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(
                fixture.localRoot,
                record.artifactRelPath + '/paper.pdf',
            )),
            fixture.localPdfContent,
        );
        assert.ok((fixture.scm as any).syncConflicts.has('/chapter'));
        assert.strictEqual(record.phase, 'blocked');
    });

    test('applies verified Overleaf binary state locally without mutating Overleaf', async () => {
        const fixture = await createBinaryConflictFixture('keep-overleaf-binary');

        const result = await fixture.scm.resolveConflictWithOverleafState(
            '/figure.png',
            false,
        );

        assert.strictEqual(result.resolved, true);
        assert.strictEqual(result.artifactRelPath, undefined);
        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.remoteContent);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), fixture.remoteContent);
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/figure.png'), false);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.conflicts['/figure.png'],
            undefined,
        );
        assert.strictEqual(
            (fixture.scm as any).syncManifest.conflictResolutions['/figure.png'],
            undefined,
        );
        const history = (fixture.scm as any).syncManifest.conflictResolutionHistory;
        assert.strictEqual(history.at(-1).choice, 'keep-overleaf');
        assert.strictEqual(history.at(-1).outcome, 'completed');
        assert.strictEqual(history.at(-1).artifactRelPath, undefined);
    });

    test('preserves a binary local conflict copy in ignored metadata for Keep Both', async () => {
        const fixture = await createBinaryConflictFixture('keep-both-binary');

        const result = await fixture.scm.resolveConflictWithOverleafState(
            '/figure.png',
            true,
        );

        assert.strictEqual(result.resolved, true);
        assert.match(
            result.artifactRelPath!,
            /^\/\.semantic-researcher-overleaf\/conflicts\/[a-f0-9]{32}\/local\/figure\.png$/,
        );
        const artifact = uriForRelPath(fixture.localRoot, result.artifactRelPath!);
        assert.deepStrictEqual(await readBytes(artifact), fixture.localContent);
        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.remoteContent);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), fixture.remoteContent);
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(
                fixture.remoteRoot,
                REPLICA_SETTINGS_DIR,
                'conflicts',
            )),
            false,
        );
        const history = (fixture.scm as any).syncManifest.conflictResolutionHistory;
        assert.strictEqual(history.at(-1).choice, 'keep-both');
        assert.strictEqual(history.at(-1).outcome, 'completed');
        assert.strictEqual(history.at(-1).artifactRelPath, result.artifactRelPath);
    });

    test('applies a verified Overleaf binary deletion and preserves the local copy for Keep Both', async () => {
        const remoteRoot = await tempDir('sr-overleaf-keep-both-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-keep-both-delete-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const localContent = Buffer.from([4, 5, 6]);
        await writeBytes(remoteImage, Buffer.from([1, 2, 3]));
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, localContent);
        await vscode.workspace.fs.delete(remoteImage);

        const conflict = await (scm as any).applySync(
            'pull',
            'delete',
            '/figure.png',
            remoteImage,
            localImage,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflict.outcome, 'blocked');

        const result = await scm.resolveConflictWithOverleafState('/figure.png', true);

        assert.strictEqual(result.resolved, true);
        assert.ok(result.artifactRelPath);
        assert.strictEqual(await pathExists(localImage), false);
        assert.strictEqual(await pathExists(remoteImage), false);
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(localRoot, result.artifactRelPath!)),
            localContent,
        );
        assert.strictEqual((scm as any).syncConflicts.has('/figure.png'), false);
    });

    test('refuses Keep Overleaf after a same-byte local atomic recreate changes inode', async () => {
        const fixture = await createBinaryConflictFixture('keep-overleaf-inode');
        const originalWrite = (fixture.scm as any).writeLocalFileIfRevision.bind(fixture.scm);
        let injected = false;
        (fixture.scm as any).writeLocalFileIfRevision = async (
            relPath: string,
            ...args: unknown[]
        ) => {
            if (relPath==='/figure.png' && !injected) {
                injected = true;
                const replacement = vscode.Uri.joinPath(
                    fixture.localRoot,
                    'same-content-atomic-replace.tmp',
                );
                await writeBytes(replacement, fixture.localContent);
                await fs.rename(replacement.fsPath, fixture.localImage.fsPath);
            }
            return originalWrite(relPath, ...args);
        };

        const result = await fixture.scm.resolveConflictWithOverleafState(
            '/figure.png',
            false,
        );

        assert.strictEqual(injected, true);
        assert.strictEqual(result.resolved, false);
        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.localContent);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), fixture.remoteContent);
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/figure.png'), true);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.conflictResolutions['/figure.png'].phase,
            'blocked',
        );
    });

    test('blocks Keep Both before local mutation when Overleaf advances during its proof', async () => {
        const fixture = await createBinaryConflictFixture('keep-both-remote-proof');
        const secondRemote = Buffer.from([10, 11, 12]);
        const fakeVfs = (fixture.scm as any).vfs;
        const originalReconnect = fakeVfs.reconnect.bind(fakeVfs);
        let injected = false;
        fakeVfs.reconnect = async (reason?: string) => {
            if (
                !injected
                && reason==='verify remote conflict decision: /figure.png'
            ) {
                injected = true;
                await writeBytes(fixture.remoteImage, secondRemote);
            }
            return originalReconnect(reason);
        };

        const result = await fixture.scm.resolveConflictWithOverleafState(
            '/figure.png',
            true,
        );

        assert.strictEqual(injected, true);
        assert.strictEqual(result.resolved, false);
        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.localContent);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), secondRemote);
        const record = (fixture.scm as any).syncManifest.conflictResolutions['/figure.png'];
        assert.strictEqual(record.phase, 'blocked');
        assert.strictEqual(
            (fixture.scm as any).syncManifest.conflicts['/figure.png'].remoteRevision,
            sha1(secondRemote),
        );
        assert.strictEqual(
            await pathExists(uriForRelPath(fixture.localRoot, record.artifactRelPath)),
            false,
        );
    });

    test('keeps the conflict open when Overleaf advances after canonical local replacement', async () => {
        const fixture = await createBinaryConflictFixture('keep-both-final-remote-race');
        const secondRemote = Buffer.from([10, 11, 12]);
        const originalWrite = (fixture.scm as any).writeLocalFileIfRevision.bind(fixture.scm);
        let injected = false;
        (fixture.scm as any).writeLocalFileIfRevision = async (
            relPath: string,
            ...args: unknown[]
        ) => {
            const written = await originalWrite(relPath, ...args);
            if (relPath==='/figure.png' && written && !injected) {
                injected = true;
                await writeBytes(fixture.remoteImage, secondRemote);
            }
            return written;
        };

        const result = await fixture.scm.resolveConflictWithOverleafState(
            '/figure.png',
            true,
        );

        assert.strictEqual(injected, true);
        assert.strictEqual(result.resolved, false);
        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.remoteContent);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), secondRemote);
        const record = (fixture.scm as any).syncManifest.conflictResolutions['/figure.png'];
        assert.strictEqual(record.phase, 'blocked');
        assert.strictEqual(
            (fixture.scm as any).syncManifest.conflicts['/figure.png'].remoteRevision,
            sha1(secondRemote),
        );
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(fixture.localRoot, record.artifactRelPath)),
            fixture.localContent,
        );
    });

    test('recovers a local-preserved Keep Both transaction after restart', async () => {
        const fixture = await createBinaryConflictFixture('keep-both-restart');
        const originalInstall = (fixture.scm as any)
            .installConflictResolutionRemoteState.bind(fixture.scm);
        (fixture.scm as any).installConflictResolutionRemoteState = async () => false;

        try {
            await fixture.scm.resolveConflictWithOverleafState('/figure.png', true);
        } finally {
            (fixture.scm as any).installConflictResolutionRemoteState = originalInstall;
        }
        const interrupted = (fixture.scm as any).syncManifest
            .conflictResolutions['/figure.png'];
        assert.strictEqual(interrupted.phase, 'local-preserved');
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(fixture.localRoot, interrupted.artifactRelPath)),
            fixture.localContent,
        );

        await fixture.scm.deactivate();
        const restarted = createSCM(fixture.remoteRoot, fixture.localRoot);
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );

        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.remoteContent);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), fixture.remoteContent);
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(fixture.localRoot, interrupted.artifactRelPath)),
            fixture.localContent,
        );
        assert.strictEqual((restarted as any).syncConflicts.has('/figure.png'), false);
        assert.strictEqual(
            (restarted as any).syncManifest.conflictResolutions['/figure.png'],
            undefined,
        );
        const history = (restarted as any).syncManifest.conflictResolutionHistory;
        assert.strictEqual(history.at(-1).choice, 'keep-both');
        assert.strictEqual(history.at(-1).outcome, 'completed');
    });

    test('recovers Keep Both when canonical local replacement finished before its phase persisted', async () => {
        const fixture = await createBinaryConflictFixture('keep-both-canonical-write-restart');
        const originalSetPhase = (fixture.scm as any).setConflictResolutionPhase.bind(fixture.scm);
        (fixture.scm as any).setConflictResolutionPhase = (
            ...args: unknown[]
        ) => args[1]==='canonical-applied'
            ? false
            : originalSetPhase(...args);

        let result: any;
        try {
            result = await fixture.scm.resolveConflictWithOverleafState(
                '/figure.png',
                true,
            );
        } finally {
            (fixture.scm as any).setConflictResolutionPhase = originalSetPhase;
        }

        assert.strictEqual(result.resolved, false);
        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.remoteContent);
        const interrupted = (fixture.scm as any).syncManifest
            .conflictResolutions['/figure.png'];
        assert.strictEqual(interrupted.phase, 'local-preserved');
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(fixture.localRoot, interrupted.artifactRelPath)),
            fixture.localContent,
        );

        await fixture.scm.deactivate();
        const restarted = createSCM(fixture.remoteRoot, fixture.localRoot);
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.remoteContent);
        assert.strictEqual((restarted as any).syncConflicts.has('/figure.png'), false);
        assert.strictEqual(
            (restarted as any).syncManifest.conflictResolutions['/figure.png'],
            undefined,
        );
        assert.strictEqual(
            (restarted as any).syncManifest.conflictResolutionHistory.at(-1).outcome,
            'completed',
        );
    });

    test('recovers Keep Overleaf when canonical local deletion finished before its phase persisted', async () => {
        const remoteRoot = await tempDir('sr-overleaf-canonical-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-canonical-delete-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        await writeBytes(remoteImage, Buffer.from([1, 2, 3]));
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, Buffer.from([4, 5, 6]));
        await vscode.workspace.fs.delete(remoteImage);
        const conflict = await (scm as any).applySync(
            'pull',
            'delete',
            '/figure.png',
            remoteImage,
            localImage,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflict.outcome, 'blocked');

        const originalSetPhase = (scm as any).setConflictResolutionPhase.bind(scm);
        (scm as any).setConflictResolutionPhase = (...args: unknown[]) =>
            args[1]==='canonical-applied'
                ? false
                : originalSetPhase(...args);
        let result: any;
        try {
            result = await scm.resolveConflictWithOverleafState('/figure.png');
        } finally {
            (scm as any).setConflictResolutionPhase = originalSetPhase;
        }

        assert.strictEqual(result.resolved, false);
        assert.strictEqual(await pathExists(localImage), false);
        assert.strictEqual(
            (scm as any).syncManifest.conflictResolutions['/figure.png'].phase,
            'prepared',
        );

        await scm.deactivate();
        const restarted = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await pathExists(localImage), false);
        assert.strictEqual(await pathExists(remoteImage), false);
        assert.strictEqual((restarted as any).syncConflicts.has('/figure.png'), false);
        assert.strictEqual(
            (restarted as any).syncManifest.conflictResolutions['/figure.png'],
            undefined,
        );
        assert.strictEqual(
            (restarted as any).syncManifest.conflictResolutionHistory.at(-1).outcome,
            'completed',
        );
    });

    test('defers file conflict choices while a covering directory move is pending', async () => {
        const fixture = await createBinaryConflictFixture(
            'conflict-covering-directory-move',
            'dir/figure.png',
        );
        (fixture.scm as any).syncManifest.pendingOperations['/dir'] = {
            id: 'pending-directory-move',
            kind: 'directory-move',
            destinationRelPath: '/newdir',
        };

        for (const preserveLocal of [false, true]) {
            const result = await fixture.scm.resolveConflictWithOverleafState(
                fixture.relPath,
                preserveLocal,
            );
            assert.strictEqual(result.resolved, false);
        }

        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.localContent);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), fixture.remoteContent);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.conflictResolutions[fixture.relPath],
            undefined,
        );
    });

    test('defers a prepared conflict resolution when a covering directory move arrives before replacement', async () => {
        const fixture = await createBinaryConflictFixture(
            'conflict-directory-move-before-install',
            'dir/figure.png',
        );
        const originalInstall = (fixture.scm as any)
            .installConflictResolutionRemoteState.bind(fixture.scm);
        (fixture.scm as any).installConflictResolutionRemoteState = async (
            ...args: unknown[]
        ) => {
            (fixture.scm as any).syncManifest.pendingOperations['/dir'] = {
                id: 'pending-directory-move-before-install',
                kind: 'directory-move',
                destinationRelPath: '/newdir',
            };
            return originalInstall(...args);
        };

        let result: any;
        try {
            result = await fixture.scm.resolveConflictWithOverleafState(
                fixture.relPath,
                true,
            );
        } finally {
            (fixture.scm as any).installConflictResolutionRemoteState = originalInstall;
        }

        assert.strictEqual(result.resolved, false);
        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.localContent);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), fixture.remoteContent);
        const record = (fixture.scm as any).syncManifest
            .conflictResolutions[fixture.relPath];
        assert.strictEqual(record.phase, 'local-preserved');
        assert.deepStrictEqual(
            await readBytes(uriForRelPath(fixture.localRoot, record.artifactRelPath)),
            fixture.localContent,
        );
    });

    test('blocks a directory-move journal that intersects an active conflict-resolution transaction', async () => {
        const fixture = await createBinaryConflictFixture(
            'directory-move-active-resolution',
            'dir/figure.png',
        );
        const originalInstall = (fixture.scm as any)
            .installConflictResolutionRemoteState.bind(fixture.scm);
        (fixture.scm as any).installConflictResolutionRemoteState = async () => false;
        try {
            const result = await fixture.scm.resolveConflictWithOverleafState(
                fixture.relPath,
                true,
            );
            assert.strictEqual(result.resolved, false);
        } finally {
            (fixture.scm as any).installConflictResolutionRemoteState = originalInstall;
        }

        const sourceEntry = (fixture.scm as any).syncManifest.directories['/dir'];
        assert.ok(sourceEntry?.parentEntity);
        const localRevision = (await (fixture.scm as any).captureLocalPathRevision(
            '/dir',
        )).revision;
        await assert.rejects(
            () => (fixture.scm as any).journalPendingLocalDirectoryMove(
                '/dir',
                '/newdir',
                sourceEntry,
                localRevision,
                sourceEntry.parentEntity,
            ),
            /active Local Replica conflict-resolution transaction/,
        );
        assert.strictEqual(
            (fixture.scm as any).syncManifest.pendingOperations['/dir'],
            undefined,
        );
    });

    test('does not offer Keep Both when the conflicted local path is missing', async () => {
        const fixture = await createBinaryConflictFixture('keep-both-missing-local');
        await vscode.workspace.fs.delete(fixture.localImage);
        const setting = (fixture.scm as any).settingItems.find((item: any) =>
            /Resolve a Local Replica sync conflict/.test(item.label),
        );
        assert.ok(setting);

        let quickPickCount = 0;
        (vscode.window as any).showQuickPick = async (items: unknown) => {
            if (quickPickCount++===0) {
                return fixture.relPath;
            }
            assert.deepStrictEqual(
                (items as Array<{choice: string}>).map(item => item.choice),
                ['keep-local', 'keep-overleaf'],
            );
            return undefined;
        };
        await setting.callback();

        assert.strictEqual(await pathExists(fixture.localImage), false);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), fixture.remoteContent);
        assert.strictEqual((fixture.scm as any).syncConflicts.has(fixture.relPath), true);
    });

    test('leaves conflict state unchanged on resolution picker cancellation and routes Keep Both', async () => {
        const fixture = await createBinaryConflictFixture('keep-both-picker');
        const setting = (fixture.scm as any).settingItems.find((item: any) =>
            /Resolve a Local Replica sync conflict/.test(item.label),
        );
        assert.ok(setting);

        let picks: unknown[] = [undefined];
        (vscode.window as any).showQuickPick = async () => picks.shift();
        await setting.callback();
        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.localContent);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), fixture.remoteContent);
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/figure.png'), true);

        picks = ['/figure.png', undefined];
        await setting.callback();
        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.localContent);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), fixture.remoteContent);
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/figure.png'), true);

        picks = ['/figure.png', {choice: 'keep-both'}];
        (vscode.window as any).showWarningMessage = async (
            ...args: unknown[]
        ) => args.at(-1);
        (vscode.window as any).showInformationMessage = async () => undefined;
        await setting.callback();

        assert.deepStrictEqual(await readBytes(fixture.localImage), fixture.remoteContent);
        assert.deepStrictEqual(await readBytes(fixture.remoteImage), fixture.remoteContent);
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/figure.png'), false);
        const history = (fixture.scm as any).syncManifest.conflictResolutionHistory;
        assert.strictEqual(history.at(-1).choice, 'keep-both');
        assert.strictEqual(
            await pathExists(uriForRelPath(fixture.localRoot, history.at(-1).artifactRelPath)),
            true,
        );
    });


    test('offers only remote-authoritative choices and routes folder Keep Both through its tree transaction', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-picker-keep-both');
        const setting = (fixture.scm as any).settingItems.find((item: any) =>
            /Resolve a Local Replica sync conflict/.test(item.label),
        );
        assert.ok(setting);
        let pickCount = 0;
        let genericLocalCalls = 0;
        const originalGenericLocal = (fixture.scm as any).resolveConflictWithLocalState;
        (fixture.scm as any).resolveConflictWithLocalState = async () => {
            genericLocalCalls += 1;
            return false;
        };
        (vscode.window as any).showQuickPick = async (items: unknown) => {
            if (pickCount++===0) {
                assert.deepStrictEqual(items, ['/chapter']);
                return '/chapter';
            }
            const choices = items as Array<{choice: string}>;
            assert.deepStrictEqual(
                choices.map(item => item.choice),
                ['keep-overleaf', 'keep-both'],
            );
            return choices.find(item => item.choice==='keep-both');
        };
        (vscode.window as any).showWarningMessage = async (...args: unknown[]) => args.at(-1);
        (vscode.window as any).showInformationMessage = async () => undefined;
        try {
            await setting.callback();
        } finally {
            (fixture.scm as any).resolveConflictWithLocalState = originalGenericLocal;
        }

        assert.strictEqual(genericLocalCalls, 0);
        assert.strictEqual(await readText(vscode.Uri.joinPath(
            fixture.localFolder,
            'remote.tex',
        )), fixture.replacementTexContent);
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(fixture.localFolder, 'figures', 'new.png')),
            fixture.replacementImageContent,
        );
        const history = (fixture.scm as any).syncManifest.folderConflictResolutionHistory;
        assert.strictEqual(history.at(-1).choice, 'keep-both');
        assert.strictEqual(history.at(-1).outcome, 'completed');
        const artifact = uriForRelPath(fixture.localRoot, history.at(-1).artifactRelPath);
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(artifact, 'paper.pdf')),
            fixture.localPdfContent,
        );
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(artifact, 'local-only.zip')),
            fixture.localZipContent,
        );
        assert.strictEqual(await readText(fixture.replacementTex), fixture.replacementTexContent);
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/chapter'), false);
    });

    test('keeps a folder conflict unchanged on picker confirmation cancellation then routes Keep Overleaf', async () => {
        const fixture = await createFolderDeleteConflictFixture('folder-picker-keep-overleaf');
        const setting = (fixture.scm as any).settingItems.find((item: any) =>
            /Resolve a Local Replica sync conflict/.test(item.label),
        );
        assert.ok(setting);
        let confirm = false;
        let pickCount = 0;
        (vscode.window as any).showQuickPick = async (items: unknown) => {
            if (pickCount++ % 2===0) {
                assert.deepStrictEqual(items, ['/chapter']);
                return '/chapter';
            }
            const choices = items as Array<{choice: string}>;
            assert.deepStrictEqual(
                choices.map(item => item.choice),
                ['keep-overleaf', 'keep-both'],
            );
            return choices.find(item => item.choice==='keep-overleaf');
        };
        (vscode.window as any).showWarningMessage = async (...args: unknown[]) =>
            confirm ? args.at(-1) : undefined;
        (vscode.window as any).showInformationMessage = async () => undefined;

        await setting.callback();
        assert.strictEqual(await pathExists(fixture.localFolder), true);
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/chapter'), true);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'],
            undefined,
        );

        confirm = true;
        await setting.callback();
        assert.strictEqual(await pathExists(fixture.localFolder), false);
        assert.strictEqual(await pathExists(fixture.remoteFolder), false);
        const history = (fixture.scm as any).syncManifest.folderConflictResolutionHistory;
        assert.strictEqual(history.at(-1).choice, 'keep-overleaf');
        assert.strictEqual(history.at(-1).outcome, 'completed');
        const guard = uriForRelPath(fixture.localRoot, history.at(-1).guardRelPath);
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(guard, 'paper.pdf')),
            fixture.localPdfContent,
        );
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/chapter'), false);
    });

    test('offers only Keep Overleaf when a folder conflict has no local tree', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-picker-missing-local');
        await vscode.workspace.fs.delete(fixture.localFolder, {recursive: true});
        const setting = (fixture.scm as any).settingItems.find((item: any) =>
            /Resolve a Local Replica sync conflict/.test(item.label),
        );
        assert.ok(setting);
        let pickCount = 0;
        (vscode.window as any).showQuickPick = async (items: unknown) => {
            if (pickCount++===0) {
                return '/chapter';
            }
            assert.deepStrictEqual(
                (items as Array<{choice: string}>).map(item => item.choice),
                ['keep-overleaf'],
            );
            return undefined;
        };

        await setting.callback();

        assert.strictEqual(await pathExists(fixture.localFolder), false);
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/chapter'), true);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.folderConflictResolutions['/chapter'],
            undefined,
        );
    });

    test('does not classify an entirely missing file conflict as a folder choice', async () => {
        const fixture = await createBinaryConflictFixture('picker-both-missing-file');
        await vscode.workspace.fs.delete(fixture.localImage);
        await vscode.workspace.fs.delete(fixture.remoteImage);
        const remoteState = await (fixture.scm as any).captureRemotePathRevision(
            fixture.relPath,
        );
        await (fixture.scm as any).markSyncConflict(
            fixture.relPath,
            'test both-missing file conflict',
            undefined,
            undefined,
            remoteState,
        );
        const setting = (fixture.scm as any).settingItems.find((item: any) =>
            /Resolve a Local Replica sync conflict/.test(item.label),
        );
        assert.ok(setting);
        let pickCount = 0;
        (vscode.window as any).showQuickPick = async (items: unknown) => {
            if (pickCount++===0) {
                return fixture.relPath;
            }
            assert.deepStrictEqual(
                (items as Array<{choice: string}>).map(item => item.choice),
                ['keep-local', 'keep-overleaf'],
            );
            return undefined;
        };

        await setting.callback();

        assert.strictEqual(await pathExists(fixture.localImage), false);
        assert.strictEqual(await pathExists(fixture.remoteImage), false);
        assert.strictEqual((fixture.scm as any).syncConflicts.has(fixture.relPath), true);
    });

    test('refuses to present an unsafe tree choice for a file-folder type conflict', async () => {
        const fixture = await createFolderReplacementConflictFixture('folder-picker-type-conflict');
        await vscode.workspace.fs.delete(fixture.remoteFolder, {recursive: true});
        await writeText(fixture.remoteFolder, 'remote file replacement');
        const remoteState = await (fixture.scm as any).captureRemotePathRevision('/chapter');
        await (fixture.scm as any).markSyncConflict(
            '/chapter',
            'test file-folder conflict',
            undefined,
            undefined,
            remoteState,
        );
        const setting = (fixture.scm as any).settingItems.find((item: any) =>
            /Resolve a Local Replica sync conflict/.test(item.label),
        );
        assert.ok(setting);
        let warning: unknown;
        (vscode.window as any).showQuickPick = async () => '/chapter';
        (vscode.window as any).showWarningMessage = async (message: unknown) => {
            warning = message;
            return undefined;
        };

        await setting.callback();

        assert.match(String(warning), /cannot be resolved automatically/i);
        assert.strictEqual(await pathExists(fixture.localFolder), true);
        assert.strictEqual(await readText(fixture.remoteFolder), 'remote file replacement');
        assert.strictEqual((fixture.scm as any).syncConflicts.has('/chapter'), true);
    });

    test('opens a text merge preview without mutating either copy and cancel discards it', async () => {
        const fixture = await createTextConflictFixture('text-merge-preview');
        const manifestBefore = JSON.stringify((fixture.scm as any).syncManifest);
        let receiveMessage: ((message: unknown) => void) | undefined;
        let disposeListener: (() => void) | undefined;
        let disposed = false;
        const panel: any = {
            webview: {
                html: '',
                onDidReceiveMessage: (listener: (message: unknown) => void) => {
                    receiveMessage = listener;
                    return {dispose: () => undefined};
                },
            },
            onDidDispose: (listener: () => void) => {
                disposeListener = listener;
                return {dispose: () => undefined};
            },
            dispose: () => {
                if (disposed) { return; }
                disposed = true;
                disposeListener?.();
            },
        };
        (vscode.window as any).createWebviewPanel = () => panel;

        assert.strictEqual(
            await (fixture.scm as any).openTextConflictPreview(fixture.relPath),
            true,
        );
        assert.ok(panel.webview.html.includes('Base'));
        assert.ok(panel.webview.html.includes('Merged result'));
        const session = [...(fixture.scm as any).textMergePreviewSessions.values()][0];
        assert.ok(session);
        assert.strictEqual(Buffer.from(session.baseContent).toString(), fixture.baseContent);
        assert.strictEqual(Buffer.from(session.localContent).toString(), fixture.localContent);
        assert.strictEqual(Buffer.from(session.remoteContent).toString(), fixture.remoteContent);
        assert.ok(panel.webview.html.includes('\\u003c\\u003c\\u003c\\u003c\\u003c\\u003c\\u003c Local'));
        assert.ok(panel.webview.html.includes('\\u003e\\u003e\\u003e\\u003e\\u003e\\u003e\\u003e Overleaf'));
        assert.strictEqual(JSON.stringify((fixture.scm as any).syncManifest), manifestBefore);
        assert.deepStrictEqual(await readText(fixture.localFile), fixture.localContent);
        assert.deepStrictEqual(await readText(fixture.remoteFile), fixture.remoteContent);

        receiveMessage!({type: 'cancel', sessionId: session.id});
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(disposed, true);
        assert.strictEqual((fixture.scm as any).textMergePreviewSessions.size, 0);
        assert.strictEqual((fixture.scm as any).syncManifest.textMergeResolutions[fixture.relPath], undefined);
        assert.strictEqual(JSON.stringify((fixture.scm as any).syncManifest), manifestBefore);
        assert.deepStrictEqual(await readText(fixture.localFile), fixture.localContent);
        assert.deepStrictEqual(await readText(fixture.remoteFile), fixture.remoteContent);
        assert.strictEqual((fixture.scm as any).syncConflicts.has(fixture.relPath), true);
    });

    test('does not open a text merge preview while its editor is dirty', async () => {
        const fixture = await createTextConflictFixture('text-merge-dirty-before-preview');
        const document = await vscode.workspace.openTextDocument(fixture.localFile);
        const editor = await vscode.window.showTextDocument(document);
        const edited = await editor.edit(builder => {
            builder.insert(new vscode.Position(0, 0), '% unsaved merge review edit\\n');
        });
        assert.strictEqual(edited, true);
        assert.strictEqual(document.isDirty, true);

        try {
            assert.strictEqual(
                await (fixture.scm as any).createTextMergePreviewSession(
                    fixture.relPath,
                    (fixture.scm as any).syncGeneration,
                ),
                undefined,
            );
            assert.strictEqual(
                (fixture.scm as any).syncManifest.textMergeResolutions[fixture.relPath],
                undefined,
            );
            assert.strictEqual(await readText(fixture.localFile), fixture.localContent);
            assert.strictEqual(await readText(fixture.remoteFile), fixture.remoteContent);
            assert.strictEqual((fixture.scm as any).syncConflicts.has(fixture.relPath), true);
        } finally {
            if (document.isDirty) {
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }
        }
    });

    test('rejects a text merge when its editor becomes dirty after preview', async () => {
        const fixture = await createTextConflictFixture('text-merge-dirty-after-preview');
        const session = await (fixture.scm as any).createTextMergePreviewSession(
            fixture.relPath,
            (fixture.scm as any).syncGeneration,
        );
        assert.ok(session);
        (fixture.scm as any).textMergePreviewSessions.set(session.id, session);
        const document = await vscode.workspace.openTextDocument(fixture.localFile);
        const editor = await vscode.window.showTextDocument(document);
        const edited = await editor.edit(builder => {
            builder.insert(new vscode.Position(0, 0), '% unsaved merge apply edit\\n');
        });
        assert.strictEqual(edited, true);
        assert.strictEqual(document.isDirty, true);

        try {
            assert.strictEqual(
                await (fixture.scm as any).applyTextMergePreviewResult(
                    session.id,
                    Buffer.from('\\title{Merged}\\nBody: merged\\n'),
                ),
                false,
            );
            assert.strictEqual(
                (fixture.scm as any).syncManifest.textMergeResolutions[fixture.relPath],
                undefined,
            );
            assert.strictEqual(await readText(fixture.localFile), fixture.localContent);
            assert.strictEqual(await readText(fixture.remoteFile), fixture.remoteContent);
            assert.strictEqual((fixture.scm as any).syncConflicts.has(fixture.relPath), true);
        } finally {
            if (document.isDirty) {
                await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
            }
        }
    });

    test('rejects a text merge after a local inode replacement following preview', async () => {
        const fixture = await createTextConflictFixture('text-merge-local-inode');
        const session = await (fixture.scm as any).createTextMergePreviewSession(
            fixture.relPath,
            (fixture.scm as any).syncGeneration,
        );
        assert.ok(session);
        (fixture.scm as any).textMergePreviewSessions.set(session.id, session);
        const replacement = vscode.Uri.joinPath(fixture.localRoot, 'agent-replacement.tex');
        const replacementContent = '\\title{Agent replacement}\\nBody: later write\\n';
        await writeText(replacement, replacementContent);
        await vscode.workspace.fs.rename(replacement, fixture.localFile, {overwrite: true});
        const local = await (fixture.scm as any).captureStableConflictLocalState(
            fixture.relPath,
            (fixture.scm as any).syncGeneration,
        );
        assert.ok(local?.kind==='file');
        assert.notStrictEqual(local?.identity.ino, session.localIdentity.ino);

        assert.strictEqual(
            await (fixture.scm as any).applyTextMergePreviewResult(
                session.id,
                Buffer.from('\\title{Merged}\\nBody: merged\\n'),
            ),
            false,
        );
        assert.strictEqual(await readText(fixture.localFile), replacementContent);
        assert.strictEqual(await readText(fixture.remoteFile), fixture.remoteContent);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.textMergeResolutions[fixture.relPath],
            undefined,
        );
        assert.strictEqual((fixture.scm as any).syncConflicts.has(fixture.relPath), true);
    });

    test('applies an explicitly merged text result through the guarded durable path', async () => {
        const fixture = await createTextConflictFixture('text-merge-apply');
        const session = await (fixture.scm as any).createTextMergePreviewSession(
            fixture.relPath,
            (fixture.scm as any).syncGeneration,
        );
        assert.ok(session);
        (fixture.scm as any).textMergePreviewSessions.set(session.id, session);
        const merged = Buffer.from('\\title{Local}\\nBody: resolved together\\n');
        const originalWrite = fixture.fakeVfs.writeFileFromRemoteBaseline.bind(fixture.fakeVfs);
        let remoteWrites = 0;
        let expectedEntity: any;
        (fixture.fakeVfs as any).writeFileFromRemoteBaseline = async (
            ...args: unknown[]
        ) => {
            remoteWrites += 1;
            expectedEntity = args[4];
            return originalWrite(...args as [
                vscode.Uri,
                Uint8Array,
                Uint8Array | undefined,
                boolean,
                {id: string; type: 'doc' | 'file'; parentId?: string} | undefined,
            ]);
        };

        assert.strictEqual(
            await (fixture.scm as any).applyTextMergePreviewResult(session.id, merged),
            true,
        );
        assert.deepStrictEqual(await readBytes(fixture.localFile), merged);
        assert.deepStrictEqual(await readBytes(fixture.remoteFile), merged);
        assert.strictEqual(remoteWrites, 1);
        assert.strictEqual(expectedEntity.type, 'doc');
        assert.strictEqual(
            expectedEntity.id,
            (await fixture.fakeVfs._resolveUri(fixture.remoteFile)).fileEntity._id,
        );
        assert.strictEqual((fixture.scm as any).syncConflicts.has(fixture.relPath), false);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.textMergeResolutions[fixture.relPath],
            undefined,
        );
        assert.strictEqual(
            (fixture.scm as any).syncManifest.textMergeResolutionHistory.at(-1).outcome,
            'completed',
        );
        assert.strictEqual(
            (fixture.scm as any).syncManifest.files[fixture.relPath].localDigest,
            sha1(merged),
        );
    });


    test('routes a confirmed merge preview message through the durable transaction', async () => {
        const fixture = await createTextConflictFixture('text-merge-preview-message');
        const session = await (fixture.scm as any).createTextMergePreviewSession(
            fixture.relPath,
            (fixture.scm as any).syncGeneration,
        );
        assert.ok(session);
        (fixture.scm as any).textMergePreviewSessions.set(session.id, session);
        const merged = '\\title{Merged from preview}\\nBody: confirmed\\n';
        let confirmationCount = 0;
        const originalWarning = vscode.window.showWarningMessage;
        (vscode.window as any).showWarningMessage = async (...args: unknown[]) => {
            if (args.at(-1)==='Apply Merged Result') {
                confirmationCount += 1;
                return args.at(-1);
            }
            return undefined;
        };
        try {
            await (fixture.scm as any).handleTextMergePreviewMessage({
                type: 'apply',
                sessionId: session.id,
                result: merged,
            });
        } finally {
            (vscode.window as any).showWarningMessage = originalWarning;
        }

        assert.strictEqual(confirmationCount, 1);
        assert.strictEqual(await readText(fixture.localFile), merged);
        assert.strictEqual(await readText(fixture.remoteFile), merged);
        assert.strictEqual((fixture.scm as any).syncConflicts.has(fixture.relPath), false);
        assert.strictEqual((fixture.scm as any).textMergePreviewSessions.has(session.id), false);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.textMergeResolutionHistory.at(-1).outcome,
            'completed',
        );
    });

    test('rejects a text merge when a same-byte Overleaf entity replacement arrives after preview', async () => {
        const fixture = await createTextConflictFixture('text-merge-remote-identity');
        const session = await (fixture.scm as any).createTextMergePreviewSession(
            fixture.relPath,
            (fixture.scm as any).syncGeneration,
        );
        assert.ok(session);
        (fixture.scm as any).textMergePreviewSessions.set(session.id, session);
        fixture.fakeVfs.setEntityId(fixture.relPath, 'same-bytes-collaborator-document');
        const originalWrite = fixture.fakeVfs.writeFileFromRemoteBaseline.bind(fixture.fakeVfs);
        let remoteWrites = 0;
        (fixture.fakeVfs as any).writeFileFromRemoteBaseline = async (
            ...args: unknown[]
        ) => {
            remoteWrites += 1;
            return originalWrite(...args as [
                vscode.Uri,
                Uint8Array,
                Uint8Array | undefined,
                boolean,
                {id: string; type: 'doc' | 'file'; parentId?: string} | undefined,
            ]);
        };

        assert.strictEqual(
            await (fixture.scm as any).applyTextMergePreviewResult(
                session.id,
                Buffer.from('\\title{Merged}\\nBody: merged\\n'),
            ),
            false,
        );
        assert.strictEqual(remoteWrites, 0);
        assert.strictEqual(await readText(fixture.localFile), fixture.localContent);
        assert.strictEqual(await readText(fixture.remoteFile), fixture.remoteContent);
        assert.strictEqual((fixture.scm as any).syncConflicts.has(fixture.relPath), true);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.textMergeResolutions[fixture.relPath],
            undefined,
        );
    });

    test('defers a text merge when a covering directory move arrives after preview', async () => {
        const fixture = await createTextConflictFixture(
            'text-merge-directory-move',
            'dir/main.tex',
        );
        const session = await (fixture.scm as any).createTextMergePreviewSession(
            fixture.relPath,
            (fixture.scm as any).syncGeneration,
        );
        assert.ok(session);
        (fixture.scm as any).textMergePreviewSessions.set(session.id, session);
        (fixture.scm as any).syncManifest.pendingOperations['/dir'] = {
            version: 1,
            id: 'pending-text-merge-directory-move',
            kind: 'directory-move',
            destinationRelPath: '/newdir',
        };

        assert.strictEqual(
            await (fixture.scm as any).applyTextMergePreviewResult(
                session.id,
                Buffer.from('\\title{Merged}\\nBody: merged\\n'),
            ),
            false,
        );
        assert.strictEqual(await readText(fixture.localFile), fixture.localContent);
        assert.strictEqual(await readText(fixture.remoteFile), fixture.remoteContent);
        assert.strictEqual((fixture.scm as any).syncConflicts.has(fixture.relPath), true);
        assert.strictEqual(
            (fixture.scm as any).syncManifest.textMergeResolutions[fixture.relPath],
            undefined,
        );
    });


    test('recovers a text merge after the local canonical write precedes its phase persistence', async () => {
        const fixture = await createTextConflictFixture('text-merge-restart');
        const session = await (fixture.scm as any).createTextMergePreviewSession(
            fixture.relPath,
            (fixture.scm as any).syncGeneration,
        );
        assert.ok(session);
        (fixture.scm as any).textMergePreviewSessions.set(session.id, session);
        const merged = Buffer.from('\\title{Merged}\\nBody: durable result\\n');
        const originalSetPhase = (fixture.scm as any)
            .setTextMergeResolutionPhase.bind(fixture.scm);
        (fixture.scm as any).setTextMergeResolutionPhase = (
            ...args: unknown[]
        ) => args[1]==='canonical-applied'
            ? false
            : originalSetPhase(...args);
        let applied = true;
        try {
            applied = await (fixture.scm as any).applyTextMergePreviewResult(
                session.id,
                merged,
            );
        } finally {
            (fixture.scm as any).setTextMergeResolutionPhase = originalSetPhase;
        }

        assert.strictEqual(applied, false);
        assert.deepStrictEqual(await readBytes(fixture.localFile), merged);
        assert.deepStrictEqual(await readText(fixture.remoteFile), fixture.remoteContent);
        const interrupted = (fixture.scm as any).syncManifest
            .textMergeResolutions[fixture.relPath];
        assert.strictEqual(interrupted.phase, 'prepared');

        await fixture.scm.deactivate();
        const restarted = createSCM(
            fixture.remoteRoot,
            fixture.localRoot,
            new FakeVirtualFileSystem(fixture.remoteRoot),
        );
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.deepStrictEqual(await readBytes(fixture.localFile), merged);
        assert.deepStrictEqual(await readBytes(fixture.remoteFile), merged);
        assert.strictEqual((restarted as any).syncConflicts.has(fixture.relPath), false);
        assert.strictEqual(
            (restarted as any).syncManifest.textMergeResolutions[fixture.relPath],
            undefined,
        );
        assert.strictEqual(
            (restarted as any).syncManifest.textMergeResolutionHistory.at(-1).outcome,
            'completed',
        );
    });


    test('does not upload a later agent write that arrives after text merge installation', async () => {
        const fixture = await createTextConflictFixture('text-merge-agent-race');
        const session = await (fixture.scm as any).createTextMergePreviewSession(
            fixture.relPath,
            (fixture.scm as any).syncGeneration,
        );
        assert.ok(session);
        (fixture.scm as any).textMergePreviewSessions.set(session.id, session);
        const merged = Buffer.from('\\title{Merged}\\nBody: selected\\n');
        const agentContent = '\\title{Agent}\\nBody: later write\\n';
        const originalInstall = (fixture.scm as any)
            .installTextMergeCanonicalState.bind(fixture.scm);
        const originalWrite = fixture.fakeVfs.writeFileFromRemoteBaseline.bind(fixture.fakeVfs);
        let injected = false;
        let remoteWrites = 0;
        (fixture.scm as any).installTextMergeCanonicalState = async (
            ...args: unknown[]
        ) => {
            const installed = await originalInstall(...args);
            if (installed && !injected) {
                injected = true;
                await writeText(fixture.localFile, agentContent);
            }
            return installed;
        };
        (fixture.fakeVfs as any).writeFileFromRemoteBaseline = async (
            ...args: unknown[]
        ) => {
            remoteWrites += 1;
            return originalWrite(...args as [
                vscode.Uri,
                Uint8Array,
                Uint8Array | undefined,
                boolean,
                {id: string; type: 'doc' | 'file'; parentId?: string} | undefined,
            ]);
        };
        let applied: boolean;
        try {
            applied = await (fixture.scm as any).applyTextMergePreviewResult(
                session.id,
                merged,
            );
        } finally {
            (fixture.scm as any).installTextMergeCanonicalState = originalInstall;
        }

        assert.strictEqual(injected, true);
        assert.strictEqual(applied!, false);
        assert.strictEqual(remoteWrites, 0);
        assert.strictEqual(await readText(fixture.localFile), agentContent);
        assert.strictEqual(await readText(fixture.remoteFile), fixture.remoteContent);
        assert.strictEqual((fixture.scm as any).syncConflicts.has(fixture.relPath), true);
    });

    test('preserves a binary revision created after conflict proof but before upload', async () => {
        const remoteRoot = await tempDir('sr-overleaf-binary-proof-race-remote-');
        const localRoot = await tempDir('sr-overleaf-binary-proof-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        await writeBytes(remoteImage, Buffer.from([1, 2, 3]));
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeBytes(localImage, Buffer.from([4, 5, 6]));
        await writeBytes(remoteImage, Buffer.from([7, 8, 9]));
        const conflictEvent = await (scm as any).applySync(
            'pull',
            'update',
            '/figure.png',
            remoteImage,
            localImage,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflictEvent.outcome, 'blocked');

        await writeBytes(localImage, Buffer.from([10, 11, 12]));
        const collaboratorRace = Buffer.from([13, 14, 15]);
        const originalCreateFileWithRetry = (scm as any).createFileWithRetry.bind(scm);
        let injected = false;
        (scm as any).createFileWithRetry = async (...args: unknown[]) => {
            if (!injected) {
                injected = true;
                await writeBytes(remoteImage, collaboratorRace);
            }
            return originalCreateFileWithRetry(...args);
        };

        const blockedPush = await (scm as any).applySync(
            'push',
            'update',
            '/figure.png',
            localImage,
            remoteImage,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(blockedPush.outcome, 'blocked');
        assert.strictEqual(injected, true);
        assert.deepStrictEqual(await readBytes(remoteImage), collaboratorRace);
        const remoteEntries = await vscode.workspace.fs.readDirectory(remoteRoot);
        const replacementStages = remoteEntries.filter(
            ([name]) => name.startsWith('.sr-overleaf-replace-'),
        );
        assert.strictEqual(replacementStages.length, 1);
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(remoteRoot, replacementStages[0][0])),
            Buffer.from([7, 8, 9]),
        );
        assert.ok((scm as any).syncConflicts.has('/figure.png'));
        assert.strictEqual(
            (scm as any).syncManifest.conflicts['/figure.png'].remoteRevision,
            sha1(collaboratorRace),
        );
    });

    test('hydrates a proof-less conflict without treating an offline edit as reviewed resolution', async () => {
        const remoteRoot = await tempDir('sr-overleaf-legacy-conflict-proof-remote-');
        const localRoot = await tempDir('sr-overleaf-legacy-conflict-proof-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(localMain, 'legacy local conflict');
        await writeText(remoteMain, 'legacy remote conflict');
        const conflictEvent = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(conflictEvent.outcome, 'blocked');

        const manifestUri = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-manifest.json',
        );
        const legacyManifest = JSON.parse(await readText(manifestUri));
        const originalLocalDigest = legacyManifest.conflicts['/main.tex'].localDigest;
        delete legacyManifest.conflicts['/main.tex'].remoteKind;
        delete legacyManifest.conflicts['/main.tex'].remoteRevision;
        await writeText(manifestUri, JSON.stringify(legacyManifest, null, 2));

        scm.deactivate();
        await writeText(localMain, 'offline edit before remote proof hydration');
        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        const hydrated = (restartedScm as any).syncManifest.conflicts['/main.tex'];
        assert.notStrictEqual(hydrated.localDigest, originalLocalDigest);
        assert.strictEqual(
            hydrated.localDigest,
            sha1('offline edit before remote proof hydration'),
        );
        assert.strictEqual(hydrated.remoteKind, 'file');
        assert.strictEqual(hydrated.remoteRevision, sha1('legacy remote conflict'));

        const blockedOfflineEdit = await (restartedScm as any).applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(blockedOfflineEdit.outcome, 'blocked');
        assert.strictEqual(await readText(remoteMain), 'legacy remote conflict');

        await writeText(localMain, 'reviewed final local resolution');
        const resolved = await (restartedScm as any).applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(resolved.outcome, 'success');
        assert.strictEqual(await readText(remoteMain), 'reviewed final local resolution');
        assert.strictEqual((restartedScm as any).syncConflicts.size, 0);
    });

    test('never lets conflict resolution bypass a failed initial pull', async () => {
        const remoteRoot = await tempDir('sr-overleaf-failed-pull-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-failed-pull-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'remote authoritative content');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        (scm as any).failedInitialPulls.add('/main.tex');
        await (scm as any).markSyncConflict(
            '/main.tex',
            'The initial pull could not be verified',
            Buffer.from('remote authoritative content'),
        );

        await writeText(localMain, 'unverified local update');
        const updateEvent = await (scm as any).applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(updateEvent.outcome, 'blocked');
        assert.strictEqual(await readText(remoteMain), 'remote authoritative content');
        assert.strictEqual((scm as any).failedInitialPulls.has('/main.tex'), true);
        assert.ok((scm as any).syncConflicts.has('/main.tex'));

        await vscode.workspace.fs.delete(localMain);
        const deleteEvent = await (scm as any).applySync(
            'push',
            'delete',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(deleteEvent.outcome, 'blocked');
        assert.strictEqual(await readText(remoteMain), 'remote authoritative content');
        assert.strictEqual((scm as any).failedInitialPulls.has('/main.tex'), true);
        assert.ok((scm as any).syncConflicts.has('/main.tex'));
    });

    test('forces Local Replica manager initialization before completing a compile barrier', async () => {
        const localRoot = await tempDir('sr-overleaf-required-manager-local-');
        tempRoots.push(localRoot);
        const origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Required%20Manager?user=test-user&project=test-project`,
        );

        const vfs = Object.create(VirtualFileSystem.prototype) as VirtualFileSystem;
        const internals = vfs as any;
        internals.origin = origin;
        internals.disposed = false;
        let forceManagers = false;
        let flushedUris: vscode.Uri[] | undefined;
        let requiredRoot: vscode.Uri | undefined;
        internals.ensureActiveManagers = (force: boolean) => {
            forceManagers = force;
            internals.scmCollectionItem = {
                collection: {
                    flushLocalReplicaBeforeCompile: async (
                        uris: vscode.Uri[],
                        root: vscode.Uri,
                    ) => {
                        flushedUris = uris;
                        requiredRoot = root;
                    },
                },
            };
        };
        const sourceUri = vscode.Uri.joinPath(localRoot, 'main.tex');
        const originalGetOrigin = localReplicaWorkspace.getActiveReplicaOriginUri;
        const originalGetRoot = localReplicaWorkspace.getActiveReplicaRoot;
        (localReplicaWorkspace as any).getActiveReplicaOriginUri = () => origin;
        (localReplicaWorkspace as any).getActiveReplicaRoot = () => localRoot;
        try {
            await vfs.flushLocalReplicaBeforeCompile([sourceUri]);

            assert.strictEqual(forceManagers, true);
            assert.deepStrictEqual(
                flushedUris?.map(uri => uri.toString()),
                [sourceUri.toString()],
            );
            assert.strictEqual(requiredRoot?.toString(), localRoot.toString());

            internals.scmCollectionItem = undefined;
            internals.ensureActiveManagers = () => undefined;
            await assert.rejects(
                () => vfs.flushLocalReplicaBeforeCompile([sourceUri]),
                /manager is not available/i,
            );
        } finally {
            (localReplicaWorkspace as any).getActiveReplicaOriginUri = originalGetOrigin;
            (localReplicaWorkspace as any).getActiveReplicaRoot = originalGetRoot;
        }
    });

    test('restores a persisted Local Replica without remote-authoritative deletion', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-');
        const localRoot = await tempDir('sr-overleaf-local-persisted-');
        tempRoots.push(remoteRoot, localRoot);

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const firstScm = createSCM(remoteRoot, localRoot, fakeVfs);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'offline local edit');
        await writeText(vscode.Uri.joinPath(localRoot, 'local-only.tex'), 'offline local file');

        const scmKey = localRoot.toString();
        const persist: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: scmKey,
            settings: {} as JSON,
        };
        fakeVfs.setProjectSCMPersist(scmKey, persist);
        const context = createExtensionContextStub({[scmKey]: persist});
        const collection = new SCMCollectionProvider(fakeVfs as unknown as VirtualFileSystem, context);

        try {
            await (collection as any).initSCMsPromise;
            assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'offline local edit');
            assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'local-only.tex')), 'offline local file');
            assert.strictEqual(await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')), 'offline local edit');
            assert.strictEqual(await readText(vscode.Uri.joinPath(remoteRoot, 'local-only.tex')), 'offline local file');
        } finally {
            collection.dispose();
        }
    });

    test('can prepare exact-folder commands without restoring a persisted Local Replica', async () => {
        const remoteRoot = await tempDir('sr-overleaf-deferred-restore-remote-');
        const localRoot = await tempDir('sr-overleaf-deferred-restore-local-');
        tempRoots.push(remoteRoot, localRoot);

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const firstScm = createSCM(remoteRoot, localRoot, fakeVfs);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        firstScm.deactivate();
        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'offline local edit');

        const scmKey = localRoot.toString();
        const persist: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: scmKey,
            settings: {} as JSON,
        };
        fakeVfs.setProjectSCMPersist(scmKey, persist);
        const context = createExtensionContextStub({[scmKey]: persist});
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            context,
            {restorePersistedSCMs: false},
        );

        try {
            await (collection as any).initSCMsPromise;
            assert.deepStrictEqual((collection as any).scms, []);
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(localRoot, 'main.tex')),
                'offline local edit',
            );
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')),
                'remote baseline',
            );
        } finally {
            collection.dispose();
        }
    });

    test('disposes collection-owned global listeners without activating SCM commands', () => {
        const remoteRoot = vscode.Uri.file('/tmp/sr-overleaf-collection-dispose-remote');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const emitter = (EventBus as any)._eventEmitter;
        const listenersBefore = emitter.listenerCount('scmStatusChangeEvent');
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub(),
            {restorePersistedSCMs: false},
        );

        assert.strictEqual(
            emitter.listenerCount('scmStatusChangeEvent'),
            listenersBefore + 1,
        );
        collection.dispose();
        assert.strictEqual(
            emitter.listenerCount('scmStatusChangeEvent'),
            listenersBefore,
        );
    });

    test('restores a persisted Local Replica after its Overleaf project is renamed', async () => {
        const remoteRoot = await tempDir('sr-overleaf-renamed-persist-remote-');
        const localRoot = await tempDir('sr-overleaf-renamed-persist-local-');
        tempRoots.push(remoteRoot, localRoot);
        const oldProjectUri = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Old%20Name?user=user-1&project=project-1',
        );
        const renamedProjectUri = oldProjectUri.with({path: '/Renamed Project'});
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');

        const firstVfs = new FakeVirtualFileSystem(remoteRoot, oldProjectUri);
        const firstScm = createSCM(remoteRoot, localRoot, firstVfs);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(vscode.Uri.joinPath(localRoot, 'main.tex'), 'offline local edit');

        const scmKey = localRoot.toString();
        const persist: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: scmKey,
            settings: {} as JSON,
        };
        const renamedVfs = new FakeVirtualFileSystem(remoteRoot, renamedProjectUri);
        renamedVfs.setProjectSCMPersist(scmKey, persist);
        const collection = new SCMCollectionProvider(
            renamedVfs as unknown as VirtualFileSystem,
            createExtensionContextStub({[scmKey]: persist}),
        );

        try {
            await (collection as any).initSCMsPromise;
            assert.strictEqual((collection as any).scms.length, 1);
            assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'main.tex')), 'offline local edit');
            assert.strictEqual(await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')), 'offline local edit');
            const manifest = JSON.parse(await readText(
                vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR, 'sync-manifest.json'),
            ));
            assert.strictEqual(vscode.Uri.parse(manifest.projectUri).path, renamedProjectUri.path);
        } finally {
            collection.dispose();
        }
    });

    test('rejects a persisted Local Replica whose folder marker belongs to another project', async () => {
        const remoteRoot = await tempDir('sr-overleaf-persist-mismatch-remote-');
        const localRoot = await tempDir('sr-overleaf-persist-mismatch-local-');
        const otherRemoteRoot = await tempDir('sr-overleaf-persist-mismatch-other-');
        tempRoots.push(remoteRoot, localRoot, otherRemoteRoot);
        await writeReplicaSettings(localRoot, otherRemoteRoot);
        await writeText(vscode.Uri.joinPath(localRoot, 'local-only.tex'), 'must stay local');

        const scmKey = localRoot.toString();
        const persist: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: scmKey,
            settings: {} as JSON,
        };
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setProjectSCMPersist(scmKey, persist);
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub({[scmKey]: persist}),
        );

        try {
            await (collection as any).initSCMsPromise;
            assert.strictEqual((collection as any).scms.length, 0);
            assert.strictEqual(fakeVfs.hasProjectSCMPersist(scmKey), false);
            assert.strictEqual(await readText(vscode.Uri.joinPath(localRoot, 'local-only.tex')), 'must stay local');
        } finally {
            collection.dispose();
        }
    });

    test('retains a persisted Local Replica when its marker is temporarily unreadable', async () => {
        const remoteRoot = await tempDir('sr-overleaf-persist-unavailable-remote-');
        tempRoots.push(remoteRoot);
        const unavailableScheme = 'sr-overleaf-unavailable';
        const localRoot = vscode.Uri.parse(`${unavailableScheme}:/replica`);
        const fileChangeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
        const unavailable = () => {
            throw vscode.FileSystemError.Unavailable('simulated unavailable mount');
        };
        const unavailableProvider: vscode.FileSystemProvider = {
            onDidChangeFile: fileChangeEmitter.event,
            watch: () => new vscode.Disposable(() => undefined),
            stat: unavailable,
            readDirectory: unavailable,
            createDirectory: unavailable,
            readFile: unavailable,
            writeFile: unavailable,
            delete: unavailable,
            rename: unavailable,
        };
        const providerRegistration = vscode.workspace.registerFileSystemProvider(
            unavailableScheme,
            unavailableProvider,
            {isCaseSensitive: true},
        );

        const scmKey = localRoot.toString();
        const persist: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: scmKey,
            settings: {} as JSON,
        };
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setProjectSCMPersist(scmKey, persist);
        let warning = '';
        (vscode.window as any).showWarningMessage = async (message: string) => {
            warning = message;
            return undefined;
        };
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub({[scmKey]: persist}),
        );

        try {
            await (collection as any).initSCMsPromise;
            assert.strictEqual((collection as any).scms.length, 0);
            assert.strictEqual(fakeVfs.hasProjectSCMPersist(scmKey), true);
            assert.match(warning, /temporarily unavailable/i);
        } finally {
            collection.dispose();
            providerRegistration.dispose();
            fileChangeEmitter.dispose();
        }
    });

    test('does not create an SCM after disposal during a slow marker inspection', async () => {
        const remoteRoot = await tempDir('sr-overleaf-dispose-marker-remote-');
        const localRoot = await tempDir('sr-overleaf-dispose-marker-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeReplicaSettings(localRoot, remoteRoot);
        const scmKey = localRoot.toString();
        const persist: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: scmKey,
            settings: {} as JSON,
        };
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setProjectSCMPersist(scmKey, persist);
        const originalInspect = (localReplicaWorkspace as any).inspectReplicaSettingsSnapshot;
        let releaseInspection!: () => void;
        const inspectionPaused = new Promise<void>(resolve => {
            releaseInspection = resolve;
        });
        let signalInspectionStarted!: () => void;
        const inspectionStarted = new Promise<void>(resolve => {
            signalInspectionStarted = resolve;
        });
        (localReplicaWorkspace as any).inspectReplicaSettingsSnapshot = async (
            baseUri: vscode.Uri,
        ) => {
            signalInspectionStarted();
            await inspectionPaused;
            return originalInspect(baseUri);
        };
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub({[scmKey]: persist}),
        );

        try {
            await inspectionStarted;
            collection.dispose();
            releaseInspection();
            await (collection as any).initSCMsPromise;
            assert.strictEqual((collection as any).scms.length, 0);
            assert.strictEqual((collection as any).pendingSCMInstances.size, 0);
        } finally {
            releaseInspection();
            (localReplicaWorkspace as any).inspectReplicaSettingsSnapshot = originalInspect;
            collection.dispose();
        }
    });

    test('keeps only the active valid Local Replica when persisted mappings are duplicated', async () => {
        const remoteRoot = await tempDir('sr-overleaf-persist-duplicate-remote-');
        const localRootA = await tempDir('sr-overleaf-persist-duplicate-a-');
        const localRootB = await tempDir('sr-overleaf-persist-duplicate-b-');
        tempRoots.push(remoteRoot, localRootA, localRootB);
        await writeReplicaSettings(localRootA, remoteRoot);
        await writeReplicaSettings(localRootB, remoteRoot);
        await setActiveReplicaRoot(localRootB);

        const persistA: PersistRecord = {
            enabled: true,
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
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setProjectSCMPersist(localRootA.toString(), persistA);
        fakeVfs.setProjectSCMPersist(localRootB.toString(), persistB);
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub({
                [localRootA.toString()]: persistA,
                [localRootB.toString()]: persistB,
            }),
        );

        try {
            await (collection as any).initSCMsPromise;
            const records = (collection as any).scms as Array<{scm: LocalReplicaSCMProvider}>;
            assert.strictEqual(records.length, 1);
            assert.strictEqual(records[0].scm.baseUri.toString(), localRootB.toString());
            assert.strictEqual(fakeVfs.hasProjectSCMPersist(localRootA.toString()), false);
            assert.strictEqual(fakeVfs.hasProjectSCMPersist(localRootB.toString()), true);
        } finally {
            collection.dispose();
            await setActiveReplicaRoot(undefined);
        }
    });

    test('does not re-enable a disabled persisted Local Replica during ensure', async () => {
        const remoteRoot = await tempDir('sr-overleaf-persist-disabled-remote-');
        const localRoot = await tempDir('sr-overleaf-persist-disabled-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeReplicaSettings(localRoot, remoteRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');

        const scmKey = localRoot.toString();
        const persist: PersistRecord = {
            enabled: false,
            label: LocalReplicaSCMProvider.label,
            baseUri: scmKey,
            settings: {} as JSON,
        };
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setProjectSCMPersist(scmKey, persist);
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub({[scmKey]: persist}),
        );

        try {
            await (collection as any).initSCMsPromise;
            const ensured = await (collection as any).ensureLocalReplicaSCM(localRoot);
            const record = (collection as any).scms[0];
            assert.strictEqual(ensured, record.scm);
            assert.strictEqual(record.enabled, false);
            assert.deepStrictEqual(record.triggers, []);
            assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, 'main.tex')), false);
        } finally {
            collection.dispose();
        }
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
        let activationOptions: unknown;

        (vscode.commands as any).executeCommand = async (
            command: string,
            arg?: unknown,
            options?: unknown,
        ) => {
            calls.push(command);
            if (command===`${ROOT_NAME}.remoteFileSystem.activateProject`) {
                assert.strictEqual((arg as vscode.Uri).toString(), projectUri.toString());
                activationOptions = options;
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
        assert.deepStrictEqual(activationOptions, {restorePersistedSCMs: false});
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

    test('stops an active Local Replica SCM before removing its persisted mapping', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remove-scm-remote-');
        const localRoot = await tempDir('sr-overleaf-remove-scm-local-');
        tempRoots.push(remoteRoot, localRoot);
        const scm = createSCM(remoteRoot, localRoot);
        const collection = Object.create(
            SCMCollectionProvider.prototype,
        ) as SCMCollectionProvider;
        const internals = collection as any;
        let prepareRemovalCount = 0;
        let finishRemovalCount = 0;
        let triggerDisposeCount = 0;
        const removedKeys: string[] = [];
        (scm as any).prepareRemovalAndHoldOwnership = async () => {
            prepareRemovalCount += 1;
        };
        (scm as any).finishRemoval = async () => {
            finishRemovalCount += 1;
        };
        internals.pendingSCMInstances = new Set();
        internals.pendingSCMs = new Map();
        internals.initSCMsPromise = Promise.resolve();
        internals.disposed = false;
        internals.scms = [{
            scm,
            enabled: true,
            triggers: [{
                dispose: () => {
                    triggerDisposeCount += 1;
                },
            }],
        }];
        internals.vfs = {
            origin: remoteRoot,
            setProjectSCMPersist: async (key: string, persist: unknown) => {
                assert.strictEqual(persist, undefined);
                removedKeys.push(key);
            },
        };
        internals.updateStatus = () => undefined;

        await collection.removeLocalReplicaSCM(scm.scmKey, localRoot);

        assert.strictEqual(prepareRemovalCount, 1);
        assert.strictEqual(finishRemovalCount, 1);
        assert.strictEqual(triggerDisposeCount, 1);
        assert.deepStrictEqual(removedKeys, [scm.scmKey]);
        assert.strictEqual(internals.scms.length, 0);
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(localRoot, REPLICA_REMOVAL_TOMBSTONE_FILE)),
            true,
        );
    });

    test('rejects a Local Replica folder owned by another extension host', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const contender = createSCM(remoteRoot, localRoot);
        const rootKey = await (contender as any).syncOwnerRootKey();
        const hostId = await (contender as any).syncOwnerHostId();
        const port = (contender as any).syncOwnerPorts(rootKey)[0];
        const ownerRecord = {
            version: 4,
            token: '0123456789abcdef0123456789abcdef',
            pid: process.pid,
            hostname: os.hostname(),
            hostId,
            projectKey: remoteRoot.toString(),
            rootKey,
            port,
            createdAt: new Date().toISOString(),
        };
        const ownerFile = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner.json',
        );
        await vscode.workspace.fs.createDirectory(
            vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR),
        );
        await writeText(ownerFile, JSON.stringify(ownerRecord));
        const ownerServer = net.createServer(socket => {
            socket.end(JSON.stringify(ownerRecord));
        });
        ownerServer.unref();
        await new Promise<void>((resolve, reject) => {
            ownerServer.once('error', reject);
            ownerServer.listen({host: '127.0.0.1', port, exclusive: true}, resolve);
        });
        try {
            await assert.rejects(
                () => contender.triggers,
                /already active.*process|already active.*VS Code window/i,
            );
            assert.strictEqual(await pathExists(ownerFile), true);
        } finally {
            await new Promise<void>((resolve, reject) => {
                ownerServer.close(error => error ? reject(error) : resolve());
            });
        }
    });

    test('does not reclaim a foreign-host owner after an old heartbeat', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-foreign-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-foreign-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const contender = createSCM(remoteRoot, localRoot);
        const rootKey = await (contender as any).syncOwnerRootKey();
        const ownerFile = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner.json',
        );
        await vscode.workspace.fs.createDirectory(
            vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR),
        );
        await writeText(ownerFile, JSON.stringify({
            version: 4,
            token: '1123456789abcdef0123456789abcdef',
            pid: 1,
            hostname: os.hostname(),
            hostId: crypto.createHash('sha256').update('foreign-host').digest('hex'),
            projectKey: remoteRoot.toString(),
            rootKey,
            port: (contender as any).syncOwnerPorts(rootKey)[0],
            createdAt: '2000-01-01T00:00:00.000Z',
        }));
        await fs.utimes(ownerFile.fsPath, new Date(0), new Date(0));

        await assert.rejects(
            () => contender.triggers,
            /Cross-host stale takeover is disabled/i,
        );
        assert.strictEqual(await pathExists(ownerFile), true);
    });

    test('does not delete an incomplete ownership marker while activation is uncertain', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-incomplete-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-incomplete-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const ownerFile = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner.json',
        );
        await vscode.workspace.fs.createDirectory(
            vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR),
        );
        await writeText(ownerFile, '{"version":');
        const contender = createSCM(remoteRoot, localRoot);

        await assert.rejects(
            () => contender.triggers,
            /incomplete ownership marker/i,
        );
        assert.strictEqual(await pathExists(ownerFile), true);
    });

    test('does not replace a marker created immediately before atomic ownership publish', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-publish-race-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-publish-race-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const contender = createSCM(remoteRoot, localRoot);
        const internals = contender as any;
        const ownerFile = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner.json',
        );
        const originalInstall = internals.installSyncOwnerClaim.bind(contender);
        let injected = false;
        internals.installSyncOwnerClaim = async (claimPath: string) => {
            if (!injected) {
                injected = true;
                await writeText(ownerFile, '{"incomplete":true}');
            }
            await originalInstall(claimPath);
        };

        await assert.rejects(
            () => contender.triggers,
            /incomplete ownership marker/i,
        );
        assert.strictEqual(await readText(ownerFile), '{"incomplete":true}');
        assert.strictEqual(internals.syncOwnerToken, undefined);
        assert.strictEqual(internals.syncOwnerServer, undefined);
    });

    test('repairs an incomplete ownership marker only after explicit confirmation', async () => {
        const localRoot = await tempDir('sr-overleaf-owner-repair-local-');
        tempRoots.push(localRoot);
        const ownerFile = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner.json',
        );
        await vscode.workspace.fs.createDirectory(
            vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR),
        );
        await writeText(ownerFile, '{"token":');
        (vscode.window as any).showWarningMessage = async (
            _message: string,
            _options: unknown,
            ...items: string[]
        ) => items[0];
        (vscode.window as any).showInformationMessage = async () => undefined;

        assert.strictEqual(
            await LocalReplicaSCMProvider.repairOwnershipMarker(localRoot),
            true,
        );
        assert.strictEqual(await pathExists(ownerFile), false);
    });

    test('runs concurrent Local Replica trigger requests as one activation', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-single-flight-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-single-flight-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        const internals = scm as any;
        const originalInitWatch = internals.initWatch.bind(scm);
        let releaseActivation!: () => void;
        const activationGate = new Promise<void>(resolve => {
            releaseActivation = resolve;
        });
        let activationCount = 0;
        internals.initWatch = async () => {
            activationCount += 1;
            await activationGate;
            return originalInitWatch();
        };

        const first = scm.triggers;
        const second = scm.triggers;
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.strictEqual(activationCount, 1);
        releaseActivation();
        const [firstTriggers, secondTriggers] = await Promise.all([first, second]);

        assert.strictEqual(firstTriggers, secondTriggers);
        assert.strictEqual(activationCount, 1);
        await scm.deactivate();
    });

    test('recovers a same-host repair lock left by a crashed process', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-repair-crash-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-repair-crash-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        const repairFile = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner.repair.json',
        );
        await writeText(repairFile, JSON.stringify({
            version: 2,
            token: '5123456789abcdef0123456789abcdef',
            pid: 2_147_483_647,
            hostname: os.hostname(),
            hostId: await (scm as any).syncOwnerHostId(),
            createdAt: new Date().toISOString(),
        }));

        await scm.triggers;

        assert.strictEqual(await pathExists(repairFile), false);
        assert.ok((scm as any).syncOwnerToken);
        await scm.deactivate();
    });

    test('resumes repair after a crash quarantined an invalid owner marker', async () => {
        const localRoot = await tempDir('sr-overleaf-owner-repair-quarantine-');
        tempRoots.push(localRoot);
        const settingsDirectory = vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR);
        const quarantinedOwner = vscode.Uri.joinPath(
            settingsDirectory,
            'sync-owner.json.repair-crashed',
        );
        const repairFile = vscode.Uri.joinPath(
            settingsDirectory,
            'sync-owner.repair.json',
        );
        const hostId = await (createSCM(localRoot, localRoot) as any).syncOwnerHostId();
        await writeText(quarantinedOwner, '{"invalid":true}');
        await writeText(repairFile, JSON.stringify({
            version: 2,
            token: '6123456789abcdef0123456789abcdef',
            pid: 2_147_483_647,
            hostname: os.hostname(),
            hostId,
            createdAt: new Date().toISOString(),
        }));
        (vscode.window as any).showWarningMessage = async (
            _message: string,
            _options: unknown,
            ...items: string[]
        ) => items[0];
        (vscode.window as any).showInformationMessage = async () => undefined;

        assert.strictEqual(
            await LocalReplicaSCMProvider.repairOwnershipMarker(localRoot),
            true,
        );
        assert.strictEqual(await pathExists(repairFile), false);
        assert.strictEqual(await pathExists(quarantinedOwner), false);
    });

    test('repairs a valid v3 owner only when its same-host process is dead', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-v3-repair-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-v3-repair-local-');
        tempRoots.push(remoteRoot, localRoot);
        const scm = createSCM(remoteRoot, localRoot);
        const legacyOwnerDirectory = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner',
        );
        const legacyOwnerFile = vscode.Uri.joinPath(legacyOwnerDirectory, 'owner.json');
        const rootKey = await (scm as any).syncOwnerRootKey();
        await writeText(legacyOwnerFile, JSON.stringify({
            version: 3,
            token: '7123456789abcdef0123456789abcdef',
            pid: 2_147_483_647,
            hostname: os.hostname(),
            hostId: await (scm as any).syncOwnerHostId(),
            projectKey: remoteRoot.toString(),
            rootKey,
            port: (scm as any).syncOwnerPorts(rootKey)[0],
            createdAt: new Date().toISOString(),
        }));
        (vscode.window as any).showWarningMessage = async (
            _message: string,
            _options: unknown,
            ...items: string[]
        ) => items[0];
        (vscode.window as any).showInformationMessage = async () => undefined;

        assert.strictEqual(
            await LocalReplicaSCMProvider.repairOwnershipMarker(localRoot),
            true,
        );
        assert.strictEqual(await pathExists(legacyOwnerDirectory), false);
    });

    test('holds ownership through durable mapping removal and blocks revival', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-remove-hold-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-remove-hold-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const owner = createSCM(remoteRoot, localRoot);
        await owner.triggers;
        await owner.prepareRemovalAndHoldOwnership();

        const waiting = createSCM(remoteRoot, localRoot);
        await assert.rejects(
            () => waiting.triggers,
            /removal is holding folder ownership/i,
        );
        await localReplicaWorkspace.writeReplicaRemovalTombstone(localRoot, remoteRoot);
        await owner.finishRemoval();

        const late = createSCM(remoteRoot, localRoot);
        await assert.rejects(
            () => late.triggers,
            /mapping was removed/i,
        );
        assert.strictEqual(
            await localReplicaWorkspace.hasReplicaRemovalTombstone(localRoot, remoteRoot),
            true,
        );
        await localReplicaWorkspace.clearReplicaRemovalTombstone(localRoot);
    });

    test('clears a removal tombstone only after explicit Select owns the folder', async () => {
        const remoteRoot = await tempDir('sr-overleaf-select-remove-race-remote-');
        const localRoot = await tempDir('sr-overleaf-select-remove-race-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        await writeReplicaSettings(localRoot, remoteRoot);
        const remover = createSCM(remoteRoot, localRoot);
        await remover.triggers;
        await remover.prepareRemovalAndHoldOwnership();
        await localReplicaWorkspace.writeReplicaRemovalTombstone(localRoot, remoteRoot);

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub(),
            {restorePersistedSCMs: false},
        );
        (collection as any).promptBaseUri = async () => localRoot.fsPath;
        try {
            assert.strictEqual(
                await (collection as any).createNewExactLocalReplicaSCM(),
                undefined,
            );
            assert.strictEqual(
                await localReplicaWorkspace.hasReplicaRemovalTombstone(
                    localRoot,
                    remoteRoot,
                ),
                true,
            );
            assert.strictEqual(
                fakeVfs.hasProjectSCMPersist(localRoot.toString()),
                false,
            );

            await remover.finishRemoval();
            const selected = await (collection as any).createNewExactLocalReplicaSCM() as
                LocalReplicaSCMProvider;
            assert.ok(selected);
            assert.strictEqual(
                await localReplicaWorkspace.hasReplicaRemovalTombstone(
                    localRoot,
                    remoteRoot,
                ),
                false,
            );
            assert.strictEqual(
                fakeVfs.hasProjectSCMPersist(localRoot.toString()),
                true,
            );
            assert.ok((selected as any).syncOwnerToken);
        } finally {
            await remover.finishRemoval();
            collection.dispose();
        }
    });

    test('keeps explicit Select disconnected when durable mapping persistence fails', async () => {
        const remoteRoot = await tempDir('sr-overleaf-select-persist-fail-remote-');
        const localRoot = await tempDir('sr-overleaf-select-persist-fail-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        await writeReplicaSettings(localRoot, remoteRoot);
        await localReplicaWorkspace.writeReplicaRemovalTombstone(localRoot, remoteRoot);

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const originalSetPersist = fakeVfs.setProjectSCMPersist.bind(fakeVfs);
        let failedCreationPersist = false;
        (fakeVfs as any).setProjectSCMPersist = async (
            key: string,
            persist?: PersistRecord,
        ) => {
            if (persist!==undefined && !failedCreationPersist) {
                failedCreationPersist = true;
                await Promise.resolve();
                throw new Error('simulated durable mapping write failure');
            }
            originalSetPersist(key, persist);
        };
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub(),
            {restorePersistedSCMs: false},
        );
        (collection as any).promptBaseUri = async () => localRoot.fsPath;

        try {
            assert.strictEqual(
                await (collection as any).createNewExactLocalReplicaSCM(),
                undefined,
            );
            assert.strictEqual(failedCreationPersist, true);
            assert.strictEqual(
                fakeVfs.hasProjectSCMPersist(localRoot.toString()),
                false,
            );
            assert.strictEqual(
                await localReplicaWorkspace.hasReplicaRemovalTombstone(
                    localRoot,
                    remoteRoot,
                ),
                true,
            );
            assert.strictEqual(
                await pathExists(vscode.Uri.joinPath(
                    localRoot,
                    REPLICA_SETTINGS_DIR,
                    'sync-owner.json',
                )),
                false,
            );
        } finally {
            collection.dispose();
        }
    });

    test('keeps a removal tombstone effective after the replica folder moves', async () => {
        const localRoot = await tempDir('sr-overleaf-remove-move-');
        const movedRoot = vscode.Uri.file(`${localRoot.fsPath}-moved`);
        tempRoots.push(localRoot, movedRoot);
        const projectUri = vscode.Uri.parse(
            `${ROOT_NAME}://test-server/Move%20Tombstone` +
            '?user=test-user&project=move-tombstone',
        );
        await writeReplicaSettings(localRoot, projectUri);
        await localReplicaWorkspace.writeReplicaRemovalTombstone(localRoot, projectUri);
        await vscode.workspace.fs.rename(localRoot, movedRoot, {overwrite: false});

        assert.strictEqual(
            await localReplicaWorkspace.hasReplicaRemovalTombstone(movedRoot, projectUri),
            true,
        );
        assert.strictEqual(await setActiveReplicaRoot(movedRoot), undefined);
        assert.strictEqual(getActiveReplicaRoot(), undefined);
        setWorkspaceFoldersForTest(movedRoot);
        await localReplicaWorkspace.initializeLocalReplicaWorkspace();
        assert.strictEqual(getActiveReplicaRoot(), undefined);

        await localReplicaWorkspace.clearReplicaRemovalTombstone(movedRoot);
        assert.strictEqual(
            await localReplicaWorkspace.hasReplicaRemovalTombstone(movedRoot, projectUri),
            false,
        );
    });

    test('fails closed for malformed and schema-invalid removal tombstones', async () => {
        for (const [label, content] of [
            ['malformed', '{"version":'],
            ['wrong-schema', '{"version":2,"removed":true}'],
        ]) {
            const remoteRoot = await tempDir(`sr-overleaf-remove-${label}-remote-`);
            const localRoot = await tempDir(`sr-overleaf-remove-${label}-local-`);
            tempRoots.push(remoteRoot, localRoot);
            await writeReplicaSettings(localRoot, remoteRoot);
            await writeText(
                vscode.Uri.joinPath(localRoot, REPLICA_REMOVAL_TOMBSTONE_FILE),
                content,
            );

            assert.strictEqual(
                await localReplicaWorkspace.hasReplicaRemovalTombstone(
                    localRoot,
                    remoteRoot,
                ),
                true,
            );
            const scm = createSCM(remoteRoot, localRoot);
            await assert.rejects(
                () => scm.triggers,
                /mapping was removed/i,
            );
            assert.strictEqual(await setActiveReplicaRoot(localRoot), undefined);
            assert.strictEqual(getActiveReplicaRoot(), undefined);
            await localReplicaWorkspace.clearReplicaRemovalTombstone(localRoot);
        }
    });

    test('writes a private atomic removal tombstone without leftover claims', async () => {
        const localRoot = await tempDir('sr-overleaf-remove-durable-');
        tempRoots.push(localRoot);
        const projectUri = vscode.Uri.parse(
            `${ROOT_NAME}://test-server/Durable%20Tombstone` +
            '?user=test-user&project=durable-tombstone',
        );

        await localReplicaWorkspace.writeReplicaRemovalTombstone(localRoot, projectUri);

        const tombstoneUri = vscode.Uri.joinPath(
            localRoot,
            REPLICA_REMOVAL_TOMBSTONE_FILE,
        );
        const tombstone = JSON.parse(await readText(tombstoneUri));
        const stat = await fs.stat(tombstoneUri.fsPath);
        const metadataEntries = await vscode.workspace.fs.readDirectory(
            vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR),
        );
        assert.strictEqual(tombstone.version, 1);
        assert.strictEqual(tombstone.rootUri, localRoot.toString());
        assert.strictEqual(stat.mode & 0o077, 0);
        assert.deepStrictEqual(
            metadataEntries
                .map(([name]) => name)
                .filter(name => name.startsWith('removed.json.claim-')),
            [],
        );
    });

    test('does not repair a valid owner that appears during confirmation', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-repair-race-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-repair-race-local-');
        tempRoots.push(remoteRoot, localRoot);
        const contender = createSCM(remoteRoot, localRoot);
        const rootKey = await (contender as any).syncOwnerRootKey();
        const ownerFile = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner.json',
        );
        await writeText(ownerFile, '{"invalid":true}');
        const ownerRecord = {
            version: 4,
            token: '3123456789abcdef0123456789abcdef',
            pid: process.pid,
            hostname: os.hostname(),
            hostId: await (contender as any).syncOwnerHostId(),
            projectKey: remoteRoot.toString(),
            rootKey,
            port: (contender as any).syncOwnerPorts(rootKey)[0],
            createdAt: new Date().toISOString(),
        };
        (vscode.window as any).showWarningMessage = async (
            _message: string,
            _options: unknown,
            ...items: string[]
        ) => {
            await writeText(ownerFile, JSON.stringify(ownerRecord));
            return items[0];
        };

        await assert.rejects(
            () => LocalReplicaSCMProvider.repairOwnershipMarker(localRoot),
            /changed during confirmation/i,
        );
        assert.deepStrictEqual(JSON.parse(await readText(ownerFile)), ownerRecord);
    });

    test('closes the ownership server even when failed claim cleanup also fails', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-cleanup-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-cleanup-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const contender = createSCM(remoteRoot, localRoot);
        const internals = contender as any;
        const originalClose = internals.closeSyncOwnerServer.bind(contender);
        let closeCount = 0;
        internals.installSyncOwnerClaim = async () => {
            throw new Error('simulated ownership install failure');
        };
        internals.cleanupSyncOwnerClaim = async () => {
            throw new Error('simulated claim cleanup failure');
        };
        internals.closeSyncOwnerServer = async (server: net.Server) => {
            closeCount += 1;
            await originalClose(server);
        };

        await assert.rejects(
            () => contender.triggers,
            /simulated ownership install failure/i,
        );
        assert.strictEqual(closeCount, 1);
        assert.strictEqual(internals.syncOwnerToken, undefined);
        assert.strictEqual(internals.syncOwnerServer, undefined);
    });

    test('falls back when an unrelated local service occupies the first ownership port', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-port-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-port-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        const rootKey = await (scm as any).syncOwnerRootKey();
        const firstPort = (scm as any).syncOwnerPorts(rootKey)[0];
        const unrelatedServer = net.createServer(socket => {
            socket.end('unrelated service');
        });
        unrelatedServer.unref();
        await new Promise<void>((resolve, reject) => {
            unrelatedServer.once('error', reject);
            unrelatedServer.listen({
                host: '127.0.0.1',
                port: firstPort,
                exclusive: true,
            }, resolve);
        });
        try {
            await scm.triggers;
            const owner = JSON.parse(await readText(vscode.Uri.joinPath(
                localRoot,
                REPLICA_SETTINGS_DIR,
                'sync-owner.json',
            )));
            assert.notStrictEqual(owner.port, firstPort);
        } finally {
            await scm.deactivate();
            await new Promise<void>((resolve, reject) => {
                unrelatedServer.close(error => error ? reject(error) : resolve());
            });
        }
    });

    test('drains old in-flight sync work before a same-process ownership handoff', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-handoff-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-handoff-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const first = createSCM(remoteRoot, localRoot);
        await first.triggers;

        let releaseOldOperation!: () => void;
        const oldOperation = new Promise<void>(resolve => {
            releaseOldOperation = resolve;
        });
        const firstInternals = first as any;
        firstInternals.inFlightSessionIO.add(oldOperation);
        void oldOperation.finally(() => {
            firstInternals.inFlightSessionIO.delete(oldOperation);
        });

        const successor = createSCM(remoteRoot, localRoot);
        let successorActivated = false;
        const successorActivation = successor.triggers.then(value => {
            successorActivated = true;
            return value;
        });
        await new Promise(resolve => setTimeout(resolve, 75));
        assert.strictEqual(successorActivated, false);

        releaseOldOperation();
        await successorActivation;
        assert.strictEqual(firstInternals.syncOwnerToken, undefined);
        assert.ok((successor as any).syncOwnerToken);
    });

    test('can retry ownership release after a transient release failure', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-release-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-release-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.triggers;
        const internals = scm as any;
        const originalRelease = internals.releaseSyncOwnershipNow.bind(scm);
        let failRelease = true;
        internals.releaseSyncOwnershipNow = async () => {
            if (failRelease) {
                const server = internals.syncOwnerServer;
                await internals.closeSyncOwnerServer(server);
                internals.syncOwnerServer = undefined;
                throw new Error('simulated ownership release failure');
            }
            await originalRelease();
        };

        await assert.rejects(
            () => scm.deactivate(),
            /simulated ownership release failure/i,
        );
        assert.ok(internals.syncOwnerToken);
        assert.strictEqual(internals.syncOwnerServer, undefined);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner.json',
        )), true);
        await assert.rejects(
            () => internals.beginSyncSession(),
            /ownership release is incomplete/i,
        );

        failRelease = false;
        await scm.deactivate();
        assert.strictEqual(internals.syncOwnerToken, undefined);
        assert.strictEqual(internals.syncOwnerServer, undefined);
    });

    test('reacquires ownership before removal preflights journals after a release', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-remove-release-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-remove-release-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.triggers;
        const internals = scm as any;
        const originalRemoveLock = internals.removeOwnedSyncOwnerLock.bind(scm);
        const originalAcquire = internals.acquireSyncOwnership.bind(scm);
        let releaseStarted!: () => void;
        const releaseAtFence = new Promise<void>(resolve => {
            releaseStarted = resolve;
        });
        let continueRelease!: () => void;
        const releaseGate = new Promise<void>(resolve => {
            continueRelease = resolve;
        });
        let gateFirstRelease = true;
        internals.removeOwnedSyncOwnerLock = async (token: string) => {
            if (gateFirstRelease) {
                gateFirstRelease = false;
                releaseStarted();
                await releaseGate;
            }
            return originalRemoveLock(token);
        };
        let acquireCount = 0;
        internals.acquireSyncOwnership = async () => {
            acquireCount += 1;
            await originalAcquire();
        };
        let preflightOwned = false;
        internals.listLocalOperationRecords = async () => {
            preflightOwned = Boolean(
                internals.syncOwnerToken
                && internals.syncOwnerServer?.listening
            );
            return [];
        };
        internals.listRemoteDeleteOperationRecords = async () => [];

        const release = scm.deactivate();
        await releaseAtFence;
        const removal = scm.deactivateAndDrain();
        continueRelease();
        await release;
        await removal;

        assert.strictEqual(acquireCount, 1);
        assert.strictEqual(preflightOwned, true);
        assert.strictEqual(internals.syncOwnerToken, undefined);
    });

    test('does not deadlock removal that starts during ownership activation', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-activation-remove-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-activation-remove-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const scm = createSCM(remoteRoot, localRoot);
        const internals = scm as any;
        const originalAcquire = internals.acquireSyncOwnership.bind(scm);
        let signalOwnershipAcquired!: () => void;
        const ownershipAcquired = new Promise<void>(resolve => {
            signalOwnershipAcquired = resolve;
        });
        let continueActivation!: () => void;
        const activationGate = new Promise<void>(resolve => {
            continueActivation = resolve;
        });
        internals.acquireSyncOwnership = async () => {
            await originalAcquire();
            signalOwnershipAcquired();
            await activationGate;
        };

        const activation = scm.triggers;
        await ownershipAcquired;
        const removal = scm.deactivateAndDrain();
        continueActivation();

        await assert.rejects(() => activation, /removal is already in progress/i);
        await Promise.race([
            removal,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('activation/removal ownership deadlock')),
                2_000,
            )),
        ]);
        assert.strictEqual(internals.syncOwnerToken, undefined);
        assert.strictEqual(internals.syncOwnerServer, undefined);
    });

    test('drains a local watcher event accepted before its settings check completes', async () => {
        const remoteRoot = await tempDir('sr-overleaf-prequeue-remove-remote-');
        const localRoot = await tempDir('sr-overleaf-prequeue-remove-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'closed agent edit before removal');

        const internals = scm as any;
        let signalSettingsCheck!: () => void;
        const settingsCheckStarted = new Promise<void>(resolve => {
            signalSettingsCheck = resolve;
        });
        let releaseSettingsCheck!: () => void;
        const settingsCheckGate = new Promise<void>(resolve => {
            releaseSettingsCheck = resolve;
        });
        internals.hasLocalReplicaSettings = async () => {
            signalSettingsCheck();
            await settingsCheckGate;
            return true;
        };

        const watcherWork = internals.syncToVFS(localMain, 'update');
        await settingsCheckStarted;
        const removal = scm.prepareRemovalAndHoldOwnership();
        releaseSettingsCheck();
        await watcherWork;
        await removal;
        try {
            assert.strictEqual(
                await readText(remoteMain),
                'closed agent edit before removal',
            );
            assert.strictEqual(internals.preQueueSyncWork.size, 0);
        } finally {
            await scm.finishRemoval();
        }
    });

    test('flushes an accepted local watcher debounce before removal', async () => {
        const remoteRoot = await tempDir('sr-overleaf-debounce-remove-remote-');
        const localRoot = await tempDir('sr-overleaf-debounce-remove-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'closed agent edit in debounce');

        const internals = scm as any;
        await internals.syncToVFS(localMain, 'update');
        assert.strictEqual(internals.pendingLocalEvents.has('/main.tex'), true);

        await scm.prepareRemovalAndHoldOwnership();
        try {
            assert.strictEqual(
                await readText(remoteMain),
                'closed agent edit in debounce',
            );
            assert.strictEqual(internals.pendingLocalEvents.size, 0);
        } finally {
            await scm.finishRemoval();
        }
    });

    test('retries transient local classification while flushing removal debounce', async () => {
        const remoteRoot = await tempDir('sr-overleaf-classify-retry-remove-remote-');
        const localRoot = await tempDir('sr-overleaf-classify-retry-remove-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'edit surviving transient classification failure');

        const internals = scm as any;
        const originalClassification = internals.localTargetNeedsPush.bind(scm);
        let classificationAttempts = 0;
        internals.localTargetNeedsPush = async (...args: unknown[]) => {
            classificationAttempts += 1;
            if (classificationAttempts===1) {
                throw new Error('injected transient classification failure');
            }
            return originalClassification(...args);
        };
        await internals.syncToVFS(localMain, 'update');
        assert.strictEqual(internals.pendingLocalEvents.has('/main.tex'), true);

        await scm.prepareRemovalAndHoldOwnership();
        try {
            assert.strictEqual(classificationAttempts>=2, true);
            assert.strictEqual(
                await readText(remoteMain),
                'edit surviving transient classification failure',
            );
            assert.strictEqual(internals.pendingLocalEvents.size, 0);
            assert.strictEqual(internals.removalAcceptedSyncErrors.size, 0);
        } finally {
            await scm.finishRemoval();
        }
    });

    test('blocks removal when accepted local classification keeps failing', async () => {
        const remoteRoot = await tempDir('sr-overleaf-classify-block-remove-remote-');
        const localRoot = await tempDir('sr-overleaf-classify-block-remove-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'edit requiring classification');

        const internals = scm as any;
        internals.localTargetNeedsPush = async () => {
            throw new Error('injected persistent classification failure');
        };
        await internals.syncToVFS(localMain, 'update');
        assert.strictEqual(internals.pendingLocalEvents.has('/main.tex'), true);

        await assert.rejects(
            () => scm.prepareRemovalAndHoldOwnership(),
            /could not classify accepted local edits before removal/i,
        );
        assert.strictEqual(await readText(remoteMain), 'baseline');
        assert.strictEqual(
            internals.removalAcceptedSyncErrors.get('/main.tex')?.error,
            'injected persistent classification failure',
        );
        assert.strictEqual(internals.removalOwnershipHeld, false);
    });

    test('blocks detached removal while another extension host owns the folder', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-detached-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-detached-local-');
        tempRoots.push(remoteRoot, localRoot);
        const detached = createSCM(remoteRoot, localRoot);
        const rootKey = await (detached as any).syncOwnerRootKey();
        const hostId = await (detached as any).syncOwnerHostId();
        const port = (detached as any).syncOwnerPorts(rootKey)[0];
        const ownerRecord = {
            version: 4,
            token: '2123456789abcdef0123456789abcdef',
            pid: process.pid,
            hostname: os.hostname(),
            hostId,
            projectKey: remoteRoot.toString(),
            rootKey,
            port,
            createdAt: new Date().toISOString(),
        };
        const ownerFile = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner.json',
        );
        await vscode.workspace.fs.createDirectory(
            vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR),
        );
        await writeText(ownerFile, JSON.stringify(ownerRecord));
        const ownerServer = net.createServer(socket => {
            socket.end(JSON.stringify(ownerRecord));
        });
        ownerServer.unref();
        await new Promise<void>((resolve, reject) => {
            ownerServer.once('error', reject);
            ownerServer.listen({host: '127.0.0.1', port, exclusive: true}, resolve);
        });
        try {
            await assert.rejects(
                () => detached.deactivateAndDrain(),
                /already active.*process|already active.*VS Code window/i,
            );
            assert.strictEqual(await pathExists(ownerFile), true);
        } finally {
            await new Promise<void>((resolve, reject) => {
                ownerServer.close(error => error ? reject(error) : resolve());
            });
        }
    });

    test('automatically activates a waiting SCM after the other owner releases', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-auto-retry-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-auto-retry-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const contender = createSCM(remoteRoot, localRoot);
        const rootKey = await (contender as any).syncOwnerRootKey();
        const hostId = await (contender as any).syncOwnerHostId();
        const port = (contender as any).syncOwnerPorts(rootKey)[0];
        const ownerRecord = {
            version: 4,
            token: '4123456789abcdef0123456789abcdef',
            pid: process.pid,
            hostname: os.hostname(),
            hostId,
            projectKey: remoteRoot.toString(),
            rootKey,
            port,
            createdAt: new Date().toISOString(),
        };
        const ownerFile = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner.json',
        );
        await vscode.workspace.fs.createDirectory(
            vscode.Uri.joinPath(localRoot, REPLICA_SETTINGS_DIR),
        );
        await writeText(ownerFile, JSON.stringify(ownerRecord));
        const ownerServer = net.createServer(socket => {
            socket.end(JSON.stringify(ownerRecord));
        });
        ownerServer.unref();
        await new Promise<void>((resolve, reject) => {
            ownerServer.once('error', reject);
            ownerServer.listen({host: '127.0.0.1', port, exclusive: true}, resolve);
        });

        const persist: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: localRoot.toString(),
            settings: {} as JSON,
        };
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setProjectSCMPersist(localRoot.toString(), persist);
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub({[localRoot.toString()]: persist}),
            {restorePersistedSCMs: false},
        );
        try {
            const created = await (collection as any).createSCM(
                LocalReplicaSCMProvider,
                localRoot,
                false,
                true,
                {preserveExistingLocalFiles: true},
            ) as LocalReplicaSCMProvider;
            const item = (collection as any).scms.find(
                (candidate: {scm: unknown}) => candidate.scm===created,
            );
            assert.ok(item);
            assert.strictEqual(item.triggers.length, 0);
            assert.strictEqual(created.status.status, 'need-attention');

            await new Promise<void>((resolve, reject) => {
                ownerServer.close(error => error ? reject(error) : resolve());
            });
            await vscode.workspace.fs.delete(ownerFile);

            const deadline = Date.now()+4_000;
            while (item.triggers.length===0 && Date.now()<deadline) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            assert.ok(item.triggers.length>0);
            assert.ok((created as any).syncOwnerToken);
        } finally {
            collection.dispose();
            if (ownerServer.listening) {
                await new Promise<void>((resolve, reject) => {
                    ownerServer.close(error => error ? reject(error) : resolve());
                });
            }
        }
    });

    test('drops a waiting SCM when removal finishes before ownership retry', async () => {
        const remoteRoot = await tempDir('sr-overleaf-owner-retry-remove-remote-');
        const localRoot = await tempDir('sr-overleaf-owner-retry-remove-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        const contender = createSCM(remoteRoot, localRoot);
        const rootKey = await (contender as any).syncOwnerRootKey();
        const hostId = await (contender as any).syncOwnerHostId();
        const port = (contender as any).syncOwnerPorts(rootKey)[0];
        const ownerRecord = {
            version: 4,
            token: '8123456789abcdef0123456789abcdef',
            pid: process.pid,
            hostname: os.hostname(),
            hostId,
            projectKey: remoteRoot.toString(),
            rootKey,
            port,
            createdAt: new Date().toISOString(),
        };
        const ownerFile = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-owner.json',
        );
        await writeText(ownerFile, JSON.stringify(ownerRecord));
        const ownerServer = net.createServer(socket => {
            socket.end(JSON.stringify(ownerRecord));
        });
        ownerServer.unref();
        await new Promise<void>((resolve, reject) => {
            ownerServer.once('error', reject);
            ownerServer.listen({host: '127.0.0.1', port, exclusive: true}, resolve);
        });

        const persist: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: localRoot.toString(),
            settings: {} as JSON,
        };
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setProjectSCMPersist(localRoot.toString(), persist);
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub({[localRoot.toString()]: persist}),
            {restorePersistedSCMs: false},
        );
        try {
            const created = await (collection as any).createSCM(
                LocalReplicaSCMProvider,
                localRoot,
                false,
                true,
                {preserveExistingLocalFiles: true},
            ) as LocalReplicaSCMProvider;
            const item = (collection as any).scms.find(
                (candidate: {scm: unknown}) => candidate.scm===created,
            );
            assert.ok(item);
            assert.strictEqual(item.triggers.length, 0);

            await localReplicaWorkspace.writeReplicaRemovalTombstone(
                localRoot,
                remoteRoot,
            );
            fakeVfs.setProjectSCMPersist(localRoot.toString(), undefined);
            await new Promise<void>((resolve, reject) => {
                ownerServer.close(error => error ? reject(error) : resolve());
            });
            await vscode.workspace.fs.delete(ownerFile);

            await waitUntil(
                () => !(collection as any).scms.includes(item),
                4_000,
            );
            assert.strictEqual((created as any).syncOwnerToken, undefined);
            assert.strictEqual(
                await localReplicaWorkspace.hasReplicaRemovalTombstone(
                    localRoot,
                    remoteRoot,
                ),
                true,
            );
        } finally {
            collection.dispose();
            if (ownerServer.listening) {
                await new Promise<void>((resolve, reject) => {
                    ownerServer.close(error => error ? reject(error) : resolve());
                });
            }
            await localReplicaWorkspace.clearReplicaRemovalTombstone(localRoot);
        }
    });

    test('drains every queued binary replacement before deleting its Local Replica mapping', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remove-drain-remote-');
        const localRoot = await tempDir('sr-overleaf-remove-drain-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const baseline = Buffer.from([1, 2, 3]);
        const replacement = Buffer.from([9, 8, 7, 6]);
        const queuedReplacement = Buffer.from([5, 4, 3, 2, 1]);
        await writeBytes(remoteImage, baseline);

        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, replacement);
        const persist: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: localRoot.toString(),
            settings: {} as JSON,
        };
        fakeVfs.setProjectSCMPersist(scm.scmKey, persist);

        const originalCreateFileWithRetry = (scm as any).createFileWithRetry.bind(scm);
        let releaseUpload!: () => void;
        const uploadGate = new Promise<void>(resolve => {
            releaseUpload = resolve;
        });
        let signalUploadStarted!: () => void;
        const uploadStarted = new Promise<void>(resolve => {
            signalUploadStarted = resolve;
        });
        (scm as any).createFileWithRetry = async (...args: unknown[]) => {
            signalUploadStarted();
            await uploadGate;
            return originalCreateFileWithRetry(...args);
        };

        const collection = Object.create(
            SCMCollectionProvider.prototype,
        ) as SCMCollectionProvider;
        const internals = collection as any;
        let triggerDisposeCount = 0;
        internals.pendingSCMInstances = new Set();
        internals.pendingSCMs = new Map();
        internals.initSCMsPromise = Promise.resolve();
        internals.disposed = false;
        internals.scms = [{
            scm,
            enabled: true,
            triggers: [{
                dispose: () => {
                    triggerDisposeCount += 1;
                },
            }],
        }];
        internals.vfs = fakeVfs;
        internals.updateStatus = () => undefined;

        const push = (scm as any).enqueueSync(
            '/figure.png',
            () => (scm as any).applySync(
                'push',
                'update',
                '/figure.png',
                localImage,
                remoteImage,
            ),
        );
        await uploadStarted;
        assert.strictEqual(await pathExists(remoteImage), false);
        assert.strictEqual(
            (await vscode.workspace.fs.readDirectory(remoteRoot))
                .filter(([name]) => name.startsWith('.sr-overleaf-replace-')).length,
            1,
        );
        await writeBytes(localImage, queuedReplacement);
        const queuedPush = (scm as any).enqueueSync(
            '/figure.png',
            () => (scm as any).applySync(
                'push',
                'update',
                '/figure.png',
                localImage,
                remoteImage,
            ),
        );

        let removalSettled = false;
        const removal = collection.removeLocalReplicaSCM(
            scm.scmKey,
            localRoot,
        ).finally(() => {
            removalSettled = true;
        });
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.strictEqual(removalSettled, false);
        assert.strictEqual(fakeVfs.hasProjectSCMPersist(scm.scmKey), true);

        releaseUpload();
        const pushed = await push as Events['scmSyncCompleteEvent'];
        const queued = await queuedPush as Events['scmSyncCompleteEvent'];
        await removal;

        assert.strictEqual(pushed.outcome, 'success');
        assert.strictEqual(queued.outcome, 'success');
        assert.deepStrictEqual(await readBytes(remoteImage), queuedReplacement);
        assert.strictEqual(fakeVfs.hasProjectSCMPersist(scm.scmKey), false);
        assert.strictEqual(triggerDisposeCount, 1);
        assert.deepStrictEqual(
            (await vscode.workspace.fs.readDirectory(remoteRoot))
                .filter(([name]) => name.startsWith('.sr-overleaf-replace-')),
            [],
        );
        const journalEntries = await vscode.workspace.fs.readDirectory(
            vscode.Uri.joinPath(
                localRoot,
                REPLICA_SETTINGS_DIR,
                'remote-delete-operations',
            ),
        );
        assert.deepStrictEqual(
            journalEntries.filter(([name]) => name.endsWith('.json')),
            [],
        );
    });

    test('retains an inactive mapping when its detached journal still needs recovery', async () => {
        const remoteRoot = await tempDir('sr-overleaf-detached-journal-remote-');
        const localRoot = await tempDir('sr-overleaf-detached-journal-local-');
        tempRoots.push(remoteRoot, localRoot);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const persist: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: localRoot.toString(),
            settings: {} as JSON,
        };
        fakeVfs.setProjectSCMPersist(localRoot.toString(), persist);
        (fakeVfs as any).context = createExtensionContextStub({
            [localRoot.toString()]: persist,
        });
        (fakeVfs as any).scmCollectionItem = undefined;
        const operationId = '0123456789abcdef01234567';
        await writeText(
            vscode.Uri.joinPath(
                localRoot,
                REPLICA_SETTINGS_DIR,
                'remote-delete-operations',
                `${operationId}.json`,
            ),
            JSON.stringify({
                version: 1,
                id: operationId,
                kind: 'replace',
                relPath: '/figure.png',
                stagingRelPath: `/.sr-overleaf-replace-${operationId}`,
                expectedRevision: sha1('baseline'),
                replacementRevision: sha1('replacement'),
                createdAt: new Date().toISOString(),
            }),
        );

        await assert.rejects(
            () => VirtualFileSystem.prototype.removeLocalReplicaSCM.call(
                fakeVfs,
                localRoot.toString(),
                localRoot,
            ),
            /recoverable file operations/,
        );

        assert.strictEqual(
            fakeVfs.hasProjectSCMPersist(localRoot.toString()),
            true,
        );
    });

    test('removes a pending Local Replica after its failed activation has stopped', async () => {
        const remoteRoot = await tempDir('sr-overleaf-pending-remove-remote-');
        const localRoot = await tempDir('sr-overleaf-pending-remove-local-');
        tempRoots.push(remoteRoot, localRoot);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        const persist: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: localRoot.toString(),
            settings: {} as JSON,
        };
        fakeVfs.setProjectSCMPersist(localRoot.toString(), persist);

        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };
        let releaseInitialization!: () => void;
        const initializationGate = new Promise<void>(resolve => {
            releaseInitialization = resolve;
        });
        let signalInitializationStarted!: () => void;
        const initializationStarted = new Promise<void>(resolve => {
            signalInitializationStarted = resolve;
        });
        (scm as any).initializeLocalReplica = async () => {
            signalInitializationStarted();
            await initializationGate;
            return false;
        };
        const activation = scm.triggers;
        const pendingCreation = activation
            .then(() => scm)
            .catch(() => undefined);
        await initializationStarted;

        const collection = Object.create(
            SCMCollectionProvider.prototype,
        ) as SCMCollectionProvider;
        const internals = collection as any;
        internals.pendingSCMInstances = new Set([scm]);
        internals.pendingSCMs = new Map([[
            `${LocalReplicaSCMProvider.label}:${localRoot.toString()}`,
            pendingCreation,
        ]]);
        internals.initSCMsPromise = Promise.resolve();
        internals.disposed = false;
        internals.scms = [];
        internals.vfs = fakeVfs;
        internals.updateStatus = () => undefined;

        const removal = collection.removeLocalReplicaSCM(
            localRoot.toString(),
            localRoot,
        );
        releaseInitialization();
        await removal;

        assert.strictEqual(
            fakeVfs.hasProjectSCMPersist(localRoot.toString()),
            false,
        );
        assert.strictEqual((scm as any).syncSessionActive, false);
        watchers.forEach(watcher => watcher.dispose());
    });

    test('does not revive the old folder after an A-to-B Local Replica switch and removal', async () => {
        const remoteRoot = await tempDir('sr-overleaf-switch-remove-remote-');
        const localRootA = await tempDir('sr-overleaf-switch-remove-a-');
        const localRootB = await tempDir('sr-overleaf-switch-remove-b-');
        tempRoots.push(remoteRoot, localRootA, localRootB);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        await writeReplicaSettings(localRootA, remoteRoot);
        await writeReplicaSettings(localRootB, remoteRoot);

        const persistA: PersistRecord = {
            enabled: true,
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
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setProjectSCMPersist(localRootA.toString(), persistA);
        fakeVfs.setProjectSCMPersist(localRootB.toString(), persistB);
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub({
                [localRootA.toString()]: persistA,
                [localRootB.toString()]: persistB,
            }),
            {restorePersistedSCMs: false},
        );

        try {
            await (collection as any).createSCM(
                LocalReplicaSCMProvider,
                localRootA,
                false,
                true,
                {preserveExistingLocalFiles: true},
            );
            const suspended = await (collection as any).suspendSCMsByLabel(
                LocalReplicaSCMProvider.label,
                localRootB,
            );
            assert.strictEqual(suspended.length, 1);
            await (collection as any).createSCM(
                LocalReplicaSCMProvider,
                localRootB,
                false,
                true,
                {preserveExistingLocalFiles: true},
            );
            await (collection as any).removeSCMsByLabel(
                LocalReplicaSCMProvider.label,
                localRootB,
            );
            assert.strictEqual(fakeVfs.hasProjectSCMPersist(localRootA.toString()), false);
            assert.strictEqual(fakeVfs.hasProjectSCMPersist(localRootB.toString()), true);

            await setActiveReplicaRoot(localRootB);
            await collection.removeLocalReplicaSCM(
                localRootB.toString(),
                localRootB,
            );
            assert.strictEqual(fakeVfs.hasProjectSCMPersist(localRootB.toString()), false);

            await setActiveReplicaRoot(undefined);
            setWorkspaceFoldersForTest(localRootA, localRootB);
            await localReplicaWorkspace.initializeLocalReplicaWorkspace();
            assert.strictEqual(getActiveReplicaRoot(), undefined);
        } finally {
            collection.dispose();
        }
    });

    test('rolls back B and restores only A when an exact-folder persist removal fails', async () => {
        const remoteRoot = await tempDir('sr-overleaf-switch-rollback-remote-');
        const localRootA = await tempDir('sr-overleaf-switch-rollback-a-');
        const localRootB = await tempDir('sr-overleaf-switch-rollback-b-');
        tempRoots.push(remoteRoot, localRootA, localRootB);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote baseline');
        await writeReplicaSettings(localRootA, remoteRoot);
        await writeReplicaSettings(localRootB, remoteRoot);
        const persistA: PersistRecord = {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: localRootA.toString(),
            settings: {} as JSON,
        };
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setProjectSCMPersist(localRootA.toString(), persistA);
        const originalSetPersist = fakeVfs.setProjectSCMPersist.bind(fakeVfs);
        let failRemovingA = true;
        fakeVfs.setProjectSCMPersist = (key: string, persist?: PersistRecord) => {
            if (
                failRemovingA
                && key===localRootA.toString()
                && persist===undefined
            ) {
                failRemovingA = false;
                throw new Error('simulated A persist removal failure');
            }
            originalSetPersist(key, persist);
        };
        const collection = new SCMCollectionProvider(
            fakeVfs as unknown as VirtualFileSystem,
            createExtensionContextStub({[localRootA.toString()]: persistA}),
            {restorePersistedSCMs: false},
        );
        await (collection as any).createSCM(
            LocalReplicaSCMProvider,
            localRootA,
            false,
            true,
            {preserveExistingLocalFiles: true},
        );
        await setActiveReplicaRoot(localRootA);
        (collection as any).promptBaseUri = async () => localRootB.fsPath;

        try {
            const created = await (collection as any).createNewExactLocalReplicaSCM();
            assert.strictEqual(created, undefined);
            const records = (collection as any).scms as Array<{
                scm: LocalReplicaSCMProvider;
                triggers: vscode.Disposable[];
            }>;
            const aRecord = records.find(record =>
                record.scm.baseUri.toString()===localRootA.toString()
            );
            const bRecord = records.find(record =>
                record.scm.baseUri.toString()===localRootB.toString()
            );
            assert.ok(aRecord);
            assert.ok(aRecord.triggers.length>0);
            assert.strictEqual(bRecord, undefined);
            assert.strictEqual(
                fakeVfs.hasProjectSCMPersist(localRootA.toString()),
                true,
            );
            assert.strictEqual(
                fakeVfs.hasProjectSCMPersist(localRootB.toString()),
                false,
            );

            await setActiveReplicaRoot(undefined);
            setWorkspaceFoldersForTest(localRootA);
            await localReplicaWorkspace.initializeLocalReplicaWorkspace();
            assert.strictEqual(
                getActiveReplicaRoot()?.toString(),
                localRootA.toString(),
            );
        } finally {
            collection.dispose();
        }
    });

    test('removing the open Local Replica stops sync and suppresses marker restoration', async () => {
        const localRoot = await tempDir('sr-overleaf-remove-open-');
        tempRoots.push(localRoot);
        const projectUri = vscode.Uri.parse(
            `${ROOT_NAME}://test-server/Remove%20Project` +
            '?user=test-user&project=remove-project',
        );
        await writeText(settingsUri(localRoot), JSON.stringify({
            uri: vscode.Uri.file('/tmp/remove-project').toString(),
            serverName: 'test-server',
            enableCompileNPreview: true,
            projectName: 'Remove Project',
        }));
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(localMain, 'local content remains');
        setWorkspaceFoldersForTest(localRoot);
        await setActiveReplicaRoot(localRoot);

        const calls: string[] = [];
        let watcherActive = true;
        const provider = new ProjectManagerProvider({} as any, {
            removeLocalReplicaSCM: async (
                receivedProject: vscode.Uri,
                receivedKey: string,
                receivedRoot: vscode.Uri,
            ) => {
                assert.strictEqual(receivedProject.toString(), projectUri.toString());
                assert.strictEqual(receivedKey, localRoot.toString());
                assert.strictEqual(receivedRoot.toString(), localRoot.toString());
                watcherActive = false;
                calls.push('remove-scm');
            },
            deactivateProject: async (receivedProject: vscode.Uri) => {
                assert.strictEqual(watcherActive, false);
                assert.strictEqual(receivedProject.toString(), projectUri.toString());
                calls.push('deactivate-vfs');
            },
        } as any);

        await (provider as any).removeLocalReplicaMapping(
            projectUri,
            localRoot.toString(),
            localRoot,
        );

        assert.deepStrictEqual(calls, ['remove-scm', 'deactivate-vfs']);
        assert.strictEqual(getActiveReplicaRoot(), undefined);
        assert.strictEqual(await pathExists(settingsUri(localRoot)), true);
        assert.strictEqual(await readText(localMain), 'local content remains');

        await localReplicaWorkspace.initializeLocalReplicaWorkspace();
        assert.strictEqual(getActiveReplicaRoot(), undefined);
    });

    test('does not revive a suppressed active root after a crash before active-root cleanup', async () => {
        const localRoot = await tempDir('sr-overleaf-remove-crash-window-');
        tempRoots.push(localRoot);
        await writeText(settingsUri(localRoot), JSON.stringify({
            uri: vscode.Uri.file('/tmp/remove-crash-window').toString(),
            serverName: 'test-server',
            enableCompileNPreview: true,
            projectName: 'Remove Crash Window',
        }));
        setWorkspaceFoldersForTest(localRoot);
        await setActiveReplicaRoot(localRoot);

        await localReplicaWorkspace.suppressReplicaAutoRestoreRoot(localRoot);
        await localReplicaWorkspace.initializeLocalReplicaWorkspace();

        assert.strictEqual(getActiveReplicaRoot(), undefined);
        await localReplicaWorkspace.initializeLocalReplicaWorkspace();
        assert.strictEqual(getActiveReplicaRoot(), undefined);
    });

    test('removing an inactive Local Replica preserves the active root and blocks later restoration', async () => {
        const activeRoot = await tempDir('sr-overleaf-remove-inactive-active-');
        const removedRoot = await tempDir('sr-overleaf-remove-inactive-removed-');
        tempRoots.push(activeRoot, removedRoot);
        const projectUri = vscode.Uri.parse(
            `${ROOT_NAME}://test-server/Inactive%20Project` +
            '?user=test-user&project=inactive-project',
        );
        for (const [root, name] of [
            [activeRoot, 'Active Project'],
            [removedRoot, 'Inactive Project'],
        ] as const) {
            await writeText(settingsUri(root), JSON.stringify({
                uri: vscode.Uri.file(`/tmp/${name.replace(' ', '-').toLowerCase()}`).toString(),
                serverName: 'test-server',
                enableCompileNPreview: true,
                projectName: name,
            }));
        }
        setWorkspaceFoldersForTest(activeRoot, removedRoot);
        await setActiveReplicaRoot(activeRoot);

        const calls: string[] = [];
        const provider = new ProjectManagerProvider({} as any, {
            removeLocalReplicaSCM: async (
                receivedProject: vscode.Uri,
                receivedKey: string,
                receivedRoot: vscode.Uri,
            ) => {
                assert.strictEqual(receivedProject.toString(), projectUri.toString());
                assert.strictEqual(receivedKey, removedRoot.toString());
                assert.strictEqual(receivedRoot.toString(), removedRoot.toString());
                calls.push('remove-scm');
            },
            deactivateProject: async () => {
                calls.push('deactivate-vfs');
            },
        } as any);

        await (provider as any).removeLocalReplicaMapping(
            projectUri,
            removedRoot.toString(),
            removedRoot,
        );

        assert.deepStrictEqual(calls, ['remove-scm']);
        assert.strictEqual(getActiveReplicaRoot()?.toString(), activeRoot.toString());

        await setActiveReplicaRoot(undefined);
        setWorkspaceFoldersForTest(removedRoot);
        await localReplicaWorkspace.initializeLocalReplicaWorkspace();
        assert.strictEqual(getActiveReplicaRoot(), undefined);
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
        let activationOptions: unknown;
        (vscode.commands as any).executeCommand = async (
            command: string,
            arg?: unknown,
            options?: unknown,
        ) => {
            calls.push(command);
            if (command===`${ROOT_NAME}.remoteFileSystem.deactivateProject`) {
                calls.push((arg as vscode.Uri).toString());
            }
            if (command===`${ROOT_NAME}.remoteFileSystem.activateProject`) {
                assert.strictEqual((arg as vscode.Uri).toString(), newProjectUri.toString());
                activationOptions = options;
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
        assert.deepStrictEqual(activationOptions, {restorePersistedSCMs: false});
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
            const ensured = await (collection as any).ensureLocalReplicaSCM(localRoot);

            assert.strictEqual(initializeCalls, 1);
            assert.deepStrictEqual((ensured as any).initializationOptions, {
                preserveExistingLocalFiles: true,
                resetLocalFilesToRemote: false,
            });
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

    test('uses a confined direct watcher for immediate Remote SSH closed-file changes', async () => {
        const remoteRoot = await tempDir('sr-overleaf-direct-watch-remote-');
        const localRoot = await tempDir('sr-overleaf-direct-watch-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v1');

        let directListener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
        let directRoot = '';
        let closeCount = 0;
        let errorListener: ((error: Error) => void) | undefined;
        (LocalReplicaSCMProvider as any).shouldUseDirectLocalWatcher = () => true;
        (LocalReplicaSCMProvider as any).createDirectLocalWatcher = (
            rootPath: string,
            listener: (eventType: string, filename: string | Buffer | null) => void,
        ) => {
            directRoot = rootPath;
            directListener = listener;
            return {
                close() {
                    closeCount += 1;
                },
                on(event: string, listener: (error: Error) => void) {
                    if (event==='error') { errorListener = listener; }
                    return this;
                },
            };
        };

        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };
        (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs = 100;
        (LocalReplicaSCMProvider as any).watcherHealthIntervalMs = 1000;
        let warningCount = 0;
        (vscode.window as any).showWarningMessage = async () => {
            warningCount += 1;
            return undefined;
        };

        const scm = createSCM(remoteRoot, localRoot);
        const internals = scm as any;
        const triggers = await scm.triggers;
        try {
            assert.strictEqual(directRoot, localRoot.fsPath);
            assert.ok(directListener);
            assert.ok(errorListener);

            await waitUntil(() => Boolean(internals.localWatcherProbe));
            const probePath = vscode.Uri.parse(internals.localWatcherProbe.uri).fsPath;
            directListener!('change', path.relative(localRoot.fsPath, probePath));
            await waitUntil(() => internals.localWatcherHealthState==='healthy');
            assert.strictEqual(warningCount, 0);
            assert.strictEqual(internals.fallbackScanGeneration, undefined);

            const nestedUri = vscode.Uri.joinPath(localRoot, 'sections', 'closed.tex');
            const pushWait = waitForSyncComplete(localRoot, '/sections/closed.tex', 'push', 'update');
            await writeText(nestedUri, 'closed agent edit through direct watcher');
            directListener!('rename', Buffer.from('sections/closed.tex'));
            assert.strictEqual((await pushWait).outcome, 'success');
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteRoot, 'sections', 'closed.tex')),
                'closed agent edit through direct watcher',
            );

            const mediaUri = vscode.Uri.joinPath(localRoot, 'figures', 'direct-watch.png');
            const mediaCreateWait = waitForSyncComplete(
                localRoot,
                '/figures/direct-watch.png',
                'push',
                'update',
            );
            await writeBytes(mediaUri, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
            directListener!('rename', 'figures/direct-watch.png');
            assert.strictEqual((await mediaCreateWait).outcome, 'success');
            assert.deepStrictEqual(
                await readBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'direct-watch.png')),
                Buffer.from([137, 80, 78, 71, 1, 2, 3]),
            );

            const mediaDeleteWait = waitForSyncComplete(
                localRoot,
                '/figures/direct-watch.png',
                'push',
                'delete',
            );
            await vscode.workspace.fs.delete(mediaUri);
            directListener!('rename', 'figures/direct-watch.png');
            assert.strictEqual((await mediaDeleteWait).outcome, 'success');
            assert.strictEqual(
                await pathExists(vscode.Uri.joinPath(remoteRoot, 'figures', 'direct-watch.png')),
                false,
            );

            const escapedUri = internals.directLocalWatcherUri('../escape.tex') as vscode.Uri | undefined;
            assert.strictEqual(escapedUri, undefined);
            assert.strictEqual(internals.directLocalWatcherUri(localRoot.fsPath), undefined);

            errorListener!(new Error('simulated direct watcher failure'));
            await waitUntil(() => internals.localWatcherHealthState==='degraded');
            assert.strictEqual(internals.directLocalWatcher, undefined);
            assert.strictEqual(internals.fallbackScanGeneration, internals.syncGeneration);
            assert.strictEqual(warningCount, 1);
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
        assert.strictEqual(closeCount, 1);
    });

    test('falls back to content scans when the local watcher emits no events', async () => {
        const remoteRoot = await tempDir('sr-overleaf-watch-fallback-remote-');
        const localRoot = await tempDir('sr-overleaf-watch-fallback-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v1');
        await writeBytes(vscode.Uri.joinPath(remoteRoot, 'old.png'), Buffer.from([1, 2, 3]));

        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };
        (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs = 20;
        (LocalReplicaSCMProvider as any).watcherHealthIntervalMs = 20;
        (LocalReplicaSCMProvider as any).fallbackScanIntervalMs = 20;
        let warning = '';
        (vscode.window as any).showWarningMessage = async (message: string) => {
            warning = message;
            return undefined;
        };

        const scm = createSCM(remoteRoot, localRoot);
        const triggers = await scm.triggers;
        try {
            assert.strictEqual(watchers.length, 2);
            const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
            const waits = [
                waitForSyncComplete(localRoot, '/main.tex', 'push', 'update'),
                waitForSyncComplete(localRoot, '/figures/new.png', 'push', 'update'),
                waitForSyncComplete(localRoot, '/empty', 'push', 'update'),
                waitForSyncComplete(localRoot, '/old.png', 'push', 'delete'),
            ];
            await writeText(localMain, 'closed agent edit without watcher event');
            await writeBytes(
                vscode.Uri.joinPath(localRoot, 'figures', 'new.png'),
                Buffer.from([9, 8, 7, 6]),
            );
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(localRoot, 'empty'));
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(localRoot, 'old.png'));

            const events = await Promise.all(waits);

            assert.ok(events.every(event => event.outcome==='success'));
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')),
                'closed agent edit without watcher event',
            );
            assert.deepStrictEqual(
                await readBytes(vscode.Uri.joinPath(remoteRoot, 'figures', 'new.png')),
                Buffer.from([9, 8, 7, 6]),
            );
            assert.strictEqual(
                (await vscode.workspace.fs.stat(vscode.Uri.joinPath(remoteRoot, 'empty'))).type,
                vscode.FileType.Directory,
            );
            assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'old.png')), false);
            assert.match(warning, /periodic content scan/i);
            assert.strictEqual(
                (scm as any).fallbackScanGeneration,
                (scm as any).syncGeneration,
            );
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('detects a watcher that dies after startup and stops fallback scans after recovery', async () => {
        const remoteRoot = await tempDir('sr-overleaf-watch-recovery-remote-');
        const localRoot = await tempDir('sr-overleaf-watch-recovery-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'remote v1');

        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };
        (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs = 40;
        (LocalReplicaSCMProvider as any).watcherHealthIntervalMs = 30;
        (LocalReplicaSCMProvider as any).fallbackScanIntervalMs = 20;
        let warningCount = 0;
        (vscode.window as any).showWarningMessage = async () => {
            warningCount += 1;
            return undefined;
        };

        const scm = createSCM(remoteRoot, localRoot);
        const internals = scm as any;
        let scanCount = 0;
        const scanWithoutWatcher = internals.scanLocalChangesWithoutWatcher.bind(scm);
        internals.scanLocalChangesWithoutWatcher = async (generation: number) => {
            scanCount += 1;
            return scanWithoutWatcher(generation);
        };
        const triggers = await scm.triggers;
        try {
            const localWatcher = watchers[1];
            assert.ok(localWatcher);

            await waitUntil(() => Boolean(internals.localWatcherProbe));
            localWatcher.fireCreate(vscode.Uri.parse(internals.localWatcherProbe.uri));
            await waitUntil(() => internals.localWatcherHealthState==='healthy');

            // Do not acknowledge the next periodic probe. The same watcher
            // object still exists, but event delivery has stopped.
            await waitUntil(() => internals.localWatcherHealthState==='degraded');
            assert.strictEqual(warningCount, 1);
            assert.strictEqual(internals.fallbackScanGeneration, internals.syncGeneration);

            const pushWait = waitForSyncComplete(localRoot, '/main.tex', 'push', 'update');
            await writeText(
                vscode.Uri.joinPath(localRoot, 'main.tex'),
                'agent edit after watcher failure',
            );
            assert.strictEqual((await pushWait).outcome, 'success');
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteRoot, 'main.tex')),
                'agent edit after watcher failure',
            );

            // A later probe event proves recovery. Lengthen the next health
            // interval so this assertion observes the recovered steady state.
            (LocalReplicaSCMProvider as any).watcherHealthIntervalMs = 1000;
            await waitUntil(() => Boolean(internals.localWatcherProbe));
            localWatcher.fireChange(vscode.Uri.parse(internals.localWatcherProbe.uri));
            await waitUntil(() => internals.localWatcherHealthState==='healthy');
            await waitUntil(() => internals.fallbackScanRunningGeneration===undefined);
            const scansAtRecovery = scanCount;
            await new Promise(resolve => setTimeout(resolve, 80));

            assert.strictEqual(internals.fallbackScanGeneration, undefined);
            assert.strictEqual(scanCount, scansAtRecovery);
            assert.strictEqual(warningCount, 1);
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('keeps watcher probe timeouts isolated across sync generations', async () => {
        const localRoot = await tempDir('sr-overleaf-watch-probe-generation-');
        tempRoots.push(localRoot);
        (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs = 80;

        const scm = Object.create(LocalReplicaSCMProvider.prototype) as LocalReplicaSCMProvider;
        const internals = scm as any;
        internals.baseUri = localRoot;
        internals.syncSessionActive = true;
        internals.syncGeneration = 1;

        const firstProbe = internals.verifyLocalWatcherHealth(1) as Promise<boolean>;
        await waitUntil(() => internals.localWatcherProbe?.generation===1);
        const firstProbeUri = vscode.Uri.parse(internals.localWatcherProbe.uri);
        await waitUntil(() => Boolean(internals.localWatcherProbe?.timeout));

        internals.syncGeneration = 2;
        const secondProbe = internals.verifyLocalWatcherHealth(2) as Promise<boolean>;
        await waitUntil(() => internals.localWatcherProbe?.generation===2);
        const secondProbeUri = vscode.Uri.parse(internals.localWatcherProbe.uri);
        await waitUntil(() => Boolean(internals.localWatcherProbe?.timeout));

        const secondOutcome = await Promise.race([
            secondProbe.then(() => 'completed'),
            new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 300)),
        ]);
        internals.syncSessionActive = false;
        await firstProbe;

        assert.strictEqual(secondOutcome, 'completed');
        assert.strictEqual(await pathExists(firstProbeUri), false);
        assert.strictEqual(await pathExists(secondProbeUri), false);
    });

    test('syncs remote and local changes through file system watchers', async function () {
        this.timeout(20000);
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

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
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

            await vscode.workspace.fs.rename(
                vscode.Uri.joinPath(localRoot, 'supplement.pdf'),
                vscode.Uri.joinPath(localRoot, 'paper-renamed.pdf'),
                {overwrite: false},
            );
            localWatcher.fireDelete(vscode.Uri.joinPath(localRoot, 'supplement.pdf'));
            localWatcher.fireCreate(vscode.Uri.joinPath(localRoot, 'paper-renamed.pdf'));
            // The watcher pair is one verified entity move, not an unrelated
            // delete and upload, so it deliberately produces no two-step
            // push events. Wait for the guarded remote postcondition instead.
            await waitUntilAsync(async () => {
                const [sourceExists, destinationExists] = await Promise.all([
                    pathExists(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf')),
                    pathExists(vscode.Uri.joinPath(remoteRoot, 'paper-renamed.pdf')),
                ]);
                return !sourceExists && destinationExists;
            }, 5_000);
            assert.strictEqual(await pathExists(vscode.Uri.joinPath(remoteRoot, 'supplement.pdf')), false);
            assert.deepStrictEqual(
                await readBytes(vscode.Uri.joinPath(remoteRoot, 'paper-renamed.pdf')),
                Buffer.from('%PDF old\n', 'utf-8'),
            );

            const mislabeledDeleteUri = vscode.Uri.joinPath(localRoot, 'delete-reported-as-change.tex');
            const mislabeledCreateWait = waitForSyncComplete(
                localRoot,
                '/delete-reported-as-change.tex',
                'push',
                'update',
            );
            await writeText(mislabeledDeleteUri, 'delete me');
            localWatcher.fireCreate(mislabeledDeleteUri);
            assert.strictEqual((await mislabeledCreateWait).outcome, 'success');

            const mislabeledDeleteWait = waitForSyncComplete(
                localRoot,
                '/delete-reported-as-change.tex',
                'push',
                'delete',
            );
            await vscode.workspace.fs.delete(mislabeledDeleteUri);
            localWatcher.fireChange(mislabeledDeleteUri);
            assert.strictEqual((await mislabeledDeleteWait).outcome, 'success');
            assert.strictEqual(
                await pathExists(vscode.Uri.joinPath(remoteRoot, 'delete-reported-as-change.tex')),
                false,
            );

            const delayedEchoUri = vscode.Uri.joinPath(localRoot, 'delete-before-delayed-echo.tex');
            const delayedEchoRemoteUri = vscode.Uri.joinPath(remoteRoot, 'delete-before-delayed-echo.tex');
            const delayedEchoCreateWait = waitForSyncComplete(
                localRoot,
                '/delete-before-delayed-echo.tex',
                'push',
                'update',
            );
            await writeText(delayedEchoUri, 'delete before delayed remote echo');
            localWatcher.fireCreate(delayedEchoUri);
            assert.strictEqual((await delayedEchoCreateWait).outcome, 'success');

            // A remote watcher echo from the completed create can arrive just
            // before the local watcher reports a subsequent deletion. It must
            // not restore the tracked file and erase the newer local intent.
            const delayedEchoDeleteWait = waitForSyncComplete(
                localRoot,
                '/delete-before-delayed-echo.tex',
                'push',
                'delete',
            );
            await vscode.workspace.fs.delete(delayedEchoUri);
            const internals = scm as any;
            const delayedPullEvent = await internals.enqueueSync(
                '/delete-before-delayed-echo.tex',
                () => internals.applySync(
                    'pull',
                    'update',
                    '/delete-before-delayed-echo.tex',
                    delayedEchoRemoteUri,
                    delayedEchoUri,
                ),
            );
            assert.strictEqual(delayedPullEvent.outcome, 'suppressed');
            assert.strictEqual((await delayedEchoDeleteWait).outcome, 'success');
            assert.strictEqual(await pathExists(delayedEchoUri), false);
            assert.strictEqual(await pathExists(delayedEchoRemoteUri), false);

            const recreateUri = vscode.Uri.joinPath(localRoot, 'recreate-during-delete.tex');
            const recreateRemoteUri = vscode.Uri.joinPath(remoteRoot, 'recreate-during-delete.tex');
            const recreateCreateWait = waitForSyncComplete(
                localRoot,
                '/recreate-during-delete.tex',
                'push',
                'update',
            );
            await writeText(recreateUri, 'delete baseline');
            localWatcher.fireCreate(recreateUri);
            assert.strictEqual((await recreateCreateWait).outcome, 'success');

            const originalAtomicDelete = internals.atomicDeleteRemotePathIfRevision.bind(scm);
            let releaseRemoteDelete!: () => void;
            const remoteDeleteGate = new Promise<void>(resolve => {
                releaseRemoteDelete = resolve;
            });
            let remoteDeleteStarted!: () => void;
            const remoteDeleteStart = new Promise<void>(resolve => {
                remoteDeleteStarted = resolve;
            });
            internals.atomicDeleteRemotePathIfRevision = async (...args: unknown[]) => {
                remoteDeleteStarted();
                await remoteDeleteGate;
                return originalAtomicDelete(...args);
            };
            const recreateDeleteWait = waitForSyncComplete(
                localRoot,
                '/recreate-during-delete.tex',
                'push',
                'delete',
            );
            // Counts the staged entity being renamed BACK, which happens only when
            // the delete is abandoned. Inode identity is not usable as the proxy
            // here: a file deleted and immediately recreated in the same directory
            // routinely gets its inode number recycled.
            const originalRestoreStaging = internals.restoreRemoteStagingPath.bind(scm);
            let stagingRestored = 0;
            internals.restoreRemoteStagingPath = async (...restoreArgs: unknown[]) => {
                stagingRestored += 1;
                return originalRestoreStaging(...restoreArgs);
            };
            await vscode.workspace.fs.delete(recreateUri);
            localWatcher.fireDelete(recreateUri);
            await remoteDeleteStart;

            const recreatedUpdateWait = waitForSyncComplete(
                localRoot,
                '/recreate-during-delete.tex',
                'push',
                'update',
            );
            await writeText(recreateUri, 'newer recreation');
            localWatcher.fireCreate(recreateUri);
            releaseRemoteDelete();

            const recreateDeleteEvent = await recreateDeleteWait;
            const recreatedUpdateEvent = await recreatedUpdateWait;
            internals.restoreRemoteStagingPath = originalRestoreStaging;
            assert.strictEqual(await readText(recreateRemoteUri), 'newer recreation');
            // Asserted first, because it is the property the change exists for and
            // a regression should say so: the Overleaf entity was renamed back into
            // place, so its id, history, comments and links survived. Without this
            // the entity is destroyed and the recreation rebuilds a new one.
            assert.strictEqual(
                stagingRestored,
                1,
                'the Overleaf entity was destroyed instead of being restored',
            );
            // Behaviour change, deliberate. The delete assertion used to be
            // 'success': the entity was destroyed and the recreation later rebuilt
            // it. The staged delete now re-checks local absence after the entity
            // has been renamed aside but before it is destroyed, finds the path
            // back, renames it into place and defers. Nothing was deleted, so
            // reporting success would be false; the deferral re-drives and the
            // bytes converge exactly as they did before.
            assert.strictEqual(recreateDeleteEvent.outcome, 'blocked');
            assert.strictEqual(recreatedUpdateEvent.outcome, 'success');
            internals.atomicDeleteRemotePathIfRevision = originalAtomicDelete;

            const concurrentRecreateUri = vscode.Uri.joinPath(
                localRoot,
                'concurrent-recreate-during-delete.tex',
            );
            const concurrentRecreateRemoteUri = vscode.Uri.joinPath(
                remoteRoot,
                'concurrent-recreate-during-delete.tex',
            );
            const concurrentBaselineWait = waitForSyncComplete(
                localRoot,
                '/concurrent-recreate-during-delete.tex',
                'push',
                'update',
            );
            await writeText(concurrentRecreateUri, 'concurrent delete baseline');
            localWatcher.fireCreate(concurrentRecreateUri);
            assert.strictEqual((await concurrentBaselineWait).outcome, 'success');

            let releaseConcurrentDelete!: () => void;
            const concurrentDeleteGate = new Promise<void>(resolve => {
                releaseConcurrentDelete = resolve;
            });
            let concurrentDeleteStarted!: () => void;
            const concurrentDeleteStart = new Promise<void>(resolve => {
                concurrentDeleteStarted = resolve;
            });
            internals.atomicDeleteRemotePathIfRevision = async (...args: unknown[]) => {
                concurrentDeleteStarted();
                // The collaborator's remote write is hooked to the delete STARTING
                // rather than to it returning. Chaining it to completion no longer
                // establishes the premise at all: the staged delete now abandons
                // itself when the local path reappears, so a write that waits for
                // it to finish would never run and the scenario would silently
                // stop testing a concurrent remote recreation.
                await writeText(concurrentRecreateRemoteUri, 'collaborator recreation');
                vfsWatcher.fireCreate(concurrentRecreateRemoteUri);
                await concurrentDeleteGate;
                return originalAtomicDelete(...args);
            };
            const concurrentDeleteWait = waitForSyncComplete(
                localRoot,
                '/concurrent-recreate-during-delete.tex',
                'push',
                'delete',
            );
            await vscode.workspace.fs.delete(concurrentRecreateUri);
            localWatcher.fireDelete(concurrentRecreateUri);
            await concurrentDeleteStart;

            const concurrentRecreatePushWait = waitForSyncComplete(
                localRoot,
                '/concurrent-recreate-during-delete.tex',
                'push',
                'update',
            );
            await writeText(concurrentRecreateUri, 'local recreation');
            localWatcher.fireCreate(concurrentRecreateUri);
            releaseConcurrentDelete();

            // Behaviour change, deliberate, and larger than a changed value.
            //
            // This used to assert 'success' here and a
            // 'concurrent untracked local and remote files' conflict below. That
            // outcome was manufactured by the delete SUCCEEDING: destroying the
            // remote entity also cleared this path's tracking state, so the local
            // recreation then met a remote file it had no baseline for and the two
            // untracked copies collided.
            //
            // The delete no longer succeeds. The collaborator wins the race
            // outright — the remote revision no longer matches the one the delete
            // was authorized against — so it is refused before anything is staged,
            // the entity is never destroyed, and the tracking state survives. With
            // a baseline still in hand the local recreation simply rebases through
            // the ordinary pull/push path. The old conflict is therefore not
            // reachable any more, and asserting it would mean contriving a state
            // the code can no longer produce.
            //
            // What this scenario exists to prove is unchanged and still asserted:
            // a collaborator recreating the file remotely while our delete is in
            // flight is handled without destroying either side.
            const concurrentDeleteEvent = await concurrentDeleteWait;
            const concurrentRecreatePush = await concurrentRecreatePushWait;
            assert.strictEqual(
                await readText(concurrentRecreateUri),
                'local recreation',
            );
            assert.strictEqual(
                await readText(concurrentRecreateRemoteUri),
                'local recreation',
            );
            // Note for the reader: this scenario does NOT exercise the staged
            // delete's final local-absence gate. The collaborator's write lands
            // before anything is staged, so the pre-existing expected-revision
            // check refuses the delete first and the outcome is the same with or
            // without that gate. It is kept because the property it proves — a
            // collaborator recreating remotely mid-delete destroys neither side —
            // is independent of it.
            assert.strictEqual(concurrentDeleteEvent.outcome, 'blocked');
            assert.strictEqual(
                concurrentDeleteEvent.error,
                'concurrent remote change before delete',
            );
            assert.strictEqual(concurrentRecreatePush.outcome, 'success');
            internals.atomicDeleteRemotePathIfRevision = originalAtomicDelete;

            const createRaceUri = vscode.Uri.joinPath(localRoot, 'create-race.tex');
            const createRaceRemoteUri = vscode.Uri.joinPath(remoteRoot, 'create-race.tex');
            const originalWriteFromBaseline = vfs.writeFileFromRemoteBaseline.bind(vfs);
            let injectRemoteCreate = true;
            vfs.writeFileFromRemoteBaseline = async (
                uri: vscode.Uri,
                content: Uint8Array,
                remoteBaseline?: Uint8Array,
                expectedRemoteMissing = false,
            ) => {
                if (injectRemoteCreate && uri.toString()===createRaceRemoteUri.toString()) {
                    injectRemoteCreate = false;
                    await writeText(createRaceRemoteUri, 'collaborator won create race');
                }
                return originalWriteFromBaseline(
                    uri,
                    content,
                    remoteBaseline,
                    expectedRemoteMissing,
                );
            };
            const createRaceWait = waitForSyncComplete(
                localRoot,
                '/create-race.tex',
                'push',
                'update',
            );
            await writeText(createRaceUri, 'local create race');
            localWatcher.fireCreate(createRaceUri);
            const createRaceEvent = await createRaceWait;
            assert.strictEqual(createRaceEvent.outcome, 'blocked');
            assert.strictEqual(
                await readText(createRaceRemoteUri),
                'collaborator won create race',
            );
            assert.strictEqual(await readText(createRaceUri), 'local create race');
            assert.strictEqual(internals.syncConflicts.has('/create-race.tex'), true);
            vfs.writeFileFromRemoteBaseline = originalWriteFromBaseline;

            const directoryTypeConflictUri = vscode.Uri.joinPath(localRoot, 'directory-type-conflict');
            const directoryTypeConflictRemoteUri = vscode.Uri.joinPath(
                remoteRoot,
                'directory-type-conflict',
            );
            await writeText(directoryTypeConflictRemoteUri, 'remote file');
            await vscode.workspace.fs.createDirectory(directoryTypeConflictUri);
            const directoryTypeConflictWait = waitForSyncComplete(
                localRoot,
                '/directory-type-conflict',
                'push',
                'update',
            );
            localWatcher.fireCreate(directoryTypeConflictUri);
            const directoryTypeConflictEvent = await directoryTypeConflictWait;
            assert.strictEqual(directoryTypeConflictEvent.outcome, 'blocked');
            assert.strictEqual(
                directoryTypeConflictEvent.error,
                'concurrent untracked path type conflict',
            );
            assert.strictEqual(await readText(directoryTypeConflictRemoteUri), 'remote file');
            assert.strictEqual(
                internals.syncConflicts.has('/directory-type-conflict'),
                true,
            );

            const classifyFailureUri = vscode.Uri.joinPath(localRoot, 'classification-retry.tex');
            const classifyFailureRemoteUri = vscode.Uri.joinPath(remoteRoot, 'classification-retry.tex');
            const classifyBaselineWait = waitForSyncComplete(
                localRoot,
                '/classification-retry.tex',
                'push',
                'update',
            );
            await writeText(classifyFailureUri, 'classification baseline');
            localWatcher.fireCreate(classifyFailureUri);
            assert.strictEqual((await classifyBaselineWait).outcome, 'success');

            const originalReadLocalFile = internals.readLocalFile.bind(scm);
            let failClassificationOnce = true;
            internals.readLocalFile = async (uri: vscode.Uri) => {
                if (
                    failClassificationOnce
                    && uri.toString()===classifyFailureUri.toString()
                ) {
                    failClassificationOnce = false;
                    throw new Error('temporary local classification failure');
                }
                return originalReadLocalFile(uri);
            };
            await writeText(classifyFailureUri, 'classification retry delivered');
            const classificationErrorWait = waitForSyncComplete(
                localRoot,
                '/classification-retry.tex',
                'push',
                'update',
            );
            localWatcher.fireChange(classifyFailureUri);
            assert.strictEqual((await classificationErrorWait).outcome, 'error');
            assert.strictEqual(internals.locallyDivergedPaths.has('/classification-retry.tex'), true);

            const classificationRetryWait = waitForSyncComplete(
                localRoot,
                '/classification-retry.tex',
                'push',
                'update',
            );
            assert.strictEqual((await classificationRetryWait).outcome, 'success');
            assert.strictEqual(
                await readText(classifyFailureRemoteUri),
                'classification retry delivered',
            );
            assert.strictEqual(internals.locallyDivergedPaths.has('/classification-retry.tex'), false);
            internals.readLocalFile = originalReadLocalFile;

            const remoteClassificationRelPath =
                `/${path.basename(remoteEventRoot.fsPath)}/remote-classification-retry.tex`;
            const remoteClassificationUri = vscode.Uri.joinPath(
                remoteEventRoot,
                'remote-classification-retry.tex',
            );
            const localRemoteClassificationUri = vscode.Uri.joinPath(
                localRoot,
                path.basename(remoteEventRoot.fsPath),
                'remote-classification-retry.tex',
            );
            await writeText(remoteClassificationUri, 'remote classification delivered');
            const originalRemoteTargetEventType = internals.remoteTargetEventType.bind(scm);
            let failRemoteClassificationOnce = true;
            internals.remoteTargetEventType = async (uri: vscode.Uri) => {
                if (
                    failRemoteClassificationOnce
                    && uri.toString()===remoteClassificationUri.toString()
                ) {
                    failRemoteClassificationOnce = false;
                    throw new Error('temporary remote classification failure');
                }
                return originalRemoteTargetEventType(uri);
            };
            const remoteClassificationErrorWait = waitForSyncComplete(
                localRoot,
                remoteClassificationRelPath,
                'pull',
                'update',
            );
            vfsWatcher.fireCreate(remoteClassificationUri);
            assert.strictEqual((await remoteClassificationErrorWait).outcome, 'error');

            const remoteClassificationRetryWait = waitForSyncComplete(
                localRoot,
                remoteClassificationRelPath,
                'pull',
                'update',
            );
            assert.strictEqual((await remoteClassificationRetryWait).outcome, 'success');
            assert.strictEqual(
                await readText(localRemoteClassificationUri),
                'remote classification delivered',
            );
            internals.remoteTargetEventType = originalRemoteTargetEventType;
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('does not let a watcher clear a persisted binary conflict without explicit resolution', async () => {
        const remoteRoot = await tempDir('sr-overleaf-conflict-watch-remote-');
        const localRoot = await tempDir('sr-overleaf-conflict-watch-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteFigure = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localFigure = vscode.Uri.joinPath(localRoot, 'figure.png');
        const initialVfs = new FakeVirtualFileSystem(remoteRoot);
        initialVfs.setEntityId('/figure.png', 'figure-v1');
        await writeBytes(remoteFigure, Buffer.from([1, 2, 3]));
        const initialScm = createSCM(remoteRoot, localRoot, initialVfs);
        await initialScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeBytes(localFigure, Buffer.from([1, 2, 4]));
        await writeBytes(remoteFigure, Buffer.from([1, 2, 5]));
        initialVfs.setEntityId('/figure.png', 'figure-v2');
        initialScm.deactivate();

        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };
        const restartedScm = createSCM(remoteRoot, localRoot, initialVfs);
        (restartedScm as any).initializationOptions = {
            preserveExistingLocalFiles: true,
        };
        const triggers = await restartedScm.triggers;
        try {
            assert.strictEqual((restartedScm as any).syncConflicts.has('/figure.png'), true);
            assert.deepStrictEqual(await readBytes(localFigure), Buffer.from([1, 2, 4]));
            assert.deepStrictEqual(await readBytes(remoteFigure), Buffer.from([1, 2, 5]));

            const pushWait = waitForSyncComplete(localRoot, '/figure.png', 'push', 'update');
            await writeBytes(localFigure, Buffer.from([1, 2, 4]));
            watchers[1].fireChange(localFigure);
            const pushEvent = await pushWait;

            assert.strictEqual(pushEvent.outcome, 'blocked');
            assert.strictEqual(pushEvent.error, 'unresolved sync conflict');
            assert.deepStrictEqual(await readBytes(remoteFigure), Buffer.from([1, 2, 5]));
            assert.strictEqual((restartedScm as any).syncConflicts.has('/figure.png'), true);
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('three-way merges quarantined local edits when a failed pull is retried', async () => {
        const remoteRoot = await tempDir('sr-overleaf-retry-merge-remote-');
        const localRoot = await tempDir('sr-overleaf-retry-merge-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'title: base\nbody: base\nfooter: base\n');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        (scm as any).failedInitialPulls.add('/main.tex');
        (scm as any).initialPullStatus = 'partial';
        await writeText(localMain, 'title: local\nbody: base\nfooter: base\n');
        await writeText(remoteMain, 'title: base\nbody: base\nfooter: remote\n');

        const result = await scm.retryFailedInitialPulls();

        assert.deepStrictEqual(result.stillFailed, []);
        assert.deepStrictEqual(result.recovered, ['/main.tex']);
        assert.strictEqual(await readText(localMain), 'title: local\nbody: base\nfooter: remote\n');
        assert.strictEqual(await readText(remoteMain), 'title: local\nbody: base\nfooter: remote\n');
        assert.strictEqual((scm as any).failedInitialPulls.has('/main.tex'), false);
    });

    test('preserves a local copy as a conflict when its failed pull target was deleted remotely', async () => {
        const remoteRoot = await tempDir('sr-overleaf-retry-delete-conflict-remote-');
        const localRoot = await tempDir('sr-overleaf-retry-delete-conflict-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        (scm as any).failedInitialPulls.add('/main.tex');
        (scm as any).initialPullStatus = 'partial';
        await writeText(localMain, 'unverified local edit');
        await vscode.workspace.fs.delete(remoteMain);

        const result = await scm.retryFailedInitialPulls();

        assert.deepStrictEqual(result.recovered, []);
        assert.deepStrictEqual(result.stillFailed, ['/main.tex']);
        assert.strictEqual(await readText(localMain), 'unverified local edit');
        assert.strictEqual((scm as any).failedInitialPulls.has('/main.tex'), true);
        assert.strictEqual((scm as any).syncConflicts.has('/main.tex'), true);
    });

    test('clears a failed pull when both its local and remote paths are already absent', async () => {
        const remoteRoot = await tempDir('sr-overleaf-retry-delete-absent-remote-');
        const localRoot = await tempDir('sr-overleaf-retry-delete-absent-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        (scm as any).failedInitialPulls.add('/main.tex');
        (scm as any).initialPullStatus = 'partial';
        await vscode.workspace.fs.delete(localMain);
        await vscode.workspace.fs.delete(remoteMain);

        const result = await scm.retryFailedInitialPulls();

        assert.deepStrictEqual(result.recovered, ['/main.tex']);
        assert.deepStrictEqual(result.stillFailed, []);
        assert.strictEqual((scm as any).failedInitialPulls.has('/main.tex'), false);
        assert.strictEqual((scm as any).syncConflicts.has('/main.tex'), false);
    });

    test('preserves a closed agent edit that lands immediately before a live pull write', async () => {
        const remoteRoot = await tempDir('sr-overleaf-pull-race-remote-');
        const localRoot = await tempDir('sr-overleaf-pull-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(remoteMain, 'remote collaborator edit');

        const originalGuardedWrite = (scm as any).writeLocalFileIfRevision.bind(scm);
        let injected = false;
        (scm as any).writeLocalFileIfRevision = async (
            relPath: string,
            content: Uint8Array,
            expectedRevision: string,
            generation: number,
        ) => {
            if (!injected && relPath==='/main.tex') {
                injected = true;
                await writeText(localMain, 'closed agent edit during pull');
            }
            return originalGuardedWrite(relPath, content, expectedRevision, generation);
        };

        const event = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(await readText(localMain), 'closed agent edit during pull');
        assert.strictEqual(await readText(remoteMain), 'remote collaborator edit');
        assert.strictEqual((scm as any).syncConflicts.has('/main.tex'), true);
    });

    test('preserves a closed agent edit that appears during the initial pull', async () => {
        const remoteRoot = await tempDir('sr-overleaf-initial-race-remote-');
        const localRoot = await tempDir('sr-overleaf-initial-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'remote initial');
        const scm = createSCM(remoteRoot, localRoot);
        const originalPullRemoteFile = (scm as any).pullRemoteFile.bind(scm);
        let injected = false;
        (scm as any).pullRemoteFile = async (
            relPath: string,
            uri: vscode.Uri,
            generation: number,
        ) => {
            const content = await originalPullRemoteFile(relPath, uri, generation);
            if (!injected && relPath==='/main.tex') {
                injected = true;
                await writeText(localMain, 'closed agent edit during initial pull');
            }
            return content;
        };

        const initialized = await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        assert.strictEqual(initialized, true);
        assert.strictEqual(await readText(localMain), 'closed agent edit during initial pull');
        assert.strictEqual(await readText(remoteMain), 'remote initial');
        assert.strictEqual((scm as any).syncConflicts.has('/main.tex'), true);
    });

    test('blocks a remote folder delete when a closed local child changes after validation', async () => {
        const remoteRoot = await tempDir('sr-overleaf-pull-delete-race-remote-');
        const localRoot = await tempDir('sr-overleaf-pull-delete-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(remoteChapter, {recursive: true});

        const originalHasChanges = (scm as any).localDirectoryHasChanges.bind(scm);
        let injected = false;
        (scm as any).localDirectoryHasChanges = async (relPath: string, generation: number) => {
            const changed = await originalHasChanges(relPath, generation);
            if (!injected && relPath==='/chapter') {
                injected = true;
                await writeText(vscode.Uri.joinPath(localChapter, 'agent-added.tex'), 'preserve me');
            }
            return changed;
        };

        const event = await (scm as any).applySync(
            'pull',
            'delete',
            '/chapter',
            remoteChapter,
            localChapter,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(localChapter, 'agent-added.tex')),
            'preserve me',
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(localChapter, 'main.tex')),
            'baseline',
        );
    });

    test('preserves a changed quarantined inode when its local path is recreated', async () => {
        const remoteRoot = await tempDir('sr-overleaf-local-delete-inode-remote-');
        const localRoot = await tempDir('sr-overleaf-local-delete-inode-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const generation = (scm as any).syncGeneration as number;
        const expected = await (scm as any).captureLocalPathRevision(
            '/main.tex',
            generation,
        );

        const originalCapture = (scm as any).captureLocalUriRevision.bind(scm);
        let injected = false;
        (scm as any).captureLocalUriRevision = async (
            uri: vscode.Uri,
            relPath: string,
            activeGeneration: number,
        ) => {
            const revision = await originalCapture(uri, relPath, activeGeneration);
            if (
                !injected
                && path.basename(uri.fsPath).startsWith('.sr-overleaf-')
                && path.basename(uri.fsPath).endsWith('.deleted')
            ) {
                injected = true;
                await writeText(uri, 'edit through the quarantined inode');
                await writeText(localMain, 'recreated local path');
            }
            return revision;
        };

        const deleted = await (scm as any).atomicDeleteLocalPathIfRevision(
            '/main.tex',
            expected.revision,
            generation,
        );

        assert.strictEqual(deleted, false);
        assert.strictEqual(await readText(localMain), 'recreated local path');
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        const operationEntries = await vscode.workspace.fs.readDirectory(operationsRoot);
        const guardName = operationEntries.find(([name]) => name.endsWith('.guard'))?.[0];
        assert.ok(guardName);
        assert.strictEqual(operationEntries.filter(([name]) => name.endsWith('.json')).length, 1);
        assert.strictEqual(operationEntries.filter(([name]) => name.endsWith('.committed')).length, 1);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(operationsRoot, guardName)),
            'edit through the quarantined inode',
        );

        await assert.rejects(
            () => scm.flushBeforeCompile([]),
            /older local file handle/i,
        );
        assert.strictEqual(
            await readText(localMain),
            'edit through the quarantined inode',
        );
        const recoveryRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'concurrent-recovery',
        );
        const recoveryEntries = await vscode.workspace.fs.readDirectory(recoveryRoot);
        assert.strictEqual(recoveryEntries.length, 1);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(recoveryRoot, recoveryEntries[0][0])),
            'recreated local path',
        );
    });

    test('recovers a journaled local write interrupted after hiding the visible path', async () => {
        const remoteRoot = await tempDir('sr-overleaf-write-crash-remote-');
        const localRoot = await tempDir('sr-overleaf-write-crash-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(remoteMain, 'remote replacement');

        const generation = (firstScm as any).syncGeneration as number;
        const expected = await (firstScm as any).captureLocalPathRevision(
            '/main.tex',
            generation,
        );
        const id = `deadbeef-${Date.now()}-c0ffee00`;
        const stageName = `.sr-overleaf-${id}.new`;
        const backupName = `.sr-overleaf-${id}.old`;
        const record = {
            version: 1,
            id,
            kind: 'write',
            relPath: '/main.tex',
            entityKind: 'file',
            expectedRevision: expected.revision,
            installedRevision: sha1('remote replacement'),
            stageName,
            backupName,
            guardName: `.sr-overleaf-${id}.guard`,
            createdAt: new Date().toISOString(),
        };
        await writeText(vscode.Uri.joinPath(localRoot, stageName), 'remote replacement');
        await (firstScm as any).createLocalOperationRecord(record);
        const backupPath = path.join(localRoot.fsPath, backupName);
        await (firstScm as any).renameDurably(localMain.fsPath, backupPath);
        await fs.writeFile(backupPath, 'agent edit through old inode after crash');
        firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(
            await readText(localMain),
            'agent edit through old inode after crash',
        );
        assert.strictEqual(await readText(remoteMain), 'remote replacement');
        assert.strictEqual((restartedScm as any).syncConflicts.has('/main.tex'), true);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, stageName)), false);
        assert.strictEqual(await pathExists(vscode.Uri.joinPath(localRoot, backupName)), false);
    });

    test('resumes a journaled local delete interrupted after quarantine', async () => {
        const remoteRoot = await tempDir('sr-overleaf-delete-crash-remote-');
        const localRoot = await tempDir('sr-overleaf-delete-crash-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const generation = (firstScm as any).syncGeneration as number;
        const expected = await (firstScm as any).captureLocalPathRevision(
            '/main.tex',
            generation,
        );
        const id = `decafbad-${Date.now()}-f00dbabe`;
        const backupName = `.sr-overleaf-${id}.deleted`;
        const record = {
            version: 1,
            id,
            kind: 'delete',
            relPath: '/main.tex',
            entityKind: 'file',
            expectedRevision: expected.revision,
            backupName,
            guardName: `.sr-overleaf-${id}.guard`,
            createdAt: new Date().toISOString(),
        };
        await (firstScm as any).createLocalOperationRecord(record);
        await (firstScm as any).renameDurably(
            localMain.fsPath,
            path.join(localRoot.fsPath, backupName),
        );
        await vscode.workspace.fs.delete(remoteMain);
        firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await pathExists(localMain), false);
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        await Promise.all([
            ...(restartedScm as any).localGuardCleanupPromises.values(),
        ]);
        const operationEntries = await vscode.workspace.fs.readDirectory(operationsRoot);
        assert.deepStrictEqual(
            operationEntries.filter(([name]) =>
                name.endsWith('.guard')
                || name.endsWith('.json')
                || name.endsWith('.committed')),
            [],
        );
    });

    test('does not revive an unchanged committed write after its parent was deleted', async () => {
        const remoteRoot = await tempDir('sr-overleaf-deleted-parent-remote-');
        const localRoot = await tempDir('sr-overleaf-deleted-parent-local-');
        tempRoots.push(remoteRoot, localRoot);
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const id = `feedface-${Date.now()}-00112233`;
        const record = {
            version: 1,
            id,
            kind: 'write',
            relPath: '/removed/child.tex',
            entityKind: 'file',
            expectedRevision: sha1('original inode'),
            installedRevision: sha1('installed remote bytes'),
            stageName: `.sr-overleaf-${id}.new`,
            backupName: `.sr-overleaf-${id}.old`,
            guardName: `.sr-overleaf-${id}.guard`,
            createdAt: new Date().toISOString(),
        };
        await (firstScm as any).createLocalOperationRecord(record);
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        await writeText(
            vscode.Uri.joinPath(operationsRoot, record.guardName),
            'original inode',
        );
        await (firstScm as any).markLocalOperationCommitted(id);
        await firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(localRoot, 'removed')),
            false,
        );
        await Promise.all([
            ...(restartedScm as any).localGuardCleanupPromises.values(),
        ]);
        const remainingEntries = await vscode.workspace.fs.readDirectory(operationsRoot);
        assert.deepStrictEqual(
            remainingEntries.filter(([name]) =>
                name.endsWith('.guard')
                || name.endsWith('.json')
                || name.endsWith('.committed')),
            [],
        );
    });

    test('restores a changed committed inode when its deleted parent is missing', async () => {
        const remoteRoot = await tempDir('sr-overleaf-changed-parent-remote-');
        const localRoot = await tempDir('sr-overleaf-changed-parent-local-');
        tempRoots.push(remoteRoot, localRoot);
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const id = `facefeed-${Date.now()}-44556677`;
        const record = {
            version: 1,
            id,
            kind: 'write',
            relPath: '/removed/child.tex',
            entityKind: 'file',
            expectedRevision: sha1('original inode'),
            installedRevision: sha1('installed remote bytes'),
            stageName: `.sr-overleaf-${id}.new`,
            backupName: `.sr-overleaf-${id}.old`,
            guardName: `.sr-overleaf-${id}.guard`,
            createdAt: new Date().toISOString(),
        };
        await (firstScm as any).createLocalOperationRecord(record);
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        await writeText(
            vscode.Uri.joinPath(operationsRoot, record.guardName),
            'late write through old inode',
        );
        await (firstScm as any).markLocalOperationCommitted(id);
        await firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            false,
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(localRoot, 'removed', 'child.tex')),
            'late write through old inode',
        );
        assert.strictEqual(
            (restartedScm as any).syncConflicts.has('/removed/child.tex'),
            true,
        );
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(remoteRoot, 'removed')),
            false,
        );
    });

    test('restores a changed open inode to the visible local path during a pull', async () => {
        const remoteRoot = await tempDir('sr-overleaf-local-write-inode-remote-');
        const localRoot = await tempDir('sr-overleaf-local-write-inode-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(remoteMain, 'remote collaborator edit');

        const originalReadStaging = (scm as any).readLocalStagingFile.bind(scm);
        let injected = false;
        (scm as any).readLocalStagingFile = async (stagingPath: string) => {
            const content = await originalReadStaging(stagingPath);
            if (!injected && stagingPath.endsWith('.old')) {
                injected = true;
                await fs.writeFile(stagingPath, 'agent edit through the original open inode');
            }
            return content;
        };

        const event = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(
            await readText(localMain),
            'agent edit through the original open inode',
        );
        assert.strictEqual(await readText(remoteMain), 'remote collaborator edit');
        assert.strictEqual((scm as any).syncConflicts.has('/main.tex'), true);
        const localEntries = await fs.readdir(localRoot.fsPath);
        assert.deepStrictEqual(
            localEntries.filter(name => name.startsWith('.sr-overleaf-')),
            [],
        );
    });

    test('falls back to an exclusive copy when the local filesystem rejects hard links', async () => {
        const remoteRoot = await tempDir('sr-overleaf-hardlink-fallback-remote-');
        const localRoot = await tempDir('sr-overleaf-hardlink-fallback-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(remoteMain, 'remote update on a hard-link-less filesystem');

        (scm as any).linkStagedFileWithoutOverwrite = async () => {
            const error = new Error('hard links unsupported') as NodeJS.ErrnoException;
            error.code = 'EXDEV';
            throw error;
        };
        const event = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(
            await readText(localMain),
            'remote update on a hard-link-less filesystem',
        );
        const localEntries = await fs.readdir(localRoot.fsPath);
        assert.deepStrictEqual(
            localEntries.filter(name => name.startsWith('.sr-overleaf-')),
            [],
        );
    });

    test('detects writes through the retained inode after a copied pull has completed', async () => {
        const remoteRoot = await tempDir('sr-overleaf-post-write-guard-remote-');
        const localRoot = await tempDir('sr-overleaf-post-write-guard-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(remoteMain, 'remote update');
        (scm as any).linkStagedFileWithoutOverwrite = async () => {
            const error = new Error('hard links unsupported') as NodeJS.ErrnoException;
            error.code = 'EXDEV';
            throw error;
        };
        let descriptorOpen = true;
        (scm as any).retainedPathHasOpenFileDescriptor = async () => descriptorOpen;

        const event = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(event.outcome, 'success');
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        const operationEntries = await vscode.workspace.fs.readDirectory(operationsRoot);
        const guardName = operationEntries.find(([name]) => name.endsWith('.guard'))?.[0];
        assert.ok(guardName);
        await writeText(
            vscode.Uri.joinPath(operationsRoot, guardName),
            'late agent edit through retained inode',
        );
        descriptorOpen = false;

        await assert.rejects(
            () => scm.flushBeforeCompile([]),
            /older local file handle/i,
        );
        assert.strictEqual(
            await readText(localMain),
            'late agent edit through retained inode',
        );
        assert.strictEqual(await readText(remoteMain), 'remote update');
    });

    test('releases an unchanged Linux inode guard only after its open handle closes', async () => {
        if (process.platform!=='linux') { return; }
        const remoteRoot = await tempDir('sr-overleaf-open-guard-remote-');
        const localRoot = await tempDir('sr-overleaf-open-guard-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(remoteMain, 'remote update');
        const openGuard = await fs.open(localMain.fsPath, 'r');
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        let descriptorOpen = true;
        try {
            const event = await (scm as any).applySync(
                'pull',
                'update',
                '/main.tex',
                remoteMain,
                localMain,
            ) as Events['scmSyncCompleteEvent'];
            assert.strictEqual(event.outcome, 'success');

            const operationEntries = await vscode.workspace.fs.readDirectory(operationsRoot);
            const guardName = operationEntries.find(([name]) => name.endsWith('.guard'))?.[0];
            assert.ok(guardName);
            const guardPath = path.join(operationsRoot.fsPath, guardName);
            assert.strictEqual(
                await (scm as any).retainedPathHasOpenFileDescriptor(guardPath),
                true,
            );
            (scm as any).retainedPathHasOpenFileDescriptor = async () => descriptorOpen;
            await scm.flushBeforeCompile([]);
            await Promise.all([
                ...(scm as any).localGuardCleanupPromises.values(),
            ]);
            assert.strictEqual(await pathExists(vscode.Uri.file(guardPath)), true);
        } finally {
            await openGuard.close();
            descriptorOpen = false;
        }

        await scm.flushBeforeCompile([]);
        await Promise.all([
            ...(scm as any).localGuardCleanupPromises.values(),
        ]);
        const remainingEntries = await vscode.workspace.fs.readDirectory(operationsRoot);
        assert.deepStrictEqual(
            remainingEntries.filter(([name]) =>
                name.endsWith('.guard')
                || name.endsWith('.json')
                || name.endsWith('.committed')),
            [],
        );
    });

    test('detects writes through a retained inode after local deletion completed', async () => {
        const remoteRoot = await tempDir('sr-overleaf-post-delete-guard-remote-');
        const localRoot = await tempDir('sr-overleaf-post-delete-guard-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(remoteMain);
        let descriptorOpen = true;
        (scm as any).retainedPathHasOpenFileDescriptor = async () => descriptorOpen;
        const event = await (scm as any).applySync(
            'pull',
            'delete',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(event.outcome, 'success');

        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        const operationEntries = await vscode.workspace.fs.readDirectory(operationsRoot);
        const guardName = operationEntries.find(([name]) => name.endsWith('.guard'))?.[0];
        assert.ok(guardName);
        await writeText(
            vscode.Uri.joinPath(operationsRoot, guardName),
            'late edit after delete',
        );
        descriptorOpen = false;

        await assert.rejects(
            () => scm.flushBeforeCompile([]),
            /older local file handle/i,
        );
        assert.strictEqual(await readText(localMain), 'late edit after delete');
        assert.strictEqual(await pathExists(remoteMain), false);
    });

    test('surfaces rollback failure and moves the original bytes to deterministic recovery', async () => {
        const remoteRoot = await tempDir('sr-overleaf-rollback-failure-remote-');
        const localRoot = await tempDir('sr-overleaf-rollback-failure-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline to recover');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const generation = (scm as any).syncGeneration as number;
        const expected = await (scm as any).captureLocalPathRevision('/main.tex', generation);

        (scm as any).installStagedFileWithoutOverwrite = async () => {
            const error = new Error('simulated filesystem install failure') as NodeJS.ErrnoException;
            error.code = 'EIO';
            throw error;
        };

        await assert.rejects(
            () => (scm as any).atomicWriteLocalFileIfRevision(
                '/main.tex',
                Buffer.from('remote replacement'),
                expected.revision,
                generation,
            ),
            /atomic write cleanup failed.*original bytes were recovered/i,
        );
        assert.strictEqual(await pathExists(localMain), false);
        const rootEntries = await fs.readdir(localRoot.fsPath);
        assert.deepStrictEqual(
            rootEntries.filter(name => name.endsWith('.old') || name.endsWith('.new')),
            [],
        );
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        const operationEntries = await vscode.workspace.fs.readDirectory(operationsRoot);
        const guardName = operationEntries.find(([name]) => name.endsWith('.guard'))?.[0];
        assert.ok(guardName);
        assert.strictEqual(operationEntries.filter(([name]) => name.endsWith('.json')).length, 1);
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(operationsRoot, guardName)),
            'baseline to recover',
        );

        scm.deactivate();
        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await readText(localMain), 'baseline to recover');
        const recoveredEntries = await vscode.workspace.fs.readDirectory(operationsRoot);
        assert.deepStrictEqual(
            recoveredEntries.filter(([name]) =>
                name.endsWith('.json')
                || name.endsWith('.committed')
                || name.endsWith('.guard')),
            [],
        );
    });

    test('journals an exact folder identity before staging a local recursive delete', async () => {
        const remoteRoot = await tempDir('sr-overleaf-rmdir-journal-remote-');
        const localRoot = await tempDir('sr-overleaf-rmdir-journal-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'baseline');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('chapter', 'chapter-folder-id');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localChapter, {recursive: true});

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let enterStage!: () => void;
        let releaseStage!: () => void;
        const stageEntered = new Promise<void>(resolve => { enterStage = resolve; });
        const stageRelease = new Promise<void>(resolve => { releaseStage = resolve; });
        (fakeVfs as any).rename = async (...args: any[]) => {
            if (args[3]?.type==='folder') {
                enterStage();
                await stageRelease;
            }
            return (originalRename as any)(...args);
        };

        const internals = scm as any;
        const sync = internals.applySync(
            'push', 'delete', '/chapter', localChapter, remoteChapter,
        ) as Promise<Events['scmSyncCompleteEvent']>;
        await stageEntered;
        const pending = internals.syncManifest.pendingOperations['/chapter'];
        assert.strictEqual(pending.kind, 'rmdir');
        assert.deepStrictEqual(pending.targetEntity, {id: 'chapter-folder-id', type: 'folder'});
        assert.deepStrictEqual(pending.parentEntity, {id: '/', type: 'folder'});
        const operation = JSON.parse(await fs.readFile(
            internals.remoteDeleteOperationRecordPath(pending.stageOperationId), 'utf8',
        ));
        assert.deepStrictEqual(operation.folderGuard, {
            entity: {id: 'chapter-folder-id', type: 'folder'},
            parent: {id: '/', type: 'folder'},
            pendingOperationId: pending.id,
        });
        assert.strictEqual(await readText(vscode.Uri.joinPath(remoteChapter, 'main.tex')), 'baseline');

        releaseStage();
        const event = await sync;
        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(await pathExists(remoteChapter), false);
        assert.strictEqual(internals.syncManifest.pendingOperations['/chapter'], undefined);
    });
    test('replays a journaled local folder delete on reconnect without another watcher event', async () => {
        const remoteRoot = await tempDir('sr-overleaf-rmdir-reconnect-remote-');
        const localRoot = await tempDir('sr-overleaf-rmdir-reconnect-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'baseline');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const triggers = await scm.triggers;
        const internals = scm as any;
        // This test injects the durable intent itself; suppress the unrelated
        // filesystem-watch echo so the reconnect path is the sole actor.
        const originalSyncToVFS = internals.syncToVFS;
        internals.syncToVFS = () => Promise.resolve();
        try {
            await vscode.workspace.fs.delete(localChapter, {recursive: true});
            fakeVfs.setConnectionState('disconnected');
            const pending = await internals.journalPendingLocalDirectoryDelete('/chapter');
            assert.strictEqual(pending.kind, 'rmdir');
            assert.strictEqual(scm.status.status, 'offline');
            assert.strictEqual(await pathExists(remoteChapter), true);

            fakeVfs.setConnectionState('connected');
            await waitUntil(() => (
                internals.syncManifest.pendingOperations['/chapter']===undefined
                && scm.status.status==='idle'
            ));
            assert.strictEqual(await pathExists(remoteChapter), false);
            assert.strictEqual(internals.syncConflicts.has('/chapter'), false);
        } finally {
            internals.syncToVFS = originalSyncToVFS;
            triggers.forEach(trigger => trigger.dispose());
        }
    });
    test('blocks a same-tree remote folder replacement with a different entity id', async () => {
        const remoteRoot = await tempDir('sr-overleaf-rmdir-replacement-remote-');
        const localRoot = await tempDir('sr-overleaf-rmdir-replacement-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'baseline');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('chapter', 'chapter-original-id');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localChapter, {recursive: true});

        const originalHasChanges = (scm as any).remoteDirectoryHasChanges.bind(scm);
        let replaced = false;
        (scm as any).remoteDirectoryHasChanges = async (relPath: string, generation: number) => {
            const changed = await originalHasChanges(relPath, generation);
            if (!replaced && relPath==='/chapter') {
                replaced = true;
                await vscode.workspace.fs.delete(remoteChapter, {recursive: true});
                await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'baseline');
                fakeVfs.setEntityId('chapter', 'chapter-replacement-id');
            }
            return changed;
        };

        const event = await (scm as any).applySync(
            'push', 'delete', '/chapter', localChapter, remoteChapter,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(replaced, true);
        assert.strictEqual(await readText(vscode.Uri.joinPath(remoteChapter, 'main.tex')), 'baseline');
        const resolved = await fakeVfs._resolveUri(remoteChapter);
        assert.strictEqual(resolved.fileEntity._id, 'chapter-replacement-id');
        assert.strictEqual((scm as any).syncManifest.pendingOperations['/chapter'].kind, 'rmdir');
        assert.strictEqual((scm as any).syncConflicts.has('/chapter'), true);
    });
    test('checks the recorded folder parent immediately before staging', async () => {
        const remoteRoot = await tempDir('sr-overleaf-rmdir-parent-guard-remote-');
        const localRoot = await tempDir('sr-overleaf-rmdir-parent-guard-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'baseline');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('', 'root-parent-before-stage');
        fakeVfs.setEntityId('chapter', 'chapter-parent-guard-id');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localChapter, {recursive: true});

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let parentChangedAtMutationBoundary = false;
        (fakeVfs as any).rename = async (...args: any[]) => {
            if (!parentChangedAtMutationBoundary && args[3]?.type==='folder') {
                parentChangedAtMutationBoundary = true;
                fakeVfs.setEntityId('', 'root-parent-replaced-before-stage');
            }
            return (originalRename as any)(...args);
        };

        const event = await (scm as any).applySync(
            'push', 'delete', '/chapter', localChapter, remoteChapter,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(parentChangedAtMutationBoundary, true);
        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(await readText(vscode.Uri.joinPath(remoteChapter, 'main.tex')), 'baseline');
        assert.strictEqual((await fakeVfs._resolveUri(remoteChapter)).fileEntity._id, 'chapter-parent-guard-id');
        assert.strictEqual((scm as any).syncConflicts.has('/chapter'), true);
    });
    test('accepts a guarded folder delete when its final delete response is lost', async () => {
        const remoteRoot = await tempDir('sr-overleaf-rmdir-delete-response-remote-');
        const localRoot = await tempDir('sr-overleaf-rmdir-delete-response-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'baseline');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localChapter, {recursive: true});

        const originalRemove = fakeVfs.remove.bind(fakeVfs);
        let loseResponseOnce = true;
        let removeCalls = 0;
        (fakeVfs as any).remove = async (...args: any[]) => {
            removeCalls += 1;
            await (originalRemove as any)(...args);
            if (loseResponseOnce) {
                loseResponseOnce = false;
                throw new Error('simulated lost guarded folder delete response');
            }
        };

        const event = await (scm as any).applySync(
            'push', 'delete', '/chapter', localChapter, remoteChapter,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(removeCalls, 1);
        assert.strictEqual(await pathExists(remoteChapter), false);
        assert.strictEqual((scm as any).syncManifest.pendingOperations['/chapter'], undefined);
    });
    test('restores a staged folder after restart when the local folder was recreated', async () => {
        const remoteRoot = await tempDir('sr-overleaf-rmdir-restart-recreate-remote-');
        const localRoot = await tempDir('sr-overleaf-rmdir-restart-recreate-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'remote baseline');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('chapter', 'chapter-recovery-id');
        const first = createSCM(remoteRoot, localRoot, fakeVfs);
        await first.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localChapter, {recursive: true});

        const firstInternals = first as any;
        const pending = await firstInternals.journalPendingLocalDirectoryDelete('/chapter');
        await firstInternals.createRemoteDeleteOperationRecord({
            version: 1,
            id: pending.stageOperationId,
            relPath: '/chapter',
            stagingRelPath: pending.stagingRelPath,
            expectedRevision: pending.remoteRevision,
            folderGuard: {
                entity: pending.targetEntity,
                parent: pending.parentEntity,
                pendingOperationId: pending.id,
            },
            createdAt: new Date().toISOString(),
        });
        await fakeVfs.rename(
            remoteChapter,
            fakeVfs.pathToUri(pending.stagingRelPath),
            false,
            {id: 'chapter-recovery-id', type: 'folder'},
        );
        first.deactivate();

        await writeText(vscode.Uri.joinPath(localChapter, 'local-recreated.tex'), 'local recreation');
        const restarted = createSCM(remoteRoot, localRoot, fakeVfs);
        assert.strictEqual(
            await restarted.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(localChapter, 'local-recreated.tex')),
            'local recreation',
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteChapter, 'main.tex')),
            'remote baseline',
        );
        assert.strictEqual((restarted as any).syncConflicts.has('/chapter'), true);
        assert.strictEqual(
            await pathExists(fakeVfs.pathToUri(pending.stagingRelPath)),
            false,
        );
    });
    test('accepts a guarded folder delete when its staging rename response is lost', async () => {
        const remoteRoot = await tempDir('sr-overleaf-rmdir-rename-response-remote-');
        const localRoot = await tempDir('sr-overleaf-rmdir-rename-response-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'baseline');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('chapter', 'chapter-rename-response-id');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localChapter, {recursive: true});

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let loseResponseOnce = true;
        let renameCalls = 0;
        (fakeVfs as any).rename = async (...args: any[]) => {
            renameCalls += 1;
            await (originalRename as any)(...args);
            if (loseResponseOnce) {
                loseResponseOnce = false;
                throw new Error('simulated lost guarded folder stage response');
            }
        };

        const event = await (scm as any).applySync(
            'push', 'delete', '/chapter', localChapter, remoteChapter,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(renameCalls, 1);
        assert.strictEqual(await pathExists(remoteChapter), false);
        assert.strictEqual((scm as any).syncManifest.pendingOperations['/chapter'], undefined);
    });
    test('blocks a local folder delete when Overleaf changes after remote validation', async () => {
        const remoteRoot = await tempDir('sr-overleaf-push-delete-race-remote-');
        const localRoot = await tempDir('sr-overleaf-push-delete-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        await writeText(vscode.Uri.joinPath(remoteChapter, 'main.tex'), 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        assert.strictEqual((scm as any).isTrackedDirectory('/chapter'), true);
        assert.ok((scm as any).syncManifest?.directories['/chapter']?.remoteEntity);
        await vscode.workspace.fs.delete(localChapter, {recursive: true});

        const originalHasChanges = (scm as any).remoteDirectoryHasChanges.bind(scm);
        let injected = false;
        (scm as any).remoteDirectoryHasChanges = async (relPath: string, generation: number) => {
            const changed = await originalHasChanges(relPath, generation);
            if (!injected && relPath==='/chapter') {
                injected = true;
                await writeText(vscode.Uri.joinPath(remoteChapter, 'collaborator.tex'), 'preserve remote');
            }
            return changed;
        };

        const event = await (scm as any).applySync(
            'push',
            'delete',
            '/chapter',
            localChapter,
            remoteChapter,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(injected, true, 'the remote-validation race hook must have run');
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteChapter, 'collaborator.tex')),
            'preserve remote',
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(remoteChapter, 'main.tex')),
            'baseline',
        );
    });

    test('restores a remotely staged file when Overleaf changes during local delete', async () => {
        const remoteRoot = await tempDir('sr-overleaf-atomic-delete-remote-');
        const localRoot = await tempDir('sr-overleaf-atomic-delete-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localMain);

        const originalCapture = (scm as any).captureRemoteUriRevision.bind(scm);
        let injected = false;
        (scm as any).captureRemoteUriRevision = async (
            uri: vscode.Uri,
            relPath: string,
            generation: number,
        ) => {
            const revision = await originalCapture(uri, relPath, generation);
            if (
                !injected
                && revision.kind!=='missing'
                && path.basename(uri.fsPath).startsWith('.sr-overleaf-delete-')
            ) {
                injected = true;
                await writeText(uri, 'remote collaborator edit during staging');
            }
            return revision;
        };

        const event = await (scm as any).applySync(
            'push',
            'delete',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(await readText(remoteMain), 'remote collaborator edit during staging');
        assert.strictEqual((scm as any).syncConflicts.has('/main.tex'), true);
        const remoteEntries = await vscode.workspace.fs.readDirectory(remoteRoot);
        assert.deepStrictEqual(
            remoteEntries.filter(([name]) => name.startsWith('.sr-overleaf-delete-')),
            [],
        );
    });

    test('resumes the same remote delete stage when the rename response is lost', async () => {
        const remoteRoot = await tempDir('sr-overleaf-delete-response-remote-');
        const localRoot = await tempDir('sr-overleaf-delete-response-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localMain);

        const originalRename = (scm as any).renameRemotePathForDelete.bind(scm);
        const originalCapture = (scm as any).captureRemoteUriRevision.bind(scm);
        let loseResponseOnce = true;
        let staleCache = false;
        let reconnectCount = 0;
        const stagingUris: string[] = [];
        (fakeVfs as any).reconnect = async () => {
            reconnectCount += 1;
            staleCache = false;
            return {} as any;
        };
        (scm as any).captureRemoteUriRevision = async (
            uri: vscode.Uri,
            relPath: string,
            generation: number,
        ) => {
            if (staleCache) {
                if (path.basename(uri.fsPath).startsWith('.sr-overleaf-delete-')) {
                    return {kind: 'missing', revision: '\0'};
                }
                return {
                    kind: 'file',
                    revision: sha1('baseline'),
                    content: Buffer.from('baseline'),
                };
            }
            return originalCapture(uri, relPath, generation);
        };
        (scm as any).renameRemotePathForDelete = async (
            targetUri: vscode.Uri,
            stagingUri: vscode.Uri,
            generation: number,
        ) => {
            stagingUris.push(stagingUri.toString());
            await originalRename(targetUri, stagingUri, generation);
            if (loseResponseOnce) {
                loseResponseOnce = false;
                staleCache = true;
                throw new Error('simulated lost rename response');
            }
        };

        const event = await (scm as any).applySync(
            'push',
            'delete',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(await pathExists(remoteMain), false);
        assert.strictEqual(new Set(stagingUris).size, 1);
        assert.ok(reconnectCount>=1);
        const remoteEntries = await vscode.workspace.fs.readDirectory(remoteRoot);
        assert.deepStrictEqual(
            remoteEntries.filter(([name]) => name.startsWith('.sr-overleaf-delete-')),
            [],
        );
    });

    test('preserves an identity-less legacy delete stage as a durable conflict after reactivation', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-delete-crash-remote-');
        const localRoot = await tempDir('sr-overleaf-remote-delete-crash-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const generation = (firstScm as any).syncGeneration as number;
        const expected = await (firstScm as any).captureRemotePathRevision(
            '/main.tex',
            generation,
        );
        // Serialized exactly as a release-v0.16.1 file-delete journal. Do
        // not derive it through the current helper: an upgrade must recover
        // the old stage naming convention byte-for-byte.
        const operationId = sha1(`/main.tex\0${expected.revision}`).slice(0, 24);
        const stagingRelPath = `/.sr-overleaf-delete-${operationId}`;
        await (firstScm as any).createRemoteDeleteOperationRecord({
            version: 1,
            id: operationId,
            relPath: '/main.tex',
            stagingRelPath,
            expectedRevision: expected.revision,
            createdAt: new Date().toISOString(),
        });
        await vscode.workspace.fs.rename(
            remoteMain,
            (firstScm as any).vfs.pathToUri(stagingRelPath),
            {overwrite: false},
        );
        await vscode.workspace.fs.delete(localMain);
        firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await pathExists(remoteMain), false);
        assert.strictEqual(
            await pathExists((restartedScm as any).vfs.pathToUri(stagingRelPath)),
            true,
        );
        assert.strictEqual((restartedScm as any).syncConflicts.has('/main.tex'), true);
        const journalRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'remote-delete-operations',
        );
        const journalEntries = await vscode.workspace.fs.readDirectory(journalRoot);
        assert.strictEqual(journalEntries.filter(([name]) => name.endsWith('.json')).length, 1);
    });

    test('rolls back a legacy staged binary without accepting its local replacement', async () => {
        const remoteRoot = await tempDir('sr-overleaf-binary-replace-crash-remote-');
        const localRoot = await tempDir('sr-overleaf-binary-replace-crash-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const baseline = Buffer.from([1, 2, 3]);
        const replacement = Buffer.from([9, 8, 7, 6]);
        await writeBytes(remoteImage, baseline);
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, replacement);

        const generation = (firstScm as any).syncGeneration as number;
        const expected = await (firstScm as any).captureRemotePathRevision(
            '/figure.png',
            generation,
        );
        const operationId = (firstScm as any).remoteReplacementOperationId(
            '/figure.png',
            expected.revision,
            sha1(replacement),
        );
        const stagingRelPath = (firstScm as any).remoteReplacementStagingPath(
            '/figure.png',
            expected.revision,
            sha1(replacement),
        );
        await (firstScm as any).createRemoteDeleteOperationRecord({
            version: 1,
            id: operationId,
            kind: 'replace',
            relPath: '/figure.png',
            stagingRelPath,
            expectedRevision: expected.revision,
            replacementRevision: sha1(replacement),
            createdAt: new Date().toISOString(),
        });
        await vscode.workspace.fs.rename(
            remoteImage,
            (firstScm as any).vfs.pathToUri(stagingRelPath),
            {overwrite: false},
        );
        firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );

        assert.deepStrictEqual(await readBytes(remoteImage), baseline);
        assert.deepStrictEqual(await readBytes(localImage), replacement);
        assert.strictEqual(
            await pathExists((restartedScm as any).vfs.pathToUri(stagingRelPath)),
            false,
        );
        assert.strictEqual((restartedScm as any).syncConflicts.has('/figure.png'), true);
        const journalRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'remote-delete-operations',
        );
        const journalEntries = await vscode.workspace.fs.readDirectory(journalRoot);
        assert.deepStrictEqual(journalEntries.filter(([name]) => name.endsWith('.json')), []);
    });

    test('blocks a binary replacement when a same-byte collaborator entity replaces the target at the guarded stage', async () => {
        const remoteRoot = await tempDir('sr-overleaf-binary-entity-race-remote-');
        const localRoot = await tempDir('sr-overleaf-binary-entity-race-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const baseline = Buffer.from([1, 2, 3]);
        const localReplacement = Buffer.from([9, 8, 7, 6]);
        await writeBytes(remoteImage, baseline);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('', 'binary-replace-parent-original');
        fakeVfs.setEntityId('figure.png', 'binary-replace-original');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, localReplacement);

        const originalRename = fakeVfs.rename.bind(fakeVfs);
        let replacementInjected = false;
        let guardedRenameObserved = false;
        (fakeVfs as any).rename = async (...args: any[]) => {
            const [targetUri, _stagingUri, _force, expectedEntity] = args;
            if (
                !replacementInjected
                && targetUri.toString()===remoteImage.toString()
                && expectedEntity?.id==='binary-replace-original'
            ) {
                guardedRenameObserved = true;
                replacementInjected = true;
                await vscode.workspace.fs.delete(remoteImage);
                await writeBytes(remoteImage, baseline);
                fakeVfs.setEntityId('figure.png', 'binary-replace-collaborator');
            }
            return (originalRename as any)(...args);
        };

        const event = await (scm as any).applySync(
            'push', 'update', '/figure.png', localImage, remoteImage,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(guardedRenameObserved, true);
        assert.strictEqual(replacementInjected, true);
        assert.strictEqual(event.outcome, 'blocked');
        assert.deepStrictEqual(await readBytes(localImage), localReplacement);
        assert.deepStrictEqual(await readBytes(remoteImage), baseline);
        assert.strictEqual(
            (await fakeVfs._resolveUri(remoteImage)).fileEntity._id,
            'binary-replace-collaborator',
        );
        assert.strictEqual((scm as any).syncConflicts.has('/figure.png'), true);
        const pending = (scm as any).syncManifest.pendingOperations['/figure.png'];
        assert.strictEqual(pending.kind, 'update');
        assert.deepStrictEqual(pending.targetEntity, {id: 'binary-replace-original', type: 'file'});
        assert.deepStrictEqual(pending.parentEntity, {id: 'binary-replace-parent-original', type: 'folder'});
    });

    test('sends the original entity identity when staging and removing a normal binary replacement', async () => {
        const remoteRoot = await tempDir('sr-overleaf-binary-guard-positive-remote-');
        const localRoot = await tempDir('sr-overleaf-binary-guard-positive-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const baseline = Buffer.from([1, 2, 3]);
        const replacement = Buffer.from([9, 8, 7, 6]);
        await writeBytes(remoteImage, baseline);
        const fakeVfs = new FakeVirtualFileSystem(remoteRoot);
        fakeVfs.setEntityId('', 'binary-replace-positive-parent');
        fakeVfs.setEntityId('figure.png', 'binary-replace-positive-original');
        const scm = createSCM(remoteRoot, localRoot, fakeVfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, replacement);

        const renameExpectedEntities: unknown[] = [];
        const removeExpectedEntities: unknown[] = [];
        const originalRename = fakeVfs.rename.bind(fakeVfs);
        const originalRemove = fakeVfs.remove.bind(fakeVfs);
        (fakeVfs as any).rename = async (...args: any[]) => {
            renameExpectedEntities.push(args[3]);
            return (originalRename as any)(...args);
        };
        (fakeVfs as any).remove = async (...args: any[]) => {
            removeExpectedEntities.push(args[2]);
            return (originalRemove as any)(...args);
        };

        const event = await (scm as any).applySync(
            'push', 'update', '/figure.png', localImage, remoteImage,
        ) as Events['scmSyncCompleteEvent'];

        const expectedEntity = {
            id: 'binary-replace-positive-original',
            type: 'file',
            parentId: 'binary-replace-positive-parent',
        };
        assert.strictEqual(event.outcome, 'success');
        assert.deepStrictEqual(renameExpectedEntities, [expectedEntity]);
        assert.deepStrictEqual(removeExpectedEntities, [expectedEntity]);
        assert.deepStrictEqual(await readBytes(remoteImage), replacement);
        assert.deepStrictEqual((scm as any).syncManifest.pendingOperations, {});
    });

    test('finishes binary replacement cleanup after restart', async () => {
        const remoteRoot = await tempDir('sr-overleaf-binary-cleanup-crash-remote-');
        const localRoot = await tempDir('sr-overleaf-binary-cleanup-crash-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const replacement = Buffer.from([9, 8, 7, 6]);
        await writeBytes(remoteImage, Buffer.from([1, 2, 3]));
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, replacement);

        const originalCleanup = (firstScm as any).removeRemoteReplacementStage.bind(firstScm);
        let retainStage = true;
        (firstScm as any).removeRemoteReplacementStage = async (...args: unknown[]) => {
            if (retainStage) {
                retainStage = false;
                return false;
            }
            return originalCleanup(...args);
        };
        const pushed = await (firstScm as any).applySync(
            'push',
            'update',
            '/figure.png',
            localImage,
            remoteImage,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(pushed.outcome, 'success');
        assert.deepStrictEqual(await readBytes(remoteImage), replacement);
        let remoteEntries = await vscode.workspace.fs.readDirectory(remoteRoot);
        assert.strictEqual(
            remoteEntries.filter(([name]) => name.startsWith('.sr-overleaf-replace-')).length,
            1,
        );
        firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.deepStrictEqual(await readBytes(remoteImage), replacement);
        remoteEntries = await vscode.workspace.fs.readDirectory(remoteRoot);
        assert.deepStrictEqual(
            remoteEntries.filter(([name]) => name.startsWith('.sr-overleaf-replace-')),
            [],
        );
        const journalRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'remote-delete-operations',
        );
        const journalEntries = await vscode.workspace.fs.readDirectory(journalRoot);
        assert.deepStrictEqual(journalEntries.filter(([name]) => name.endsWith('.json')), []);
    });

    test('restores a changed replacement stage to its visible path before blocking recovery', async () => {
        const remoteRoot = await tempDir('sr-overleaf-binary-changed-stage-remote-');
        const localRoot = await tempDir('sr-overleaf-binary-changed-stage-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const baseline = Buffer.from([1, 2, 3]);
        const replacement = Buffer.from([9, 8, 7]);
        const collaboratorStage = Buffer.from([4, 5, 6]);
        await writeBytes(remoteImage, baseline);
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, replacement);
        const generation = (firstScm as any).syncGeneration as number;
        const operationId = (firstScm as any).remoteReplacementOperationId(
            '/figure.png',
            sha1(baseline),
            sha1(replacement),
        );
        const stagingRelPath = (firstScm as any).remoteReplacementStagingPath(
            '/figure.png',
            sha1(baseline),
            sha1(replacement),
        );
        const stagingUri = (firstScm as any).vfs.pathToUri(stagingRelPath);
        await (firstScm as any).createRemoteDeleteOperationRecord({
            version: 1,
            id: operationId,
            kind: 'replace',
            relPath: '/figure.png',
            stagingRelPath,
            expectedRevision: sha1(baseline),
            replacementRevision: sha1(replacement),
            createdAt: new Date().toISOString(),
        });
        await vscode.workspace.fs.rename(remoteImage, stagingUri, {overwrite: false});
        await writeBytes(stagingUri, collaboratorStage);
        firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.deepStrictEqual(await readBytes(remoteImage), collaboratorStage);
        assert.strictEqual(await pathExists(stagingUri), false);
        assert.strictEqual((restartedScm as any).syncConflicts.has('/figure.png'), true);
        const journalRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'remote-delete-operations',
        );
        const journalEntries = await vscode.workspace.fs.readDirectory(journalRoot);
        assert.deepStrictEqual(journalEntries.filter(([name]) => name.endsWith('.json')), []);
    });

    test('keeps a superseded cleanup journal from reviving an already resolved conflict', async () => {
        const remoteRoot = await tempDir('sr-overleaf-binary-superseded-remote-');
        const localRoot = await tempDir('sr-overleaf-binary-superseded-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const baseline = Buffer.from([1, 2, 3]);
        const firstReplacement = Buffer.from([4, 5, 6]);
        const finalReplacement = Buffer.from([7, 8, 9]);
        await writeBytes(remoteImage, baseline);
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const originalCleanup = (firstScm as any).removeRemoteReplacementStage.bind(firstScm);
        let retainFirstStage = true;
        (firstScm as any).removeRemoteReplacementStage = async (...args: unknown[]) => {
            if (retainFirstStage) {
                retainFirstStage = false;
                return false;
            }
            return originalCleanup(...args);
        };
        await writeBytes(localImage, firstReplacement);
        const firstPush = await (firstScm as any).applySync(
            'push',
            'update',
            '/figure.png',
            localImage,
            remoteImage,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(firstPush.outcome, 'success');
        const firstStageName = (await vscode.workspace.fs.readDirectory(remoteRoot))
            .find(([name]) => name.startsWith('.sr-overleaf-replace-'))?.[0];
        assert.ok(firstStageName);

        (firstScm as any).removeRemoteReplacementStage = async (
            stagingUri: vscode.Uri,
            ...args: unknown[]
        ) => {
            if (path.basename(stagingUri.fsPath)===firstStageName) {
                return false;
            }
            return originalCleanup(stagingUri, ...args);
        };
        await writeBytes(localImage, finalReplacement);
        const finalPush = await (firstScm as any).applySync(
            'push',
            'update',
            '/figure.png',
            localImage,
            remoteImage,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(finalPush.outcome, 'success');
        assert.deepStrictEqual(await readBytes(remoteImage), finalReplacement);

        const journalRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'remote-delete-operations',
        );
        const retainedJournalNames = (await vscode.workspace.fs.readDirectory(journalRoot))
            .filter(([name]) => name.endsWith('.json'))
            .map(([name]) => name);
        assert.strictEqual(retainedJournalNames.length, 1);
        const retainedJournal = JSON.parse(await readText(
            vscode.Uri.joinPath(journalRoot, retainedJournalNames[0]),
        ));
        assert.strictEqual(retainedJournal.supersededByRevision, sha1(finalReplacement));
        firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.deepStrictEqual(await readBytes(remoteImage), finalReplacement);
        assert.strictEqual((restartedScm as any).syncConflicts.has('/figure.png'), false);
        assert.deepStrictEqual(
            (await vscode.workspace.fs.readDirectory(remoteRoot))
                .filter(([name]) => name.startsWith('.sr-overleaf-replace-')),
            [],
        );
        assert.deepStrictEqual(
            (await vscode.workspace.fs.readDirectory(journalRoot))
                .filter(([name]) => name.endsWith('.json')),
            [],
        );
    });

    test('retires unchanged committed guards before Local Replica removal', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remove-guard-remote-');
        const localRoot = await tempDir('sr-overleaf-remove-guard-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(remoteMain, 'remote update');

        const event = await (scm as any).applySync(
            'pull',
            'update',
            '/main.tex',
            remoteMain,
            localMain,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(event.outcome, 'success');

        await scm.prepareRemovalAndHoldOwnership();
        try {
            const operationsRoot = vscode.Uri.joinPath(
                localRoot,
                REPLICA_SETTINGS_DIR,
                'operations',
            );
            const remainingEntries = await vscode.workspace.fs.readDirectory(operationsRoot);
            assert.deepStrictEqual(
                remainingEntries.filter(([name]) =>
                    name.endsWith('.guard')
                    || name.endsWith('.json')
                    || name.endsWith('.committed')),
                [],
            );
        } finally {
            await scm.finishRemoval();
        }
    });

    test('keeps a detached inode reachable for writes after non-Linux removal', async () => {
        const remoteRoot = await tempDir('sr-overleaf-detached-guard-remote-');
        const localRoot = await tempDir('sr-overleaf-detached-guard-local-');
        tempRoots.push(remoteRoot, localRoot);
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const id = `abcdef0123-${Date.now()}-abcdef12`;
        const record = {
            version: 1,
            id,
            kind: 'delete',
            relPath: '/main.tex',
            entityKind: 'file',
            expectedRevision: sha1('retained inode'),
            backupName: `.sr-overleaf-${id}.deleted`,
            guardName: `.sr-overleaf-${id}.guard`,
            createdAt: new Date().toISOString(),
        };
        await (scm as any).createLocalOperationRecord(record);
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        const guardPath = vscode.Uri.joinPath(operationsRoot, record.guardName);
        await writeText(guardPath, 'retained inode');
        await (scm as any).markLocalOperationCommitted(id);

        const openGuard = await fs.open(guardPath.fsPath, 'r+');
        try {
            await (scm as any).stageDetachedLocalGuard(
                record,
                guardPath.fsPath,
            );
            await scm.confirmRemovalPersistenceDeleted();
            await openGuard.truncate(0);
            await openGuard.writeFile('late write through detached inode');
        } finally {
            await openGuard.close();
        }

        const detachedRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'detached-inode-guards',
        );
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(detachedRoot, `${id}.guard`)),
            'late write through detached inode',
        );
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(detachedRoot, `${id}.json`)),
            true,
        );
        const remainingOperations = await vscode.workspace.fs.readDirectory(operationsRoot);
        assert.deepStrictEqual(
            remainingOperations.filter(([name]) =>
                name.endsWith('.guard')
                || name.endsWith('.json')
                || name.endsWith('.committed')),
            [],
        );
    });

    test('restores staged inode tracking when mapping removal rolls back', async () => {
        const remoteRoot = await tempDir('sr-overleaf-detach-rollback-remote-');
        const localRoot = await tempDir('sr-overleaf-detach-rollback-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'visible baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const id = `bcdefa0123-${Date.now()}-bcdefa12`;
        const record = {
            version: 1,
            id,
            kind: 'delete',
            relPath: '/main.tex',
            entityKind: 'file',
            expectedRevision: sha1('retained inode'),
            backupName: `.sr-overleaf-${id}.deleted`,
            guardName: `.sr-overleaf-${id}.guard`,
            createdAt: new Date().toISOString(),
        };
        await (scm as any).createLocalOperationRecord(record);
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        const guardPath = vscode.Uri.joinPath(operationsRoot, record.guardName);
        await writeText(guardPath, 'retained inode');
        await (scm as any).markLocalOperationCommitted(id);

        const openGuard = await fs.open(guardPath.fsPath, 'r+');
        try {
            await (scm as any).stageDetachedLocalGuard(record, guardPath.fsPath);
            await (scm as any).rollbackStagedDetachedLocalGuards();
            await openGuard.truncate(0);
            await openGuard.writeFile('late write after removal rollback');
        } finally {
            await openGuard.close();
        }

        assert.strictEqual(await pathExists(guardPath), true);
        await assert.rejects(
            () => scm.flushBeforeCompile([]),
            /older local file handle/i,
        );
        assert.strictEqual(
            await readText(localMain),
            'late write after removal rollback',
        );
    });

    test('recovers staged inode tracking after restart before mapping removal commits', async () => {
        const remoteRoot = await tempDir('sr-overleaf-detach-restart-remote-');
        const localRoot = await tempDir('sr-overleaf-detach-restart-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'visible baseline');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const id = `cdefab0123-${Date.now()}-cdefab12`;
        const record = {
            version: 1,
            id,
            kind: 'delete',
            relPath: '/main.tex',
            entityKind: 'file',
            expectedRevision: sha1('retained inode'),
            backupName: `.sr-overleaf-${id}.deleted`,
            guardName: `.sr-overleaf-${id}.guard`,
            createdAt: new Date().toISOString(),
        };
        await (firstScm as any).createLocalOperationRecord(record);
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        const guardPath = vscode.Uri.joinPath(operationsRoot, record.guardName);
        await writeText(guardPath, 'retained inode');
        await (firstScm as any).markLocalOperationCommitted(id);
        await (firstScm as any).stageDetachedLocalGuard(record, guardPath.fsPath);
        await firstScm.deactivate();

        const detachedRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'detached-inode-guards',
        );
        await writeText(
            vscode.Uri.joinPath(detachedRoot, `${id}.guard`),
            'late write while extension host was stopped',
        );

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(
            await readText(localMain),
            'late write while extension host was stopped',
        );
        assert.strictEqual((restartedScm as any).syncConflicts.has('/main.tex'), true);
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(detachedRoot, `${id}.json`)),
            false,
        );
    });

    test('keeps staged inode rollback retryable after a rename failure', async () => {
        const remoteRoot = await tempDir('sr-overleaf-detach-rename-retry-remote-');
        const localRoot = await tempDir('sr-overleaf-detach-rename-retry-local-');
        tempRoots.push(remoteRoot, localRoot);
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const id = `defabc0123-${Date.now()}-defabc12`;
        const record = {
            version: 1,
            id,
            kind: 'delete',
            relPath: '/main.tex',
            entityKind: 'file',
            expectedRevision: sha1('retained inode'),
            backupName: `.sr-overleaf-${id}.deleted`,
            guardName: `.sr-overleaf-${id}.guard`,
            createdAt: new Date().toISOString(),
        };
        await (scm as any).createLocalOperationRecord(record);
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        const guardPath = vscode.Uri.joinPath(operationsRoot, record.guardName);
        await writeText(guardPath, 'retained inode');
        await (scm as any).markLocalOperationCommitted(id);
        await (scm as any).stageDetachedLocalGuard(record, guardPath.fsPath);

        const internals = scm as any;
        const originalRename = internals.renameDurably.bind(scm);
        let injected = false;
        internals.renameDurably = async (sourcePath: string, targetPath: string) => {
            if (!injected && targetPath===guardPath.fsPath) {
                injected = true;
                throw new Error('injected rollback rename failure');
            }
            return originalRename(sourcePath, targetPath);
        };
        await assert.rejects(
            () => internals.rollbackStagedDetachedLocalGuards(),
            /injected rollback rename failure/i,
        );
        assert.strictEqual(internals.stagedDetachedLocalGuards.length, 1);

        internals.renameDurably = originalRename;
        await internals.rollbackStagedDetachedLocalGuards();
        assert.strictEqual(internals.stagedDetachedLocalGuards.length, 0);
        assert.strictEqual(await pathExists(guardPath), true);
    });

    test('keeps staged inode rollback retryable after metadata cleanup fails', async () => {
        const remoteRoot = await tempDir('sr-overleaf-detach-unlink-retry-remote-');
        const localRoot = await tempDir('sr-overleaf-detach-unlink-retry-local-');
        tempRoots.push(remoteRoot, localRoot);
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const id = `efabcd0123-${Date.now()}-efabcd12`;
        const record = {
            version: 1,
            id,
            kind: 'delete',
            relPath: '/main.tex',
            entityKind: 'file',
            expectedRevision: sha1('retained inode'),
            backupName: `.sr-overleaf-${id}.deleted`,
            guardName: `.sr-overleaf-${id}.guard`,
            createdAt: new Date().toISOString(),
        };
        await (scm as any).createLocalOperationRecord(record);
        const operationsRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'operations',
        );
        const guardPath = vscode.Uri.joinPath(operationsRoot, record.guardName);
        await writeText(guardPath, 'retained inode');
        await (scm as any).markLocalOperationCommitted(id);
        await (scm as any).stageDetachedLocalGuard(record, guardPath.fsPath);

        const internals = scm as any;
        const originalRemoveMetadata =
            internals.removeDetachedLocalGuardRecord.bind(scm);
        let injected = false;
        internals.removeDetachedLocalGuardRecord = async (recordPath: string) => {
            if (!injected) {
                injected = true;
                throw new Error('injected detached metadata cleanup failure');
            }
            return originalRemoveMetadata(recordPath);
        };
        await assert.rejects(
            () => internals.rollbackStagedDetachedLocalGuards(),
            /injected detached metadata cleanup failure/i,
        );
        assert.strictEqual(internals.stagedDetachedLocalGuards.length, 1);
        assert.strictEqual(await pathExists(guardPath), true);

        internals.removeDetachedLocalGuardRecord = originalRemoveMetadata;
        await internals.rollbackStagedDetachedLocalGuards();
        assert.strictEqual(internals.stagedDetachedLocalGuards.length, 0);
        assert.strictEqual(await pathExists(guardPath), true);
    });

    test('preserves an unmarked identity-less older replacement rather than treating bytes as completion proof', async () => {
        const remoteRoot = await tempDir('sr-overleaf-binary-unmarked-superseded-remote-');
        const localRoot = await tempDir('sr-overleaf-binary-unmarked-superseded-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const baseline = Buffer.from([1, 2, 3]);
        const firstReplacement = Buffer.from([4, 5, 6]);
        const finalReplacement = Buffer.from([7, 8, 9]);
        await writeBytes(remoteImage, baseline);
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, finalReplacement);

        const olderId = '000000000000000000000001';
        const completedId = 'ffffffffffffffffffffffff';
        const olderStage = `/.sr-overleaf-replace-${olderId}`;
        const completedStage = `/.sr-overleaf-replace-${completedId}`;
        await (firstScm as any).createRemoteDeleteOperationRecord({
            version: 1,
            id: olderId,
            kind: 'replace',
            relPath: '/figure.png',
            stagingRelPath: olderStage,
            expectedRevision: sha1(baseline),
            replacementRevision: sha1(firstReplacement),
            createdAt: new Date(Date.now()-1000).toISOString(),
        });
        await vscode.workspace.fs.rename(
            remoteImage,
            (firstScm as any).vfs.pathToUri(olderStage),
            {overwrite: false},
        );
        await writeBytes(remoteImage, finalReplacement);
        await (firstScm as any).createRemoteDeleteOperationRecord({
            version: 1,
            id: completedId,
            kind: 'replace',
            relPath: '/figure.png',
            stagingRelPath: completedStage,
            expectedRevision: sha1(firstReplacement),
            replacementRevision: sha1(finalReplacement),
            createdAt: new Date().toISOString(),
        });
        firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.deepStrictEqual(await readBytes(remoteImage), finalReplacement);
        assert.strictEqual((restartedScm as any).syncConflicts.has('/figure.png'), true);
        assert.deepStrictEqual(
            (await vscode.workspace.fs.readDirectory(remoteRoot))
                .filter(([name]) => name.startsWith('.sr-overleaf-replace-')),
            [[path.basename(olderStage), vscode.FileType.File]],
        );
        const journalRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'remote-delete-operations',
        );
        assert.strictEqual(
            (await vscode.workspace.fs.readDirectory(journalRoot))
                .filter(([name]) => name.endsWith('.json')).length,
            2,
        );
    });

    test('blocks restart recovery when binary target and stage are both missing', async () => {
        const remoteRoot = await tempDir('sr-overleaf-binary-double-missing-remote-');
        const localRoot = await tempDir('sr-overleaf-binary-double-missing-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteImage = vscode.Uri.joinPath(remoteRoot, 'figure.png');
        const localImage = vscode.Uri.joinPath(localRoot, 'figure.png');
        const replacement = Buffer.from([9, 8, 7, 6]);
        await writeBytes(remoteImage, Buffer.from([1, 2, 3]));
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeBytes(localImage, replacement);
        const generation = (firstScm as any).syncGeneration as number;
        const expected = await (firstScm as any).captureRemotePathRevision(
            '/figure.png',
            generation,
        );
        const operationId = (firstScm as any).remoteReplacementOperationId(
            '/figure.png',
            expected.revision,
            sha1(replacement),
        );
        const stagingRelPath = (firstScm as any).remoteReplacementStagingPath(
            '/figure.png',
            expected.revision,
            sha1(replacement),
        );
        await (firstScm as any).createRemoteDeleteOperationRecord({
            version: 1,
            id: operationId,
            kind: 'replace',
            relPath: '/figure.png',
            stagingRelPath,
            expectedRevision: expected.revision,
            replacementRevision: sha1(replacement),
            createdAt: new Date().toISOString(),
        });
        await vscode.workspace.fs.delete(remoteImage);
        firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await pathExists(remoteImage), false);
        assert.deepStrictEqual(await readBytes(localImage), replacement);
        assert.strictEqual((restartedScm as any).syncConflicts.has('/figure.png'), true);
        const journalRoot = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'remote-delete-operations',
        );
        const journalEntries = await vscode.workspace.fs.readDirectory(journalRoot);
        assert.strictEqual(
            journalEntries.filter(([name]) => name.endsWith('.json')).length,
            1,
        );
    });

    test('rechecks and preserves a remote target recreated after stage deletion', async () => {
        const remoteRoot = await tempDir('sr-overleaf-post-stage-recreate-remote-');
        const localRoot = await tempDir('sr-overleaf-post-stage-recreate-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await vscode.workspace.fs.delete(localMain);
        const originalRefresh = (scm as any).refreshRemoteStateForReconciliation.bind(scm);
        let recreated = false;
        (scm as any).refreshRemoteStateForReconciliation = async (
            relPath: string,
            generation: number,
            reason: string,
        ) => {
            await originalRefresh(relPath, generation, reason);
            if (!recreated && reason==='verify completed remote delete') {
                recreated = true;
                await writeText(remoteMain, 'recreated after stage deletion');
            }
        };

        const event = await (scm as any).applySync(
            'push',
            'delete',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(await readText(remoteMain), 'recreated after stage deletion');
        assert.strictEqual((scm as any).syncConflicts.has('/main.tex'), true);
    });

    test('never deletes a recreated remote target while resuming an old delete', async () => {
        const remoteRoot = await tempDir('sr-overleaf-remote-recreate-remote-');
        const localRoot = await tempDir('sr-overleaf-remote-recreate-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'same bytes');
        const firstScm = createSCM(remoteRoot, localRoot);
        await firstScm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const generation = (firstScm as any).syncGeneration as number;
        const expected = await (firstScm as any).captureRemotePathRevision(
            '/main.tex',
            generation,
        );
        const operationId = (firstScm as any).remoteDeleteOperationId(
            '/main.tex',
            expected.revision,
        );
        const stagingRelPath = (firstScm as any).remoteDeleteStagingPath(
            '/main.tex',
            expected.revision,
        );
        await (firstScm as any).createRemoteDeleteOperationRecord({
            version: 1,
            id: operationId,
            relPath: '/main.tex',
            stagingRelPath,
            expectedRevision: expected.revision,
            createdAt: new Date().toISOString(),
        });
        await vscode.workspace.fs.rename(
            remoteMain,
            (firstScm as any).vfs.pathToUri(stagingRelPath),
            {overwrite: false},
        );
        await writeText(remoteMain, 'same bytes');
        await vscode.workspace.fs.delete(localMain);
        firstScm.deactivate();

        const restartedScm = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await restartedScm.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await readText(remoteMain), 'same bytes');
        assert.strictEqual((restartedScm as any).syncConflicts.has('/main.tex'), true);
        const manifestUri = vscode.Uri.joinPath(
            localRoot,
            REPLICA_SETTINGS_DIR,
            'sync-manifest.json',
        );
        assert.ok(JSON.parse(await readText(manifestUri)).conflicts['/main.tex']);

        restartedScm.deactivate();
        const secondRestart = createSCM(remoteRoot, localRoot);
        assert.strictEqual(
            await secondRestart.initializeLocalReplica({preserveExistingLocalFiles: true}),
            true,
        );
        assert.strictEqual(await readText(remoteMain), 'same bytes');
        assert.strictEqual((secondRestart as any).syncConflicts.has('/main.tex'), true);
    });

    test('lets a closed child edit resolve an ancestor folder conflict at compile time', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-resolution-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-resolution-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'chapter', 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'chapter', 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await (scm as any).markSyncConflict('/chapter', 'simulated folder conflict');
        await writeText(localMain, 'closed child resolution');

        const result = await scm.flushBeforeCompile([]);

        assert.strictEqual(result.failedCount, 0);
        assert.strictEqual(result.blockedCount, 0);
        assert.strictEqual(await readText(remoteMain), 'closed child resolution');
        assert.strictEqual((scm as any).syncConflicts.has('/chapter'), false);
    });

    test('recreates missing remote ancestors before resolving a deleted folder conflict', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-recreate-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-recreate-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteChapter = vscode.Uri.joinPath(remoteRoot, 'chapter');
        const remoteMain = vscode.Uri.joinPath(remoteChapter, 'main.tex');
        const localChapter = vscode.Uri.joinPath(localRoot, 'chapter');
        const localMain = vscode.Uri.joinPath(localChapter, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        await writeText(localMain, 'first closed local edit');
        await vscode.workspace.fs.delete(remoteChapter, {recursive: true});
        const deleteEvent = await (scm as any).applySync(
            'pull',
            'delete',
            '/chapter',
            remoteChapter,
            localChapter,
        ) as Events['scmSyncCompleteEvent'];
        assert.strictEqual(deleteEvent.outcome, 'blocked');
        assert.strictEqual((scm as any).syncConflicts.has('/chapter'), true);

        await writeText(localMain, 'final closed local resolution');
        const result = await scm.flushBeforeCompile([]);

        assert.strictEqual(result.failedCount, 0);
        assert.strictEqual(result.blockedCount, 0);
        assert.deepStrictEqual(result.paths.slice(0, 2), ['/chapter', '/chapter/main.tex']);
        assert.strictEqual(await readText(remoteMain), 'final closed local resolution');
        assert.strictEqual((scm as any).syncConflicts.has('/chapter'), false);
    });

    test('replays closed file and media changes captured while the initial pull is running', async () => {
        const remoteRoot = await tempDir('sr-overleaf-buffered-watch-remote-');
        const localRoot = await tempDir('sr-overleaf-buffered-watch-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };

        const scm = createSCM(remoteRoot, localRoot);
        const originalInitialize = scm.initializeLocalReplica.bind(scm);
        (scm as any).initializeLocalReplica = async (...args: unknown[]) => {
            const initialized = await (originalInitialize as any)(...args);
            assert.strictEqual(watchers.length, 2);
            const lateTex = vscode.Uri.joinPath(localRoot, 'late-agent.tex');
            const latePng = vscode.Uri.joinPath(localRoot, 'late-agent.png');
            const lateFolder = vscode.Uri.joinPath(localRoot, 'late-folder');
            const nestedTex = vscode.Uri.joinPath(lateFolder, 'nested-agent.tex');
            await writeText(lateTex, 'created while pull was finishing');
            await writeBytes(latePng, Buffer.from([9, 8, 7, 6]));
            await writeText(nestedTex, 'nested child captured before its parent event');
            watchers[1].fireCreate(lateTex);
            watchers[1].fireCreate(latePng);
            watchers[1].fireCreate(nestedTex);
            watchers[1].fireCreate(lateFolder);
            return initialized;
        };

        const texPush = waitForSyncComplete(localRoot, '/late-agent.tex', 'push', 'update');
        const pngPush = waitForSyncComplete(localRoot, '/late-agent.png', 'push', 'update');
        const folderPush = waitForSyncComplete(localRoot, '/late-folder', 'push', 'update');
        const nestedPush = waitForSyncComplete(localRoot, '/late-folder/nested-agent.tex', 'push', 'update');
        const triggers = await scm.triggers;
        try {
            const [texEvent, pngEvent, folderEvent, nestedEvent] = await Promise.all([
                texPush,
                pngPush,
                folderPush,
                nestedPush,
            ]);
            assert.strictEqual(texEvent.outcome, 'success');
            assert.strictEqual(pngEvent.outcome, 'success');
            assert.strictEqual(folderEvent.outcome, 'success');
            assert.strictEqual(nestedEvent.outcome, 'success');
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteRoot, 'late-agent.tex')),
                'created while pull was finishing',
            );
            assert.deepStrictEqual(
                await readBytes(vscode.Uri.joinPath(remoteRoot, 'late-agent.png')),
                Buffer.from([9, 8, 7, 6]),
            );
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteRoot, 'late-folder', 'nested-agent.tex')),
                'nested child captured before its parent event',
            );
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('reconciles a rapidly renamed local folder when watchers omit destination child events', async function () {
        this.timeout(20000);
        const remoteRoot = await tempDir('sr-overleaf-folder-rename-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-rename-local-');
        tempRoots.push(remoteRoot, localRoot);

        const remoteSource = vscode.Uri.joinPath(remoteRoot, 'source');
        await writeText(vscode.Uri.joinPath(remoteSource, 'chapter.tex'), 'renamed text');
        await writeBytes(
            vscode.Uri.joinPath(remoteSource, 'figure.png'),
            Buffer.from([1, 3, 5, 7, 9]),
        );
        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };

        const scm = createSCM(remoteRoot, localRoot);
        const triggers = await scm.triggers;
        try {
            const localWatcher = watchers[1];
            const localSource = vscode.Uri.joinPath(localRoot, 'source');
            const localDestination = vscode.Uri.joinPath(localRoot, 'destination');
            const oldText = vscode.Uri.joinPath(localSource, 'chapter.tex');
            const oldImage = vscode.Uri.joinPath(localSource, 'figure.png');
            await vscode.workspace.fs.rename(
                oldText,
                vscode.Uri.joinPath(localSource, 'chapter-renamed.tex'),
                {overwrite: false},
            );
            await vscode.workspace.fs.rename(
                oldImage,
                vscode.Uri.joinPath(localSource, 'figure-renamed.png'),
                {overwrite: false},
            );
            await vscode.workspace.fs.rename(localSource, localDestination, {overwrite: false});

            const destinationWait = waitForSyncComplete(
                localRoot,
                '/destination',
                'push',
                'update',
            );
            const sourceDeleteWait = waitForSyncComplete(
                localRoot,
                '/source',
                'push',
                'delete',
            );
            localWatcher.fireDelete(oldText);
            localWatcher.fireDelete(oldImage);
            localWatcher.fireCreate(localDestination);
            localWatcher.fireDelete(localSource);

            assert.strictEqual((await destinationWait).outcome, 'success');
            assert.strictEqual((await sourceDeleteWait).outcome, 'success');
            assert.strictEqual(await pathExists(remoteSource), false);
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteRoot, 'destination', 'chapter-renamed.tex')),
                'renamed text',
            );
            assert.deepStrictEqual(
                await readBytes(vscode.Uri.joinPath(remoteRoot, 'destination', 'figure-renamed.png')),
                Buffer.from([1, 3, 5, 7, 9]),
            );
        } finally {
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('serializes ordinary destination reconciliation with child watcher events', async function () {
        this.timeout(20000);
        const remoteRoot = await tempDir('sr-overleaf-folder-queue-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-queue-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(
            vscode.Uri.joinPath(remoteRoot, 'source', 'chapter.tex'),
            'first local revision',
        );
        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };
        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const originalWrite = vfs.writeFileFromRemoteBaseline.bind(vfs);
        let releaseFirstWrite!: () => void;
        const firstWriteGate = new Promise<void>(resolve => {
            releaseFirstWrite = resolve;
        });
        let firstWriteStarted!: () => void;
        const firstWriteStart = new Promise<void>(resolve => {
            firstWriteStarted = resolve;
        });
        let destinationWrites = 0;
        let inFlightDestinationWrites = 0;
        let maxInFlightDestinationWrites = 0;
        vfs.writeFileFromRemoteBaseline = async (...args) => {
            if (args[0].path.endsWith('/destination/chapter.tex')) {
                destinationWrites += 1;
                inFlightDestinationWrites += 1;
                maxInFlightDestinationWrites = Math.max(
                    maxInFlightDestinationWrites,
                    inFlightDestinationWrites,
                );
                if (destinationWrites===1) {
                    firstWriteStarted();
                    await firstWriteGate;
                }
                try {
                    return await originalWrite(...args);
                } finally {
                    inFlightDestinationWrites -= 1;
                }
            }
            return originalWrite(...args);
        };

        const scm = createSCM(remoteRoot, localRoot, vfs);
        const triggers = await scm.triggers;
        try {
            const localDestination = vscode.Uri.joinPath(localRoot, 'destination');
            const localDestinationChild = vscode.Uri.joinPath(localDestination, 'chapter.tex');
            await writeText(localDestinationChild, 'first local revision');

            const rootPush = waitForSyncComplete(
                localRoot,
                '/destination',
                'push',
                'update',
            );
            watchers[1].fireCreate(localDestination);
            watchers[1].fireCreate(localDestinationChild);
            await firstWriteStart;
            await writeText(localDestinationChild, 'second local revision');
            watchers[1].fireChange(localDestinationChild);
            await new Promise(resolve => setTimeout(resolve, 350));
            releaseFirstWrite();

            await waitUntil(
                () => destinationWrites>=2 && inFlightDestinationWrites===0,
                5000,
            );
            await new Promise<void>(resolve => setTimeout(resolve, 350));
            assert.strictEqual((await rootPush).outcome, 'success');
            assert.strictEqual(maxInFlightDestinationWrites, 1);
            assert.strictEqual(
                await readText(vscode.Uri.joinPath(remoteRoot, 'destination', 'chapter.tex')),
                'second local revision',
            );
            // The initial create is proven by its exact entity, then the
            // second writer revision becomes a normal guarded update. It must
            // not survive as a false same-name-create conflict or journal.
            assert.strictEqual((scm as any).syncConflicts.has('/destination/chapter.tex'), false);
            assert.strictEqual(
                (scm as any).syncManifest.pendingOperations['/destination/chapter.tex'],
                undefined,
            );
        } finally {
            releaseFirstWrite();
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('drains a promoted parent delete when removal overlaps parent reconciliation', async function () {
        this.timeout(20000);
        const remoteRoot = await tempDir('sr-overleaf-folder-delete-queue-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-delete-queue-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(
            vscode.Uri.joinPath(remoteRoot, 'destination', 'chapter.tex'),
            'baseline',
        );
        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };
        const scm = createSCM(remoteRoot, localRoot);
        const triggers = await scm.triggers;
        const internals = scm as any;
        const originalEnqueue = internals.enqueueSync.bind(scm);
        const originalPromote = internals.promoteDeleteToMissingTrackedDirectory.bind(scm);
        let releaseReconcileChild!: () => void;
        const reconcileChildGate = new Promise<void>(resolve => {
            releaseReconcileChild = resolve;
        });
        let signalReconcileChild!: () => void;
        const reconcileChildReached = new Promise<void>(resolve => {
            signalReconcileChild = resolve;
        });
        let signalPromotedDelete!: () => void;
        const promotedDeleteReached = new Promise<void>(resolve => {
            signalPromotedDelete = resolve;
        });
        let releasePromotedDelete!: () => void;
        const promotedDeleteGate = new Promise<void>(resolve => {
            releasePromotedDelete = resolve;
        });
        let childEnqueueCount = 0;
        internals.enqueueSync = (
            relPath: string,
            task: () => Promise<unknown>,
            generation: number,
            acceptedBeforeRemoval = false,
        ) => {
            if (relPath==='/destination/chapter.tex') {
                childEnqueueCount += 1;
                if (childEnqueueCount===1) {
                    signalReconcileChild();
                    return reconcileChildGate.then(
                        () => originalEnqueue(
                            relPath,
                            task,
                            generation,
                            acceptedBeforeRemoval,
                        ),
                    );
                }
            }
            return originalEnqueue(
                relPath,
                task,
                generation,
                acceptedBeforeRemoval,
            );
        };
        internals.promoteDeleteToMissingTrackedDirectory = async (
            action: 'push' | 'pull',
            relPath: string,
            generation: number,
        ) => {
            const promoted = await originalPromote(action, relPath, generation);
            if (
                action==='push'
                && relPath==='/destination/chapter.tex'
                && promoted==='/destination'
            ) {
                signalPromotedDelete();
                await promotedDeleteGate;
            }
            return promoted;
        };

        let removal: Promise<void> | undefined;
        try {
            const localDestination = vscode.Uri.joinPath(localRoot, 'destination');
            const localChild = vscode.Uri.joinPath(localDestination, 'chapter.tex');
            const rootUpdate = internals.enqueueSync(
                '/destination',
                () => internals.applySync(
                    'push',
                    'update',
                    '/destination',
                    localDestination,
                    vscode.Uri.joinPath(remoteRoot, 'destination'),
                    {forcePush: true, reason: 'queue-deadlock-regression'},
                ),
                internals.syncGeneration,
            );
            await reconcileChildReached;

            await vscode.workspace.fs.delete(localDestination, {recursive: true});
            await internals.syncToVFS(localChild, 'delete');
            await Promise.race([
                promotedDeleteReached,
                new Promise<never>((_, reject) => setTimeout(
                    () => reject(new Error(
                        `child delete was not promoted; queues=${[
                            ...internals.syncQueues.keys(),
                        ].join(',')} pending=${[
                            ...internals.pendingLocalEvents.keys(),
                        ].join(',')}`,
                    )),
                    3_000,
                )),
            ]);
            const rootDelete = waitForSyncComplete(
                localRoot,
                '/destination',
                'push',
                'delete',
            );
            removal = scm.prepareRemovalAndHoldOwnership();
            releasePromotedDelete();
            releaseReconcileChild();

            const deleted = await Promise.race([
                rootDelete,
                new Promise<never>((_, reject) => setTimeout(
                    () => reject(new Error('parent/child sync queue deadlocked')),
                    5_000,
                )),
            ]);
            assert.strictEqual(deleted.outcome, 'success');
            assert.strictEqual(
                await pathExists(vscode.Uri.joinPath(remoteRoot, 'destination')),
                false,
            );
            await rootUpdate;
            await removal;
            await waitUntil(() => internals.syncQueues.size===0, 5_000);
            assert.strictEqual(internals.deferredSyncWork.size, 0);
        } finally {
            releasePromotedDelete();
            releaseReconcileChild();
            if (removal) {
                await removal.catch(() => undefined);
                await scm.finishRemoval();
            }
            triggers.forEach(trigger => trigger.dispose());
        }
    });

    test('refuses symlink descendants during local folder reconciliation', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-symlink-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-symlink-local-');
        const outsideRoot = await tempDir('sr-overleaf-folder-symlink-outside-');
        tempRoots.push(remoteRoot, localRoot, outsideRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        await writeText(vscode.Uri.joinPath(outsideRoot, 'secret.tex'), 'must stay local');
        const localFolder = vscode.Uri.joinPath(localRoot, 'destination');
        await vscode.workspace.fs.createDirectory(localFolder);
        await fs.symlink(
            outsideRoot.fsPath,
            vscode.Uri.joinPath(localFolder, 'outside-link').fsPath,
            'dir',
        );
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({preserveExistingLocalFiles: true});

        const event = await (scm as any).applySync(
            'push',
            'update',
            '/destination',
            localFolder,
            vscode.Uri.joinPath(remoteRoot, 'destination'),
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'error');
        assert.match(event.error ?? '', /refuses symbolic links/i);
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(remoteRoot, 'destination', 'outside-link', 'secret.tex')),
            false,
        );
    });

    test('revalidates confinement when a scanned ancestor becomes a symlink', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-swap-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-swap-local-');
        const outsideRoot = await tempDir('sr-overleaf-folder-swap-outside-');
        tempRoots.push(remoteRoot, localRoot, outsideRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({preserveExistingLocalFiles: true});
        const localFolder = vscode.Uri.joinPath(localRoot, 'destination');
        const localChild = vscode.Uri.joinPath(localFolder, 'chapter.tex');
        await writeText(localChild, 'safe local bytes');
        await writeText(
            vscode.Uri.joinPath(outsideRoot, 'chapter.tex'),
            'external secret bytes',
        );

        const internals = scm as any;
        const originalEnqueue = internals.enqueueSync.bind(scm);
        let swapped = false;
        internals.enqueueSync = async (
            relPath: string,
            task: () => Promise<unknown>,
            generation: number,
        ) => {
            if (!swapped && relPath==='/destination/chapter.tex') {
                swapped = true;
                await vscode.workspace.fs.delete(localFolder, {recursive: true});
                await fs.symlink(outsideRoot.fsPath, localFolder.fsPath, 'dir');
            }
            return originalEnqueue(relPath, task, generation);
        };

        const event = await internals.applySync(
            'push',
            'update',
            '/destination',
            localFolder,
            vscode.Uri.joinPath(remoteRoot, 'destination'),
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(swapped, true);
        assert.strictEqual(event.outcome, 'error');
        assert.match(event.error ?? '', /escaped the selected folder|symbolic links/i);
        assert.strictEqual(
            await pathExists(vscode.Uri.joinPath(remoteRoot, 'destination', 'chapter.tex')),
            false,
        );
    });

    test('revalidates the opened descriptor after local bytes are read', async () => {
        const remoteRoot = await tempDir('sr-overleaf-read-fd-remote-');
        const localRoot = await tempDir('sr-overleaf-read-fd-local-');
        const outsideRoot = await tempDir('sr-overleaf-read-fd-outside-');
        tempRoots.push(remoteRoot, localRoot, outsideRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const escapedMain = vscode.Uri.joinPath(outsideRoot, 'escaped.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'bytes from the opened inode');

        const internals = scm as any;
        const originalRead = internals.readOpenedLocalFile.bind(scm);
        let moved = false;
        internals.readOpenedLocalFile = async (handle: fs.FileHandle) => {
            const content = await originalRead(handle);
            if (!moved) {
                moved = true;
                await vscode.workspace.fs.rename(localMain, escapedMain, {overwrite: false});
                await writeText(localMain, 'replacement inside the replica');
            }
            return content;
        };

        await assert.rejects(
            () => internals.readConfinedLocalFile('/main.tex'),
            /escaped the selected folder|changed during confinement validation/i,
        );
        assert.strictEqual(moved, true);
        assert.strictEqual(await readText(escapedMain), 'bytes from the opened inode');
        assert.strictEqual(await readText(localMain), 'replacement inside the replica');
    });

    test('rejects a same-inode local mutation while descriptor bytes are read', async () => {
        if (process.platform!=='linux') { return; }
        const remoteRoot = await tempDir('sr-overleaf-read-same-inode-remote-');
        const localRoot = await tempDir('sr-overleaf-read-same-inode-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'bytes before same inode mutation');
        const inodeBefore = (await fs.lstat(localMain.fsPath)).ino;

        const internals = scm as any;
        const originalRead = internals.readOpenedLocalFile.bind(scm);
        let mutated = false;
        internals.readOpenedLocalFile = async (handle: fs.FileHandle) => {
            const content = await originalRead(handle);
            if (!mutated) {
                mutated = true;
                const writer = await fs.open(localMain.fsPath, 'r+');
                try {
                    await writer.truncate(0);
                    await writer.writeFile('bytes written through the same inode');
                } finally {
                    await writer.close();
                }
            }
            return content;
        };

        await assert.rejects(
            () => internals.readConfinedLocalFile('/main.tex'),
            /changed while bytes were read/i,
        );
        assert.strictEqual(mutated, true);
        assert.strictEqual((await fs.lstat(localMain.fsPath)).ino, inodeBefore);
        assert.strictEqual(
            await readText(localMain),
            'bytes written through the same inode',
        );
    });

    test('allows sibling directory entries to change during a confined Linux read', async () => {
        if (process.platform!=='linux') { return; }
        const remoteRoot = await tempDir('sr-overleaf-read-sibling-remote-');
        const localRoot = await tempDir('sr-overleaf-read-sibling-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const localSibling = vscode.Uri.joinPath(localRoot, 'sibling.tex');
        const renamedSibling = vscode.Uri.joinPath(localRoot, 'sibling-renamed.tex');
        await writeText(remoteMain, 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        await writeText(localMain, 'stable opened bytes');
        await writeText(localSibling, 'sibling');

        const internals = scm as any;
        const originalRead = internals.readOpenedLocalFile.bind(scm);
        let renamed = false;
        internals.readOpenedLocalFile = async (handle: fs.FileHandle) => {
            const content = await originalRead(handle);
            if (!renamed) {
                renamed = true;
                await vscode.workspace.fs.rename(
                    localSibling,
                    renamedSibling,
                    {overwrite: false},
                );
            }
            return content;
        };

        assert.strictEqual(
            Buffer.from(await internals.readConfinedLocalFile('/main.tex')).toString(),
            'stable opened bytes',
        );
        assert.strictEqual(renamed, true);
    });

    test('pulls every descendant when Overleaf reports only a renamed folder event', async () => {
        const remoteRoot = await tempDir('sr-overleaf-folder-pull-remote-');
        const localRoot = await tempDir('sr-overleaf-folder-pull-local-');
        tempRoots.push(remoteRoot, localRoot);

        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});

        const remoteFolder = vscode.Uri.joinPath(remoteRoot, 'renamed-folder');
        const localFolder = vscode.Uri.joinPath(localRoot, 'renamed-folder');
        await writeText(
            vscode.Uri.joinPath(remoteFolder, 'nested', 'chapter.tex'),
            'remote renamed text',
        );
        await writeBytes(
            vscode.Uri.joinPath(remoteFolder, 'nested', 'figure.png'),
            Buffer.from([2, 4, 6, 8]),
        );

        const event = await (scm as any).applySync(
            'pull',
            'update',
            '/renamed-folder',
            remoteFolder,
            localFolder,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(
            await readText(vscode.Uri.joinPath(localFolder, 'nested', 'chapter.tex')),
            'remote renamed text',
        );
        assert.deepStrictEqual(
            await readBytes(vscode.Uri.joinPath(localFolder, 'nested', 'figure.png')),
            Buffer.from([2, 4, 6, 8]),
        );
    });

    test('reports startup watchers ready while guarded buffered replay continues', async () => {
        const remoteRoot = await tempDir('sr-overleaf-buffered-remote-ready-');
        const remoteEventRoot = await tempDir('sr-overleaf-buffered-remote-event-');
        const localRoot = await tempDir('sr-overleaf-buffered-local-ready-');
        tempRoots.push(remoteRoot, remoteEventRoot, localRoot);

        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const remoteEventUri = vscode.Uri.joinPath(remoteEventRoot, 'startup-change.tex');
        const localEventUri = vscode.Uri.joinPath(
            localRoot,
            path.basename(remoteEventRoot.fsPath),
            'startup-change.tex',
        );
        await writeText(remoteMain, 'baseline');
        const watchers: TestFileSystemWatcher[] = [];
        (vscode.workspace as any).createFileSystemWatcher = () => {
            const watcher = new TestFileSystemWatcher();
            watchers.push(watcher);
            return watcher;
        };

        let signalReplayStarted!: () => void;
        let releaseReplay!: () => void;
        const replayStarted = new Promise<void>(resolve => {
            signalReplayStarted = resolve;
        });
        const replayGate = new Promise<void>(resolve => {
            releaseReplay = resolve;
        });

        const scm = createSCM(remoteRoot, localRoot);
        const internals = scm as any;
        const originalReplay = internals.replayBufferedVfsEvents.bind(scm);
        internals.replayBufferedVfsEvents = async (...args: unknown[]) => {
            signalReplayStarted();
            await replayGate;
            return originalReplay(...args);
        };
        const originalInitialize = scm.initializeLocalReplica.bind(scm);
        (scm as any).initializeLocalReplica = async (...args: unknown[]) => {
            const initialized = await (originalInitialize as any)(...args);
            await writeText(remoteEventUri, 'collaborator edit while startup was finishing');
            watchers[0].fireChange(remoteEventUri);
            return initialized;
        };

        const triggersPromise = scm.triggers;
        await replayStarted;
        const triggers = await Promise.race([
            triggersPromise,
            new Promise<never>((_, reject) => setTimeout(
                () => reject(new Error('watcher readiness waited for buffered replay')),
                500,
            )),
        ]);
        try {
            assert.strictEqual(internals.startupReplayGeneration, internals.syncGeneration);
            assert.strictEqual(await pathExists(localEventUri), false);
            // The project UI is already usable, but a compile requested in this
            // brief handoff window waits for the accepted watcher events rather
            // than failing immediately. Subscription verification is tested
            // separately below, so isolate this assertion to replay ordering.
            internals.pendingInitialDocumentSubscriptions.clear();
            let flushSettled = false;
            const startupFlush = internals.waitForStartupReadinessBeforeCompile(
                internals.syncGeneration,
            ).finally(() => {
                flushSettled = true;
            });
            await new Promise(resolve => setTimeout(resolve, 75));
            assert.strictEqual(flushSettled, false);
            releaseReplay();
            await startupFlush;
            await waitUntil(() => internals.startupReplayPromise===undefined, 5_000);
            assert.strictEqual(
                await readText(localEventUri),
                'collaborator edit while startup was finishing',
            );
            assert.strictEqual(internals.startupReplayGeneration, undefined);
            assert.strictEqual(internals.startupReplayFailure, undefined);

            internals.pendingInitialDocumentSubscriptions.add('/main.tex');
            const subscriptionFlush = internals.waitForStartupReadinessBeforeCompile(
                internals.syncGeneration,
            );
            await new Promise(resolve => setTimeout(resolve, 75));
            internals.pendingInitialDocumentSubscriptions.clear();
            await subscriptionFlush;

            internals.precompileStartupReadinessWaitMs = 20;
            internals.pendingInitialDocumentSubscriptions.add('/main.tex');
            await internals.waitForStartupReadinessBeforeCompile(
                internals.syncGeneration,
            );
            assert.strictEqual(
                internals.pendingInitialDocumentSubscriptions.has('/main.tex'),
                true,
            );
            internals.pendingInitialDocumentSubscriptions.clear();

            internals.startupReplayFailure = {
                generation: internals.syncGeneration,
                message: 'simulated retained startup replay failure',
            };
            await assert.rejects(
                () => scm.flushBeforeCompile([]),
                /startup watcher change reconciliation failed.*simulated retained startup replay failure/,
            );
            internals.startupReplayFailure = undefined;
        } finally {
            releaseReplay();
            triggers.forEach(trigger => trigger.dispose());
        }
    });
});
