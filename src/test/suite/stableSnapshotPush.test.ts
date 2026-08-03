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
import {
    LOCAL_SNAPSHOT_UNSTABLE,
    LocalReadUnstableError,
    LocalReplicaSCMProvider,
} from '../../scm/localReplicaSCM';
import { EventBus, Events } from '../../utils/eventBus';
import { getOutputChannel } from '../../utils/outputChannel';
import * as localReplicaWorkspace from '../../utils/localReplicaWorkspace';
import { setActiveReplicaRoot } from '../../utils/localReplicaWorkspace';

// Mirrors REMOTE_DELETE_MTIME_SLOP_MS in localReplicaSCM.ts, which is module
// private. The P0 regression depends on the exact predicate, so the test states
// the window it is reasoning about rather than inferring it.
const REMOTE_DELETE_MTIME_SLOP_MS = 2_000;

interface PersistRecord {
    enabled: boolean;
    label: string;
    baseUri: string;
    settings: JSON;
}

class FakeVirtualFileSystem {
    public readonly origin: vscode.Uri;
    public readonly projectName = 'Stable Snapshot Test';
    public readonly serverName = 'test-server';
    public readonly _userId = 'test-user';
    public readonly projectId = 'test-project';
    public readonly connectionState = 'connected';
    private readonly connectionEmitter = new vscode.EventEmitter<string>();
    public readonly onDidChangeConnection = this.connectionEmitter.event;
    private readonly persists = new Map<string, PersistRecord>();
    // Every byte that reaches Overleaf goes through writeFileFromRemoteBaseline
    // (guardedReplaceRemoteBinary and pushWithRetry both end here). Entries are
    // appended only once the bytes have actually landed, and they carry the
    // target path and a monotonic sequence number so a test can check causal
    // provenance rather than mere set membership.
    public readonly uploads: Array<{seq: number; relPath: string; digest: string}> = [];

    public get uploadedDigests() {
        return this.uploads.map(upload => upload.digest);
    }

    public get uploadCount() {
        return this.uploads.length;
    }

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
                this.recordUpload(uri, content);
                return content;
            }
            throw new RemoteDocumentMergeConflictError(
                `Overleaf path appeared while the local file was being created: ${uri.path}`,
            );
        }
        await vscode.workspace.fs.writeFile(uri, content);
        this.recordUpload(uri, content);
        return content;
    }

    private recordUpload(uri: vscode.Uri, content: Uint8Array) {
        const relative = path.relative(this.remoteRoot.fsPath, uri.fsPath).split(path.sep).join('/');
        this.uploads.push({
            seq: nextObservationSeq(),
            relPath: '/' + relative.split('/').filter(Boolean).join('/'),
            digest: sha1Bytes(content),
        });
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

function sha1(content: string) {
    return crypto.createHash('sha1').update(Buffer.from(content, 'utf-8')).digest('hex');
}

function sha1Bytes(content: Uint8Array) {
    return crypto.createHash('sha1').update(Buffer.from(content)).digest('hex');
}

// One monotonic clock shared by every observation the provenance test records,
// so "this read happened before that upload" is a fact rather than an inference.
let observationSeq = 0;
function nextObservationSeq() {
    observationSeq += 1;
    return observationSeq;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4000) {
    const deadline = Date.now()+timeoutMs;
    while (!predicate()) {
        if (Date.now()>=deadline) {
            throw new Error('Timed out waiting for test condition');
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
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

// Rewrite the file through its existing inode. Same dev/ino, different size and
// mtime — exactly what latexmk does to a PDF it regenerates, and the condition
// the descriptor pre/post guard is there to catch.
async function rewriteInPlace(uri: vscode.Uri, content: string) {
    const writer = await fs.open(uri.fsPath, 'r+');
    try {
        await writer.truncate(0);
        await writer.writeFile(content);
    } finally {
        await writer.close();
    }
}

const createdSCMsForTest: LocalReplicaSCMProvider[] = [];

function createSCM(remoteRoot: vscode.Uri, localRoot: vscode.Uri, fakeVfs = new FakeVirtualFileSystem(remoteRoot)) {
    const scm = new LocalReplicaSCMProvider(fakeVfs as unknown as VirtualFileSystem, localRoot);
    createdSCMsForTest.push(scm);
    return scm;
}

suite('Local Replica stable-snapshot push', function () {
    this.timeout(20000);

    const tempRoots: vscode.Uri[] = [];
    let outputLines: string[] = [];
    let warnings: string[] = [];
    let restoreOutputAppendLine: () => void;
    let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
    let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
    let originalCreateFileSystemWatcher: typeof vscode.workspace.createFileSystemWatcher;
    let originalWatcherProbeTimeoutMs: number;
    let originalWatcherHealthIntervalMs: number;
    let originalShouldUseDirectLocalWatcher: () => boolean;
    let originalStabilizeDelays: number[];
    let originalStabilizeWarnMs: number;
    let originalStabilizeRearmMs: number;
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
        originalStabilizeDelays = (LocalReplicaSCMProvider as any).localReadStabilizeDelays;
        originalStabilizeWarnMs = (LocalReplicaSCMProvider as any).localReadStabilizeWarnMs;
        originalStabilizeRearmMs = (LocalReplicaSCMProvider as any).localReadStabilizeRearmMs;
        (LocalReplicaSCMProvider as any).shouldUseDirectLocalWatcher = () => false;
        (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs = 60_000;
        (LocalReplicaSCMProvider as any).watcherHealthIntervalMs = 60_000;
        (LocalReplicaSCMProvider as any).localReadStabilizeDelays = [5, 10];
        (LocalReplicaSCMProvider as any).localReadStabilizeRearmMs = 20;
        warnings = [];
        (vscode.window as any).showWarningMessage = async (message: string) => {
            warnings.push(message);
            return undefined;
        };
        (vscode.window as any).showInformationMessage = async () => undefined;

        outputLines = [];
        const channel = getOutputChannel();
        const originalAppendLine = channel.appendLine.bind(channel);
        (channel as any).appendLine = (line: string) => {
            outputLines.push(line);
            originalAppendLine(line);
        };
        restoreOutputAppendLine = () => {
            (channel as any).appendLine = originalAppendLine;
        };
    });

    teardown(async () => {
        restoreOutputAppendLine();
        (vscode.window as any).showWarningMessage = originalShowWarningMessage;
        (vscode.window as any).showInformationMessage = originalShowInformationMessage;
        (vscode.workspace as any).createFileSystemWatcher = originalCreateFileSystemWatcher;
        (LocalReplicaSCMProvider as any).watcherProbeTimeoutMs = originalWatcherProbeTimeoutMs;
        (LocalReplicaSCMProvider as any).watcherHealthIntervalMs = originalWatcherHealthIntervalMs;
        (LocalReplicaSCMProvider as any).shouldUseDirectLocalWatcher = originalShouldUseDirectLocalWatcher;
        (LocalReplicaSCMProvider as any).localReadStabilizeDelays = originalStabilizeDelays;
        (LocalReplicaSCMProvider as any).localReadStabilizeWarnMs = originalStabilizeWarnMs;
        (LocalReplicaSCMProvider as any).localReadStabilizeRearmMs = originalStabilizeRearmMs;
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

    function hasLine(fragment: string) {
        return outputLines.some(line => line.includes(fragment));
    }

    // ---------------------------------------------------------------- P0 ----

    test('P0: a retried read never pairs fresh bytes with the pre-read mtime and deletes the local file', async () => {
        const remoteRoot = await tempDir('sr-stable-p0-remote-');
        const localRoot = await tempDir('sr-stable-p0-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteSample = vscode.Uri.joinPath(remoteRoot, 'sample.tex');
        const localSample = vscode.Uri.joinPath(localRoot, 'sample.tex');
        await writeText(remoteSample, 'restored bytes');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        // Overleaf deletes the file; the local copy goes with it and leaves a
        // tombstone carrying the deleted revision's digest and mtime.
        await vscode.workspace.fs.delete(remoteSample);
        await internals.applySync('pull', 'delete', '/sample.tex', remoteSample, localSample);
        assert.strictEqual(await pathExists(localSample), false);
        const tombstone = internals.remoteDeleteTombstones.get('/sample.tex');
        assert.ok(tombstone, 'the pull delete must record a tombstone');
        assert.strictEqual(tombstone.digest, sha1('restored bytes'));

        // The user starts working again. At the moment applySync takes its
        // pre-read stat the file holds an OLDER revision whose mtime is still
        // inside the tombstone's echo window.
        await writeText(localSample, 'work in progress');
        const staleTime = new Date(tombstone.staleLocalMtime);
        await fs.utimes(localSample.fsPath, staleTime, staleTime);
        const preReadStat = await fs.stat(localSample.fsPath);

        // The writer finishes mid-read: the file becomes the recreated revision,
        // whose bytes happen to equal the tombstone digest, with a fresh mtime
        // far outside the echo window.
        const restoredTime = new Date(Date.now()+120_000);
        const originalRead = internals.readOpenedLocalFile.bind(scm);
        let torn = false;
        internals.readOpenedLocalFile = async (handle: fs.FileHandle) => {
            const content = await originalRead(handle);
            if (!torn) {
                torn = true;
                await rewriteInPlace(localSample, 'restored bytes');
                await fs.utimes(localSample.fsPath, restoredTime, restoredTime);
            }
            return content;
        };

        // Both halves of the old echo predicate are satisfied by the STALE
        // metadata plus the FRESH bytes: mtime inside the window, digest equal.
        // Pairing them is what deleted the local file.
        assert.ok(
            preReadStat.mtimeMs<=tombstone.staleLocalMtime+REMOTE_DELETE_MTIME_SLOP_MS,
            'the pre-read mtime must satisfy the remote-delete echo window',
        );
        assert.ok(
            restoredTime.getTime()>tombstone.staleLocalMtime+REMOTE_DELETE_MTIME_SLOP_MS,
            'the revision actually read must fall outside the echo window',
        );

        const event = await internals.applySync(
            'push',
            'update',
            '/sample.tex',
            localSample,
            remoteSample,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(torn, true, 'the read must have been retried');
        assert.ok(hasLine('[local read deferred:descriptor-changed]'));
        assert.ok(
            !hasLine('[push update suppressed:remote-delete-echo]'),
            'the recreated file must not be classified as a tombstone echo',
        );
        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(await pathExists(localSample), true);
        assert.strictEqual(await readText(localSample), 'restored bytes');
        assert.strictEqual(await readText(remoteSample), 'restored bytes');
        assert.strictEqual(vfs.uploadCount, 1);
        internals.readOpenedLocalFile = originalRead;
    });

    test('P0: the tombstone echo delete removes only the revision that authorized it', async () => {
        const remoteRoot = await tempDir('sr-stable-echo-cas-remote-');
        const localRoot = await tempDir('sr-stable-echo-cas-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteSample = vscode.Uri.joinPath(remoteRoot, 'sample.tex');
        const localSample = vscode.Uri.joinPath(localRoot, 'sample.tex');
        await writeText(remoteSample, 'tombstoned bytes');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        await vscode.workspace.fs.delete(remoteSample);
        await internals.applySync('pull', 'delete', '/sample.tex', remoteSample, localSample);
        const tombstone = internals.remoteDeleteTombstones.get('/sample.tex');
        assert.ok(tombstone);

        // Revision A is a genuine tombstone echo: same bytes, mtime inside the
        // window. It authorizes the suppression delete.
        await writeText(localSample, 'tombstoned bytes');
        const staleTime = new Date(tombstone.staleLocalMtime);
        await fs.utimes(localSample.fsPath, staleTime, staleTime);

        // Revision B lands after the authorization and before the delete: a real
        // edit the user would lose if the delete were revision-unconditional.
        const originalStableRead = internals.readStableConfinedLocalFile.bind(scm);
        let replaced = false;
        internals.readStableConfinedLocalFile = async (
            relPath: string,
            uri?: vscode.Uri,
            generation?: number,
        ) => {
            const snapshot = await originalStableRead(relPath, uri, generation);
            if (relPath==='/sample.tex' && !replaced) {
                replaced = true;
                await writeText(localSample, 'legitimate revision B');
            }
            return snapshot;
        };

        let event: Events['scmSyncCompleteEvent'];
        try {
            event = await internals.applySync(
                'push',
                'update',
                '/sample.tex',
                localSample,
                remoteSample,
            ) as Events['scmSyncCompleteEvent'];
        } finally {
            internals.readStableConfinedLocalFile = originalStableRead;
        }

        assert.strictEqual(replaced, true, 'revision B must have landed before the delete');
        assert.strictEqual(await pathExists(localSample), true, 'revision B was deleted');
        assert.strictEqual(await readText(localSample), 'legitimate revision B');
        assert.ok(hasLine('[push update deferred:echo-delete-superseded]'));
        assert.ok(
            !hasLine('[push update suppressed:remote-delete-echo]'),
            'a refused delete must not be reported as a completed suppression',
        );
        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(internals.locallyDivergedPaths.has('/sample.tex'), true);

        // And the deferral converges: B is not stranded by the cleared provenance.
        const retry = await waitForSyncComplete(localRoot, '/sample.tex', 'push', 'update');
        assert.strictEqual(retry.outcome, 'success');
        assert.strictEqual(await readText(remoteSample), 'legitimate revision B');
        assert.strictEqual(await readText(localSample), 'legitimate revision B');
        assert.strictEqual(vfs.uploadCount, 1);
    });

    test('P0: the tombstone echo delete refuses a same-byte recreate on a new inode', async () => {
        const remoteRoot = await tempDir('sr-stable-echo-samebytes-remote-');
        const localRoot = await tempDir('sr-stable-echo-samebytes-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteSample = vscode.Uri.joinPath(remoteRoot, 'sample.tex');
        const localSample = vscode.Uri.joinPath(localRoot, 'sample.tex');
        await writeText(remoteSample, 'tombstoned bytes');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        await vscode.workspace.fs.delete(remoteSample);
        await internals.applySync('pull', 'delete', '/sample.tex', remoteSample, localSample);
        const tombstone = internals.remoteDeleteTombstones.get('/sample.tex');
        assert.ok(tombstone);

        // Revision A: the stale echo. Same bytes as the tombstone, mtime inside
        // the window, so it authorizes the suppression delete.
        await writeText(localSample, 'tombstoned bytes');
        const staleTime = new Date(tombstone.staleLocalMtime);
        await fs.utimes(localSample.fsPath, staleTime, staleTime);
        const staleIno = (await fs.lstat(localSample.fsPath)).ino;

        // Revision B: the user restores the file on purpose. Byte-for-byte
        // identical to A — so a digest-only compare-and-swap sees no difference —
        // but a different inode with a fresh mtime, which is exactly what makes
        // it an intentional restore rather than the stale echo.
        const replacement = vscode.Uri.joinPath(localRoot, 'restore.tmp');
        await writeText(replacement, 'tombstoned bytes');
        const restoredTime = new Date(Date.now()+120_000);
        const originalStableRead = internals.readStableConfinedLocalFile.bind(scm);
        let recreated = false;
        internals.readStableConfinedLocalFile = async (
            relPath: string,
            uri?: vscode.Uri,
            generation?: number,
        ) => {
            const snapshot = await originalStableRead(relPath, uri, generation);
            if (relPath==='/sample.tex' && !recreated) {
                recreated = true;
                await fs.rename(replacement.fsPath, localSample.fsPath);
                await fs.utimes(localSample.fsPath, restoredTime, restoredTime);
            }
            return snapshot;
        };

        let event: Events['scmSyncCompleteEvent'];
        try {
            event = await internals.applySync(
                'push',
                'update',
                '/sample.tex',
                localSample,
                remoteSample,
            ) as Events['scmSyncCompleteEvent'];
        } finally {
            internals.readStableConfinedLocalFile = originalStableRead;
        }

        assert.strictEqual(recreated, true);
        assert.strictEqual(
            await pathExists(localSample),
            true,
            'the same-byte recreate was deleted by a digest-only compare-and-swap',
        );
        const survivingIno = (await fs.lstat(localSample.fsPath)).ino;
        assert.notStrictEqual(survivingIno, staleIno, 'the recreate must be a new inode');
        assert.strictEqual(await readText(localSample), 'tombstoned bytes');
        assert.ok(hasLine('[push update deferred:echo-delete-superseded]'));
        assert.ok(!hasLine('[push update suppressed:remote-delete-echo]'));
        assert.strictEqual(event.outcome, 'blocked');

        // The intentional restore then reaches Overleaf, because on re-read its
        // fresh mtime no longer satisfies the tombstone predicate.
        const retry = await waitForSyncComplete(localRoot, '/sample.tex', 'push', 'update');
        assert.strictEqual(retry.outcome, 'success');
        assert.strictEqual(await readText(remoteSample), 'tombstoned bytes');
        assert.strictEqual(await readText(localSample), 'tombstoned bytes');
    });

    test('a short read is refused even when every metadata field matches', async () => {
        const remoteRoot = await tempDir('sr-stable-shortread-remote-');
        const localRoot = await tempDir('sr-stable-shortread-local-');
        tempRoots.push(remoteRoot, localRoot);
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'complete revision bytes');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        // The file is never touched, so dev/ino/size/mtime/ctime are all
        // identical before and after — exactly the state a same-length rewrite
        // inside one coarse timestamp tick leaves behind. Only the byte count
        // betrays that the reader saw a partial file.
        const originalRead = internals.readOpenedLocalFile.bind(scm);
        let shortened = false;
        internals.readOpenedLocalFile = async (handle: fs.FileHandle) => {
            const content = await originalRead(handle);
            if (!shortened) {
                shortened = true;
                return content.subarray(0, content.length-4);
            }
            return content;
        };

        try {
            let captured: unknown;
            await assert.rejects(
                () => internals.readConfinedLocalFileSnapshot('/main.tex'),
                (error: unknown) => {
                    captured = error;
                    return /bytes for a .*-byte revision/.test(String((error as Error).message));
                },
            );
            assert.strictEqual(captured instanceof LocalReadUnstableError, true);
            assert.strictEqual((captured as LocalReadUnstableError).reason, 'descriptor-changed');

            // And the stabilizing wrapper recovers on the next attempt.
            shortened = false;
            const snapshot = await internals.readStableConfinedLocalFile('/main.tex') as {
                content: Uint8Array;
                stat: vscode.FileStat;
            };
            assert.strictEqual(
                Buffer.from(snapshot.content).toString('utf-8'),
                'complete revision bytes',
            );
            assert.strictEqual(snapshot.content.length, snapshot.stat.size);
            assert.ok(hasLine('[local read deferred:descriptor-changed]'));
        } finally {
            internals.readOpenedLocalFile = originalRead;
        }
    });

    test('read metadata is derived from the descriptor that produced the bytes', async () => {
        const remoteRoot = await tempDir('sr-stable-token-remote-');
        const localRoot = await tempDir('sr-stable-token-local-');
        tempRoots.push(remoteRoot, localRoot);
        const localSample = vscode.Uri.joinPath(localRoot, 'sample.tex');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'sample.tex'), 'first revision');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        const firstRevisionMtime = (await fs.stat(localSample.fsPath)).mtimeMs;
        const secondRevisionTime = new Date(Date.now()-90_000);
        const originalRead = internals.readOpenedLocalFile.bind(scm);
        let torn = false;
        internals.readOpenedLocalFile = async (handle: fs.FileHandle) => {
            const content = await originalRead(handle);
            if (!torn) {
                torn = true;
                await rewriteInPlace(localSample, 'second revision bytes');
                await fs.utimes(localSample.fsPath, secondRevisionTime, secondRevisionTime);
            }
            return content;
        };

        const snapshot = await internals.readStableConfinedLocalFile('/sample.tex') as {
            content: Uint8Array;
            stat: vscode.FileStat;
        };
        internals.readOpenedLocalFile = originalRead;

        assert.strictEqual(torn, true);
        assert.strictEqual(Buffer.from(snapshot.content).toString('utf-8'), 'second revision bytes');
        assert.strictEqual(snapshot.stat.size, snapshot.content.length);
        assert.ok(
            Math.abs(snapshot.stat.mtime-secondRevisionTime.getTime())<=5,
            'the metadata must describe the revision whose bytes were returned',
        );
        assert.ok(
            Math.abs(snapshot.stat.mtime-firstRevisionMtime)>1_000,
            'the metadata must not come from the pre-read revision',
        );

        // A later path lstat must not be able to redefine what was read: move the
        // path forward and confirm the already-returned metadata is unchanged.
        const laterTime = new Date(Date.now()+90_000);
        await fs.utimes(localSample.fsPath, laterTime, laterTime);
        assert.ok(Math.abs(snapshot.stat.mtime-secondRevisionTime.getTime())<=5);
    });

    // ------------------------------------------------- successful exits ----

    test('the "remote already matches local" exit re-drives when the local file advanced', async () => {
        const remoteRoot = await tempDir('sr-stable-exit-a-remote-');
        const localRoot = await tempDir('sr-stable-exit-a-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'v1');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        // A watcher push already delivered v2, so the remote readback matches.
        await writeText(localMain, 'v2');
        await writeText(remoteMain, 'v2');

        const originalPull = internals.pullRemoteFile.bind(scm);
        let advanced = false;
        internals.pullRemoteFile = async (relPath: string, uri: vscode.Uri, generation?: number) => {
            const content = await originalPull(relPath, uri, generation);
            if (!advanced && relPath==='/main.tex') {
                advanced = true;
                await writeText(localMain, 'v3');
            }
            return content;
        };

        const event = await internals.applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        const retryWait = waitForSyncComplete(localRoot, '/main.tex', 'push', 'update');

        assert.strictEqual(advanced, true);
        assert.strictEqual(event.outcome, 'success');
        assert.ok(hasLine('[push verified]'));
        assert.ok(hasLine('[push intermediate]'));
        assert.strictEqual(internals.locallyDivergedPaths.has('/main.tex'), true);
        assert.strictEqual(vfs.uploadCount, 0, 'the verified exit must not upload');

        assert.strictEqual((await retryWait).outcome, 'success');
        assert.strictEqual(await readText(remoteMain), 'v3');
        assert.strictEqual(vfs.uploadCount, 1, 'exactly one upload for the advanced revision');
        await waitUntil(() => internals.locallyDivergedPaths.has('/main.tex')===false);
    });

    test('the untracked-remote exit re-drives when the local file advanced', async () => {
        const remoteRoot = await tempDir('sr-stable-exit-b-remote-');
        const localRoot = await tempDir('sr-stable-exit-b-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'anchor');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        // Neither side is tracked: no baseline, but the bytes already agree.
        const remoteNew = vscode.Uri.joinPath(remoteRoot, 'appendix.tex');
        const localNew = vscode.Uri.joinPath(localRoot, 'appendix.tex');
        await writeText(localNew, 'a1');
        await writeText(remoteNew, 'a1');

        const originalPull = internals.pullRemoteFile.bind(scm);
        let advanced = false;
        internals.pullRemoteFile = async (relPath: string, uri: vscode.Uri, generation?: number) => {
            const content = await originalPull(relPath, uri, generation);
            if (!advanced && relPath==='/appendix.tex') {
                advanced = true;
                await writeText(localNew, 'a2');
            }
            return content;
        };

        const event = await internals.applySync(
            'push',
            'update',
            '/appendix.tex',
            localNew,
            remoteNew,
        ) as Events['scmSyncCompleteEvent'];
        const retryWait = waitForSyncComplete(localRoot, '/appendix.tex', 'push', 'update');

        assert.strictEqual(advanced, true);
        assert.strictEqual(event.outcome, 'success');
        assert.ok(hasLine('untracked remote already matches local'));
        assert.ok(hasLine('[push intermediate]'));
        assert.strictEqual(internals.locallyDivergedPaths.has('/appendix.tex'), true);
        assert.strictEqual(vfs.uploadCount, 0);

        assert.strictEqual((await retryWait).outcome, 'success');
        assert.strictEqual(await readText(remoteNew), 'a2');
        assert.strictEqual(vfs.uploadCount, 1);
        await waitUntil(() => internals.locallyDivergedPaths.has('/appendix.tex')===false);
    });

    // ---------------------------------------------- transient disappearance ----

    test('classification does not turn a watcher update into a delete on one missing observation', async () => {
        const remoteRoot = await tempDir('sr-stable-classify-enoent-remote-');
        const localRoot = await tempDir('sr-stable-classify-enoent-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'v1');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        const pathEvents: Events['scmSyncCompleteEvent'][] = [];
        const subscription = EventBus.on('scmSyncCompleteEvent', pushEvent => {
            if (pushEvent.relPath==='/main.tex' && pushEvent.direction==='push') {
                pathEvents.push(pushEvent);
            }
        });

        // The unlink half of an atomic replacement has landed; the rename half
        // has not. The watcher reported a change, not a delete.
        await fs.rm(localMain.fsPath);
        const originalStat = internals.statConfinedLocalUri.bind(scm);
        let classificationStats = 0;
        internals.statConfinedLocalUri = async (uri: vscode.Uri, operation: string) => {
            if (
                uri.fsPath===localMain.fsPath
                && operation.startsWith('classification of')
            ) {
                classificationStats += 1;
                // The replacement lands while the classifier is still looking.
                if (classificationStats===2) { await writeText(localMain, 'v2'); }
            }
            return originalStat(uri, operation);
        };

        try {
            const event = await internals.enqueueLocalPendingEvent(
                '/main.tex',
                {latestType: 'update', latestUri: localMain},
                internals.syncGeneration,
            ) as Events['scmSyncCompleteEvent'];

            assert.ok(classificationStats>=2, 'the classifier must look more than once');
            assert.ok(hasLine('[classification recheck:vanished-during-update]'));
            assert.strictEqual(event.type, 'update');
            assert.strictEqual(event.outcome, 'success');
            assert.strictEqual(await pathExists(remoteMain), true, 'Overleaf copy was deleted');
            assert.strictEqual(await readText(remoteMain), 'v2');
            assert.deepStrictEqual(
                pathEvents.filter(pushEvent => pushEvent.type==='delete'),
                [],
                'no delete may be propagated for a replacement in flight',
            );

            // The window is bounded, so a genuinely deleted file that the watcher
            // mislabelled as a change still propagates its delete.
            await fs.rm(localMain.fsPath);
            const beforeMislabelled = classificationStats;
            assert.strictEqual(
                await internals.localTargetNeedsPush('/main.tex', localMain, 'update'),
                'delete',
            );
            assert.strictEqual(
                classificationStats-beforeMislabelled,
                4,
                'the recheck window must be bounded, not unbounded',
            );

            // A watcher-reported delete is direct evidence and spends no window.
            const beforeObservedDelete = classificationStats;
            assert.strictEqual(
                await internals.localTargetNeedsPush('/main.tex', localMain, 'delete'),
                'delete',
            );
            assert.strictEqual(classificationStats-beforeObservedDelete, 1);
        } finally {
            internals.statConfinedLocalUri = originalStat;
            subscription.dispose();
        }
    });

    test('the synthesized save flush also rechecks a momentary vanish', async () => {
        const remoteRoot = await tempDir('sr-stable-flush-enoent-remote-');
        const localRoot = await tempDir('sr-stable-flush-enoent-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'v1');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        const pathEvents: Events['scmSyncCompleteEvent'][] = [];
        const subscription = EventBus.on('scmSyncCompleteEvent', pushEvent => {
            if (pushEvent.relPath==='/main.tex' && pushEvent.direction==='push') {
                pathEvents.push(pushEvent);
            }
        });

        // flushPendingPush with no debounced event synthesises its own push, so
        // it classifies without any watcher observation to inherit.
        await fs.rm(localMain.fsPath);
        const originalStat = internals.statConfinedLocalUri.bind(scm);
        let classificationStats = 0;
        internals.statConfinedLocalUri = async (uri: vscode.Uri, operation: string) => {
            if (
                uri.fsPath===localMain.fsPath
                && operation.startsWith('classification of')
            ) {
                classificationStats += 1;
                if (classificationStats===2) { await writeText(localMain, 'v2'); }
            }
            return originalStat(uri, operation);
        };

        try {
            assert.strictEqual(internals.pendingLocalEvents.has('/main.tex'), false);
            await scm.flushPendingPush(localMain);

            assert.ok(classificationStats>=2, 'the classifier must look more than once');
            assert.ok(hasLine('[classification recheck:vanished-during-update]'));
            assert.strictEqual(await pathExists(remoteMain), true, 'Overleaf copy was deleted');
            assert.strictEqual(await readText(remoteMain), 'v2');
            assert.deepStrictEqual(
                pathEvents.filter(pushEvent => pushEvent.type==='delete'),
                [],
                'no delete may be propagated for a replacement in flight',
            );
            assert.strictEqual(vfs.uploadCount, 1);
        } finally {
            internals.statConfinedLocalUri = originalStat;
            subscription.dispose();
        }
    });

    test('a vanish during an already-classified update defers instead of deleting the remote', async () => {
        const remoteRoot = await tempDir('sr-stable-enoent-remote-');
        const localRoot = await tempDir('sr-stable-enoent-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'v1');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        (LocalReplicaSCMProvider as any).localReadStabilizeRearmMs = 300;

        // The atomic replacement's unlink lands after the watcher event was
        // already classified as an update.
        await fs.rm(localMain.fsPath);
        const event = await internals.applySync(
            'push',
            'update',
            '/main.tex',
            localMain,
            remoteMain,
        ) as Events['scmSyncCompleteEvent'];
        // Complete the replacement before the re-arm re-classifies.
        await writeText(localMain, 'v2');
        const retryWait = waitForSyncComplete(localRoot, '/main.tex', 'push', 'update');

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(event.error, LOCAL_SNAPSHOT_UNSTABLE);
        assert.strictEqual(await pathExists(remoteMain), true);
        assert.strictEqual(await readText(remoteMain), 'v1');
        assert.strictEqual(internals.locallyDivergedPaths.has('/main.tex'), true);
        assert.ok(hasLine('[push deferred:unstable-read]'));
        assert.strictEqual(warnings.length, 0, 'a transient vanish must not toast');

        assert.strictEqual((await retryWait).outcome, 'success');
        assert.strictEqual(await readText(remoteMain), 'v2');
        assert.strictEqual(vfs.uploadCount, 1);
    });

    test('a push delete does not propagate while the local path is back', async () => {
        const remoteRoot = await tempDir('sr-stable-redelete-remote-');
        const localRoot = await tempDir('sr-stable-redelete-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteNotes = vscode.Uri.joinPath(remoteRoot, 'notes.tex');
        const localNotes = vscode.Uri.joinPath(localRoot, 'notes.tex');
        await writeText(remoteNotes, 'notes v1');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        // A delete classified from a transient ENOENT, reaching applySync after
        // the replacement has already put a real file back at the path.
        const event = await internals.applySync(
            'push',
            'delete',
            '/notes.tex',
            localNotes,
            remoteNotes,
        ) as Events['scmSyncCompleteEvent'];

        assert.strictEqual(event.outcome, 'blocked');
        assert.strictEqual(event.error, LOCAL_SNAPSHOT_UNSTABLE);
        assert.strictEqual(await pathExists(remoteNotes), true);
        assert.strictEqual(await readText(remoteNotes), 'notes v1');
        assert.strictEqual(vfs.uploadCount, 0);

        // Re-classification finds the path in sync, so the deferral resolves
        // itself and the divergence mark is cleared rather than left stuck.
        await waitUntil(() => internals.locallyDivergedPaths.has('/notes.tex')===false);
        assert.strictEqual(await pathExists(remoteNotes), true);
        assert.strictEqual(internals.localStabilizeState.has('/notes.tex'), false);
    });

    // -------------------------------------------------- compile barrier ----

    test('the compile barrier blocks with the sentinel and schedules a retry', async () => {
        const remoteRoot = await tempDir('sr-stable-barrier-remote-');
        const localRoot = await tempDir('sr-stable-barrier-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'compiled baseline');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        (LocalReplicaSCMProvider as any).localReadStabilizeDelays = [1, 1];
        // Keep the re-arm far enough out that the assertions below observe the
        // barrier's own state rather than a retry's.
        (LocalReplicaSCMProvider as any).localReadStabilizeRearmMs = 5_000;

        await writeText(localMain, 'agent edit in flight');
        const originalRead = internals.readOpenedLocalFile.bind(scm);
        let revision = 0;
        internals.readOpenedLocalFile = async (handle: fs.FileHandle) => {
            const content = await originalRead(handle);
            revision += 1;
            // Each revision must differ in LENGTH from the previous one. The
            // descriptor guard's mtime/ctime halves compare a coarse filesystem
            // clock whose granularity is machine-dependent (a tick can be 1-4ms
            // on some kernels, sub-microsecond on others), so two same-length
            // rewrites a millisecond apart are not reliably distinguishable by
            // timestamp. The size comparison is exact, so growing the file makes
            // "no coherent snapshot exists" true by construction everywhere.
            await rewriteInPlace(localMain, `agent edit in flight${'!'.repeat(revision)}`);
            return content;
        };

        try {
            // localUris empty: the only discovery path is the source scan, whose
            // read catch used to record the raw internal error and schedule
            // nothing.
            await assert.rejects(
                () => scm.flushBeforeCompile([]),
                /still being written/,
            );
            assert.ok(hasLine('[compile barrier end]'), 'the barrier must always log its end');
            assert.ok(hasLine('[push deferred:unstable-read]'));
            assert.strictEqual(internals.pendingLocalEvents.has('/main.tex'), true);
            assert.strictEqual(internals.locallyDivergedPaths.has('/main.tex'), true);

            // And again through the explicit-target and pending-event
            // classification sites, which used to throw out of flushBeforeCompile
            // before [compile barrier end] was reached.
            outputLines = [];
            await assert.rejects(
                () => scm.flushBeforeCompile([localMain]),
                /still being written/,
            );
            assert.ok(hasLine('[compile barrier end]'));
            assert.ok(
                !hasLine('[compile barrier scan incomplete]'),
                'an unstable read is not a truncated scan',
            );
            assert.ok(revision>0, 'the premise requires the file to have been read at all');
            assert.strictEqual(await readText(remoteMain), 'compiled baseline');
            assert.deepStrictEqual(vfs.uploadedDigests, []);
        } finally {
            internals.readOpenedLocalFile = originalRead;
        }
    });

    // The container run of the previous test exposed the real boundary of the
    // descriptor guard: it proves the bytes were not torn, not that the file
    // stopped moving afterwards. A read can legitimately return a revision that
    // is superseded microseconds later, and on a filesystem whose timestamps are
    // coarse enough the guard cannot see that.
    //
    // The guarantee that must hold regardless is narrower than "every payload was
    // returned by a confined read", which is false: the auto-merge writers push
    // diff3 output that no read produced, and the production VFS can merge again
    // before emitting OT, so a payload's local side may itself already be a merge
    // product. The honest statement is that remote bytes are ROOTED in a confined
    // read, possibly through one or more merge stages: a payload is either
    // (a) causally traceable to an earlier confined read OF THE SAME PATH that
    // returned exactly those bytes, or (b) the output of an auto-merge that ran
    // before it. Nothing is cached, replayed from a buffer, or fabricated from
    // nothing.
    //
    // Instrumentation notes. Uploads are recorded only after the bytes land, and
    // uploads and reads carry a path plus a sequence number, so a later read
    // cannot retroactively legitimise an earlier upload. Merge observations carry
    // a sequence number but NO path: mergeTextContents receives only contents, so
    // the merge side proves ordering ("an auto-merge produced these bytes before
    // this upload") and not path linkage.
    function installProvenanceProbes(scm: LocalReplicaSCMProvider) {
        const internals = scm as any;
        const reads: Array<{seq: number; relPath: string; digest: string}> = [];
        const mergeProducts: Array<{seq: number; digest: string}> = [];
        const originalSnapshotRead = internals.readConfinedLocalFileSnapshot.bind(scm);
        internals.readConfinedLocalFileSnapshot = async (relPath: string, uri?: vscode.Uri) => {
            const snapshot = await originalSnapshotRead(relPath, uri);
            reads.push({
                seq: nextObservationSeq(),
                relPath,
                digest: sha1Bytes(snapshot.content),
            });
            return snapshot;
        };
        const originalMerge = internals.mergeTextContents.bind(scm);
        internals.mergeTextContents = (...args: unknown[]) => {
            const merged = originalMerge(...args);
            if (merged!==undefined) {
                mergeProducts.push({seq: nextObservationSeq(), digest: sha1Bytes(merged)});
            }
            return merged;
        };
        return {
            reads,
            mergeProducts,
            restore() {
                internals.readConfinedLocalFileSnapshot = originalSnapshotRead;
                internals.mergeTextContents = originalMerge;
            },
        };
    }

    function assertUploadProvenance(
        vfs: FakeVirtualFileSystem,
        probes: {
            reads: Array<{seq: number; relPath: string; digest: string}>;
            mergeProducts: Array<{seq: number; digest: string}>;
        },
    ) {
        for (const upload of vfs.uploads) {
            const causallyRead = probes.reads.some(read =>
                read.seq<upload.seq
                && read.relPath===upload.relPath
                && read.digest===upload.digest
            );
            const causallyMerged = probes.mergeProducts.some(merge =>
                merge.seq<upload.seq && merge.digest===upload.digest
            );
            assert.ok(
                causallyRead || causallyMerged,
                `upload #${upload.seq} of ${upload.relPath} carried bytes that no earlier `
                + 'confined read of that path returned and that no auto-merge produced',
            );
        }
    }

    test('uploads are causally traceable to an earlier confined read of the same path', async () => {
        const remoteRoot = await tempDir('sr-stable-provenance-remote-');
        const localRoot = await tempDir('sr-stable-provenance-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        const probes = installProvenanceProbes(scm);

        // Model the guard's blind spot exactly: the read returned an untorn
        // revision, and the writer moved the file on immediately after, with no
        // metadata difference left for the guard to observe.
        const originalStableRead = internals.readStableConfinedLocalFile.bind(scm);
        let supersededCount = 0;
        internals.readStableConfinedLocalFile = async (
            relPath: string,
            uri?: vscode.Uri,
            generation?: number,
        ) => {
            const snapshot = await originalStableRead(relPath, uri, generation);
            if (relPath==='/main.tex' && supersededCount<2) {
                supersededCount += 1;
                await writeText(localMain, `settled revision ${supersededCount+1}`);
            }
            return snapshot;
        };

        try {
            await writeText(localMain, 'settled revision 1');
            const event = await internals.applySync(
                'push',
                'update',
                '/main.tex',
                localMain,
                remoteMain,
            ) as Events['scmSyncCompleteEvent'];
            assert.strictEqual(event.outcome, 'success');
            assert.ok(
                hasLine('[push intermediate]'),
                'a revision superseded during the upload must be re-driven',
            );

            // The re-arms chain until the file stops moving.
            await waitUntil(
                () => internals.locallyDivergedPaths.has('/main.tex')===false,
                8000,
            );
        } finally {
            internals.readStableConfinedLocalFile = originalStableRead;
            probes.restore();
        }

        assert.strictEqual(supersededCount, 2, 'the blind spot must have been exercised');
        assert.ok(vfs.uploads.length>=2, 'the scenario must actually upload');
        assert.strictEqual(probes.mergeProducts.length, 0, 'this scenario must not auto-merge');
        assertUploadProvenance(vfs, probes);
        assert.strictEqual(await readText(remoteMain), 'settled revision 3');
        assert.strictEqual(await readText(localMain), 'settled revision 3');
    });

    test('the push-side auto-merge writer uploads merge output built from a confined read', async () => {
        const remoteRoot = await tempDir('sr-stable-merge-remote-');
        const localRoot = await tempDir('sr-stable-merge-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'line1\nline2\nline3\n');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        const probes = installProvenanceProbes(scm);

        // Non-overlapping concurrent edits: the push path three-way merges and
        // uploads bytes that exist nowhere on disk.
        await writeText(localMain, 'LOCAL\nline2\nline3\n');
        await writeText(remoteMain, 'line1\nline2\nREMOTE\n');

        let event: Events['scmSyncCompleteEvent'];
        try {
            event = await internals.applySync(
                'push',
                'update',
                '/main.tex',
                localMain,
                remoteMain,
            ) as Events['scmSyncCompleteEvent'];
        } finally {
            probes.restore();
        }

        assert.strictEqual(event.outcome, 'success');
        assert.strictEqual(await readText(remoteMain), 'LOCAL\nline2\nREMOTE\n');
        assert.strictEqual(await readText(localMain), 'LOCAL\nline2\nREMOTE\n');
        assert.strictEqual(vfs.uploads.length, 1);

        const merged = sha1Bytes(Buffer.from('LOCAL\nline2\nREMOTE\n', 'utf-8'));
        assert.ok(
            probes.mergeProducts.some(merge =>
                merge.digest===merged && merge.seq<vfs.uploads[0].seq
            ),
            'the upload must be recorded as merge output produced before it',
        );
        // The exception is real: these bytes were never returned by any read.
        assert.strictEqual(
            probes.reads.some(read => read.digest===merged && read.seq<vfs.uploads[0].seq),
            false,
            'the merge product is deliberately not a previously-read revision',
        );
        // The merge input was, though, which is the part that must stay true.
        assert.ok(
            probes.reads.some(read =>
                read.relPath==='/main.tex'
                && read.digest===sha1Bytes(Buffer.from('LOCAL\nline2\nline3\n', 'utf-8'))
            ),
            'the local side of the merge must come from a confined read',
        );
        assertUploadProvenance(vfs, probes);
    });

    test('the post-push compile reclassification blocks instead of escaping', async () => {
        const remoteRoot = await tempDir('sr-stable-reclassify-remote-');
        const localRoot = await tempDir('sr-stable-reclassify-local-');
        tempRoots.push(remoteRoot, localRoot);
        const remoteMain = vscode.Uri.joinPath(remoteRoot, 'main.tex');
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(remoteMain, 'baseline');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        (LocalReplicaSCMProvider as any).localReadStabilizeRearmMs = 5_000;
        await writeText(localMain, 'edit that uploads cleanly');

        // Tear only the classification that runs AFTER the push succeeded.
        const originalApplySync = internals.applySync.bind(scm);
        let tearNextClassification = false;
        internals.applySync = async (...args: unknown[]) => {
            const event = await originalApplySync(...args);
            if (args[0]==='push' && args[2]==='/main.tex') { tearNextClassification = true; }
            return event;
        };
        const originalNeedsPush = internals.localTargetNeedsPush.bind(scm);
        internals.localTargetNeedsPush = async (relPath: string, uri: vscode.Uri) => {
            if (tearNextClassification && relPath==='/main.tex') {
                tearNextClassification = false;
                throw new LocalReadUnstableError(
                    relPath,
                    'descriptor-changed',
                    'simulated writer holding the file after the upload',
                );
            }
            return originalNeedsPush(relPath, uri);
        };

        try {
            await assert.rejects(
                () => scm.flushBeforeCompile([localMain]),
                /still being written/,
            );
            assert.ok(hasLine('[compile barrier end]'));
            assert.strictEqual(await readText(remoteMain), 'edit that uploads cleanly');
            assert.strictEqual(vfs.uploadCount, 1, 'the upload itself still happened exactly once');
            assert.strictEqual(internals.pendingLocalEvents.has('/main.tex'), true);
            assert.strictEqual(internals.locallyDivergedPaths.has('/main.tex'), true);
        } finally {
            internals.localTargetNeedsPush = originalNeedsPush;
            internals.applySync = originalApplySync;
        }
    });

    test('the queued precompile reclassification reports the sentinel, not a missing event', async () => {
        const remoteRoot = await tempDir('sr-stable-queued-remote-');
        const localRoot = await tempDir('sr-stable-queued-local-');
        tempRoots.push(remoteRoot, localRoot);
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');

        const vfs = new FakeVirtualFileSystem(remoteRoot);
        const scm = createSCM(remoteRoot, localRoot, vfs);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        (LocalReplicaSCMProvider as any).localReadStabilizeRearmMs = 5_000;

        const originalNeedsPush = internals.localTargetNeedsPush.bind(scm);
        internals.localTargetNeedsPush = async (relPath: string, uri: vscode.Uri) => {
            if (relPath==='/main.tex') {
                throw new LocalReadUnstableError(
                    relPath,
                    'path-identity-changed',
                    'simulated replacement during the queued reclassification',
                );
            }
            return originalNeedsPush(relPath, uri);
        };

        const result = {
            pendingCount: 0,
            divergedCount: 0,
            openDocCount: 0,
            sourceScanCount: 0,
            sourceScanDeleteCount: 0,
            attemptedCount: 0,
            failedCount: 0,
            blockedCount: 0,
            suppressedCount: 0,
            paths: [] as string[],
            failures: [] as string[],
        };
        try {
            // type 'delete' forces the in-queue reclassification whose throw used
            // to be swallowed by enqueueSync's catch-all.
            await internals.runPrecompilePush(
                '/main.tex',
                localMain,
                result,
                {forcePush: true, reason: 'compile-scan'},
                internals.syncGeneration,
                'delete',
            );
        } finally {
            internals.localTargetNeedsPush = originalNeedsPush;
        }

        assert.strictEqual(result.blockedCount, 1);
        assert.strictEqual(result.failedCount, 0);
        assert.deepStrictEqual(result.failures, [`/main.tex: ${LOCAL_SNAPSHOT_UNSTABLE}`]);
        assert.strictEqual(internals.pendingLocalEvents.has('/main.tex'), true);
        assert.strictEqual(internals.locallyDivergedPaths.has('/main.tex'), true);
        assert.strictEqual(vfs.uploadCount, 0);
    });

    // ------------------------------------------------------- error shape ----

    test('withRetry does not amplify an unstable read', async () => {
        const remoteRoot = await tempDir('sr-stable-retry-remote-');
        const localRoot = await tempDir('sr-stable-retry-local-');
        tempRoots.push(remoteRoot, localRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        const thrown = new LocalReadUnstableError(
            '/main.tex',
            'descriptor-changed',
            'simulated mid-write read',
        );
        assert.strictEqual((thrown as unknown as {retryable: boolean}).retryable, false);
        assert.strictEqual(thrown instanceof LocalReadUnstableError, true);
        assert.strictEqual(thrown.reason, 'descriptor-changed');

        let attempts = 0;
        await assert.rejects(
            () => internals.withRetry('push', '/main.tex', async () => {
                attempts += 1;
                throw thrown;
            }, {delays: [0, 0, 0, 0]}),
            (error: unknown) => error===thrown,
        );
        assert.strictEqual(attempts, 1, 'the non-retryable short-circuit must fire on the first attempt');
    });

    test('every unstable reason defers silently instead of reporting a classification failure', async () => {
        const remoteRoot = await tempDir('sr-stable-reasons-remote-');
        const localRoot = await tempDir('sr-stable-reasons-local-');
        tempRoots.push(remoteRoot, localRoot);
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        (LocalReplicaSCMProvider as any).localReadStabilizeRearmMs = 5_000;

        const errorEvents: Events['scmSyncCompleteEvent'][] = [];
        const subscription = EventBus.on('scmSyncCompleteEvent', event => {
            if (event.outcome==='error') { errorEvents.push(event); }
        });
        try {
            const reasons = [
                'descriptor-changed',
                'reopened-different-inode',
                'path-identity-changed',
                'vanished-during-update',
            ] as const;
            for (const reason of reasons) {
                internals.pendingLocalEvents.forEach(
                    (pending: {timer: ReturnType<typeof setTimeout>}) => clearTimeout(pending.timer),
                );
                internals.pendingLocalEvents.clear();
                internals.locallyDivergedPaths.delete('/main.tex');
                internals.localStabilizeState.delete('/main.tex');
                outputLines = [];

                internals.retainLocalPushIntentAfterClassificationFailure(
                    '/main.tex',
                    localMain,
                    'update',
                    new LocalReadUnstableError('/main.tex', reason, `simulated ${reason}`),
                    internals.syncGeneration,
                );

                assert.strictEqual(
                    hasLine('[push classification failed]'),
                    false,
                    `${reason} must not be reported as a classification failure`,
                );
                assert.ok(hasLine('[push deferred:unstable-read]'), reason);
                assert.strictEqual(internals.pendingLocalEvents.has('/main.tex'), true, reason);
                assert.strictEqual(internals.locallyDivergedPaths.has('/main.tex'), true, reason);
            }
            assert.deepStrictEqual(errorEvents, []);
            assert.deepStrictEqual(warnings, []);
        } finally {
            subscription.dispose();
        }
    });

    test('a replaced inode between snapshot and open is deferred and the retry reads the replacement', async () => {
        const remoteRoot = await tempDir('sr-stable-inode-remote-');
        const localRoot = await tempDir('sr-stable-inode-local-');
        tempRoots.push(remoteRoot, localRoot);
        const localSample = vscode.Uri.joinPath(localRoot, 'sample.tex');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'sample.tex'), 'original inode bytes');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        // Allocated while the original inode is still live, so the rename below
        // is guaranteed to install a different inode rather than possibly
        // recycling the freed one.
        const replacement = vscode.Uri.joinPath(localRoot, 'replacement.tmp');
        await writeText(replacement, 'replacement inode bytes');

        const originalSnapshot = internals.captureLocalPathIdentitySnapshot.bind(scm);
        let swapped = false;
        internals.captureLocalPathIdentitySnapshot = async (uri: vscode.Uri, operation: string) => {
            const snapshot = await originalSnapshot(uri, operation);
            if (
                !swapped
                && operation.startsWith('read of')
                && uri.fsPath===localSample.fsPath
            ) {
                swapped = true;
                await fs.rename(replacement.fsPath, localSample.fsPath);
            }
            return snapshot;
        };

        try {
            const snapshot = await internals.readStableConfinedLocalFile('/sample.tex') as {
                content: Uint8Array;
            };
            assert.strictEqual(swapped, true);
            assert.ok(hasLine('[local read deferred:reopened-different-inode]'));
            assert.strictEqual(
                Buffer.from(snapshot.content).toString('utf-8'),
                'replacement inode bytes',
            );
        } finally {
            internals.captureLocalPathIdentitySnapshot = originalSnapshot;
        }
    });

    // ------------------------------------------------------- warn policy ----

    test('warns only after a sustained failure and keeps retrying afterwards', async () => {
        const remoteRoot = await tempDir('sr-stable-warn-remote-');
        const localRoot = await tempDir('sr-stable-warn-local-');
        tempRoots.push(remoteRoot, localRoot);
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        (LocalReplicaSCMProvider as any).localReadStabilizeWarnMs = 60;
        (LocalReplicaSCMProvider as any).localReadStabilizeRearmMs = 5_000;
        const generation = internals.syncGeneration;

        internals.scheduleLocalPushRetry('/main.tex', localMain, 'unstable-read', generation);
        assert.deepStrictEqual(warnings, [], 'the first deferral must be silent');
        const firstUnstableAt = internals.localStabilizeState.get('/main.tex').firstUnstableAt;

        await new Promise(resolve => setTimeout(resolve, 90));
        internals.scheduleLocalPushRetry('/main.tex', localMain, 'unstable-read', generation);
        assert.strictEqual(warnings.length, 1, 'a sustained failure must warn once');
        assert.match(warnings[0], /rewritten continuously/);

        internals.scheduleLocalPushRetry('/main.tex', localMain, 'unstable-read', generation);
        const state = internals.localStabilizeState.get('/main.tex');
        assert.strictEqual(state.attempts, 3, 'retries continue after the warning');
        assert.strictEqual(
            state.firstUnstableAt,
            firstUnstableAt,
            'the sustained-failure clock must not be reset by later deferrals',
        );
        assert.strictEqual(internals.pendingLocalEvents.has('/main.tex'), true);
        assert.strictEqual(internals.locallyDivergedPaths.has('/main.tex'), true);
        // maybeWarnSyncFailure rate-limits per (path × message), so the extra
        // deferral must not produce a second toast.
        assert.strictEqual(warnings.length, 1);
    });

    test('stopping sync inputs cancels the pending stabilization retry', async () => {
        const remoteRoot = await tempDir('sr-stable-cancel-remote-');
        const localRoot = await tempDir('sr-stable-cancel-local-');
        tempRoots.push(remoteRoot, localRoot);
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        const pushEvents: Events['scmSyncCompleteEvent'][] = [];
        const subscription = EventBus.on('scmSyncCompleteEvent', event => {
            if (event.relPath==='/main.tex' && event.direction==='push') { pushEvents.push(event); }
        });
        try {
            internals.scheduleLocalPushRetry(
                '/main.tex',
                localMain,
                'unstable-read',
                internals.syncGeneration,
            );
            assert.strictEqual(internals.pendingLocalEvents.has('/main.tex'), true);
            assert.strictEqual(internals.localStabilizeState.has('/main.tex'), true);

            internals.stopSyncInputs();
            assert.strictEqual(internals.pendingLocalEvents.size, 0);
            assert.strictEqual(internals.localStabilizeState.size, 0);

            await new Promise(resolve => setTimeout(resolve, 200));
            assert.deepStrictEqual(pushEvents, [], 'a cancelled retry must never fire');
        } finally {
            subscription.dispose();
        }
    });

    test('a session teardown wakes an in-flight stabilization sleep instead of holding it', async () => {
        const remoteRoot = await tempDir('sr-stable-sleep-remote-');
        const localRoot = await tempDir('sr-stable-sleep-local-');
        tempRoots.push(remoteRoot, localRoot);
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline bytes');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        // Long enough that finishing the delay would be unmistakable.
        (LocalReplicaSCMProvider as any).localReadStabilizeDelays = [10_000];

        const originalRead = internals.readOpenedLocalFile.bind(scm);
        let reads = 0;
        internals.readOpenedLocalFile = async (handle: fs.FileHandle) => {
            const content = await originalRead(handle);
            reads += 1;
            await rewriteInPlace(localMain, `baseline bytes${'!'.repeat(reads)}`);
            return content;
        };

        try {
            const pending = internals.readStableConfinedLocalFile('/main.tex') as Promise<unknown>;
            await waitUntil(() => internals.stabilizeSleeps.size===1);
            const startedAt = Date.now();

            // Exactly the order deactivateSyncSession uses.
            internals.stopSyncInputs();
            internals.syncSessionActive = false;

            let captured: unknown;
            await assert.rejects(
                () => pending,
                (error: unknown) => {
                    captured = error;
                    return true;
                },
            );
            const elapsed = Date.now()-startedAt;

            assert.strictEqual(captured instanceof LocalReadUnstableError, true);
            assert.ok(elapsed<2_000, `the sleep held for ${elapsed}ms instead of being woken`);
            assert.strictEqual(internals.stabilizeSleeps.size, 0);
            assert.strictEqual(reads, 1, 'no further disk read may follow a teardown');
        } finally {
            internals.readOpenedLocalFile = originalRead;
        }
    });

    // ---------------------------------------------------------- security ----

    test('a symlinked local path stays a loud, immediate refusal', async () => {
        const remoteRoot = await tempDir('sr-stable-symlink-remote-');
        const localRoot = await tempDir('sr-stable-symlink-local-');
        const outsideRoot = await tempDir('sr-stable-symlink-outside-');
        tempRoots.push(remoteRoot, localRoot, outsideRoot);
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');
        const outsideSecret = vscode.Uri.joinPath(outsideRoot, 'secret.tex');
        await writeText(outsideSecret, 'external secret bytes');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;

        const linkPath = vscode.Uri.joinPath(localRoot, 'linked.tex');
        await fs.symlink(outsideSecret.fsPath, linkPath.fsPath);

        let reads = 0;
        const originalRead = internals.readOpenedLocalFile.bind(scm);
        internals.readOpenedLocalFile = async (handle: fs.FileHandle) => {
            reads += 1;
            return originalRead(handle);
        };

        let captured: unknown;
        await assert.rejects(
            () => internals.readStableConfinedLocalFile('/linked.tex'),
            (error: unknown) => {
                captured = error;
                return /refuses symbolic links/i.test(String((error as Error).message));
            },
        );
        internals.readOpenedLocalFile = originalRead;

        assert.strictEqual(captured instanceof LocalReadUnstableError, false);
        assert.strictEqual(reads, 0, 'a security refusal must not burn the backoff budget');
        assert.strictEqual(hasLine('[local read deferred'), false);
    });

    test('a read whose descriptor escapes the replica stays a loud, immediate refusal', async function () {
        if (process.platform!=='linux') { this.skip(); }
        const remoteRoot = await tempDir('sr-stable-escape-remote-');
        const localRoot = await tempDir('sr-stable-escape-local-');
        const outsideRoot = await tempDir('sr-stable-escape-outside-');
        tempRoots.push(remoteRoot, localRoot, outsideRoot);
        const localMain = vscode.Uri.joinPath(localRoot, 'main.tex');
        const escapedMain = vscode.Uri.joinPath(outsideRoot, 'escaped.tex');
        await writeText(vscode.Uri.joinPath(remoteRoot, 'main.tex'), 'baseline');

        const scm = createSCM(remoteRoot, localRoot);
        await scm.initializeLocalReplica({resetLocalFilesToRemote: true});
        const internals = scm as any;
        await writeText(localMain, 'bytes from the opened inode');

        let reads = 0;
        const originalRead = internals.readOpenedLocalFile.bind(scm);
        internals.readOpenedLocalFile = async (handle: fs.FileHandle) => {
            const content = await originalRead(handle);
            reads += 1;
            if (reads===1) {
                await vscode.workspace.fs.rename(localMain, escapedMain, {overwrite: false});
                await writeText(localMain, 'replacement inside the replica');
            }
            return content;
        };

        let captured: unknown;
        await assert.rejects(
            () => internals.readStableConfinedLocalFile('/main.tex'),
            (error: unknown) => {
                captured = error;
                return /escaped the selected folder/i.test(String((error as Error).message));
            },
        );
        internals.readOpenedLocalFile = originalRead;

        assert.strictEqual(captured instanceof LocalReadUnstableError, false);
        assert.strictEqual(reads, 1, 'the escape must abort before any retry');
    });
});
