import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    RemoteDocumentMergeConflictError,
    VirtualFileSystem,
} from '../../core/remoteFileSystemProvider';
import { LocalReplicaSCMProvider } from '../../scm/localReplicaSCM';

/**
 * These are deliberately integration-shaped Local Replica tests.  The VFS
 * tests cover joinDoc's revision epoch/retry loop; this suite covers the gap
 * above it: an HTTP bootstrap snapshot has been applied locally, but the
 * document has not been joined/subscribed yet.
 */
class SnapshotVfs {
    public readonly origin: vscode.Uri;
    public readonly projectName = 'Snapshot handoff test';
    public readonly serverName = 'test-server';
    public readonly _userId = 'test-user';
    public readonly projectId = 'test-project';
    public readonly connectionState = 'connected';
    public readonly documentSnapshotTransport = 'test-http';
    private readonly connectionEmitter = new vscode.EventEmitter<string>();
    public readonly onDidChangeConnection = this.connectionEmitter.event;
    private readonly persists = new Map<string, unknown>();

    constructor(private readonly remoteRoot: vscode.Uri) {
        this.origin = remoteRoot;
    }

    pathToUri(...parts: string[]) {
        return vscode.Uri.joinPath(
            this.remoteRoot,
            ...parts.flatMap(part => part.split('/').filter(Boolean)),
        );
    }

    async _resolveUri(uri: vscode.Uri) {
        const relativePath = path.relative(this.remoteRoot.fsPath, uri.fsPath).split(path.sep).join('/');
        const relPath = '/' + relativePath.split('/').filter(Boolean).join('/');
        const fileName = path.basename(uri.fsPath);
        let isDirectory = false;
        try {
            isDirectory = (await vscode.workspace.fs.stat(uri)).type===vscode.FileType.Directory;
        } catch {
            isDirectory = false;
        }
        const fileType = isDirectory
            ? 'folder'
            : /\.tex$/i.test(fileName) ? 'doc' : 'file';
        const parentRelPath = relPath==='/' ? '/' : path.posix.dirname(relPath);
        return {
            parentFolder: {
                _id: parentRelPath,
                name: path.posix.basename(parentRelPath),
                _type: 'folder',
            },
            fileName,
            fileType,
            fileEntity: {
                _id: fileType==='folder' ? relPath : uri.toString(),
                name: fileName,
                _type: fileType,
                linkedFileData: null,
                created: new Date(0).toISOString(),
            },
        };
    }

    async downloadDocumentSnapshots(uris: vscode.Uri[]) {
        // Take independent copies now.  Mutating the remote file after this
        // method resolves is precisely the snapshot -> socket-subscribe gap.
        const entries = await Promise.all(uris
            .filter(uri => /\.tex$/i.test(uri.path))
            .map(async uri => [
                uri.toString(),
                Buffer.from(await vscode.workspace.fs.readFile(uri)),
            ] as const));
        return new Map<string, Uint8Array>(entries);
    }

    async ensureConnectedForWrite() {}

    async writeFileFromRemoteBaseline(
        uri: vscode.Uri,
        content: Uint8Array,
        _baseline?: Uint8Array,
        expectedRemoteMissing = false,
    ) {
        if (expectedRemoteMissing && await pathExists(uri)) {
            const current = await vscode.workspace.fs.readFile(uri);
            if (Buffer.compare(Buffer.from(current), Buffer.from(content))!==0) {
                throw new RemoteDocumentMergeConflictError(`remote path appeared: ${uri.path}`);
            }
            return content;
        }
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

    async reconnect() { return {} as any; }

    getProjectSCMPersist(key: string) { return this.persists.get(key); }
    setProjectSCMPersist(key: string, value?: unknown) {
        if (value===undefined) { this.persists.delete(key); }
        else { this.persists.set(key, value); }
    }
    hasProjectSCMPersist(key: string) { return this.persists.has(key); }
}

async function tempDir(prefix: string) {
    return vscode.Uri.file(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function writeText(uri: vscode.Uri, content: string) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

async function readText(uri: vscode.Uri) {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

async function pathExists(uri: vscode.Uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000) {
    const deadline = Date.now()+timeoutMs;
    while (!predicate()) {
        if (Date.now()>=deadline) {
            throw new Error('Timed out waiting for handoff state');
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function sha1(content: string) {
    return crypto.createHash('sha1').update(Buffer.from(content, 'utf8')).digest('hex');
}

const createdScms: LocalReplicaSCMProvider[] = [];

function createScm(remoteRoot: vscode.Uri, localRoot: vscode.Uri, vfs = new SnapshotVfs(remoteRoot)) {
    const scm = new LocalReplicaSCMProvider(vfs as unknown as VirtualFileSystem, localRoot);
    createdScms.push(scm);
    return {scm, vfs};
}

suite('Local Replica HTTP snapshot subscription handoff', function () {
    this.timeout(15000);

    const roots: vscode.Uri[] = [];
    let originalPullRetryDelays: number[];
    let originalPullReconnectWaitMs: number;

    setup(() => {
        originalPullRetryDelays = (LocalReplicaSCMProvider as any).pullRetryDelays;
        originalPullReconnectWaitMs = (LocalReplicaSCMProvider as any).pullReconnectWaitMs;
        (LocalReplicaSCMProvider as any).pullRetryDelays = [0, 5];
        (LocalReplicaSCMProvider as any).pullReconnectWaitMs = 5;
    });

    teardown(async () => {
        (LocalReplicaSCMProvider as any).pullRetryDelays = originalPullRetryDelays;
        (LocalReplicaSCMProvider as any).pullReconnectWaitMs = originalPullReconnectWaitMs;
        await Promise.allSettled(createdScms.splice(0).map(scm => scm.deactivate()));
        await Promise.all(roots.splice(0).map(root => fs.rm(root.fsPath, {recursive: true, force: true})));
    });

    async function initializeSnapshot() {
        const remoteRoot = await tempDir('sr-snapshot-handoff-remote-');
        const localRoot = await tempDir('sr-snapshot-handoff-local-');
        roots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'A: HTTP snapshot\n');
        const {scm} = createScm(remoteRoot, localRoot);
        assert.strictEqual(await scm.initializeLocalReplica({resetLocalFilesToRemote: true}), true);
        assert.strictEqual(await readText(localMain), 'A: HTTP snapshot\n');
        assert.deepStrictEqual(
            [...(scm as any).pendingInitialDocumentSubscriptions],
            ['/main.tex'],
            'HTTP bootstrap must leave every text document pending until join/subscription',
        );
        return {scm, remoteMain, localMain};
    }

    test('P0: a remote revision arriving after the HTTP snapshot wins the initial verification', async () => {
        const {scm, remoteMain, localMain} = await initializeSnapshot();
        await writeText(remoteMain, 'B: joined document revision\n');

        await (scm as any).verifyInitialDocumentSubscriptions();

        assert.strictEqual(await readText(localMain), 'B: joined document revision\n');
        assert.strictEqual((scm as any).pendingInitialDocumentSubscriptions.size, 0);
        assert.strictEqual(
            (scm as any).syncManifest.files['/main.tex'].localDigest,
            sha1('B: joined document revision\n'),
            'the accepted manifest baseline must be the joined revision, not snapshot A',
        );
    });

    test('P0: concurrent local and remote revisions in the handoff become a merge/conflict, never a silent winner', async () => {
        const {scm, remoteMain, localMain} = await initializeSnapshot();
        await writeText(localMain, 'L: local agent edit\n');
        await writeText(remoteMain, 'R: collaborator edit\n');

        const verification = (scm as any).verifyInitialDocumentSubscriptions();
        await waitUntil(() => (scm as any).syncConflicts.has('/main.tex'));

        const local = await readText(localMain);
        assert.strictEqual(await readText(remoteMain), 'R: collaborator edit\n');
        assert.strictEqual(
            local,
            'L: local agent edit\n',
            'a conflict preserves the local bytes; the unchanged remote path above preserves R',
        );
        assert.ok(
            (scm as any).syncConflicts.has('/main.tex'),
            'an overlapping A/L/R transition must be surfaced instead of choosing a side',
        );
        assert.strictEqual(
            (scm as any).pendingInitialDocumentSubscriptions.has('/main.tex'),
            true,
            'a conflicted handoff is deliberately not treated as a subscribed/verified baseline',
        );
        await scm.deactivate();
        await verification;
    });

    test('P0: a failed join remains pending, blocks compile, then clears only after recovery', async () => {
        const {scm, remoteMain} = await initializeSnapshot();
        const internals = scm as any;
        const heldRemote = remoteMain.with({path: `${remoteMain.path}.held`});
        await fs.rename(remoteMain.fsPath, heldRemote.fsPath);
        // The path still exists, so verification classifies it as an update,
        // but reading the directory as a document fails through the real
        // workspace.fs boundary. This avoids monkey-patching VS Code's
        // read-only filesystem API and models an unavailable join payload.
        await fs.mkdir(remoteMain.fsPath);

        const verification = internals.verifyInitialDocumentSubscriptions();
        await new Promise(resolve => setTimeout(resolve, 25));
        internals.precompileStartupReadinessWaitMs = 20;
        await assert.rejects(
            scm.flushBeforeCompile([]),
            /initial Overleaf document subscription is still being verified/i,
        );
        assert.strictEqual(internals.pendingInitialDocumentSubscriptions.has('/main.tex'), true);

        await fs.rm(remoteMain.fsPath, {recursive: true});
        await fs.rename(heldRemote.fsPath, remoteMain.fsPath);
        await verification;
        assert.strictEqual(internals.pendingInitialDocumentSubscriptions.size, 0);
        const flush = await scm.flushBeforeCompile([]);
        assert.strictEqual(flush.blockedCount, 0);
        assert.strictEqual(flush.failedCount, 0);
    });

    test('P0: teardown invalidates an in-flight verification before it can write a stale joined revision', async () => {
        const {scm, remoteMain, localMain} = await initializeSnapshot();
        await writeText(remoteMain, 'B: must not reach a stopped replica\n');
        const heldRemote = remoteMain.with({path: `${remoteMain.path}.held`});
        await fs.rename(remoteMain.fsPath, heldRemote.fsPath);
        await fs.mkdir(remoteMain.fsPath);

        const verification = (scm as any).verifyInitialDocumentSubscriptions();
        await new Promise(resolve => setTimeout(resolve, 25));
        // deactivate() invalidates the session synchronously, then drains its
        // queue. Restore B only after that invalidation; a stale verification
        // must not get another opportunity to apply it to the local tree.
        const deactivation = scm.deactivate();
        await fs.rm(remoteMain.fsPath, {recursive: true});
        await fs.rename(heldRemote.fsPath, remoteMain.fsPath);
        await Promise.all([verification, deactivation]);

        assert.strictEqual(await readText(localMain), 'A: HTTP snapshot\n');
        assert.strictEqual((scm as any).pendingInitialDocumentSubscriptions.size, 0);
    });
});
