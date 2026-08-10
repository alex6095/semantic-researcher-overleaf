import * as crypto from 'crypto';
import {constants as nodeFsConstants, watch as nodeFsWatch} from 'fs';
import * as nodeFs from 'fs/promises';
import * as nodeNet from 'net';
import * as os from 'os';
import * as nodePath from 'path';
import * as vscode from 'vscode';
import picomatch = require('picomatch');
import { BaseSCM, CommitItem, SettingItem } from ".";
import {
    RemoteDocumentMergeConflictError,
    RemoteDocumentWriteAmbiguousError,
    VirtualFileSystem,
    parseUri,
    vfsProjectKey,
} from '../core/remoteFileSystemProvider';
import {
    getActiveReplicaRoot,
    hasReplicaRemovalTombstone,
    isLocalReplicaMetadataUri,
    localUriToPath,
    normalizeLocalReplicaRelPath,
    normalizeReplicaPath,
    pathToLocalUri,
    readReplicaSettings,
    readReplicaSettingsSnapshot,
} from '../utils/localReplicaWorkspace';
import {
    LEGACY_REPLICA_SETTINGS_BACKUP_FILE,
    LEGACY_REPLICA_SETTINGS_DIR,
    LEGACY_REPLICA_SETTINGS_FILE,
    OUTPUT_FOLDER_NAME,
    REPLICA_SETTINGS_DIR,
    REPLICA_SETTINGS_FILE,
    getConfiguredValue,
} from '../consts';
import { stringifyOverleafUri } from '../utils/overleafUri';
import { EventBus, Events } from '../utils/eventBus';
import { formatUnknownError } from '../utils/errorMessage';
import { getOutputChannel } from '../utils/outputChannel';
import { PROTECTED_LOCAL_REPLICA_IGNORE_PATTERNS } from './replicaIgnorePatterns';
import { decodeUtf8Text, mergeUtf8Text } from '../utils/threeWayMerge';

const IGNORE_SETTING_KEY = 'ignore-patterns';
const ECHO_WINDOW_MS = 500;
/**
 * The extension's compile output is distinguished by its configured root
 * folder, never by a filename. In particular, source assets named main.pdf
 * and output.pdf are ordinary project files and must remain syncable.
 */
export function isLocalReplicaCompileOutputPath(
    relPath: string,
    outputFolderName = OUTPUT_FOLDER_NAME,
): boolean {
    // Settings validation rejects path separators, but persisted legacy values
    // still need a fail-closed check before they can affect sync filtering.
    if (
        outputFolderName==='' ||
        outputFolderName==='.' ||
        outputFolderName==='..' ||
        /[\\/]/.test(outputFolderName)
    ) {
        return false;
    }
    const outputRoot = '/' + outputFolderName;
    const normalized = normalizeReplicaPath(relPath);
    return normalized===outputRoot || normalized.startsWith(outputRoot + '/');
}

const SYNC_MANIFEST_FILE = `${REPLICA_SETTINGS_DIR}/sync-manifest.json`;
const SYNC_OWNER_FILE = 'sync-owner.json';
const SYNC_OWNER_REPAIR_FILE = 'sync-owner.repair.json';
const LEGACY_SYNC_OWNER_DIRECTORY = 'sync-owner';
const LEGACY_SYNC_OWNER_FILE = 'owner.json';

// Reported instead of the raw internal read error whenever a push is deferred
// because the local bytes would not hold still. It reaches the user through the
// compile barrier, so it has to read as a state of the file rather than as a
// defect in the extension.
export const LOCAL_SNAPSHOT_UNSTABLE =
    'local file is still being written; no consistent snapshot available';

export function matchesLocalReplicaIgnorePattern(path: string, pattern: string): boolean {
    return picomatch.isMatch(path, pattern, {dot: true});
}

// The shared output channel now lives in src/utils/outputChannel so the
// compile pipeline can log to the same 'Semantic Researcher Overleaf' channel.

// De-dupe warning notifications: remember the last error signature we surfaced.
const lastWarnByRel = new Map<string, {signature: string, at: number}>();
function maybeWarnSyncFailure(relPath: string, error: unknown) {
    const signature = formatUnknownError(error);
    const key = relPath;
    const previous = lastWarnByRel.get(key);
    const now = Date.now();
    // One toast per (file × message) in any 60s window — stops spam on disconnected sockets.
    if (previous && previous.signature===signature && now-previous.at<60_000) { return; }
    lastWarnByRel.set(key, {signature, at: now});
    vscode.window.showWarningMessage(
        vscode.l10n.t('Overleaf sync failed for {relPath}: {message}', {relPath, message: signature}),
        vscode.l10n.t('Show Output'),
    ).then((choice) => {
        if (choice==='Show Output') { getOutputChannel().show(true); }
    });
}

async function deleteWithTrashFallback(uri: vscode.Uri, options?: {recursive?: boolean}) {
    try {
        await vscode.workspace.fs.delete(uri, {...options, useTrash: true});
    } catch (error) {
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [delete trash fallback] ${uri.toString()}: ${formatUnknownError(error)}`,
        );
        await vscode.workspace.fs.delete(uri, options);
    }
}

type FileCache = {date:number, hash:string, type:'update'|'delete'};
type LocalPathIdentitySnapshot = {
    entries: Array<{path: string; identity: string}>;
    finalStat: {
        isFile: boolean;
        isDirectory: boolean;
        ctimeMs: number;
        mtimeMs: number;
        size: number;
        dev: string;
        ino: string;
    };
};
type StagedDetachedLocalGuard = {
    record: LocalReplicaOperationRecord;
    guardPath: string;
    detachedGuardPath: string;
    detachedRecordPath: string;
};
type DetachedLocalGuardRecord = LocalReplicaOperationRecord & {
    detachedAt: string;
    mappingRemovalCommittedAt?: string;
};

const DELETE_DIGEST = '\0';

interface SyncManifestRemoteEntityIdentity {
    id: string;
    type: 'doc' | 'file';
}

interface SyncManifestLocalFileIdentity {
    dev: string;
    ino: string;
}

interface SyncManifestRemoteFolderIdentity {
    id: string;
    type: 'folder';
}

interface SyncManifestEntry {
    remoteFingerprint: string;
    localSize: number;
    localMtime: number;
    localDigest: string;
    remoteEntity?: SyncManifestRemoteEntityIdentity;
    localIdentity?: SyncManifestLocalFileIdentity;
    baseContentBase64?: string;
    updatedAt: string;
}

interface SyncManifestDirectoryEntry {
    remoteEntity?: SyncManifestRemoteFolderIdentity;
    parentEntity?: SyncManifestRemoteFolderIdentity;
    localIdentity?: SyncManifestLocalFileIdentity;
    updatedAt: string;
}

interface SyncManifestConflictEntry {
    reason: string;
    localDigest: string;
    remoteKind?: PathRevision['kind'];
    remoteRevision?: string;
    updatedAt: string;
}

interface SyncManifest {
    version: 9;
    projectUri: string;
    baselineComplete: boolean;
    files: Record<string, SyncManifestEntry>;
    directories: Record<string, SyncManifestDirectoryEntry>;
    conflicts: Record<string, SyncManifestConflictEntry>;
    pendingOperations: Record<string, SyncManifestPendingOperation>;
}

type SyncManifestBaselineMode = 'trusted' | 'fresh-replica' | 'unavailable';

interface LocalReplicaSnapshot {
    files: Set<string>;
    directories: Set<string>;
}

interface PathRevision {
    kind: 'missing' | 'file' | 'directory' | 'other';
    revision: string;
    content?: Uint8Array;
}

type RemoteFolderPathIdentity = {
    entity: SyncManifestRemoteFolderIdentity;
    parent: SyncManifestRemoteFolderIdentity;
};

interface SyncManifestPendingFileOperation {
    version: 1;
    id: string;
    kind: 'update' | 'delete';
    localKind: 'file' | 'missing';
    localRevision: string;
    remoteKind?: PathRevision['kind'];
    remoteRevision?: string;
    createdAt: string;
    updatedAt: string;
}

interface SyncManifestPendingMoveOperation {
    version: 2;
    id: string;
    kind: 'move';
    localKind: 'file';
    localRevision: string;
    sourceEntity: SyncManifestRemoteEntityIdentity;
    sourceLocalIdentity: SyncManifestLocalFileIdentity;
    destinationRelPath: string;
    sourceRemoteKind?: PathRevision['kind'];
    sourceRemoteRevision?: string;
    createdAt: string;
    updatedAt: string;
}

interface SyncManifestPendingDirectoryCreateOperation {
    version: 1;
    id: string;
    kind: 'mkdir';
    localKind: 'directory';
    localRevision: string;
    remoteKind: 'missing';
    remoteRevision: typeof DELETE_DIGEST;
    parentEntity: SyncManifestRemoteFolderIdentity;
    // Persisted immediately after the server confirms our POST and before the
    // final authoritative path verification. If a process dies before that
    // write, a later folder at the same name is intentionally unproven.
    createdEntity?: SyncManifestRemoteFolderIdentity;
    createdAt: string;
    updatedAt: string;
}

// A local folder deletion has no bytes left to journal. Its durable proof is
// the exact remote tree revision and the target/parent folder identities that
// existed before the remote stage mutation. The deterministic stage fields link
// this manifest intent to the crash-recovery journal kept beside it.
interface SyncManifestPendingDirectoryDeleteOperation {
    version: 1;
    id: string;
    kind: 'rmdir';
    localKind: 'missing';
    localRevision: typeof DELETE_DIGEST;
    remoteKind: 'directory';
    remoteRevision: string;
    targetEntity: SyncManifestRemoteFolderIdentity;
    parentEntity: SyncManifestRemoteFolderIdentity;
    stageOperationId: string;
    stagingRelPath: string;
    createdAt: string;
    updatedAt: string;
}

// A local folder rename/move is one identity-preserving project-tree intent,
// never a recursive delete followed by unrelated folder/file creates. The
// source tree revision and local directory inode prove the local rename; the
// source/destination parent identities make every replay re-check the exact
// remote entities before it asks Overleaf to rename or move the folder.
interface SyncManifestPendingDirectoryMoveOperation {
    version: 1;
    id: string;
    kind: 'directory-move';
    localKind: 'directory';
    localRevision: string;
    sourceEntity: SyncManifestRemoteFolderIdentity;
    sourceParentEntity: SyncManifestRemoteFolderIdentity;
    sourceLocalIdentity: SyncManifestLocalFileIdentity;
    destinationRelPath: string;
    destinationParentEntity: SyncManifestRemoteFolderIdentity;
    sourceRemoteKind: 'directory';
    sourceRemoteRevision: string;
    createdAt: string;
    updatedAt: string;
}

type SyncManifestPendingOperation = SyncManifestPendingFileOperation
    | SyncManifestPendingMoveOperation
    | SyncManifestPendingDirectoryCreateOperation
    | SyncManifestPendingDirectoryDeleteOperation
    | SyncManifestPendingDirectoryMoveOperation;

type PendingLocalMoveDelete = {
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
};

type PendingLocalMoveInspection = {
    sourceState: PathRevision;
    destinationState: PathRevision;
    accepted: boolean;
    ready: boolean;
    resumeSourceRelPath?: string;
};

interface LocalReplicaOperationRecord {
    version: 1;
    id: string;
    kind: 'write' | 'delete';
    relPath: string;
    entityKind: PathRevision['kind'];
    expectedRevision: string;
    installedRevision?: string;
    stageName?: string;
    backupName: string;
    guardName: string;
    createdAt: string;
}

interface RemoteFolderDeleteGuard {
    entity: SyncManifestRemoteFolderIdentity;
    parent: SyncManifestRemoteFolderIdentity;
    pendingOperationId: string;
}

interface RemoteDeleteOperationRecord {
    version: 1;
    id: string;
    kind?: 'delete' | 'replace';
    relPath: string;
    stagingRelPath: string;
    expectedRevision: string;
    replacementRevision?: string;
    supersededByRevision?: string;
    // Present only for a guarded recursive folder deletion. It lets crash
    // recovery distinguish the original folder from a same-name replacement.
    folderGuard?: RemoteFolderDeleteGuard;
    createdAt: string;
}

interface PendingEvent {
    timer: ReturnType<typeof setTimeout>;
    firstEventAt: number;
    latestType: 'update' | 'delete';
    latestUri: vscode.Uri;
}

interface RemoteDeleteTombstone {
    digest: string;
    staleLocalMtime?: number;
    deletedAt: number;
}

interface InitializeLocalReplicaOptions {
    preserveExistingLocalFiles?: boolean;
    resetLocalFilesToRemote?: boolean;
}

interface InitialRemoteBootstrap {
    files: [string, string][];
    directories: string[];
    documentSnapshots?: Map<string, Uint8Array>;
    remoteTreeElapsedMs: number;
    documentBatchElapsedMs: number;
}

type InitialRemoteBootstrapOutcome =
    | {value: InitialRemoteBootstrap; error?: never}
    | {value?: never; error: unknown};

interface ValidateExactBaseUriOptions {
    beforeEmpty?: (baseUri: vscode.Uri) => void | Promise<void>;
    projectUri?: vscode.Uri;
}

interface ApplySyncOptions {
    forcePush?: boolean;
    reason?: string;
    resolveConflict?: boolean;
    deferConflictResolution?: boolean;
    acceptUnchangedLocalConflictState?: boolean;
    skipDirectoryDescendants?: boolean;
}

interface DirectLocalWatcher {
    close(): void;
    on(event: 'error', listener: (error: Error) => void): DirectLocalWatcher;
}

type DirectLocalWatcherFactory = (
    rootPath: string,
    listener: (eventType: string, filename: string | Buffer | null) => void,
) => DirectLocalWatcher;

interface SyncOwnerRecord {
    version: 4;
    token: string;
    pid: number;
    hostname: string;
    hostId: string;
    projectKey: string;
    rootKey: string;
    port: number;
    createdAt: string;
}

interface SyncOwnerRepairRecord {
    version: 2;
    token: string;
    pid: number;
    hostname: string;
    hostId: string;
    createdAt: string;
}

// Ownership handshakes are the last line of defence against two writers, so a
// probe distinguishes "nobody owns this port" from "something answered but
// never identified itself". The latter must never read as free.
type SyncOwnerProbe =
    | {kind: 'owner'; owner: SyncOwnerRecord}
    | {kind: 'unrelated'}
    | {kind: 'ambiguous'; reason: string};

interface ConflictResolutionProof {
    conflictPath: string;
    remoteState: PathRevision;
}

export interface LocalReplicaPrecompileFlushResult {
    pendingCount: number;
    divergedCount: number;
    openDocCount: number;
    sourceScanCount: number;
    sourceScanDeleteCount: number;
    attemptedCount: number;
    failedCount: number;
    blockedCount: number;
    suppressedCount: number;
    paths: string[];
    failures: string[];
}

type ProtectedExactBaseUriReasonCode =
    | 'filesystem-root'
    | 'home-directory'
    | 'workspace-root'
    | 'mount-root'
    | 'windows-user-profile-root'
    | 'git-repository-root';

class LocalReplicaFolderSelectionCancelledError extends Error {}
class LocalReplicaFolderSelectionRejectedError extends Error {}
class ConcurrentReplicaChangeError extends Error {}
export class LocalReplicaOwnershipUnavailableError extends Error {}

// Identity of the file object a confined read actually observed, taken from the
// same descriptor as the bytes. It is what lets a destructive action be
// conditioned on the revision that authorized it rather than on its bytes alone.
export type LocalReadIdentity = {
    dev: string;
    ino: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
};

export type LocalReadUnstableReason =
    // The bytes moved under the open descriptor (latexmk rewriting in place).
    | 'descriptor-changed'
    // The path was replaced between the identity snapshot and open().
    | 'reopened-different-inode'
    // dev/ino under the path no longer match the descriptor we read.
    | 'path-identity-changed'
    // The path vanished after classification already concluded 'update' — an
    // atomic temp-file replacement, not evidence of a user deletion.
    | 'vanished-during-update'
    // A folder changed into a file or disappeared before its create intent
    // could be persisted; defer rather than creating a stale tree path.
    | 'directory-changed-during-create';

// A local read that observed a writer mid-flight. This is a normal condition,
// not a failure: the only correct response is to defer and look again. It is a
// distinct type so the handling layers can tell it apart from the security
// refusals (symlink, path escape, non-regular file) that share the same read
// primitive and must stay loud.
export class LocalReadUnstableError extends Error {
    // withRetry short-circuits on retryable===false. Without this its generic
    // backoff would multiply on top of the in-task stabilization loop, turning
    // one deferral into sixteen full re-reads of the same large file.
    public readonly retryable = false;

    constructor(
        public readonly relPath: string,
        public readonly reason: LocalReadUnstableReason,
        message: string,
    ) {
        super(message);
        this.name = 'LocalReadUnstableError';
    }
}

function definedInitializationOptions(options?: InitializeLocalReplicaOptions): InitializeLocalReplicaOptions {
    return Object.fromEntries(
        Object.entries(options ?? {}).filter(([_key, value]) => value!==undefined),
    ) as InitializeLocalReplicaOptions;
}

// Byte-true digest used to detect echoes in the bypass cache. The previous
// implementation went through TextDecoder which mangles arbitrary byte
// sequences into U+FFFD and was lossy for binaries (different PDFs could
// collapse to the same 32-bit hash, defeating echo suppression for media
// files). sha1 over raw bytes is collision-safe.
function contentDigest(content?: Uint8Array): string {
    if (content===undefined) { return DELETE_DIGEST; }
    return crypto.createHash('sha1').update(content).digest('hex');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a === b) { return true; }
    if (a.length !== b.length) { return false; }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { return false; }
    }
    return true;
}

function normalizeMtimeMs(mtime: number): number {
    return mtime<10_000_000_000 ? mtime*1000 : mtime;
}

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');
    private static readonly processSyncOwners = new Map<string, LocalReplicaSCMProvider>();
    private static syncOwnerHostIdPromise?: Promise<string>;
    private static legacySyncOwnerHostIdPromise?: Promise<string>;

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private bypassCache: Map<string, [FileCache,FileCache]> = new Map();
    private baseCache: {[key:string]: Uint8Array} = {};
    private syncManifest?: SyncManifest;
    private syncManifestBaselineMode: SyncManifestBaselineMode = 'unavailable';
    private settingsExistedBeforeInitialization = false;
    private syncManifestDirty = false;
    private syncManifestRevision = 0;
    private syncManifestPersistQueue: Promise<void> = Promise.resolve();
    private pendingOperationReplay?: {
        generation: number;
        started: boolean;
        promise: Promise<void>;
    };
    // Files we have written locally at least once. A push-delete arriving for a
    // relPath that isn't in here AND isn't in baseCache is treated as an echo,
    // not a user-driven delete, and is refused in the delete-guard layer.
    private seenLocalEntities: Set<string> = new Set();
    // Files whose initial pull failed even after Layer 1 retries. These are
    // present on the remote but never landed locally, so a watcher event for
    // them must NEVER propagate to the remote. Cleared by retryFailedInitialPulls
    // or by ignoreFailedInitialPulls.
    private failedInitialPulls: Set<string> = new Set();
    // Text files bootstrapped through the stateless HTTP snapshot endpoint are
    // current coherent copies, but their socket rooms are not joined yet. They
    // are verified and subscribed sequentially after startup so Overleaf's
    // single join/leave epoch is never raced. Compile remains blocked while a
    // path is in this set.
    private pendingInitialDocumentSubscriptions: Set<string> = new Set();
    // Watcher events accepted while the initial HTTP/manifest snapshot is
    // being built are replayed after readiness on the ordinary per-path sync
    // queues. Keeping this state separate lets startup become responsive
    // without allowing a compile against a tree whose accepted startup events
    // have not yet been reconciled.
    private startupReplayGeneration?: number;
    private startupReplayPromise?: Promise<void>;
    private startupReplayFailure?: {generation: number; message: string};
    // Project/UI activation stays responsive while the HTTP snapshot, buffered
    // watcher replay, and sequential joinDoc subscriptions finish in the
    // background. A compile requested during that window is queued here at the
    // barrier instead of failing a few milliseconds before startup becomes
    // safe. Tests may shorten this bounded wait through the instance seam.
    private precompileStartupReadinessWaitMs = 60_000;
    // Last synced bytes for paths that were deleted from the remote. If a local
    // create/update for the exact same bytes arrives after the delete, it is a
    // stale watcher echo rather than a new user edit and must not recreate the
    // remote file.
    private remoteDeleteTombstones: Map<string, RemoteDeleteTombstone> = new Map();
    private initialPullStatus: 'pending' | 'complete' | 'partial' = 'pending';
    private partialPullToastGeneration?: number;
    private syncQueues: Map<string, Promise<unknown>> = new Map();
    private locallyDivergedPaths: Set<string> = new Set();
    // Paths the local content scan could not classify, keyed to the time of the
    // first failure. One unreadable path (a symlinked references.bib, an EACCES
    // file) must not stop the scan, but a path that stays unreadable is silently
    // unsynced while the user was told a periodic scan covers them.
    private unscannableLocalPaths: Map<string, number> = new Map();
    // Back-pressure state for paths whose local bytes will not hold still. A
    // single mid-write read is normal and silent; this is what lets us tell the
    // user after ~30s that the file has never once been coherent, without
    // resetting that clock on every individual deferral.
    private localStabilizeState: Map<string, {
        firstUnstableAt: number;
        attempts: number;
    }> = new Map();
    // In-task backoff sleeps. They are tracked so a session change or disposal
    // wakes them immediately instead of leaving up to a second of post-disposal
    // disk I/O queued behind an untracked timer.
    // Paths the degraded-watcher scan has already seen absent once. Its "delete"
    // is an inference from a single directory listing, not a kernel unlink
    // notification, so it has to be seen absent by two consecutive scans before
    // it is allowed to claim that strength of evidence.
    private scannerAbsentPaths: Set<string> = new Set();
    private stabilizeSleeps = new Set<{
        timer: ReturnType<typeof setTimeout>;
        wake: () => void;
    }>();
    private syncConflicts: Map<string, string> = new Map();
    private conflictLocalDigests: Map<string, string> = new Map();
    private localReplicaSettings?: {
        uri: string,
        serverName: string,
        enableCompileNPreview: boolean,
        projectName: string,
    };
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
    private directLocalWatcher?: DirectLocalWatcher;
    private directLocalWatcherGeneration?: number;
    private localWatcherProbe?: {
        generation: number;
        uri: string;
        timeout?: ReturnType<typeof setTimeout>;
        resolve: () => void;
    };
    private localWatcherHealthTimer?: ReturnType<typeof setTimeout>;
    private localWatcherHealthState: 'unknown' | 'healthy' | 'degraded' = 'unknown';
    private localWatcherWarningShown = false;
    private fallbackScanTimer?: ReturnType<typeof setTimeout>;
    private fallbackScanRunningGeneration?: number;
    private fallbackScanGeneration?: number;
    // Lazily-armable trigger for the local-watcher subscriptions. When the
    // initial pull is partial we never invoke this, so the push direction is
    // physically impossible until retryFailedInitialPulls / ignoreFailedInitialPulls
    // recovers cleanly.
    private armLocalWatcher?: () => void;
    private dynamicLocalDisposables: vscode.Disposable[] = [];
    // Per-path event coalescers. The VFS fires Change events for every
    // compile-cycle touch (often 4× the same .tex file in a 30s span with
    // identical content). Debouncing per-path collapses these into a single
    // applySync call; MAX_WAIT_MS caps the worst case so a continuous stream
    // can't starve the path indefinitely.
    private pendingVfsEvents: Map<string, PendingEvent> = new Map();
    private pendingLocalEvents: Map<string, PendingEvent> = new Map();
    private pendingLocalMoveDeletes: Map<string, PendingLocalMoveDelete> = new Map();
    // Events accepted while a folder move is verifying must survive the short
    // journal-finalization window. They are reclassified only after the
    // folder identity has been accepted and its manifest paths are rekeyed.
    private deferredLocalEventsDuringDirectoryMove = new Map<
        string,
        Pick<PendingEvent, 'latestType' | 'latestUri'>
    >();
    private inFlightSessionIO = new Set<Promise<unknown>>();
    private localGuardCleanupPromises = new Map<string, Promise<void>>();
    private deferredSyncWork = new Set<Promise<void>>();
    private preQueueSyncWork = new Set<Promise<void>>();
    private activationPromise?: Promise<vscode.Disposable[]>;
    private removalPendingGeneration?: number;
    private removalDrainPromise?: Promise<void>;
    private removalOwnershipHeld = false;
    private stagedDetachedLocalGuards: StagedDetachedLocalGuard[] = [];
    private removalAcceptedSyncErrors = new Map<string, {
        generation: number;
        error: string;
    }>();
    private syncOwnerToken?: string;
    private syncOwnerServer?: nodeNet.Server;
    private syncOwnerHeartbeat?: ReturnType<typeof setInterval>;
    private syncOwnerReleasePromise?: Promise<void>;
    private localRootRealPath?: string;
    private syncGeneration = 0;
    private syncSessionActive = false;
    private static readonly eventCoalesceMs = 250;
    private static readonly eventMaxWaitMs = 2000;
    private static readonly localClassificationRetryDelays = [0, 25, 100, 300];
    private static readonly watcherProbeTimeoutMs = 750;
    private static readonly watcherHealthIntervalMs = 1000;
    private static readonly fallbackScanIntervalMs = 750;
    private static readonly unscannablePathWarnMs = 30_000;
    // In-task backoff for a read that caught a writer mid-flight. It must stay
    // an in-task loop: re-entering enqueueSync for the same path from inside its
    // own queued task self-deadlocks. The total (~1.85s) is the ceiling on how
    // long one push holds its path's queue slot.
    private static readonly localReadStabilizeDelays = [100, 250, 500, 1000];
    private static readonly localReadStabilizeRearmMs = 750;
    // A successful upload proves only that one revision reached Overleaf. Give
    // agent/shell writers one coalescing window to demonstrate that the local
    // source has actually gone quiet before allowing a compile to start.
    private static readonly compileQuiescenceMs = 250;
    private static readonly remoteDeleteConflictWindowMs = 5_000;
    // How long a watcher-observed update may keep looking for a path that has
    // momentarily vanished before the absence is accepted as a real deletion.
    // An atomic rename replacement closes in microseconds; this only has to
    // outlast that, and it must stay short because a watcher that mislabels a
    // genuine deletion as a change pays this delay before the delete propagates.
    private static readonly localVanishRecheckDelays = [25, 100, 250];
    // Deliberately separate from localVanishRecheckDelays[0] even though the two
    // currently agree: this one is the single probe taken immediately before a
    // destructive push-delete, and tuning the classification window must not
    // silently move it.
    private static readonly localDeleteCorroborationMs = 25;
    // A local rename candidate may wait briefly for its matching watcher event,
    // but the delay never proves a move. The inode, digest, current remote
    // entity identity, and destination absence checks below are the proof.
    private static readonly localMoveCandidateWindowMs = 500;
    private static readonly shouldUseDirectLocalWatcher = () => {
        const remoteName = vscode.env.remoteName?.toLowerCase();
        return remoteName?.includes('ssh')===true || Boolean(
            process.env.SSH_CONNECTION && process.env.VSCODE_AGENT_FOLDER,
        );
    };
    private static readonly createDirectLocalWatcher: DirectLocalWatcherFactory = (rootPath, listener) => (
        nodeFsWatch(rootPath, {recursive: true}, listener)
    );
    private static readonly syncOwnerHeartbeatMs = 10_000;
    private static readonly syncOwnerPortBase = 10_000;
    private static readonly syncOwnerPortRange = 10_000;
    private static readonly syncOwnerPortAttempts = 64;
    private static readonly maxMergeBaselineBytes = 5 * 1024 * 1024;
    private initializationOptions: InitializeLocalReplicaOptions = {};
    private ignorePatterns: string[] = [
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/__latexindent*',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    private static async ownershipMarkerSnapshot(
        markerPath: string,
    ): Promise<string | undefined> {
        const snapshot: string[] = [];
        const visit = async (filePath: string, relativePath: string): Promise<void> => {
            const stat = await nodeFs.lstat(filePath);
            if (stat.isFile()) {
                const content = await nodeFs.readFile(filePath);
                snapshot.push(
                    `file\0${relativePath}\0${stat.size}\0` +
                    crypto.createHash('sha256').update(content).digest('hex'),
                );
                return;
            }
            if (stat.isDirectory()) {
                snapshot.push(`directory\0${relativePath}`);
                const entries = await nodeFs.readdir(filePath);
                for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
                    await visit(
                        nodePath.join(filePath, entry),
                        relativePath ? `${relativePath}/${entry}` : entry,
                    );
                }
                return;
            }
            snapshot.push(`other\0${relativePath}\0${stat.mode}\0${stat.size}`);
        };
        try {
            await visit(markerPath, '');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code==='ENOENT') { return undefined; }
            throw error;
        }
        return crypto.createHash('sha256').update(snapshot.join('\n')).digest('hex');
    }

    private static async readOwnerRecordFile(filePath: string): Promise<unknown> {
        return nodeFs.readFile(filePath, 'utf8')
            .then(content => {
                try {
                    return JSON.parse(content);
                } catch {
                    return undefined;
                }
            })
            .catch(error => {
                if ((error as NodeJS.ErrnoException).code==='ENOENT') { return undefined; }
                throw error;
            });
    }

    private static async acquireOwnershipRepairLock(
        settingsDirectoryPath: string,
    ): Promise<() => Promise<void>> {
        await nodeFs.mkdir(settingsDirectoryPath, {recursive: true});
        const hostId = await LocalReplicaSCMProvider.getSyncOwnerHostId();
        await LocalReplicaSCMProvider.recoverStaleOwnershipRepairLock(
            settingsDirectoryPath,
            hostId,
        );
        const token = crypto.randomUUID();
        const repairPath = nodePath.join(settingsDirectoryPath, SYNC_OWNER_REPAIR_FILE);
        const claimPath = `${repairPath}.claim-${token}`;
        const record = JSON.stringify({
            version: 2,
            token,
            pid: process.pid,
            hostname: os.hostname(),
            hostId,
            createdAt: new Date().toISOString(),
        });
        let handle: nodeFs.FileHandle | undefined;
        try {
            handle = await nodeFs.open(claimPath, 'wx', 0o600);
            await handle.writeFile(record, 'utf8');
            await handle.sync();
        } finally {
            await handle?.close();
        }
        try {
            await nodeFs.link(claimPath, repairPath);
        } catch (error) {
            await nodeFs.unlink(claimPath).catch(() => undefined);
            if ((error as NodeJS.ErrnoException).code==='EEXIST') {
                throw new Error(
                    'Another Local Replica ownership repair is already in progress.',
                );
            }
            throw error;
        }
        await nodeFs.unlink(claimPath).catch(cleanupError => {
            if ((cleanupError as NodeJS.ErrnoException).code==='ENOENT') { return; }
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [ownership repair claim cleanup failed] ` +
                `${claimPath}: ${formatUnknownError(cleanupError)}`,
            );
        });

        return async () => {
            const current = await LocalReplicaSCMProvider.readOwnerRecordFile(repairPath);
            if (
                !current
                || typeof current!=='object'
                || (current as {token?: unknown}).token!==token
            ) {
                return;
            }
            const releasePath = `${repairPath}.release-${token}`;
            try {
                await nodeFs.rename(repairPath, releasePath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code!=='ENOENT') { throw error; }
            }
            await nodeFs.unlink(releasePath).catch(error => {
                if ((error as NodeJS.ErrnoException).code!=='ENOENT') { throw error; }
            });
        };
    }

    private static isValidSyncOwnerRepairRecord(
        value: unknown,
    ): value is SyncOwnerRepairRecord {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const record = value as Partial<SyncOwnerRepairRecord>;
        return record.version===2
            && typeof record.token==='string'
            && /^[a-f0-9-]{16,128}$/.test(record.token)
            && Number.isSafeInteger(record.pid)
            && record.pid!>0
            && typeof record.hostname==='string'
            && record.hostname.length>0
            && record.hostname.length<=255
            && typeof record.hostId==='string'
            && /^[a-f0-9]{64}$/.test(record.hostId)
            && typeof record.createdAt==='string'
            && Number.isFinite(Date.parse(record.createdAt));
    }

    private static processIsAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code!=='ESRCH';
        }
    }

    private static async recoverStaleOwnershipRepairLock(
        settingsDirectoryPath: string,
        expectedHostId?: string,
    ): Promise<boolean> {
        const hostId = expectedHostId
            ?? await LocalReplicaSCMProvider.getSyncOwnerHostId();
        const repairPath = nodePath.join(settingsDirectoryPath, SYNC_OWNER_REPAIR_FILE);
        const record = await LocalReplicaSCMProvider.readOwnerRecordFile(repairPath);
        if (record===undefined) { return false; }
        if (!LocalReplicaSCMProvider.isValidSyncOwnerRepairRecord(record)) {
            throw new Error(
                'Local Replica ownership repair has an incomplete lock. ' +
                'Preserving it because its owner cannot be identified safely.',
            );
        }
        if (
            record.hostId!==hostId
            && !await LocalReplicaSCMProvider.isLocalSyncOwnerHostId(record.hostId)
        ) {
            throw new LocalReplicaOwnershipUnavailableError(
                `Local Replica ownership repair belongs to process ${record.pid} ` +
                `on ${record.hostname}. Cross-host stale takeover is disabled.`,
            );
        }
        if (LocalReplicaSCMProvider.processIsAlive(record.pid)) {
            throw new LocalReplicaOwnershipUnavailableError(
                `Local Replica ownership repair is active in process ${record.pid}.`,
            );
        }

        const stalePath = `${repairPath}.stale-${crypto.randomUUID()}`;
        try {
            await nodeFs.rename(repairPath, stalePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code==='ENOENT') { return false; }
            throw error;
        }
        const moved = await LocalReplicaSCMProvider.readOwnerRecordFile(stalePath);
        if (
            !LocalReplicaSCMProvider.isValidSyncOwnerRepairRecord(moved)
            || moved.token!==record.token
        ) {
            await nodeFs.link(stalePath, repairPath).catch(() => undefined);
            throw new Error(
                `The Local Replica ownership repair lock changed during recovery. ` +
                `It was preserved at ${stalePath}.`,
            );
        }
        await nodeFs.unlink(stalePath);
        return true;
    }

    public static async repairOwnershipMarker(baseUri: vscode.Uri): Promise<boolean> {
        if (baseUri.scheme!=='file') {
            throw new Error('Local Replica ownership repair requires a local file folder.');
        }
        const settingsDirectoryPath = nodePath.join(baseUri.fsPath, REPLICA_SETTINGS_DIR);
        const ownerFilePath = nodePath.join(settingsDirectoryPath, SYNC_OWNER_FILE);
        const legacyOwnerDirectoryPath = nodePath.join(
            settingsDirectoryPath,
            LEGACY_SYNC_OWNER_DIRECTORY,
        );
        const hostId = await LocalReplicaSCMProvider.getSyncOwnerHostId();
        await LocalReplicaSCMProvider.recoverStaleOwnershipRepairLock(
            settingsDirectoryPath,
            hostId,
        );
        const orphanNames = await nodeFs.readdir(settingsDirectoryPath)
            .catch(error => (error as NodeJS.ErrnoException).code==='ENOENT' ? [] : Promise.reject(error));
        const candidateDescriptors = [
            {
                markerPath: ownerFilePath,
                legacy: false,
                quarantined: false,
            },
            {
                markerPath: legacyOwnerDirectoryPath,
                legacy: true,
                quarantined: false,
            },
            ...orphanNames
                .filter(name =>
                    name.startsWith(`${SYNC_OWNER_FILE}.repair-`)
                    || name.startsWith(`${LEGACY_SYNC_OWNER_DIRECTORY}.repair-`)
                )
                .map(name => ({
                    markerPath: nodePath.join(settingsDirectoryPath, name),
                    legacy: name.startsWith(`${LEGACY_SYNC_OWNER_DIRECTORY}.repair-`),
                    quarantined: true,
                })),
        ];
        const candidates = (
            await Promise.all(candidateDescriptors.map(
                async descriptor => ({
                    ...descriptor,
                    snapshot: await LocalReplicaSCMProvider.ownershipMarkerSnapshot(
                        descriptor.markerPath,
                    ),
                }),
            ))
        ).filter(candidate => candidate.snapshot!==undefined);
        if (candidates.length>1) {
            throw new Error(
                'Both current and legacy Local Replica ownership markers exist. ' +
                'Repair was stopped without changing either marker.',
            );
        }
        const candidate = candidates[0];
        const markerPath = candidate?.markerPath;
        const before = candidate?.snapshot;
        if (!markerPath || !before) {
            void vscode.window.showInformationMessage(
                vscode.l10n.t('This folder has no Local Replica ownership marker to repair.'),
            );
            return false;
        }

        const recordPath = candidate.legacy
            ? nodePath.join(markerPath, LEGACY_SYNC_OWNER_FILE)
            : markerPath;
        const owner = await LocalReplicaSCMProvider.readOwnerRecordFile(recordPath);
        // A structurally valid record used to be untouchable, which left a
        // reused pid or an unreachable host id with no in-product recovery at
        // all. It stays untouchable while anything still answers on its
        // ownership port, and an unanswerable probe still counts as live.
        const markerBlocksRepair = async (value: unknown): Promise<boolean> => {
            if (LocalReplicaSCMProvider.isValidSyncOwnerRecord(value)) {
                return LocalReplicaSCMProvider.recordedOwnerListenerIsLive(value);
            }
            if (LocalReplicaSCMProvider.isLegacySyncOwnerRecord(value)) {
                const legacyOwner = value as SyncOwnerRecord;
                return !(
                    await LocalReplicaSCMProvider.isLocalSyncOwnerHostId(legacyOwner.hostId)
                    && !LocalReplicaSCMProvider.processIsAlive(legacyOwner.pid)
                );
            }
            return false;
        };
        if (await markerBlocksRepair(owner)) {
            throw new Error(
                'The ownership marker may belong to a live owner and cannot be repaired manually. ' +
                'Close or disconnect its owning VS Code window.',
            );
        }

        const repairAction = vscode.l10n.t('Repair Ownership Marker');
        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                'Repair this incomplete, legacy, or abandoned Local Replica ownership marker? ' +
                'Continue only after every VS Code window and remote host using this folder is closed.',
            ),
            {modal: true},
            repairAction,
        );
        if (choice!==repairAction) { return false; }

        const releaseRepairLock = await LocalReplicaSCMProvider.acquireOwnershipRepairLock(
            settingsDirectoryPath,
        );
        try {
            const confirmed = await LocalReplicaSCMProvider.ownershipMarkerSnapshot(
                markerPath,
            );
            const confirmedOwner = await LocalReplicaSCMProvider.readOwnerRecordFile(
                recordPath,
            );
            if (confirmed!==before || await markerBlocksRepair(confirmedOwner)) {
                throw new Error(
                    'The Local Replica ownership marker changed during confirmation. ' +
                    'Repair was cancelled.',
                );
            }

            const quarantinePath = candidate.quarantined
                ? markerPath
                : `${markerPath}.repair-${crypto.randomUUID()}`;
            if (!candidate.quarantined) {
                await nodeFs.rename(markerPath, quarantinePath);
            }
            const moved = await LocalReplicaSCMProvider.ownershipMarkerSnapshot(quarantinePath);
            const movedRecordPath = candidate.legacy
                ? nodePath.join(quarantinePath, LEGACY_SYNC_OWNER_FILE)
                : quarantinePath;
            const movedOwner = await LocalReplicaSCMProvider.readOwnerRecordFile(
                movedRecordPath,
            );
            if (moved!==before || await markerBlocksRepair(movedOwner)) {
                throw new Error(
                    'The Local Replica ownership marker changed during repair. ' +
                    `It was preserved at ${quarantinePath}.`,
                );
            }
            await nodeFs.rm(quarantinePath, {recursive: true, force: true});
            void vscode.window.showInformationMessage(
                vscode.l10n.t('The invalid Local Replica ownership marker was repaired.'),
            );
            return true;
        } finally {
            await releaseRepairLock();
        }
    }

    private get syncOwnerFilePath(): string {
        return nodePath.join(this.settingsDirectoryUri.fsPath, SYNC_OWNER_FILE);
    }

    private get syncOwnerRepairFilePath(): string {
        return nodePath.join(this.settingsDirectoryUri.fsPath, SYNC_OWNER_REPAIR_FILE);
    }

    private get legacySyncOwnerDirectoryPath(): string {
        return nodePath.join(
            this.settingsDirectoryUri.fsPath,
            LEGACY_SYNC_OWNER_DIRECTORY,
        );
    }

    private static isSyncOwnerRecordVersion(
        value: unknown,
        version: 3 | 4,
    ): value is SyncOwnerRecord {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const record = value as Partial<SyncOwnerRecord>;
        return record.version===version
            && typeof record.token==='string'
            && /^[a-f0-9-]{16,128}$/.test(record.token)
            && Number.isSafeInteger(record.pid)
            && record.pid!>0
            && typeof record.hostname==='string'
            && record.hostname.length>0
            && record.hostname.length<=255
            && typeof record.hostId==='string'
            && /^[a-f0-9]{64}$/.test(record.hostId)
            && typeof record.projectKey==='string'
            && record.projectKey.length>0
            && record.projectKey.length<=16_384
            && typeof record.rootKey==='string'
            && /^[a-f0-9]{64}$/.test(record.rootKey)
            && Number.isSafeInteger(record.port)
            && record.port!>=LocalReplicaSCMProvider.syncOwnerPortBase
            && record.port!<(
                LocalReplicaSCMProvider.syncOwnerPortBase
                +LocalReplicaSCMProvider.syncOwnerPortRange
            )
            && typeof record.createdAt==='string'
            && Number.isFinite(Date.parse(record.createdAt));
    }

    private static isValidSyncOwnerRecord(value: unknown): value is SyncOwnerRecord {
        return LocalReplicaSCMProvider.isSyncOwnerRecordVersion(value, 4);
    }

    private static isLegacySyncOwnerRecord(value: unknown): boolean {
        return LocalReplicaSCMProvider.isSyncOwnerRecordVersion(value, 3);
    }

    private async readSyncOwnerRecord(): Promise<SyncOwnerRecord | undefined> {
        try {
            const content = await nodeFs.readFile(this.syncOwnerFilePath, 'utf8');
            const parsed = JSON.parse(content);
            return LocalReplicaSCMProvider.isValidSyncOwnerRecord(parsed)
                ? parsed
                : undefined;
        } catch (error) {
            if (
                this.isNodeErrorCode(error, 'ENOENT')
                || error instanceof SyntaxError
            ) {
                return undefined;
            }
            throw error;
        }
    }

    private static getSyncOwnerHostId(): Promise<string> {
        if (!LocalReplicaSCMProvider.syncOwnerHostIdPromise) {
            LocalReplicaSCMProvider.syncOwnerHostIdPromise = (async () => {
                // Only stable identity may feed this fingerprint. The systemd
                // session scope in /proc/self/cgroup differs per SSH login and
                // the MAC set changes the moment docker0/veth*/a VPN tap
                // appears, so either input would leave an ungraceful shutdown
                // with a marker under a host id this machine can never produce
                // again — a permanently locked replica.
                const machineId = process.platform==='linux'
                    ? await nodeFs.readFile('/etc/machine-id', 'utf8')
                        .then(value => value.trim())
                        .catch(() => '')
                    : '';
                const identity = [
                    process.platform,
                    process.arch,
                    os.hostname(),
                    machineId,
                ].join('\n');
                return crypto.createHash('sha256').update(identity).digest('hex');
            })();
        }
        return LocalReplicaSCMProvider.syncOwnerHostIdPromise;
    }

    // Markers written before the fingerprint dropped its unstable inputs still
    // carry the old id. Recognising it keeps an upgrade from turning every
    // existing marker into an unreclaimable foreign-host marker.
    private static getLegacySyncOwnerHostId(): Promise<string> {
        if (!LocalReplicaSCMProvider.legacySyncOwnerHostIdPromise) {
            LocalReplicaSCMProvider.legacySyncOwnerHostIdPromise = (async () => {
                const systemIdentityPaths = process.platform==='linux'
                    ? ['/etc/machine-id', '/proc/self/cgroup']
                    : [];
                const systemIdentity = await Promise.all(systemIdentityPaths.map(
                    filePath => nodeFs.readFile(filePath, 'utf8')
                        .then(value => value.trim())
                        .catch(() => ''),
                ));
                const networkIdentity = Object.values(os.networkInterfaces())
                    .flatMap(records => records ?? [])
                    .filter(record => !record.internal && record.mac!=='00:00:00:00:00:00')
                    .map(record => record.mac.toLocaleLowerCase('en-US'))
                    .sort();
                const identity = [
                    process.platform,
                    process.arch,
                    os.hostname(),
                    ...systemIdentity,
                    ...networkIdentity,
                ].join('\n');
                return crypto.createHash('sha256').update(identity).digest('hex');
            })();
        }
        return LocalReplicaSCMProvider.legacySyncOwnerHostIdPromise;
    }

    private static async isLocalSyncOwnerHostId(hostId: string): Promise<boolean> {
        return hostId===await LocalReplicaSCMProvider.getSyncOwnerHostId()
            || hostId===await LocalReplicaSCMProvider.getLegacySyncOwnerHostId();
    }

    private syncOwnerHostId(): Promise<string> {
        return LocalReplicaSCMProvider.getSyncOwnerHostId();
    }

    private async syncOwnerRootKey(): Promise<string> {
        const realPath = await nodeFs.realpath(this.baseUri.fsPath);
        const normalizedPath = process.platform==='win32'
            ? realPath.toLocaleLowerCase('en-US')
            : realPath;
        return crypto.createHash('sha256').update(normalizedPath).digest('hex');
    }

    private syncOwnerPorts(rootKey: string): number[] {
        const range = LocalReplicaSCMProvider.syncOwnerPortRange;
        const start = Number.parseInt(rootKey.slice(0, 8), 16)%range;
        let step = (Number.parseInt(rootKey.slice(8, 16), 16)%range)|1;
        const gcd = (left: number, right: number): number => {
            while (right!==0) {
                [left, right] = [right, left%right];
            }
            return left;
        };
        while (gcd(step, range)!==1) {
            step = (step+2)%range;
            if (step===0) { step = 1; }
        }
        return Array.from(
            {length: LocalReplicaSCMProvider.syncOwnerPortAttempts},
            (_, index) => LocalReplicaSCMProvider.syncOwnerPortBase
                +((start+(index*step))%range),
        );
    }

    private static probeSyncOwner(port: number): Promise<SyncOwnerProbe> {
        return new Promise(resolve => {
            let payload = '';
            let settled = false;
            let connected = false;
            const socket = nodeNet.createConnection({host: '127.0.0.1', port});
            socket.unref();
            const finish = (
                evidence: 'closed' | 'timeout' | 'error' | 'overflow',
                reason?: string,
            ) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timeout);
                socket.destroy();
                // Nothing accepted the connection, or the peer flooded us: an
                // owner replies with one small record and closes, so both are
                // decisive evidence that this port holds something else.
                if ((evidence==='error' && !connected) || evidence==='overflow') {
                    resolve({kind: 'unrelated'});
                    return;
                }
                if (evidence==='closed') {
                    // A complete reply is decisive either way.
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(payload);
                    } catch {
                        resolve({kind: 'unrelated'});
                        return;
                    }
                    resolve(LocalReplicaSCMProvider.isValidSyncOwnerRecord(parsed)
                        ? {kind: 'owner', owner: parsed}
                        : {kind: 'unrelated'});
                    return;
                }
                // The peer accepted the connection but never finished the
                // handshake. It may be an owner whose reply was lost or whose
                // process is paused, so callers must treat it as possibly live.
                resolve({
                    kind: 'ambiguous',
                    reason: reason ?? (evidence==='timeout'
                        ? 'no ownership handshake within 500ms'
                        : 'the ownership handshake was interrupted'),
                });
            };
            const timeout = setTimeout(() => finish('timeout'), 500);
            timeout.unref?.();
            socket.once('connect', () => { connected = true; });
            socket.on('data', chunk => {
                payload += chunk.toString('utf8');
                if (payload.length>64*1024) {
                    finish('overflow');
                }
            });
            socket.once('end', () => finish('closed'));
            socket.once('error', error => finish('error', formatUnknownError(error)));
        });
    }

    private static async recordedOwnerListenerIsLive(
        record: SyncOwnerRecord,
    ): Promise<boolean> {
        const probe = await LocalReplicaSCMProvider.probeSyncOwner(record.port);
        if (probe.kind==='owner') {
            return probe.owner.rootKey===record.rootKey;
        }
        // Only a port that provably answers for nobody makes a structurally
        // valid marker safe to quarantine.
        return probe.kind!=='unrelated';
    }

    private async recordedOwnerHoldsPort(rootKey: string, port: number): Promise<boolean> {
        const recorded = await this.readSyncOwnerRecord().catch(() => undefined);
        return recorded?.rootKey===rootKey && recorded.port===port;
    }

    // Decide whether a same-host marker may still belong to a live owner. The
    // pid alone cannot answer this: a reused pid answers process.kill forever,
    // which used to make the marker unreclaimable. An owner holds its
    // deterministic port for as long as it owns the folder, so the port is the
    // corroborating authority — and ambiguity always reads as "still live".
    private async recordedOwnerIsActive(
        record: SyncOwnerRecord,
        ownPort: number,
    ): Promise<boolean> {
        if (ownPort===record.port) {
            // This process is bound to the port the record claims, so the
            // recording process can no longer be listening on it.
            return false;
        }
        const probe = await LocalReplicaSCMProvider.probeSyncOwner(record.port);
        if (probe.kind==='owner') {
            return probe.owner.rootKey===record.rootKey;
        }
        if (probe.kind==='ambiguous') {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [sync ownership probe ambiguous] ` +
                `${this.baseUri.toString()} port=${record.port}: ${probe.reason}`,
            );
            return true;
        }
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [sync ownership marker stale] ` +
            `${this.baseUri.toString()} pid=${record.pid} ` +
            `pidAnswers=${LocalReplicaSCMProvider.processIsAlive(record.pid)} ` +
            `port=${record.port} released`,
        );
        return false;
    }

    private async listenSyncOwnerServer(
        ownerBase: Omit<SyncOwnerRecord, 'port'>,
    ): Promise<{owner: SyncOwnerRecord; server: nodeNet.Server}> {
        for (const port of this.syncOwnerPorts(ownerBase.rootKey)) {
            const owner: SyncOwnerRecord = {...ownerBase, port};
            const server = nodeNet.createServer(socket => {
                socket.on('error', () => undefined);
                socket.end(JSON.stringify(owner));
            });
            server.unref();
            try {
                await new Promise<void>((resolve, reject) => {
                    const onError = (error: Error) => {
                        server.off('listening', onListening);
                        reject(error);
                    };
                    const onListening = () => {
                        server.off('error', onError);
                        resolve();
                    };
                    server.once('error', onError);
                    server.once('listening', onListening);
                    server.listen({
                        host: '127.0.0.1',
                        port,
                        exclusive: true,
                    });
                });
            } catch (error) {
                if (!this.isNodeErrorCode(error, 'EADDRINUSE')) { throw error; }
                const probe = await LocalReplicaSCMProvider.probeSyncOwner(port);
                if (probe.kind==='owner' && probe.owner.rootKey===owner.rootKey) {
                    throw new LocalReplicaOwnershipUnavailableError(
                        `Local Replica folder is already active in process ` +
                        `${probe.owner.pid} on ${probe.owner.hostname}. ` +
                        'Keep only one VS Code window connected to this Local Replica.',
                    );
                }
                // A silent peer proves nothing on its own, but on the exact port
                // this folder's marker records it is far more likely the owner
                // than an unrelated service. Refuse rather than admit a second
                // writer behind a lost handshake.
                if (
                    probe.kind==='ambiguous'
                    && await this.recordedOwnerHoldsPort(owner.rootKey, port)
                ) {
                    throw new LocalReplicaOwnershipUnavailableError(
                        `Local Replica ownership port ${port} is held by a process that did ` +
                        `not identify itself (${probe.reason}), and this folder's ownership ` +
                        'marker records that port. Close every VS Code window using this ' +
                        'Local Replica, then retry.',
                    );
                }
                continue;
            }
            server.on('error', error => {
                if (this.syncOwnerServer!==server) { return; }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [sync ownership server failed] ` +
                    `${this.baseUri.toString()}: ${formatUnknownError(error)}`,
                );
                this.deactivateSyncSession();
            });
            return {owner, server};
        }
        throw new Error(
            'Local Replica could not reserve any deterministic host ownership port. ' +
            'Close conflicting local services or select a different folder.',
        );
    }

    private closeSyncOwnerServer(server: nodeNet.Server): Promise<void> {
        if (!server.listening) { return Promise.resolve(); }
        return new Promise((resolve, reject) => {
            server.close(error => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }

    private clearSyncOwnerHeartbeat() {
        if (this.syncOwnerHeartbeat) {
            clearInterval(this.syncOwnerHeartbeat);
            this.syncOwnerHeartbeat = undefined;
        }
    }

    private handleLostSyncOwnership(token: string, reason: string) {
        if (this.syncOwnerToken!==token) { return; }
        this.clearSyncOwnerHeartbeat();
        this.deactivateSyncSession();
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [sync ownership lost] ${this.baseUri.toString()}: ${reason}`,
        );
        void vscode.window.showWarningMessage(
            vscode.l10n.t(
                'Local Replica sync stopped because another VS Code window owns this folder. ' +
                'Keep only one window connected to this Local Replica.',
            ),
        );
    }

    private startSyncOwnerHeartbeat(token: string) {
        this.clearSyncOwnerHeartbeat();
        this.syncOwnerHeartbeat = setInterval(() => {
            void (async () => {
                const owner = await this.readSyncOwnerRecord();
                if (owner?.token!==token) {
                    this.handleLostSyncOwnership(token, 'owner token changed');
                    return;
                }
                await nodeFs.utimes(this.syncOwnerFilePath, new Date(), new Date());
            })().catch(error => {
                if (this.isNodeErrorCode(error, 'ENOENT')) {
                    this.handleLostSyncOwnership(token, 'owner file disappeared');
                    return;
                }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [sync ownership heartbeat failed] ` +
                    `${this.baseUri.toString()}: ${formatUnknownError(error)}`,
                );
            });
        }, LocalReplicaSCMProvider.syncOwnerHeartbeatMs);
        this.syncOwnerHeartbeat.unref?.();
    }

    private installSyncOwnerClaim(claimPath: string): Promise<void> {
        return nodeFs.link(claimPath, this.syncOwnerFilePath);
    }

    private cleanupSyncOwnerClaim(claimPath: string): Promise<void> {
        return nodeFs.unlink(claimPath);
    }

    private async removeOwnedSyncOwnerLock(token: string): Promise<boolean> {
        const owner = await this.readSyncOwnerRecord();
        if (owner?.token!==token) { return false; }
        const releasePath = `${this.syncOwnerFilePath}.release-${token}`;
        try {
            await nodeFs.rename(this.syncOwnerFilePath, releasePath);
        } catch (error) {
            if (this.isNodeErrorCode(error, 'ENOENT')) { return false; }
            throw error;
        }
        await nodeFs.unlink(releasePath).catch(cleanupError => {
            if (this.isNodeErrorCode(cleanupError, 'ENOENT')) { return; }
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [released ownership cleanup failed] ` +
                `${releasePath}: ${formatUnknownError(cleanupError)}`,
            );
        });
        return true;
    }

    private async acquireSyncOwnership(): Promise<void> {
        await this.syncOwnerReleasePromise;
        if (this.syncOwnerToken) {
            const owner = await this.readSyncOwnerRecord();
            if (
                this.syncOwnerServer?.listening
                && owner?.token===this.syncOwnerToken
            ) {
                return;
            }
            throw new Error(
                'Local Replica ownership release is incomplete. ' +
                'Retry deactivation before starting another sync session.',
            );
        }

        const processOwner = LocalReplicaSCMProvider.processSyncOwners.get(
            this.syncOwnerFilePath,
        );
        if (processOwner && processOwner!==this) {
            if (
                processOwner.removalDrainPromise
                || processOwner.removalOwnershipHeld
            ) {
                throw new LocalReplicaOwnershipUnavailableError(
                    'Local Replica removal is holding folder ownership.',
                );
            }
            processOwner.deactivateSyncSession();
            await processOwner.syncOwnerReleasePromise;
        }

        await nodeFs.mkdir(this.settingsDirectoryUri.fsPath, {recursive: true});
        const hostId = await this.syncOwnerHostId();
        await LocalReplicaSCMProvider.recoverStaleOwnershipRepairLock(
            this.settingsDirectoryUri.fsPath,
            hostId,
        );
        const legacyMarkerExists = await nodeFs.stat(this.legacySyncOwnerDirectoryPath)
            .then(() => true)
            .catch(error => {
                if (this.isNodeErrorCode(error, 'ENOENT')) { return false; }
                throw error;
            });
        if (legacyMarkerExists) {
            throw new Error(
                'Local Replica folder has an incomplete ownership marker or legacy marker. ' +
                'Close every window using this folder, then run the ownership repair command.',
            );
        }
        const token = crypto.randomUUID();
        const projectKey = vfsProjectKey(this.vfs.origin);
        const rootKey = await this.syncOwnerRootKey();
        const ownerBase: Omit<SyncOwnerRecord, 'port'> = {
            version: 4,
            token,
            pid: process.pid,
            hostname: os.hostname(),
            hostId,
            projectKey,
            rootKey,
            createdAt: new Date().toISOString(),
        };
        const {owner, server} = await this.listenSyncOwnerServer(ownerBase);
        const claimFilePath = `${this.syncOwnerFilePath}.claim-${token}`;
        let adoptedServer = false;
        let installedClaim = false;

        try {
            const claimHandle = await nodeFs.open(claimFilePath, 'wx', 0o600);
            try {
                await claimHandle.writeFile(JSON.stringify(owner), 'utf8');
                await claimHandle.sync();
            } finally {
                await claimHandle.close();
            }
            for (let attempt = 0; attempt<5; attempt += 1) {
                try {
                    await this.installSyncOwnerClaim(claimFilePath);
                    installedClaim = true;
                    break;
                } catch (error) {
                    if (!this.isNodeErrorCode(error, 'EEXIST')) { throw error; }
                }

                const existingOwner = await this.readSyncOwnerRecord();
                if (!existingOwner) {
                    throw new Error(
                        'Local Replica folder has an incomplete ownership marker or legacy marker. ' +
                        'Close every window using this folder, then run the ownership repair command.',
                    );
                }
                if (existingOwner.rootKey!==rootKey) {
                    throw new Error(
                        'Local Replica ownership marker does not match the selected folder.',
                    );
                }
                if (!await LocalReplicaSCMProvider.isLocalSyncOwnerHostId(existingOwner.hostId)) {
                    throw new LocalReplicaOwnershipUnavailableError(
                        `Local Replica folder is owned by process ${existingOwner.pid} ` +
                        `on ${existingOwner.hostname}. Cross-host stale takeover is disabled.`,
                    );
                }
                if (await this.recordedOwnerIsActive(existingOwner, owner.port)) {
                    throw new LocalReplicaOwnershipUnavailableError(
                        `Local Replica folder is already active in process ` +
                        `${existingOwner.pid} on ${existingOwner.hostname}. ` +
                        'Keep only one VS Code window connected to this Local Replica.',
                    );
                }

                const stalePath = `${this.syncOwnerFilePath}.stale-${token}-${attempt}`;
                try {
                    await nodeFs.rename(this.syncOwnerFilePath, stalePath);
                } catch (renameError) {
                    if (this.isNodeErrorCode(renameError, 'ENOENT')) { continue; }
                    throw renameError;
                }
                await nodeFs.unlink(stalePath).catch(
                    cleanupError => {
                        if (this.isNodeErrorCode(cleanupError, 'ENOENT')) { return; }
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [stale ownership cleanup failed] ` +
                            `${stalePath}: ${formatUnknownError(cleanupError)}`,
                        );
                    },
                );
            }
            if (!installedClaim) {
                throw new LocalReplicaOwnershipUnavailableError(
                    'Could not acquire Local Replica folder ownership after concurrent retries.',
                );
            }
            const repairStarted = await nodeFs.stat(this.syncOwnerRepairFilePath)
                .then(() => true)
                .catch(error => {
                    if (this.isNodeErrorCode(error, 'ENOENT')) { return false; }
                    throw error;
                });
            if (repairStarted) {
                await this.removeOwnedSyncOwnerLock(token);
                installedClaim = false;
                throw new LocalReplicaOwnershipUnavailableError(
                    'Local Replica ownership repair started during activation.',
                );
            }
            this.syncOwnerServer = server;
            this.syncOwnerToken = token;
            LocalReplicaSCMProvider.processSyncOwners.set(
                this.syncOwnerFilePath,
                this,
            );
            this.startSyncOwnerHeartbeat(token);
            adoptedServer = true;
        } catch (error) {
            if (installedClaim) {
                await this.removeOwnedSyncOwnerLock(token).catch(cleanupError => {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [failed claim release failed] ` +
                        `${this.syncOwnerFilePath}: ${formatUnknownError(cleanupError)}`,
                    );
                });
            }
            throw error;
        } finally {
            await this.cleanupSyncOwnerClaim(claimFilePath).catch(cleanupError => {
                if (this.isNodeErrorCode(cleanupError, 'ENOENT')) { return; }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [ownership claim cleanup failed] ` +
                    `${claimFilePath}: ${formatUnknownError(cleanupError)}`,
                );
            });
            if (!adoptedServer) {
                await this.closeSyncOwnerServer(server).catch(closeError => {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [failed claim server close failed] ` +
                        `${this.baseUri.toString()}: ${formatUnknownError(closeError)}`,
                    );
                });
            }
        }
    }

    private clearSyncOwnershipState() {
        this.syncOwnerServer = undefined;
        this.syncOwnerToken = undefined;
        this.clearSyncOwnerHeartbeat();
        if (
            LocalReplicaSCMProvider.processSyncOwners.get(
                this.syncOwnerFilePath,
            )===this
        ) {
            LocalReplicaSCMProvider.processSyncOwners.delete(
                this.syncOwnerFilePath,
            );
        }
    }

    private async releaseSyncOwnershipNow(): Promise<void> {
        const token = this.syncOwnerToken;
        const server = this.syncOwnerServer;
        this.clearSyncOwnerHeartbeat();
        if (server) {
            await this.closeSyncOwnerServer(server);
            if (this.syncOwnerServer===server) {
                this.syncOwnerServer = undefined;
            }
        }
        if (!token) {
            this.clearSyncOwnershipState();
            return;
        }

        const owner = await this.readSyncOwnerRecord();
        if (owner?.token!==token) {
            this.clearSyncOwnershipState();
            return;
        }
        await this.removeOwnedSyncOwnerLock(token);
        this.clearSyncOwnershipState();
    }

    private releaseSyncOwnership(): Promise<void> {
        if (this.syncOwnerReleasePromise) {
            return this.syncOwnerReleasePromise;
        }
        if (!this.syncOwnerToken && !this.syncOwnerServer) {
            return Promise.resolve();
        }
        const activation = this.activationPromise;
        const release = (async () => {
            if (activation) {
                await Promise.allSettled([activation]);
            }
            this.stopSyncInputs();
            await this.drainPendingSyncWork();
            await this.releaseSyncOwnershipNow();
        })();
        const trackedRelease = release.finally(() => {
            if (this.syncOwnerReleasePromise===trackedRelease) {
                this.syncOwnerReleasePromise = undefined;
            }
        });
        this.syncOwnerReleasePromise = trackedRelease;
        return trackedRelease;
    }

    private async runSessionIO<T>(
        generation: number,
        task: () => Thenable<T> | Promise<T>,
    ): Promise<T> {
        this.requireSyncSession(generation);
        const operation = Promise.resolve().then(task);
        this.inFlightSessionIO.add(operation);
        try {
            return await operation;
        } finally {
            this.inFlightSessionIO.delete(operation);
        }
    }

    private async drainInFlightSessionIO() {
        while (this.inFlightSessionIO.size>0) {
            await Promise.allSettled([...this.inFlightSessionIO]);
        }
    }

    private async beginSyncSession() {
        if (this.removalDrainPromise || this.removalOwnershipHeld) {
            throw new Error('Local Replica removal is already in progress.');
        }
        if (this.syncSessionActive) {
            this.deactivateSyncSession(undefined, false);
        }
        if (await hasReplicaRemovalTombstone(this.baseUri, this.vfs.origin)) {
            throw new Error(
                'This Local Replica mapping was removed. ' +
                'Select the folder explicitly to connect it again.',
            );
        }
        // Acquisition can take hundreds of ms binding and probing up to 64
        // ports, and a deactivate during that window leaves no other trace:
        // releaseSyncOwnership() no-ops while no token is held yet. Without
        // this fence the disposed session would still run the initial pull and
        // startup reconcile — writing, pushing and deleting for a replica the
        // user already switched away from.
        const activationGeneration = this.syncGeneration;
        await this.syncOwnerReleasePromise;
        await this.acquireSyncOwnership();
        const sessionDisposedDuringAcquisition = this.syncGeneration!==activationGeneration;
        if (
            this.removalDrainPromise
            || this.removalOwnershipHeld
            || sessionDisposedDuringAcquisition
            || await hasReplicaRemovalTombstone(this.baseUri, this.vfs.origin)
        ) {
            await this.releaseSyncOwnershipNow();
            throw new Error(
                this.removalDrainPromise || this.removalOwnershipHeld
                    ? 'Local Replica removal is already in progress.'
                    : sessionDisposedDuringAcquisition
                        ? 'This Local Replica sync session was disposed while ownership was being acquired.'
                        : 'This Local Replica mapping was removed while activation was waiting.',
            );
        }
        const generation = ++this.syncGeneration;
        this.removalPendingGeneration = undefined;
        this.syncSessionActive = false;
        this.partialPullToastGeneration = undefined;
        await this.drainInFlightSessionIO();
        if (generation===this.syncGeneration) {
            this.syncSessionActive = true;
        }
        return generation;
    }

    public async prepareExplicitSelectionAndHoldOwnership(): Promise<void> {
        if (this.removalDrainPromise || this.removalOwnershipHeld) {
            throw new Error('Local Replica removal is already in progress.');
        }
        await this.syncOwnerReleasePromise;
        await this.acquireSyncOwnership();
        if (this.removalDrainPromise || this.removalOwnershipHeld) {
            await this.releaseSyncOwnershipNow();
            throw new Error('Local Replica removal started while selection was waiting.');
        }
    }

    private isSyncSessionActive(generation = this.syncGeneration) {
        return this.syncSessionActive && generation===this.syncGeneration;
    }

    private requireSyncSession(generation = this.syncGeneration) {
        if (!this.isSyncSessionActive(generation)) {
            throw new Error('Local Replica sync session is no longer active.');
        }
    }

    private stopSyncInputs(generation?: number) {
        if (generation!==undefined && generation!==this.syncGeneration) { return; }
        this.vfsWatcher?.dispose();
        this.vfsWatcher = undefined;
        for (const disposable of this.dynamicLocalDisposables) {
            disposable.dispose();
        }
        this.dynamicLocalDisposables = [];
        this.localWatcher = undefined;
        if (this.directLocalWatcher) {
            try {
                this.directLocalWatcher.close();
            } catch {
                // It may already have closed after emitting an error.
            }
        }
        this.directLocalWatcher = undefined;
        this.directLocalWatcherGeneration = undefined;
        this.armLocalWatcher = undefined;
        const localWatcherProbe = this.localWatcherProbe;
        this.localWatcherProbe = undefined;
        if (localWatcherProbe) {
            if (localWatcherProbe.timeout) {
                clearTimeout(localWatcherProbe.timeout);
                localWatcherProbe.timeout = undefined;
            }
            localWatcherProbe.resolve();
        }
        if (this.localWatcherHealthTimer) {
            clearTimeout(this.localWatcherHealthTimer);
            this.localWatcherHealthTimer = undefined;
        }
        this.localWatcherHealthState = 'unknown';
        this.localWatcherWarningShown = false;
        this.unscannableLocalPaths.clear();
        // The re-arm timers themselves live in pendingLocalEvents and are
        // cleared with it below; this drops the deferral history so a new
        // session does not inherit an already-expired warn clock.
        this.localStabilizeState.clear();
        this.scannerAbsentPaths.clear();
        for (const sleep of [...this.stabilizeSleeps]) {
            clearTimeout(sleep.timer);
            sleep.wake();
        }
        this.stabilizeSleeps.clear();
        if (this.fallbackScanTimer) {
            clearTimeout(this.fallbackScanTimer);
            this.fallbackScanTimer = undefined;
        }
        this.fallbackScanRunningGeneration = undefined;
        this.fallbackScanGeneration = undefined;
        for (const pending of this.pendingVfsEvents.values()) {
            clearTimeout(pending.timer);
        }
        this.pendingVfsEvents.clear();
        for (const pending of this.pendingLocalEvents.values()) {
            clearTimeout(pending.timer);
        }
        this.pendingLocalEvents.clear();
        for (const pending of this.pendingLocalMoveDeletes.values()) {
            clearTimeout(pending.timer);
            pending.resolve();
        }
        this.pendingLocalMoveDeletes.clear();
        this.deferredLocalEventsDuringDirectoryMove.clear();
        this.pendingInitialDocumentSubscriptions.clear();
        this.startupReplayGeneration = undefined;
        this.startupReplayPromise = undefined;
        this.startupReplayFailure = undefined;
    }

    private deactivateSyncSession(
        generation?: number,
        releaseOwnership = true,
    ) {
        if (generation!==undefined && generation!==this.syncGeneration) { return; }
        this.stopSyncInputs(generation);
        this.syncSessionActive = false;
        this.syncGeneration += 1;
        this.removalPendingGeneration = undefined;
        this.partialPullToastGeneration = undefined;
        if (!releaseOwnership) { return; }
        void this.releaseSyncOwnership().catch(error => {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [sync ownership release failed] ` +
                `${this.baseUri.toString()}: ${formatUnknownError(error)}`,
            );
        });
    }

    private async drainPendingSyncWork(): Promise<void> {
        while (true) {
            const pending = new Set<Promise<unknown>>([
                ...this.syncQueues.values(),
                ...this.inFlightSessionIO,
                ...this.localGuardCleanupPromises.values(),
                ...this.deferredSyncWork,
                ...this.preQueueSyncWork,
            ]);
            if (pending.size===0) { return; }
            await Promise.allSettled([...pending]);
        }
    }

    private async flushPendingLocalEventsForRemoval(
        generation: number,
    ): Promise<void> {
        const pendingEvents = [...this.pendingLocalEvents.entries()];
        const flushes: Promise<unknown>[] = [];
        // A delete held briefly for a possible rename is still an accepted
        // local intent. Mapping removal must flush it before stopSyncInputs
        // clears candidate timers; otherwise a real folder/file delete can
        // disappear solely because it overlapped a parent reconciliation.
        for (const relPath of [...this.pendingLocalMoveDeletes.keys()]) {
            if (!this.pendingLocalMoveDeletes.has(relPath)) { continue; }
            this.releasePendingLocalMoveDelete(relPath);
            flushes.push(this.enqueueLocalPendingEvent(
                relPath,
                {latestType: 'delete', latestUri: this.localUri(relPath)},
                generation,
                true,
                true,
            ));
        }
        for (const [relPath, pending] of pendingEvents) {
            if (this.pendingLocalEvents.get(relPath)!==pending) { continue; }
            clearTimeout(pending.timer);
            this.pendingLocalEvents.delete(relPath);
            flushes.push(this.enqueueLocalPendingEvent(
                relPath,
                pending,
                generation,
                true,
            ));
        }
        await Promise.allSettled(flushes);
    }

    /**
     * Stops new watcher work while allowing an already-started remote
     * transaction to finish its rollback/cleanup before its mapping is removed.
     */
    public prepareRemovalAndHoldOwnership(): Promise<void> {
        if (this.removalOwnershipHeld) {
            return Promise.resolve();
        }
        if (this.removalDrainPromise) {
            return this.removalDrainPromise;
        }
        const generation = this.syncGeneration;
        for (const [relPath, failure] of this.removalAcceptedSyncErrors) {
            if (failure.generation!==generation) {
                this.removalAcceptedSyncErrors.delete(relPath);
            }
        }
        this.removalPendingGeneration = generation;
        const drain = (async () => {
            try {
                const pendingLocalFlush = this.flushPendingLocalEventsForRemoval(
                    generation,
                );
                this.stopSyncInputs(generation);
                await pendingLocalFlush;
                const activation = this.activationPromise;
                if (activation) {
                    await Promise.allSettled([activation]);
                }
                this.stopSyncInputs(generation);
                await this.syncOwnerReleasePromise;
                await this.acquireSyncOwnership();
                await this.drainPendingSyncWork();
                if (this.syncSessionActive) {
                    await this.recoverChangedCommittedLocalOperations(
                        this.syncGeneration,
                    );
                    await this.drainPendingSyncWork();
                }
                const classificationFailures = [
                    ...this.removalAcceptedSyncErrors.entries(),
                ].filter(([_relPath, failure]) =>
                    failure.generation===generation
                );
                if (classificationFailures.length>0) {
                    throw new Error(
                        'Local Replica could not classify accepted local edits before removal: ' +
                        classificationFailures
                            .map(([relPath, failure]) => `${relPath}: ${failure.error}`)
                            .join('; '),
                    );
                }
                await this.cleanupUnchangedCommittedGuardsForRemoval();
                if (
                    generation!==this.syncGeneration
                    && this.syncSessionActive
                ) {
                    throw new Error(
                        'Local Replica changed sync sessions while removal was being prepared.',
                    );
                }

                const [localOperations, remoteOperations] = await Promise.all([
                    this.listLocalOperationRecords(),
                    this.listRemoteDeleteOperationRecords(),
                ]);
                const stagedIds = new Set(
                    this.stagedDetachedLocalGuards.map(item => item.record.id),
                );
                const blockingLocalOperations = localOperations.filter(
                    item => !stagedIds.has(item.record.id),
                );
                if (blockingLocalOperations.length>0 || remoteOperations.length>0) {
                    throw new Error(
                        'Local Replica still has recoverable file operations. ' +
                        'Its mapping was retained so recovery can complete safely.',
                    );
                }
                this.deactivateSyncSession(undefined, false);
                this.removalOwnershipHeld = true;
            } catch (error) {
                let removalError = error;
                this.removalOwnershipHeld = false;
                try {
                    await this.rollbackStagedDetachedLocalGuards();
                } catch (rollbackError) {
                    removalError = new Error(
                        `${formatUnknownError(error)}; retained inode guard rollback failed: ` +
                        formatUnknownError(rollbackError),
                    );
                }
                if (this.syncOwnerToken || this.syncOwnerServer) {
                    this.deactivateSyncSession();
                    await this.syncOwnerReleasePromise?.catch(releaseError => {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [temporary sync ownership release failed] ` +
                            `${this.baseUri.toString()}: ${formatUnknownError(releaseError)}`,
                        );
                    });
                }
                throw removalError;
            }
        })();
        this.removalDrainPromise = drain;
        return drain.finally(() => {
            if (this.removalDrainPromise===drain) {
                this.removalDrainPromise = undefined;
            }
        });
    }

    public async finishRemoval(): Promise<void> {
        if (this.removalDrainPromise) {
            await this.removalDrainPromise;
        }
        if (!this.removalOwnershipHeld) { return; }
        await this.rollbackStagedDetachedLocalGuards();
        this.removalOwnershipHeld = false;
        this.deactivateSyncSession();
        await this.syncOwnerReleasePromise;
    }

    public async deactivateAndDrain(): Promise<void> {
        await this.prepareRemovalAndHoldOwnership();
        await this.finishRemoval();
    }

    public deactivate(): Promise<void> {
        this.deactivateSyncSession();
        return this.syncOwnerReleasePromise ?? Promise.resolve();
    }

    public markWaitingForOwnership(message: string) {
        this.status = {
            status: 'need-attention',
            message: `sync paused: ${message}`,
        };
    }

    public static sanitizeProjectFolderName(projectName: string): string {
        let sanitized = projectName;
        if (process.platform==='win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        } else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }

    private static async pathExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return false;
            }
            throw error;
        }
    }

    private static isFileNotFoundError(error: unknown): boolean {
        const code = typeof error==='object' && error!==null && 'code' in error
            ? String((error as {code?: unknown}).code)
            : '';
        const message = formatUnknownError(error);
        return code==='FileNotFound'
            || code==='ENOENT'
            || /EntryNotFound|FileNotFound|ENOENT|not found/i.test(message);
    }

    private static isLocalReadUnstable(error: unknown): error is LocalReadUnstableError {
        return error instanceof LocalReadUnstableError;
    }

    private static isSyncStatType(
        stat: vscode.FileStat,
        type: vscode.FileType.File | vscode.FileType.Directory,
        allowSymbolicLink: boolean,
    ): boolean {
        return allowSymbolicLink
            ? (stat.type & type)!==0
            : stat.type===type;
    }

    private static comparableFsPath(fsPath: string): string {
        const normalized = nodePath.normalize(fsPath);
        return process.platform==='win32' ? normalized.toLowerCase() : normalized;
    }

    private static async resolvedFsPath(uri: vscode.Uri): Promise<string> {
        const resolvedPath = nodePath.resolve(uri.fsPath);
        try {
            return LocalReplicaSCMProvider.comparableFsPath(await nodeFs.realpath(resolvedPath));
        } catch {
            return LocalReplicaSCMProvider.comparableFsPath(resolvedPath);
        }
    }

    private static async isGitRepositoryRoot(uri: vscode.Uri): Promise<boolean> {
        return LocalReplicaSCMProvider.pathExists(vscode.Uri.joinPath(uri, '.git'));
    }

    private static isMountRoot(resolvedPath: string): boolean {
        if (process.platform==='win32') { return false; }
        const normalized = resolvedPath.replace(/\/+$/, '') || '/';
        return normalized==='/mnt'
            || /^\/mnt\/[^/]+$/i.test(normalized);
    }

    private static isWindowsUserProfileRoot(resolvedPath: string): boolean {
        if (process.platform==='win32') {
            return LocalReplicaSCMProvider.isNativeWindowsUserProfileRoot(resolvedPath);
        }
        const normalized = resolvedPath.replace(/\/+$/, '');
        return /^\/mnt\/[^/]+\/Users$/i.test(normalized)
            || /^\/mnt\/[^/]+\/Users\/[^/]+$/i.test(normalized);
    }

    private static isNativeWindowsUserProfileRoot(resolvedPath: string): boolean {
        const normalized = nodePath.win32.normalize(resolvedPath).replace(/[\\/]+$/, '');
        const parts = normalized.split(/[\\/]+/).filter(Boolean);
        return /^[a-z]:$/i.test(parts[0] ?? '')
            && parts[1]?.toLowerCase()==='users'
            && (parts.length===2 || parts.length===3);
    }

    private static protectedExactBaseUriReasonMessage(reason: ProtectedExactBaseUriReasonCode): string {
        switch (reason) {
            case 'filesystem-root': return vscode.l10n.t('filesystem root');
            case 'home-directory': return vscode.l10n.t('home directory');
            case 'workspace-root': return vscode.l10n.t('workspace root');
            case 'mount-root': return vscode.l10n.t('mount root');
            case 'windows-user-profile-root': return vscode.l10n.t('Windows user profile root');
            case 'git-repository-root': return vscode.l10n.t('Git repository root');
        }
    }

    private static async getProtectedExactBaseUriReasonCode(baseUri: vscode.Uri): Promise<ProtectedExactBaseUriReasonCode | undefined> {
        if (baseUri.scheme!=='file') {
            return undefined;
        }

        const resolvedPath = await LocalReplicaSCMProvider.resolvedFsPath(baseUri);
        const parsed = nodePath.parse(resolvedPath);
        const homePath = await LocalReplicaSCMProvider.resolvedFsPath(vscode.Uri.file(os.homedir()));
        const workspaceRoots = await Promise.all(
            (vscode.workspace.workspaceFolders ?? [])
                .filter(folder => folder.uri.scheme==='file')
                .map(folder => LocalReplicaSCMProvider.resolvedFsPath(folder.uri)),
        );

        if (resolvedPath===nodePath.resolve(parsed.root)) {
            return 'filesystem-root';
        } else if (resolvedPath===homePath) {
            return 'home-directory';
        } else if (LocalReplicaSCMProvider.isMountRoot(resolvedPath)) {
            return 'mount-root';
        } else if (LocalReplicaSCMProvider.isWindowsUserProfileRoot(resolvedPath)) {
            return 'windows-user-profile-root';
        } else if (await LocalReplicaSCMProvider.isGitRepositoryRoot(baseUri)) {
            return 'git-repository-root';
        } else if (workspaceRoots.includes(resolvedPath)) {
            return 'workspace-root';
        }

        return undefined;
    }

    private static async getProtectedExactBaseUriReason(baseUri: vscode.Uri): Promise<string | undefined> {
        const reason = await LocalReplicaSCMProvider.getProtectedExactBaseUriReasonCode(baseUri);
        return reason ? LocalReplicaSCMProvider.protectedExactBaseUriReasonMessage(reason) : undefined;
    }

    private static async rejectDangerousExactBaseUri(baseUri: vscode.Uri): Promise<void> {
        if (baseUri.scheme!=='file') {
            const message = vscode.l10n.t('Local Replica folder must be a local file-system path.');
            getOutputChannel().appendLine(`${new Date().toISOString()} [exact folder rejected] ${baseUri.toString()}: non-local path`);
            vscode.window.showErrorMessage(message);
            throw new LocalReplicaFolderSelectionRejectedError('Local Replica folder must be a file URI.');
        }

        const reasonCode = await LocalReplicaSCMProvider.getProtectedExactBaseUriReasonCode(baseUri);
        if (reasonCode) {
            const reason = LocalReplicaSCMProvider.protectedExactBaseUriReasonMessage(reasonCode);
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [exact folder rejected] ${baseUri.fsPath || baseUri.toString()}: ${reason}`,
            );
            vscode.window.showErrorMessage(
                vscode.l10n.t(
                    'Refusing to use {path} as a Local Replica folder because it is a protected {reason}. Select a dedicated project folder instead.',
                    {path: baseUri.fsPath || baseUri.toString(), reason},
                ),
            );
            throw new LocalReplicaFolderSelectionRejectedError(`Protected Local Replica folder: ${reason}`);
        }
    }

    private static async validateExistingExactReplicaSettings(
        baseUri: vscode.Uri,
        expectedProjectUri?: vscode.Uri,
    ): Promise<'same-project' | 'different-project' | 'none'> {
        const settings = await readReplicaSettingsSnapshot(baseUri);
        if (!settings?.uri) {
            return 'none';
        }
        if (!expectedProjectUri) {
            return 'different-project';
        }
        try {
            const existingProjectUri = vscode.Uri.parse(settings.uri);
            return vfsProjectKey(existingProjectUri)===vfsProjectKey(expectedProjectUri)
                ? 'same-project'
                : 'different-project';
        } catch {
            return 'different-project';
        }
    }

    public setInitializationOptions(options?: InitializeLocalReplicaOptions) {
        this.initializationOptions = {
            ...this.initializationOptions,
            ...definedInitializationOptions(options),
        };
        return this;
    }

    private get settingsUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, REPLICA_SETTINGS_FILE);
    }

    private get syncManifestUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, SYNC_MANIFEST_FILE);
    }

    private get legacySettingsUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, LEGACY_REPLICA_SETTINGS_FILE);
    }

    private get settingsDirectoryUri(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, REPLICA_SETTINGS_DIR);
    }

    private get localOperationsDirectoryPath(): string {
        return nodePath.join(this.settingsDirectoryUri.fsPath, 'operations');
    }

    private get remoteDeleteOperationsDirectoryPath(): string {
        return nodePath.join(this.settingsDirectoryUri.fsPath, 'remote-delete-operations');
    }

    private localOperationRecordPath(id: string): string {
        return nodePath.join(this.localOperationsDirectoryPath, `${id}.json`);
    }

    private localOperationCommitPath(id: string): string {
        return nodePath.join(this.localOperationsDirectoryPath, `${id}.committed`);
    }

    private localOperationGuardPath(record: LocalReplicaOperationRecord): string {
        return nodePath.join(this.localOperationsDirectoryPath, record.guardName);
    }

    private async syncDirectoryBestEffort(directoryPath: string): Promise<void> {
        let handle: nodeFs.FileHandle | undefined;
        try {
            handle = await nodeFs.open(directoryPath, 'r');
            await handle.sync();
        } catch {
            // Directory fsync is unavailable on some Windows/network filesystems.
        } finally {
            await handle?.close().catch(() => undefined);
        }
    }

    private async renameDurably(sourcePath: string, targetPath: string): Promise<void> {
        await nodeFs.rename(sourcePath, targetPath);
        const sourceDirectory = nodePath.dirname(sourcePath);
        const targetDirectory = nodePath.dirname(targetPath);
        await this.syncDirectoryBestEffort(sourceDirectory);
        if (targetDirectory!==sourceDirectory) {
            await this.syncDirectoryBestEffort(targetDirectory);
        }
    }

    private async writeDurableOperationFile(
        targetPath: string,
        content: Uint8Array,
    ): Promise<void> {
        await nodeFs.mkdir(nodePath.dirname(targetPath), {recursive: true});
        const temporaryPath = `${targetPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        let handle: nodeFs.FileHandle | undefined;
        try {
            handle = await nodeFs.open(temporaryPath, 'wx', 0o600);
            await handle.writeFile(content);
            await handle.sync();
            await handle.close();
            handle = undefined;
            await nodeFs.rename(temporaryPath, targetPath);
            await this.syncDirectoryBestEffort(nodePath.dirname(targetPath));
        } catch (error) {
            await handle?.close().catch(() => undefined);
            await nodeFs.unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    }

    private async createLocalOperationRecord(
        record: LocalReplicaOperationRecord,
    ): Promise<void> {
        await this.writeDurableOperationFile(
            this.localOperationRecordPath(record.id),
            Buffer.from(JSON.stringify(record)),
        );
    }

    private async markLocalOperationCommitted(id: string): Promise<void> {
        if (await this.localPathExists(this.localOperationCommitPath(id))) {
            return;
        }
        await this.writeDurableOperationFile(
            this.localOperationCommitPath(id),
            Buffer.from('committed\n'),
        );
    }

    private async removeLocalOperationRecord(id: string): Promise<void> {
        await nodeFs.unlink(this.localOperationCommitPath(id)).catch(error => {
            if (!this.isNodeErrorCode(error, 'ENOENT')) { throw error; }
        });
        await nodeFs.unlink(this.localOperationRecordPath(id)).catch(error => {
            if (!this.isNodeErrorCode(error, 'ENOENT')) { throw error; }
        });
        await this.syncDirectoryBestEffort(this.localOperationsDirectoryPath);
    }

    private async retainGuardOrRemoveLocalOperation(
        record: LocalReplicaOperationRecord,
    ): Promise<boolean> {
        if (await this.localPathExists(this.localOperationGuardPath(record))) {
            await this.markLocalOperationCommitted(record.id);
            return true;
        }
        await this.removeLocalOperationRecord(record.id);
        return false;
    }

    private remoteDeleteOperationRecordPath(id: string): string {
        return nodePath.join(this.remoteDeleteOperationsDirectoryPath, `${id}.json`);
    }

    private isValidRecordedPathRevision(value: unknown): value is string {
        return typeof value==='string'
            && value.length<=16_384
            && (
                value===DELETE_DIGEST
                || /^[a-f0-9]{40}$/.test(value)
                || /^directory:[a-f0-9]{40}$/.test(value)
                || value.startsWith('other:')
                || value.startsWith('unreadable:')
            );
    }

    private isValidRemoteFolderDeleteGuard(
        value: unknown,
    ): value is RemoteFolderDeleteGuard {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const guard = value as Partial<RemoteFolderDeleteGuard>;
        return this.isValidSyncManifestFolderIdentity(guard.entity)
            && this.isValidSyncManifestFolderIdentity(guard.parent)
            && typeof guard.pendingOperationId==='string'
            && /^[a-f0-9]{32}$/.test(guard.pendingOperationId);
    }

    private remoteFolderDeleteGuardsMatch(
        left: RemoteFolderDeleteGuard | undefined,
        right: RemoteFolderDeleteGuard | undefined,
    ): boolean {
        if (left===undefined || right===undefined) {
            return left===right;
        }
        return this.remoteFolderIdentityMatches(left.entity, right.entity)
            && this.remoteFolderIdentityMatches(left.parent, right.parent)
            && left.pendingOperationId===right.pendingOperationId;
    }

    private isValidRemoteDeleteOperationRecord(
        value: unknown,
    ): value is RemoteDeleteOperationRecord {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const record = value as Partial<RemoteDeleteOperationRecord>;
        const kind = record.kind ?? 'delete';
        const expectedStageName = kind==='replace'
            ? `.sr-overleaf-replace-${record.id}`
            : `.sr-overleaf-delete-${record.id}`;
        const validFolderGuard = record.folderGuard===undefined
            || (
                kind==='delete'
                && this.isValidRemoteFolderDeleteGuard(record.folderGuard)
            );
        return record.version===1
            && (kind==='delete' || kind==='replace')
            && typeof record.id==='string'
            && record.id.length<=128
            && /^[a-f0-9]{24}$/.test(record.id)
            && typeof record.relPath==='string'
            && this.isCanonicalReplicaRelPath(record.relPath)
            && typeof record.stagingRelPath==='string'
            && this.isCanonicalReplicaRelPath(record.stagingRelPath)
            && nodePath.posix.basename(record.stagingRelPath)===expectedStageName
            && nodePath.posix.dirname(record.stagingRelPath)===nodePath.posix.dirname(record.relPath)
            && this.isValidRecordedPathRevision(record.expectedRevision)
            && (
                kind==='delete'
                    ? record.replacementRevision===undefined
                        && record.supersededByRevision===undefined
                    : this.isValidRecordedPathRevision(record.replacementRevision)
                        && (
                            record.supersededByRevision===undefined
                            || this.isValidRecordedPathRevision(record.supersededByRevision)
                        )
            )
            && validFolderGuard
            && typeof record.createdAt==='string'
            && Number.isFinite(Date.parse(record.createdAt));
    }

    private async createRemoteDeleteOperationRecord(
        record: RemoteDeleteOperationRecord,
    ): Promise<void> {
        const recordPath = this.remoteDeleteOperationRecordPath(record.id);
        try {
            const existing: unknown = JSON.parse(await nodeFs.readFile(recordPath, 'utf8'));
            if (
                this.isValidRemoteDeleteOperationRecord(existing)
                && existing.relPath===record.relPath
                && existing.stagingRelPath===record.stagingRelPath
                && existing.expectedRevision===record.expectedRevision
                && (existing.kind ?? 'delete')===(record.kind ?? 'delete')
                && existing.replacementRevision===record.replacementRevision
                && existing.supersededByRevision===record.supersededByRevision
                && this.remoteFolderDeleteGuardsMatch(existing.folderGuard, record.folderGuard)
            ) {
                return;
            }
            throw new Error(`Conflicting remote delete journal at ${recordPath}`);
        } catch (error) {
            if (!this.isNodeErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
        await this.writeDurableOperationFile(
            recordPath,
            Buffer.from(JSON.stringify(record)),
        );
    }

    private async updateRemoteDeleteOperationRecord(
        record: RemoteDeleteOperationRecord,
    ): Promise<void> {
        const relPath = record.relPath;
        if (!this.isValidRemoteDeleteOperationRecord(record)) {
            throw new Error(`Invalid remote delete journal update for ${relPath}`);
        }
        await this.writeDurableOperationFile(
            this.remoteDeleteOperationRecordPath(record.id),
            Buffer.from(JSON.stringify(record)),
        );
    }

    private async removeRemoteDeleteOperationRecord(id: string): Promise<void> {
        await nodeFs.unlink(this.remoteDeleteOperationRecordPath(id)).catch(error => {
            if (!this.isNodeErrorCode(error, 'ENOENT')) { throw error; }
        });
        await this.syncDirectoryBestEffort(this.remoteDeleteOperationsDirectoryPath);
    }

    private async listRemoteDeleteOperationRecords(): Promise<RemoteDeleteOperationRecord[]> {
        let entries: string[];
        try {
            entries = await nodeFs.readdir(this.remoteDeleteOperationsDirectoryPath);
        } catch (error) {
            if (this.isNodeErrorCode(error, 'ENOENT')) {
                return [];
            }
            throw error;
        }
        const records: RemoteDeleteOperationRecord[] = [];
        for (const name of entries.filter(entry => entry.endsWith('.json')).sort()) {
            const recordPath = nodePath.join(this.remoteDeleteOperationsDirectoryPath, name);
            try {
                const parsed: unknown = JSON.parse(await nodeFs.readFile(recordPath, 'utf8'));
                if (!this.isValidRemoteDeleteOperationRecord(parsed)) {
                    throw new Error('invalid remote delete operation record shape');
                }
                records.push(parsed);
            } catch (error) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [remote delete journal retained] ${recordPath}: ` +
                    formatUnknownError(error),
                );
                throw new Error(
                    `Cannot safely resume remote deletes because ${recordPath} is invalid: ` +
                    formatUnknownError(error),
                );
            }
        }
        return records;
    }

    private isValidLocalOperationRecord(
        value: unknown,
    ): value is LocalReplicaOperationRecord {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const record = value as Partial<LocalReplicaOperationRecord>;
        const validName = (name: unknown, suffix: string) =>
            typeof name==='string'
            && nodePath.basename(name)===name
            && name.startsWith('.sr-overleaf-')
            && name.endsWith(suffix);
        return record.version===1
            && typeof record.id==='string'
            && record.id.length<=128
            && /^[a-f0-9-]+$/.test(record.id)
            && (record.kind==='write' || record.kind==='delete')
            && typeof record.relPath==='string'
            && this.isCanonicalReplicaRelPath(record.relPath)
            && (
                record.entityKind==='missing'
                || record.entityKind==='file'
                || record.entityKind==='directory'
                || record.entityKind==='other'
            )
            && this.isValidRecordedPathRevision(record.expectedRevision)
            && (
                record.kind==='write'
                    ? (
                        typeof record.installedRevision==='string'
                        && /^[a-f0-9]{40}$/.test(record.installedRevision)
                        && validName(record.stageName, '.new')
                    )
                    : (
                        record.installedRevision===undefined
                        && record.stageName===undefined
                    )
            )
            && validName(record.backupName, record.kind==='write' ? '.old' : '.deleted')
            && validName(record.guardName, '.guard')
            && typeof record.createdAt==='string'
            && Number.isFinite(Date.parse(record.createdAt));
    }

    private async localPathExists(localPath: string): Promise<boolean> {
        try {
            await nodeFs.lstat(localPath);
            return true;
        } catch (error) {
            if (this.isNodeErrorCode(error, 'ENOENT')) {
                return false;
            }
            throw error;
        }
    }

    private async collectLocalInodeKeys(
        localPath: string,
        result = new Set<string>(),
    ): Promise<Set<string>> {
        const stat = await nodeFs.lstat(localPath, {bigint: true});
        result.add(`${stat.dev}:${stat.ino}`);
        if (!stat.isDirectory()) {
            return result;
        }
        for (const entry of await nodeFs.readdir(localPath)) {
            await this.collectLocalInodeKeys(nodePath.join(localPath, entry), result);
        }
        return result;
    }

    private async retainedPathHasOpenFileDescriptor(
        localPath: string,
    ): Promise<boolean | undefined> {
        if (process.platform!=='linux') {
            return undefined;
        }
        let inodeKeys: Set<string>;
        let processEntries: string[];
        try {
            inodeKeys = await this.collectLocalInodeKeys(localPath);
            processEntries = await nodeFs.readdir('/proc');
        } catch {
            return undefined;
        }
        const currentUid = process.getuid?.();
        let inspectionIncomplete = false;
        for (const pid of processEntries.filter(entry => /^\d+$/.test(entry))) {
            const processRoot = `/proc/${pid}`;
            if (currentUid!==undefined && currentUid!==0) {
                try {
                    const status = await nodeFs.readFile(
                        nodePath.join(processRoot, 'status'),
                        'utf8',
                    );
                    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
                    if (uid===undefined || Number(uid)!==currentUid) {
                        continue;
                    }
                } catch (error) {
                    if (this.isNodeErrorCode(error, 'ENOENT')) {
                        continue;
                    }
                    inspectionIncomplete = true;
                    continue;
                }
            }
            const fileDescriptorDirectory = nodePath.join(processRoot, 'fd');
            let descriptors: string[];
            try {
                descriptors = await nodeFs.readdir(fileDescriptorDirectory);
            } catch (error) {
                if (this.isNodeErrorCode(error, 'ENOENT')) {
                    continue;
                }
                inspectionIncomplete = true;
                continue;
            }
            for (const descriptor of descriptors) {
                try {
                    const stat = await nodeFs.stat(
                        nodePath.join(fileDescriptorDirectory, descriptor),
                        {bigint: true},
                    );
                    if (inodeKeys.has(`${stat.dev}:${stat.ino}`)) {
                        return true;
                    }
                } catch (error) {
                    if (this.isNodeErrorCode(error, 'ENOENT')) {
                        continue;
                    }
                    inspectionIncomplete = true;
                }
            }
        }
        return inspectionIncomplete ? undefined : false;
    }

    private scheduleUnreferencedLocalGuardCleanup(
        record: LocalReplicaOperationRecord,
        generation: number,
    ): void {
        if (
            process.platform!=='linux'
            || this.localGuardCleanupPromises.has(record.id)
        ) {
            return;
        }
        const cleanup = Promise.resolve().then(async () => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const guardPath = this.localOperationGuardPath(record);
            const before = await this.captureLocalUriRevision(
                vscode.Uri.file(guardPath),
                record.relPath,
                generation,
            );
            if (before.revision!==record.expectedRevision) { return; }
            const hasOpenDescriptor = await this.retainedPathHasOpenFileDescriptor(guardPath);
            if (hasOpenDescriptor!==false || !this.isSyncSessionActive(generation)) {
                return;
            }
            const after = await this.captureLocalUriRevision(
                vscode.Uri.file(guardPath),
                record.relPath,
                generation,
            );
            if (after.revision!==record.expectedRevision) { return; }
            await this.runSessionIO(generation, async () => {
                await nodeFs.rm(guardPath, {recursive: true, force: true});
                await this.removeLocalOperationRecord(record.id);
            });
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [local inode guard released] ${record.relPath}: ` +
                'no open file descriptor references the retained inode',
            );
        }).catch(error => {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [local inode guard cleanup deferred] ${record.relPath}: ` +
                formatUnknownError(error),
            );
        }).finally(() => {
            if (this.localGuardCleanupPromises.get(record.id)===cleanup) {
                this.localGuardCleanupPromises.delete(record.id);
            }
        });
        this.localGuardCleanupPromises.set(record.id, cleanup);
    }

    private detachedLocalGuardPaths(record: LocalReplicaOperationRecord): {
        detachedDirectory: string;
        detachedGuardPath: string;
        detachedRecordPath: string;
    } {
        const detachedDirectory = nodePath.join(
            this.settingsDirectoryUri.fsPath,
            'detached-inode-guards',
        );
        return {
            detachedDirectory,
            detachedGuardPath: nodePath.join(detachedDirectory, `${record.id}.guard`),
            detachedRecordPath: nodePath.join(detachedDirectory, `${record.id}.json`),
        };
    }

    private localOperationRecordsEqual(
        left: LocalReplicaOperationRecord,
        right: LocalReplicaOperationRecord,
    ): boolean {
        return left.version===right.version
            && left.id===right.id
            && left.kind===right.kind
            && left.relPath===right.relPath
            && left.entityKind===right.entityKind
            && left.expectedRevision===right.expectedRevision
            && left.installedRevision===right.installedRevision
            && left.stageName===right.stageName
            && left.backupName===right.backupName
            && left.guardName===right.guardName
            && left.createdAt===right.createdAt;
    }

    private async readDetachedLocalGuardRecord(
        record: LocalReplicaOperationRecord,
    ): Promise<DetachedLocalGuardRecord | undefined> {
        const {detachedRecordPath} = this.detachedLocalGuardPaths(record);
        let parsed: unknown;
        try {
            parsed = JSON.parse(await nodeFs.readFile(detachedRecordPath, 'utf8'));
        } catch (error) {
            if (this.isNodeErrorCode(error, 'ENOENT')) { return undefined; }
            throw new Error(
                `Cannot read detached inode metadata ${detachedRecordPath}: ` +
                formatUnknownError(error),
            );
        }
        if (
            !this.isValidLocalOperationRecord(parsed)
            || !this.localOperationRecordsEqual(parsed, record)
            || typeof (parsed as Partial<DetachedLocalGuardRecord>).detachedAt!=='string'
            || !Number.isFinite(Date.parse(
                (parsed as Partial<DetachedLocalGuardRecord>).detachedAt!,
            ))
            || (
                (parsed as Partial<DetachedLocalGuardRecord>)
                    .mappingRemovalCommittedAt!==undefined
                && (
                    typeof (parsed as Partial<DetachedLocalGuardRecord>)
                        .mappingRemovalCommittedAt!=='string'
                    || !Number.isFinite(Date.parse(
                        (parsed as Partial<DetachedLocalGuardRecord>)
                            .mappingRemovalCommittedAt!,
                    ))
                )
            )
        ) {
            throw new Error(
                `Detached inode metadata does not match its active journal: ` +
                detachedRecordPath,
            );
        }
        return parsed as DetachedLocalGuardRecord;
    }

    private async removeDetachedLocalGuardRecord(
        detachedRecordPath: string,
    ): Promise<void> {
        await nodeFs.unlink(detachedRecordPath).catch(error => {
            if (!this.isNodeErrorCode(error, 'ENOENT')) { throw error; }
        });
        await this.syncDirectoryBestEffort(nodePath.dirname(detachedRecordPath));
    }

    private async recoverDetachedLocalGuardForActiveMapping(
        record: LocalReplicaOperationRecord,
    ): Promise<'none' | 'active' | 'mapping-removed'> {
        const {
            detachedGuardPath,
            detachedRecordPath,
        } = this.detachedLocalGuardPaths(record);
        const [metadata, activeGuardExists, detachedGuardExists] = await Promise.all([
            this.readDetachedLocalGuardRecord(record),
            this.localPathExists(this.localOperationGuardPath(record)),
            this.localPathExists(detachedGuardPath),
        ]);
        if (!metadata) {
            if (detachedGuardExists) {
                throw new Error(
                    `Detached inode guard has no durable metadata: ${detachedGuardPath}`,
                );
            }
            return 'none';
        }
        if (metadata.mappingRemovalCommittedAt!==undefined) {
            if (activeGuardExists) {
                throw new Error(
                    `A mapping-removed inode journal also has an active guard: ` +
                    this.localOperationGuardPath(record),
                );
            }
            await this.removeLocalOperationRecord(record.id);
            return 'mapping-removed';
        }
        if (activeGuardExists && detachedGuardExists) {
            throw new Error(
                `Detached inode recovery found both active and staged guards for ` +
                `${record.relPath}`,
            );
        }
        if (detachedGuardExists) {
            await this.renameDurably(
                detachedGuardPath,
                this.localOperationGuardPath(record),
            );
        } else if (!activeGuardExists) {
            throw new Error(
                `Detached inode metadata has no recoverable guard: ${detachedRecordPath}`,
            );
        }
        await this.removeDetachedLocalGuardRecord(detachedRecordPath);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [local inode guard staging recovered] ` +
            `${record.relPath}: restored active journal tracking`,
        );
        return 'active';
    }

    private async stageDetachedLocalGuard(
        record: LocalReplicaOperationRecord,
        guardPath: string,
    ): Promise<void> {
        const {
            detachedDirectory,
            detachedGuardPath,
            detachedRecordPath,
        } = this.detachedLocalGuardPaths(record);
        await nodeFs.mkdir(detachedDirectory, {recursive: true});
        await this.writeDurableOperationFile(
            detachedRecordPath,
            Buffer.from(JSON.stringify({
                ...record,
                detachedAt: new Date().toISOString(),
            })),
        );
        try {
            await this.renameDurably(guardPath, detachedGuardPath);
        } catch (error) {
            await nodeFs.unlink(detachedRecordPath).catch(() => undefined);
            throw error;
        }
        this.stagedDetachedLocalGuards.push({
            record,
            guardPath,
            detachedGuardPath,
            detachedRecordPath,
        });
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [local inode guard staged for detach] ${record.relPath}: ` +
            `platform cannot prove descriptor closure; staged=${detachedGuardPath}`,
        );
    }

    private async rollbackStagedDetachedLocalGuards(): Promise<void> {
        for (
            let index=this.stagedDetachedLocalGuards.length-1;
            index>=0;
            index--
        ) {
            const item = this.stagedDetachedLocalGuards[index];
            const metadata = await this.readDetachedLocalGuardRecord(item.record);
            if (metadata?.mappingRemovalCommittedAt!==undefined) {
                this.stagedDetachedLocalGuards.splice(index, 1);
                continue;
            }
            const [detachedGuardExists, activeGuardExists] = await Promise.all([
                this.localPathExists(item.detachedGuardPath),
                this.localPathExists(item.guardPath),
            ]);
            if (detachedGuardExists) {
                if (activeGuardExists) {
                    throw new Error(
                        `Cannot restore retained inode guard because its active path was recreated: ` +
                        `${item.guardPath}`,
                    );
                }
                await this.renameDurably(item.detachedGuardPath, item.guardPath);
            } else if (!activeGuardExists) {
                throw new Error(
                    `Cannot restore retained inode guard because both staged and active paths ` +
                    `are missing for ${item.record.relPath}`,
                );
            }
            await this.removeDetachedLocalGuardRecord(item.detachedRecordPath);
            this.stagedDetachedLocalGuards.splice(index, 1);
        }
    }

    public async confirmRemovalPersistenceDeleted(): Promise<void> {
        for (const item of [...this.stagedDetachedLocalGuards]) {
            const metadata = await this.readDetachedLocalGuardRecord(item.record);
            if (!metadata) {
                throw new Error(
                    `Cannot commit mapping removal without detached inode metadata: ` +
                    item.detachedRecordPath,
                );
            }
            if (metadata.mappingRemovalCommittedAt===undefined) {
                await this.writeDurableOperationFile(
                    item.detachedRecordPath,
                    Buffer.from(JSON.stringify({
                        ...metadata,
                        mappingRemovalCommittedAt: new Date().toISOString(),
                    })),
                );
            }
            const index = this.stagedDetachedLocalGuards.indexOf(item);
            if (index>=0) {
                this.stagedDetachedLocalGuards.splice(index, 1);
            }
            await this.removeLocalOperationRecord(item.record.id).catch(error => {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [detached inode journal cleanup deferred] ` +
                    `${item.record.relPath}: ${formatUnknownError(error)}`,
                );
            });
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [local inode guard detached] ${item.record.relPath}: ` +
                `mapping removal committed; preserved=${item.detachedGuardPath}`,
            );
        }
    }

    private async listLocalOperationRecords(): Promise<Array<{
        record: LocalReplicaOperationRecord;
        committed: boolean;
    }>> {
        let entries: string[];
        try {
            entries = await nodeFs.readdir(this.localOperationsDirectoryPath);
        } catch (error) {
            if (this.isNodeErrorCode(error, 'ENOENT')) {
                return [];
            }
            throw error;
        }
        const records: Array<{
            record: LocalReplicaOperationRecord;
            committed: boolean;
        }> = [];
        for (const name of entries.filter(entry => entry.endsWith('.json')).sort()) {
            const recordPath = nodePath.join(this.localOperationsDirectoryPath, name);
            try {
                const parsed: unknown = JSON.parse(await nodeFs.readFile(recordPath, 'utf8'));
                if (!this.isValidLocalOperationRecord(parsed)) {
                    throw new Error('invalid operation record shape');
                }
                records.push({
                    record: parsed,
                    committed: await this.localPathExists(
                        this.localOperationCommitPath(parsed.id),
                    ),
                });
            } catch (error) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local operation journal retained] ${recordPath}: ` +
                    formatUnknownError(error),
                );
                throw new Error(
                    `Cannot safely resume Local Replica operations because ${recordPath} is invalid: ` +
                    formatUnknownError(error),
                );
            }
        }
        return records;
    }

    private localOperationSiblingPath(
        record: LocalReplicaOperationRecord,
        name: string,
    ): string {
        return nodePath.join(
            nodePath.dirname(this.localUri(record.relPath).fsPath),
            name,
        );
    }

    private async restoreOperationGuardToVisiblePath(
        record: LocalReplicaOperationRecord,
        guardPath: string,
        generation: number,
    ): Promise<void> {
        const targetPath = this.localUri(record.relPath).fsPath;
        const targetExists = await this.localPathExists(targetPath);
        if (!targetExists) {
            await this.ensureOperationRecoveryParent(record.relPath, generation);
            await this.restoreStagedPathWithoutOverwrite(
                guardPath,
                targetPath,
                record.relPath,
                record.entityKind,
                'recovering a changed inode retained by an interrupted Local Replica operation',
                this.localOperationGuardPath(record),
            );
            return;
        }

        if (record.entityKind==='file') {
            await this.restoreChangedBackupAfterInstall(
                guardPath,
                targetPath,
                record.relPath,
                record.kind==='write' ? record.installedRevision : undefined,
                this.localOperationGuardPath(record),
            );
            return;
        }

        await this.preserveConcurrentStagingPath(
            targetPath,
            record.relPath,
            'the visible path was displaced while a changed directory inode was recovered',
        );
        await this.renameDurably(guardPath, targetPath);
    }

    private async ensureOperationRecoveryParent(
        relPath: string,
        generation: number,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const pathParts = this.requireConfinedRelPath(
            relPath,
            'recover local operation parent',
        ).replace(/^\/+/, '').split('/').slice(0, -1);
        const rootRealPath = LocalReplicaSCMProvider.comparableFsPath(
            await nodeFs.realpath(this.baseUri.fsPath),
        );
        let parentPath = this.baseUri.fsPath;
        for (const pathPart of pathParts) {
            this.requireSyncSession(generation);
            parentPath = nodePath.join(parentPath, pathPart);
            try {
                const stat = await nodeFs.lstat(parentPath);
                if (stat.isSymbolicLink() || !stat.isDirectory()) {
                    throw new Error(
                        `Local Replica operation recovery refuses a non-directory ancestor: ${parentPath}`,
                    );
                }
            } catch (error) {
                if (!this.isNodeErrorCode(error, 'ENOENT')) {
                    throw error;
                }
                await nodeFs.mkdir(parentPath);
                await this.syncDirectoryBestEffort(nodePath.dirname(parentPath));
            }
            const parentRealPath = LocalReplicaSCMProvider.comparableFsPath(
                await nodeFs.realpath(parentPath),
            );
            const relative = nodePath.relative(rootRealPath, parentRealPath);
            if (
                relative==='..'
                || relative.startsWith(`..${nodePath.sep}`)
                || nodePath.isAbsolute(relative)
            ) {
                throw new Error(
                    `Local Replica operation recovery escaped the selected folder: ${parentPath}`,
                );
            }
        }
    }

    private async cleanupLocalOperationStage(
        record: LocalReplicaOperationRecord,
    ): Promise<void> {
        if (!record.stageName) { return; }
        const stagePath = this.localOperationSiblingPath(record, record.stageName);
        await nodeFs.rm(stagePath, {recursive: true, force: true});
    }

    private async recoverInterruptedLocalOperations(
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        for (const {record, committed} of await this.listLocalOperationRecords()) {
            this.requireSyncSession(generation);
            const detachedRecovery =
                await this.recoverDetachedLocalGuardForActiveMapping(record);
            if (detachedRecovery==='mapping-removed') { continue; }
            const targetPath = this.localUri(record.relPath).fsPath;
            const backupPath = this.localOperationSiblingPath(record, record.backupName);
            const guardPath = this.localOperationGuardPath(record);
            const backupExists = await this.localPathExists(backupPath);
            const guardExists = await this.localPathExists(guardPath);
            const sourcePath = guardExists ? guardPath : (backupExists ? backupPath : undefined);

            if (committed) {
                if (sourcePath) {
                    const sourceRevision = await this.captureLocalUriRevision(
                        vscode.Uri.file(sourcePath),
                        record.relPath,
                        generation,
                    );
                    if (sourceRevision.revision!==record.expectedRevision) {
                        await this.restoreOperationGuardToVisiblePath(
                            record,
                            sourcePath,
                            generation,
                        );
                        const latestLocal = await this.captureLocalPathRevision(
                            record.relPath,
                            generation,
                        );
                        await this.markSyncConflict(
                            record.relPath,
                            'A process continued writing through an older local file handle while Local Replica was inactive',
                            latestLocal.kind==='file' ? latestLocal.content : undefined,
                            generation,
                        );
                        await this.retainGuardOrRemoveLocalOperation(record);
                    } else {
                        if (sourcePath!==guardPath) {
                            await this.renameDurably(sourcePath, guardPath);
                        }
                        this.scheduleUnreferencedLocalGuardCleanup(record, generation);
                    }
                } else {
                    await this.removeLocalOperationRecord(record.id);
                }
                await this.cleanupLocalOperationStage(record);
                continue;
            }

            if (sourcePath) {
                const sourceRevision = await this.captureLocalUriRevision(
                    vscode.Uri.file(sourcePath),
                    record.relPath,
                    generation,
                );
                const targetExists = await this.localPathExists(targetPath);
                if (
                    record.kind==='write'
                    && targetExists
                    && sourceRevision.revision===record.expectedRevision
                ) {
                    const targetRevision = await this.captureLocalPathRevision(
                        record.relPath,
                        generation,
                    );
                    if (
                        record.installedRevision!==undefined
                        && targetRevision.revision===record.installedRevision
                    ) {
                        if (sourcePath!==guardPath) {
                            await this.renameDurably(sourcePath, guardPath);
                        }
                        await this.markLocalOperationCommitted(record.id);
                        this.scheduleUnreferencedLocalGuardCleanup(record, generation);
                        await this.cleanupLocalOperationStage(record);
                        continue;
                    }
                }
                if (
                    record.kind==='delete'
                    && !targetExists
                    && sourceRevision.revision===record.expectedRevision
                ) {
                    if (sourcePath!==guardPath) {
                        await this.renameDurably(sourcePath, guardPath);
                    }
                    await this.markLocalOperationCommitted(record.id);
                    this.scheduleUnreferencedLocalGuardCleanup(record, generation);
                    await this.cleanupLocalOperationStage(record);
                    continue;
                }
                await this.restoreOperationGuardToVisiblePath(
                    record,
                    sourcePath,
                    generation,
                );
                const latestLocal = await this.captureLocalPathRevision(
                    record.relPath,
                    generation,
                );
                await this.markSyncConflict(
                    record.relPath,
                    'An interrupted Local Replica operation encountered concurrent local changes during recovery',
                    latestLocal.kind==='file' ? latestLocal.content : undefined,
                    generation,
                );
                await this.retainGuardOrRemoveLocalOperation(record);
            }
            await this.cleanupLocalOperationStage(record);
            if (!sourcePath) {
                await this.removeLocalOperationRecord(record.id);
            }
        }
    }

    private async recoverChangedCommittedLocalOperations(
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        await Promise.all([...this.localGuardCleanupPromises.values()]);
        this.requireSyncSession(generation);
        for (const {record, committed} of await this.listLocalOperationRecords()) {
            if (!committed) { continue; }
            const detachedRecovery =
                await this.recoverDetachedLocalGuardForActiveMapping(record);
            if (detachedRecovery==='mapping-removed') { continue; }
            const guardPath = this.localOperationGuardPath(record);
            if (!await this.localPathExists(guardPath)) {
                await this.removeLocalOperationRecord(record.id);
                continue;
            }
            const guardRevision = await this.captureLocalUriRevision(
                vscode.Uri.file(guardPath),
                record.relPath,
                generation,
            );
            if (guardRevision.revision===record.expectedRevision) {
                this.scheduleUnreferencedLocalGuardCleanup(record, generation);
                continue;
            }
            await this.restoreOperationGuardToVisiblePath(
                record,
                guardPath,
                generation,
            );
            const latestLocal = await this.captureLocalPathRevision(record.relPath, generation);
            await this.markSyncConflict(
                record.relPath,
                'A process continued writing through an older local file handle after an Overleaf operation',
                latestLocal.kind==='file' ? latestLocal.content : undefined,
                generation,
            );
            await this.retainGuardOrRemoveLocalOperation(record);
        }
    }

    private async cleanupUnchangedCommittedGuardsForRemoval(): Promise<void> {
        for (const {record, committed} of await this.listLocalOperationRecords()) {
            if (!committed) { continue; }
            const detachedRecovery =
                await this.recoverDetachedLocalGuardForActiveMapping(record);
            if (detachedRecovery==='mapping-removed') { continue; }
            const guardPath = this.localOperationGuardPath(record);
            if (!await this.localPathExists(guardPath)) {
                await this.removeLocalOperationRecord(record.id);
                continue;
            }
            const guardRevision = await this.captureLocalUriRevisionUnfenced(
                vscode.Uri.file(guardPath),
                record.relPath,
            );
            if (guardRevision.revision!==record.expectedRevision) {
                continue;
            }
            if (process.platform!=='linux') {
                await this.stageDetachedLocalGuard(record, guardPath);
                continue;
            }
            const hasOpenDescriptor = await this.retainedPathHasOpenFileDescriptor(guardPath);
            if (hasOpenDescriptor!==false) {
                continue;
            }
            await nodeFs.rm(guardPath, {recursive: true, force: true});
            await this.removeLocalOperationRecord(record.id);
        }
    }

    private async backupLegacySettings(
        generation = this.syncGeneration,
        knownToExist?: boolean,
    ) {
        this.requireSyncSession(generation);
        if (
            knownToExist===false
            || (
                knownToExist===undefined
                && !await LocalReplicaSCMProvider.pathExists(this.legacySettingsUri)
            )
        ) {
            return;
        }
        this.requireSyncSession(generation);
        try {
            await this.runSessionIO(
                generation,
                () => vscode.workspace.fs.rename(
                    this.legacySettingsUri,
                    vscode.Uri.joinPath(this.baseUri, LEGACY_REPLICA_SETTINGS_BACKUP_FILE),
                    {overwrite: false},
                ),
            );
        } catch {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            try {
                await this.runSessionIO(
                    generation,
                    () => vscode.workspace.fs.rename(
                        this.legacySettingsUri,
                        vscode.Uri.joinPath(this.baseUri, LEGACY_REPLICA_SETTINGS_DIR, `settings.${timestamp}.overleaf-workshop.json`),
                        {overwrite: false},
                    ),
                );
            } catch (error) {
                console.warn(`Could not back up legacy local replica settings under ${this.baseUri.toString()}:`, error);
            }
        }
    }

    private async pathExistsInSession(
        uri: vscode.Uri,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        try {
            await this.runSessionIO(generation, () => vscode.workspace.fs.stat(uri));
            this.requireSyncSession(generation);
            return true;
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                this.requireSyncSession(generation);
                return false;
            }
            throw error;
        }
    }

    private async ensureLocalReplicaSettings(generation = this.syncGeneration) {
        this.requireSyncSession(generation);
        // These are independent reads of the same local folder. On Remote SSH
        // every workspace.fs call crosses the extension-host boundary, so doing
        // them serially adds roughly three round trips to every activation.
        const [canonicalSettingsExisted, legacySettingsExisted, settingsRead] = await Promise.all([
            this.pathExistsInSession(this.settingsUri, generation),
            this.pathExistsInSession(this.legacySettingsUri, generation),
            this.runSessionIO(
                generation,
                () => vscode.workspace.fs.readFile(this.settingsUri),
            ).then(
                content => ({content}),
                error => ({error}),
            ),
        ]);
        this.requireSyncSession(generation);
        this.settingsExistedBeforeInitialization = canonicalSettingsExisted || legacySettingsExisted;
        const canonicalSettings = {
            'uri': stringifyOverleafUri(this.vfs.origin),
            'serverName': this.vfs.serverName,
            'enableCompileNPreview': true,
            'projectName': this.vfs.projectName,
        };
        let shouldPersist = false;
        try {
            if ('error' in settingsRead) { throw settingsRead.error; }
            const storedSettings = JSON.parse(new TextDecoder().decode(settingsRead.content));
            // `enableAgentReview` is dead metadata from a removed feature.
            // Ignoring it before the comparison keeps replicas written by older
            // builds from being rewritten on every load.
            const {enableAgentReview: _legacyEnableAgentReview, ...storedWithoutLegacyAgentReview} = storedSettings;
            this.localReplicaSettings = {
                ...canonicalSettings,
            };
            shouldPersist = JSON.stringify(storedWithoutLegacyAgentReview)!==JSON.stringify(this.localReplicaSettings);
        } catch (error) {
            if (!this.isSyncSessionActive(generation)) {
                throw error;
            }
            this.localReplicaSettings = canonicalSettings;
            shouldPersist = true;
        }
        if (shouldPersist) {
            await this.persistLocalReplicaSettings(generation);
        }
        // We already paid for the legacy stat above. A missing file cannot need
        // migration, and ownership prevents another Local Replica from creating
        // one concurrently in this folder.
        if (legacySettingsExisted) {
            await this.backupLegacySettings(generation, true);
        }
        return this.localReplicaSettings;
    }

    private async hasLocalReplicaSettings() {
        try {
            await vscode.workspace.fs.stat(this.settingsUri);
            return true;
        } catch {
            return LocalReplicaSCMProvider.pathExists(this.legacySettingsUri);
        }
    }

    private async persistLocalReplicaSettings(generation = this.syncGeneration) {
        this.requireSyncSession(generation);
        if (this.localReplicaSettings===undefined) { return; }
        await this.runSessionIO(
            generation,
            () => vscode.workspace.fs.createDirectory(this.settingsDirectoryUri),
        );
        await this.runSessionIO(
            generation,
            () => vscode.workspace.fs.writeFile(
                this.settingsUri,
                Buffer.from(JSON.stringify(this.localReplicaSettings, null, 4)),
            ),
        );
    }

    private emptySyncManifest(baselineComplete = true): SyncManifest {
        return {
            version: 9,
            projectUri: stringifyOverleafUri(this.vfs.origin),
            baselineComplete,
            files: {},
            directories: {},
            conflicts: {},
            pendingOperations: {},
        };
    }

    private markSyncManifestDirty() {
        this.syncManifestDirty = true;
        this.syncManifestRevision += 1;
    }

    private isValidSyncManifestEntry(value: unknown): value is SyncManifestEntry {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const entry = value as Partial<SyncManifestEntry>;
        const validBaseContent = entry.baseContentBase64===undefined
            || (
                typeof entry.baseContentBase64==='string'
                &&
                entry.baseContentBase64.length<=Math.ceil(
                    LocalReplicaSCMProvider.maxMergeBaselineBytes*4/3,
                )+4
                && entry.baseContentBase64.length%4===0
                && /^[A-Za-z0-9+/]*={0,2}$/.test(entry.baseContentBase64)
                && Buffer.from(entry.baseContentBase64, 'base64').toString('base64')
                    ===entry.baseContentBase64
                && contentDigest(Buffer.from(entry.baseContentBase64, 'base64'))
                    ===entry.localDigest
            );
        const remoteEntity = entry.remoteEntity;
        const validRemoteEntity = remoteEntity===undefined || (
            typeof remoteEntity.id==='string'
            && remoteEntity.id.length>0
            && remoteEntity.id.length<=4096
            && (remoteEntity.type==='doc' || remoteEntity.type==='file')
        );
        const localIdentity = entry.localIdentity;
        const validLocalIdentity = localIdentity===undefined || (
            typeof localIdentity.dev==='string'
            && /^[0-9]+$/.test(localIdentity.dev)
            && typeof localIdentity.ino==='string'
            && /^[1-9][0-9]*$/.test(localIdentity.ino)
        );

        return typeof entry.remoteFingerprint==='string'
            && entry.remoteFingerprint.length>0
            && entry.remoteFingerprint.length<=4096
            && typeof entry.localSize==='number'
            && Number.isSafeInteger(entry.localSize)
            && entry.localSize>=0
            && typeof entry.localMtime==='number'
            && Number.isFinite(entry.localMtime)
            && entry.localMtime>=0
            && typeof entry.localDigest==='string'
            && /^[a-f0-9]{40}$/.test(entry.localDigest)
            && (
                entry.baseContentBase64===undefined
                || typeof entry.baseContentBase64==='string'
            )
            && validBaseContent
            && validRemoteEntity
            && validLocalIdentity
            && (
                !entry.remoteFingerprint.startsWith('content:')
                || entry.remoteFingerprint===`content:${entry.localDigest}`
            )
            && typeof entry.updatedAt==='string'
            && Number.isFinite(Date.parse(entry.updatedAt));
    }

    private isValidSyncManifestFolderIdentity(
        value: unknown,
    ): value is SyncManifestRemoteFolderIdentity {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const identity = value as Partial<SyncManifestRemoteFolderIdentity>;
        return typeof identity.id==='string'
            && identity.id.length>0
            && identity.id.length<=4096
            && identity.type==='folder';
    }

    private isValidSyncManifestDirectoryEntry(
        value: unknown,
    ): value is SyncManifestDirectoryEntry {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const entry = value as Partial<SyncManifestDirectoryEntry>;
        const localIdentity = entry.localIdentity;
        const validLocalIdentity = localIdentity===undefined || (
            typeof localIdentity.dev==='string'
            && /^[0-9]+$/.test(localIdentity.dev)
            && typeof localIdentity.ino==='string'
            && /^[1-9][0-9]*$/.test(localIdentity.ino)
        );
        return (entry.remoteEntity===undefined || this.isValidSyncManifestFolderIdentity(entry.remoteEntity))
            && (entry.parentEntity===undefined || this.isValidSyncManifestFolderIdentity(entry.parentEntity))
            && validLocalIdentity
            && typeof entry.updatedAt==='string'
            && Number.isFinite(Date.parse(entry.updatedAt));
    }

    private isValidSyncManifestConflictEntry(
        value: unknown,
    ): value is SyncManifestConflictEntry {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const entry = value as Partial<SyncManifestConflictEntry>;
        const validRemoteProof = (
            entry.remoteKind===undefined
            && entry.remoteRevision===undefined
        ) || (
            (
                entry.remoteKind==='missing'
                || entry.remoteKind==='file'
                || entry.remoteKind==='directory'
                || entry.remoteKind==='other'
            )
            && this.isValidRecordedPathRevision(entry.remoteRevision)
        );
        return typeof entry.reason==='string'
            && entry.reason.length>0
            && entry.reason.length<=16_384
            && this.isValidRecordedPathRevision(entry.localDigest)
            && validRemoteProof
            && typeof entry.updatedAt==='string'
            && Number.isFinite(Date.parse(entry.updatedAt));
    }

    private isValidSyncManifestPendingFileOperation(
        value: unknown,
    ): value is SyncManifestPendingFileOperation {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const entry = value as Partial<SyncManifestPendingFileOperation>;
        const validRemoteProof = (
            entry.remoteKind===undefined
            && entry.remoteRevision===undefined
        ) || (
            (
                entry.remoteKind==='missing'
                || entry.remoteKind==='file'
                || entry.remoteKind==='directory'
                || entry.remoteKind==='other'
            )
            && this.isValidRecordedPathRevision(entry.remoteRevision)
        );
        return entry.version===1
            && typeof entry.id==='string'
            && /^[a-f0-9]{32}$/.test(entry.id)
            && (entry.kind==='update' || entry.kind==='delete')
            && (
                entry.localKind==='file'
                || entry.localKind==='missing'
            )
            && (
                entry.kind==='update'
                    ? entry.localKind==='file' && /^[a-f0-9]{40}$/.test(entry.localRevision ?? '')
                    : entry.localKind==='missing' && entry.localRevision===DELETE_DIGEST
            )
            && validRemoteProof
            && typeof entry.createdAt==='string'
            && Number.isFinite(Date.parse(entry.createdAt))
            && typeof entry.updatedAt==='string'
            && Number.isFinite(Date.parse(entry.updatedAt));
    }

    private isValidSyncManifestPendingMoveOperation(
        value: unknown,
    ): value is SyncManifestPendingMoveOperation {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const entry = value as Partial<SyncManifestPendingMoveOperation>;
        const sourceEntity = entry.sourceEntity;
        const validSourceEntity = !!sourceEntity
            && typeof sourceEntity.id==='string'
            && sourceEntity.id.length>0
            && sourceEntity.id.length<=4096
            && (sourceEntity.type==='doc' || sourceEntity.type==='file');
        const sourceLocalIdentity = entry.sourceLocalIdentity;
        const validSourceLocalIdentity = !!sourceLocalIdentity
            && typeof sourceLocalIdentity.dev==='string'
            && /^[0-9]+$/.test(sourceLocalIdentity.dev)
            && typeof sourceLocalIdentity.ino==='string'
            && /^[1-9][0-9]*$/.test(sourceLocalIdentity.ino);
        const validRemoteProof = (
            entry.sourceRemoteKind===undefined
            && entry.sourceRemoteRevision===undefined
        ) || (
            (
                entry.sourceRemoteKind==='missing'
                || entry.sourceRemoteKind==='file'
                || entry.sourceRemoteKind==='directory'
                || entry.sourceRemoteKind==='other'
            )
            && this.isValidRecordedPathRevision(entry.sourceRemoteRevision)
        );
        return entry.version===2
            && typeof entry.id==='string'
            && /^[a-f0-9]{32}$/.test(entry.id)
            && entry.kind==='move'
            && entry.localKind==='file'
            && /^[a-f0-9]{40}$/.test(entry.localRevision ?? '')
            && typeof entry.destinationRelPath==='string'
            && this.isCanonicalReplicaRelPath(entry.destinationRelPath)
            && validSourceEntity
            && validSourceLocalIdentity
            && validRemoteProof
            && typeof entry.createdAt==='string'
            && Number.isFinite(Date.parse(entry.createdAt))
            && typeof entry.updatedAt==='string'
            && Number.isFinite(Date.parse(entry.updatedAt));
    }

    private isValidSyncManifestPendingDirectoryCreateOperation(
        value: unknown,
    ): value is SyncManifestPendingDirectoryCreateOperation {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const entry = value as Partial<SyncManifestPendingDirectoryCreateOperation>;
        return entry.version===1
            && typeof entry.id==='string'
            && /^[a-f0-9]{32}$/.test(entry.id)
            && entry.kind==='mkdir'
            && entry.localKind==='directory'
            && this.isValidRecordedPathRevision(entry.localRevision)
            && entry.remoteKind==='missing'
            && entry.remoteRevision===DELETE_DIGEST
            && this.isValidSyncManifestFolderIdentity(entry.parentEntity)
            && (
                entry.createdEntity===undefined
                || this.isValidSyncManifestFolderIdentity(entry.createdEntity)
            )
            && typeof entry.createdAt==='string'
            && Number.isFinite(Date.parse(entry.createdAt))
            && typeof entry.updatedAt==='string'
            && Number.isFinite(Date.parse(entry.updatedAt));
    }

    private isValidSyncManifestPendingDirectoryDeleteOperation(
        value: unknown,
    ): value is SyncManifestPendingDirectoryDeleteOperation {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const entry = value as Partial<SyncManifestPendingDirectoryDeleteOperation>;
        const validStage = typeof entry.stageOperationId==='string'
            && /^[a-f0-9]{24}$/.test(entry.stageOperationId)
            && typeof entry.stagingRelPath==='string'
            && this.isCanonicalReplicaRelPath(entry.stagingRelPath)
            && nodePath.posix.basename(entry.stagingRelPath)
                ==='.sr-overleaf-delete-' + entry.stageOperationId;
        return entry.version===1
            && typeof entry.id==='string'
            && /^[a-f0-9]{32}$/.test(entry.id)
            && entry.kind==='rmdir'
            && entry.localKind==='missing'
            && entry.localRevision===DELETE_DIGEST
            && entry.remoteKind==='directory'
            && typeof entry.remoteRevision==='string'
            && /^directory:[a-f0-9]{40}$/.test(entry.remoteRevision)
            && this.isValidSyncManifestFolderIdentity(entry.targetEntity)
            && this.isValidSyncManifestFolderIdentity(entry.parentEntity)
            && validStage
            && typeof entry.createdAt==='string'
            && Number.isFinite(Date.parse(entry.createdAt))
            && typeof entry.updatedAt==='string'
            && Number.isFinite(Date.parse(entry.updatedAt));
    }

    private isValidSyncManifestPendingDirectoryMoveOperation(
        value: unknown,
    ): value is SyncManifestPendingDirectoryMoveOperation {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        const entry = value as Partial<SyncManifestPendingDirectoryMoveOperation>;
        const localIdentity = entry.sourceLocalIdentity;
        const validLocalIdentity = !!localIdentity
            && typeof localIdentity.dev==='string'
            && /^[0-9]+$/.test(localIdentity.dev)
            && typeof localIdentity.ino==='string'
            && /^[1-9][0-9]*$/.test(localIdentity.ino);
        return entry.version===1
            && typeof entry.id==='string'
            && /^[a-f0-9]{32}$/.test(entry.id)
            && entry.kind==='directory-move'
            && entry.localKind==='directory'
            && typeof entry.localRevision==='string'
            && /^directory:[a-f0-9]{40}$/.test(entry.localRevision)
            && this.isValidSyncManifestFolderIdentity(entry.sourceEntity)
            && this.isValidSyncManifestFolderIdentity(entry.sourceParentEntity)
            && validLocalIdentity
            && typeof entry.destinationRelPath==='string'
            && this.isCanonicalReplicaRelPath(entry.destinationRelPath)
            && this.isValidSyncManifestFolderIdentity(entry.destinationParentEntity)
            && entry.sourceRemoteKind==='directory'
            && typeof entry.sourceRemoteRevision==='string'
            && /^directory:[a-f0-9]{40}$/.test(entry.sourceRemoteRevision)
            && typeof entry.createdAt==='string'
            && Number.isFinite(Date.parse(entry.createdAt))
            && typeof entry.updatedAt==='string'
            && Number.isFinite(Date.parse(entry.updatedAt));
    }

    private isValidSyncManifestPendingOperation(
        value: unknown,
    ): value is SyncManifestPendingOperation {
        const kind = (
            value
            && typeof value==='object'
            && !Array.isArray(value)
        )
            ? (value as {kind?: unknown}).kind
            : undefined;
        if (kind==='move') {
            return this.isValidSyncManifestPendingMoveOperation(value);
        }
        if (kind==='directory-move') {
            return this.isValidSyncManifestPendingDirectoryMoveOperation(value);
        }
        if (kind==='mkdir') {
            return this.isValidSyncManifestPendingDirectoryCreateOperation(value);
        }
        if (kind==='rmdir') {
            return this.isValidSyncManifestPendingDirectoryDeleteOperation(value);
        }
        return this.isValidSyncManifestPendingFileOperation(value);
    }

    private isCanonicalReplicaRelPath(relPath: string): boolean {
        return relPath.length>1
            && relPath.startsWith('/')
            && !relPath.endsWith('/')
            && !relPath.includes('\\')
            && !relPath.includes('\0')
            && nodePath.posix.normalize(relPath)===relPath
            && !relPath.split('/').some(segment => segment==='.' || segment==='..');
    }

    private isValidSyncManifestRecord<T>(
        value: unknown,
        entryValidator: (entry: unknown) => entry is T,
    ): value is Record<string, T> {
        if (!value || typeof value!=='object' || Array.isArray(value)) {
            return false;
        }
        return Object.entries(value).every(([relPath, entry]) => {
            return this.isCanonicalReplicaRelPath(relPath)
                && entryValidator(entry);
        });
    }

    private hasValidSyncManifestTree(
        files: Record<string, SyncManifestEntry>,
        directories: Record<string, SyncManifestDirectoryEntry>,
    ): boolean {
        const filePaths = new Set(Object.keys(files));
        const directoryPaths = new Set(Object.keys(directories));
        if ([...filePaths].some(relPath => directoryPaths.has(relPath))) {
            return false;
        }
        for (const relPath of [...filePaths, ...directoryPaths]) {
            let parent = nodePath.posix.dirname(relPath);
            while (parent!=='/') {
                if (filePaths.has(parent)) {
                    return false;
                }
                parent = nodePath.posix.dirname(parent);
            }
        }
        return true;
    }

    private readSyncManifestFile(): Thenable<Uint8Array> {
        return vscode.workspace.fs.readFile(this.syncManifestUri);
    }

    private async loadSyncManifest(generation = this.syncGeneration) {
        this.requireSyncSession(generation);
        const projectUri = stringifyOverleafUri(this.vfs.origin);
        let manifestWasMissing = false;
        try {
            const content = await this.readSyncManifestFile();
            this.requireSyncSession(generation);
            const manifest = JSON.parse(new TextDecoder().decode(content)) as {
                version?: number;
                projectUri?: string;
                baselineComplete?: boolean;
                files?: Record<string, SyncManifestEntry>;
                directories?: Record<string, SyncManifestDirectoryEntry>;
                conflicts?: Record<string, SyncManifestConflictEntry>;
                pendingOperations?: Record<string, SyncManifestPendingOperation>;
            };
            let sameProject = false;
            try {
                sameProject = manifest.projectUri!==undefined
                    && vfsProjectKey(vscode.Uri.parse(manifest.projectUri))===vfsProjectKey(this.vfs.origin);
            } catch {
                sameProject = false;
            }
            const validShape = (manifest.version===1 || manifest.version===2 || manifest.version===3 || manifest.version===4 || manifest.version===5 || manifest.version===6 || manifest.version===7 || manifest.version===8 || manifest.version===9)
                && sameProject
                && (manifest.baselineComplete===undefined || typeof manifest.baselineComplete==='boolean')
                && this.isValidSyncManifestRecord<SyncManifestEntry>(
                    manifest.files,
                    (value): value is SyncManifestEntry =>
                        this.isValidSyncManifestEntry(value),
                )
                && (
                    manifest.directories===undefined
                    || this.isValidSyncManifestRecord<SyncManifestDirectoryEntry>(
                        manifest.directories,
                        (value): value is SyncManifestDirectoryEntry =>
                            this.isValidSyncManifestDirectoryEntry(value),
                    )
                )
                && (
                    manifest.conflicts===undefined
                    || this.isValidSyncManifestRecord<SyncManifestConflictEntry>(
                        manifest.conflicts,
                        (value): value is SyncManifestConflictEntry =>
                            this.isValidSyncManifestConflictEntry(value),
                    )
                )
                && (
                    manifest.version===1
                    || manifest.version===2
                    || this.isValidSyncManifestRecord<SyncManifestPendingOperation>(
                        manifest.pendingOperations,
                        (value): value is SyncManifestPendingOperation =>
                            this.isValidSyncManifestPendingOperation(value),
                    )
                )
                && this.hasValidSyncManifestTree(
                    manifest.files!,
                    manifest.directories ?? {},
                );
            if (validShape) {
                this.requireSyncSession(generation);
                this.syncManifest = {
                    version: 9,
                    projectUri,
                    baselineComplete: manifest.baselineComplete!==false,
                    files: manifest.files!,
                    directories: manifest.version!==1 && manifest.directories
                        ? manifest.directories
                        : {},
                    conflicts: manifest.conflicts ?? {},
                    pendingOperations: manifest.version===3 || manifest.version===4 || manifest.version===5 || manifest.version===6 || manifest.version===7 || manifest.version===8 || manifest.version===9
                        ? manifest.pendingOperations!
                        : {},
                };
                this.syncConflicts = new Map(
                    Object.entries(this.syncManifest.conflicts)
                        .map(([relPath, entry]) => [relPath, entry.reason]),
                );
                this.conflictLocalDigests = new Map(
                    Object.entries(this.syncManifest.conflicts)
                        .map(([relPath, entry]) => [relPath, entry.localDigest]),
                );
                for (const [relPath, pendingOperation] of Object.entries(
                    this.syncManifest.pendingOperations,
                )) {
                    // A pending operation is a durable local intent that did not
                    // yet receive an acknowledged terminal outcome. Keep it in
                    // the compile barrier until startup reconciliation proves it
                    // accepted, superseded, or conflicted.
                    this.locallyDivergedPaths.add(relPath);
                    if (pendingOperation.kind==='move' || pendingOperation.kind==='directory-move') {
                        this.locallyDivergedPaths.add(pendingOperation.destinationRelPath);
                    }
                }
                this.syncManifestBaselineMode = manifest.baselineComplete===false
                    ? 'unavailable'
                    : 'trusted';
                this.syncManifestRevision += 1;
                this.syncManifestDirty = manifest.version!==9
                    || manifest.directories===undefined
                    || manifest.conflicts===undefined
                    || manifest.baselineComplete===undefined
                    || manifest.projectUri!==projectUri;
                return;
            }
        } catch (error) {
            if (!this.isSyncSessionActive(generation)) {
                throw error;
            }
            manifestWasMissing = LocalReplicaSCMProvider.isFileNotFoundError(error);
            // Missing or invalid manifests are rebuilt opportunistically.
        }
        this.requireSyncSession(generation);
        this.syncManifestBaselineMode = manifestWasMissing
            && !this.settingsExistedBeforeInitialization
            ? 'fresh-replica'
            : 'unavailable';
        this.syncManifest = this.emptySyncManifest(
            this.syncManifestBaselineMode!=='unavailable',
        );
        this.syncConflicts.clear();
        this.conflictLocalDigests.clear();
        this.markSyncManifestDirty();
    }

    private persistSyncManifest(
        force = false,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        if (!this.syncManifest || (!force && !this.syncManifestDirty)) {
            return Promise.resolve();
        }

        const publish = this.syncManifestPersistQueue
            .catch(() => undefined)
            .then(async () => {
                this.requireSyncSession(generation);
                if (!this.syncManifest || (!force && !this.syncManifestDirty)) { return; }

                while (true) {
                    this.requireSyncSession(generation);
                    const revision = this.syncManifestRevision;
                    const serialized = Buffer.from(JSON.stringify(this.syncManifest, null, 2));
                    const temporaryUri = vscode.Uri.joinPath(
                        this.settingsDirectoryUri,
                        `sync-manifest.${process.pid}.${generation}.${revision}.${Date.now()}.tmp`,
                    );
                    try {
                        await this.runSessionIO(
                            generation,
                            () => vscode.workspace.fs.createDirectory(this.settingsDirectoryUri),
                        );
                        await this.runSessionIO(
                            generation,
                            () => vscode.workspace.fs.writeFile(temporaryUri, serialized),
                        );
                        await this.runSessionIO(
                            generation,
                            () => vscode.workspace.fs.rename(
                                temporaryUri,
                                this.syncManifestUri,
                                {overwrite: true},
                            ),
                        );
                        this.requireSyncSession(generation);
                    } catch (error) {
                        await Promise.resolve(vscode.workspace.fs.delete(temporaryUri)).catch(() => undefined);
                        throw error;
                    }

                    if (revision===this.syncManifestRevision) {
                        this.syncManifestDirty = false;
                        return;
                    }
                }
            });
        this.syncManifestPersistQueue = publish;
        return publish;
    }

    private async captureLocalUriRevision(
        uri: vscode.Uri,
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<PathRevision> {
        this.requireSyncSession(generation);
        const revision = await this.captureLocalUriRevisionUnfenced(uri, relPath);
        this.requireSyncSession(generation);
        return revision;
    }

    private async captureLocalUriRevisionUnfenced(
        uri: vscode.Uri,
        relPath: string,
    ): Promise<PathRevision> {
        let stat: vscode.FileStat;
        try {
            stat = await this.statConfinedLocalUri(
                uri,
                `revision capture of ${relPath}`,
            );
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return {kind: 'missing', revision: DELETE_DIGEST};
            }
            throw error;
        }

        if (LocalReplicaSCMProvider.isSyncStatType(stat, vscode.FileType.File, false)) {
            const content = await this.readConfinedLocalFile(relPath, uri);
            return {
                kind: 'file',
                revision: contentDigest(content),
                content,
            };
        }
        if (stat.type===vscode.FileType.Directory) {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            const revisions: string[] = [];
            for (const [name] of entries.sort(([left], [right]) => left.localeCompare(right))) {
                const childRelPath = this.requireConfinedRelPath(
                    `${relPath.replace(/\/+$/, '')}/${name}`,
                    'local path revision',
                );
                const child = await this.captureLocalUriRevisionUnfenced(
                    vscode.Uri.joinPath(uri, name),
                    childRelPath,
                );
                revisions.push(`${name}\0${child.kind}\0${child.revision}`);
            }
            return {
                kind: 'directory',
                revision: `directory:${contentDigest(Buffer.from(revisions.join('\n')))}`,
            };
        }
        return {
            kind: 'other',
            revision: `other:${stat.type}:${stat.size}:${normalizeMtimeMs(stat.mtime)}`,
        };
    }

    private captureLocalPathRevision(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<PathRevision> {
        return this.captureLocalUriRevision(this.localUri(relPath), relPath, generation);
    }

    private async readLocalFileInSession(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<Uint8Array | undefined> {
        this.requireSyncSession(generation);
        try {
            const content = await this.runSessionIO(
                generation,
                () => this.readConfinedLocalFile(relPath),
            );
            this.requireSyncSession(generation);
            return content;
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                this.requireSyncSession(generation);
                return undefined;
            }
            throw error;
        }
    }

    private async captureRemoteUriRevision(
        uri: vscode.Uri,
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<PathRevision> {
        this.requireSyncSession(generation);
        let stat: vscode.FileStat;
        try {
            stat = await vscode.workspace.fs.stat(uri);
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return {kind: 'missing', revision: DELETE_DIGEST};
            }
            throw error;
        }
        this.requireSyncSession(generation);

        if (LocalReplicaSCMProvider.isSyncStatType(stat, vscode.FileType.File, true)) {
            const content = await this.pullRemoteFile(relPath, uri, generation);
            return {
                kind: 'file',
                revision: contentDigest(content),
                content,
            };
        }
        if (stat.type===vscode.FileType.Directory) {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            this.requireSyncSession(generation);
            const revisions: string[] = [];
            for (const [name] of entries.sort(([left], [right]) => left.localeCompare(right))) {
                const childRelPath = this.requireConfinedRelPath(
                    `${relPath.replace(/\/+$/, '')}/${name}`,
                    'remote path revision',
                );
                const child = await this.captureRemoteUriRevision(
                    vscode.Uri.joinPath(uri, name),
                    childRelPath,
                    generation,
                );
                revisions.push(`${name}\0${child.kind}\0${child.revision}`);
            }
            return {
                kind: 'directory',
                revision: `directory:${contentDigest(Buffer.from(revisions.join('\n')))}`,
            };
        }
        return {
            kind: 'other',
            revision: `other:${stat.type}:${stat.size}:${normalizeMtimeMs(stat.mtime)}`,
        };
    }

    private captureRemotePathRevision(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<PathRevision> {
        return this.captureRemoteUriRevision(
            this.vfs.pathToUri(relPath),
            relPath,
            generation,
        );
    }

    private remoteDeleteOperationId(
        relPath: string,
        expectedRevision: string,
        expectedFolderId?: string,
    ): string {
        // Keep the v0.16.1 file-delete seed byte-for-byte stable. Existing
        // crash journals name their remote stage from it, so adding folder
        // identity must be a distinct seed rather than an empty third field.
        const seed = expectedFolderId===undefined
            ? `${relPath}\0${expectedRevision}`
            : `${relPath}\0${expectedRevision}\0${expectedFolderId}`;
        return contentDigest(Buffer.from(seed)).slice(0, 24);
    }

    private remoteDeleteStagingPath(
        relPath: string,
        expectedRevision: string,
        expectedFolderId?: string,
    ): string {
        const parentPath = nodePath.posix.dirname(relPath);
        const operationId = this.remoteDeleteOperationId(
            relPath,
            expectedRevision,
            expectedFolderId,
        );
        const stageName = `.sr-overleaf-delete-${operationId}`;
        return parentPath==='/' ? `/${stageName}` : `${parentPath}/${stageName}`;
    }

    private remoteReplacementOperationId(
        relPath: string,
        expectedRevision: string,
        replacementRevision: string,
    ): string {
        return contentDigest(
            Buffer.from(`${relPath}\0${expectedRevision}\0${replacementRevision}`),
        ).slice(0, 24);
    }

    private remoteReplacementStagingPath(
        relPath: string,
        expectedRevision: string,
        replacementRevision: string,
    ): string {
        const parentPath = nodePath.posix.dirname(relPath);
        const operationId = this.remoteReplacementOperationId(
            relPath,
            expectedRevision,
            replacementRevision,
        );
        const stageName = `.sr-overleaf-replace-${operationId}`;
        return parentPath==='/' ? `/${stageName}` : `${parentPath}/${stageName}`;
    }

    private async refreshRemoteStateForReconciliation(
        relPath: string,
        generation: number,
        reason: string,
    ): Promise<void> {
        this.requireSyncSession(generation);
        await this.runSessionIO(
            generation,
            () => this.vfs.reconnect(`${reason}: ${relPath}`),
        );
        this.requireSyncSession(generation);
    }

    private renameRemotePathForDelete(
        targetUri: vscode.Uri,
        stagingUri: vscode.Uri,
        generation: number,
    ): Promise<void> {
        return this.runSessionIO(
            generation,
            () => vscode.workspace.fs.rename(
                targetUri,
                stagingUri,
                {overwrite: false},
            ),
        );
    }

    private async remotePathExists(
        uri: vscode.Uri,
        generation: number,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        try {
            await vscode.workspace.fs.stat(uri);
            this.requireSyncSession(generation);
            return true;
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                this.requireSyncSession(generation);
                return false;
            }
            throw error;
        }
    }

    private async restoreRemoteStagingPath(
        stagingUri: vscode.Uri,
        targetUri: vscode.Uri,
        relPath: string,
        generation: number,
    ): Promise<boolean> {
        if (await this.remotePathExists(targetUri, generation)) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [remote concurrent bytes preserved] ${relPath}: ` +
                `recovery=${stagingUri.toString()}`,
            );
            return false;
        }
        try {
            await this.runSessionIO(
                generation,
                () => vscode.workspace.fs.rename(
                    stagingUri,
                    targetUri,
                    {overwrite: false},
                ),
            );
            this.requireSyncSession(generation);
            return true;
        } catch (error) {
            try {
                await this.refreshRemoteStateForReconciliation(
                    relPath,
                    generation,
                    'reconcile ambiguous remote staging restore',
                );
                const stagingExists = await this.remotePathExists(stagingUri, generation);
                const targetExists = await this.remotePathExists(targetUri, generation);
                if (!stagingExists && targetExists) {
                    return true;
                }
            } catch {
                // Keep the original rename error when the reconciliation read
                // is unavailable too.
            }
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [remote staging restore failed] ${relPath}: ` +
                `${formatUnknownError(error)}; recovery=${stagingUri.toString()}`,
            );
            return false;
        }
    }

    private async assertRemoteFolderDeletePath(
        uri: vscode.Uri,
        relPath: string,
        expectedRevision: string,
        expectedEntity: SyncManifestRemoteFolderIdentity,
        expectedParent: SyncManifestRemoteFolderIdentity,
        label: string,
        generation = this.syncGeneration,
    ): Promise<PathRevision> {
        const state = await this.captureRemoteUriRevision(uri, relPath, generation);
        this.requireSyncSession(generation);
        if (state.kind==='missing') {
            return state;
        }
        if (state.kind!=='directory' || state.revision!==expectedRevision) {
            throw new ConcurrentReplicaChangeError(
                `Overleaf ${label} no longer has the expected folder tree revision`,
            );
        }
        const identity = await this.resolveRemoteFolderPathIdentity(uri);
        this.requireSyncSession(generation);
        if (!this.remoteFolderPathIdentityMatches(
            identity,
            expectedEntity,
            expectedParent,
        )) {
            throw new ConcurrentReplicaChangeError(
                `Overleaf ${label} no longer has the expected folder identity`,
            );
        }
        return state;
    }

    private async verifyRemoteFolderDeletePostcondition(
        relPath: string,
        record: SyncManifestPendingDirectoryDeleteOperation,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        await this.refreshRemoteStateForReconciliation(
            relPath,
            generation,
            'verify guarded remote folder delete',
        );
        const [target, staging] = await Promise.all([
            this.captureRemotePathRevision(relPath, generation),
            this.captureRemoteUriRevision(
                this.vfs.pathToUri(record.stagingRelPath),
                record.stagingRelPath,
                generation,
            ),
        ]);
        this.requireSyncSession(generation);
        return target.kind==='missing'
            && staging.kind==='missing'
            && this.vfs._resolveById(record.targetEntity.id)===undefined;
    }

    private async restoreRemoteFolderDeleteStage(
        relPath: string,
        record: SyncManifestPendingDirectoryDeleteOperation,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        const targetUri = this.vfs.pathToUri(relPath);
        const stagingUri = this.vfs.pathToUri(record.stagingRelPath);
        const target = await this.captureRemotePathRevision(relPath, generation);
        if (target.kind!=='missing') {
            return false;
        }
        const staging = await this.assertRemoteFolderDeletePath(
            stagingUri,
            record.stagingRelPath,
            record.remoteRevision,
            record.targetEntity,
            record.parentEntity,
            'folder delete recovery stage',
            generation,
        );
        if (staging.kind==='missing') {
            return false;
        }
        try {
            await this.runSessionIO(
                generation,
                () => this.vfs.rename(
                    stagingUri,
                    targetUri,
                    false,
                    {
                        id: record.targetEntity.id,
                        type: 'folder',
                        parentId: record.parentEntity.id,
                    },
                ),
            );
        } catch (error) {
            await this.refreshRemoteStateForReconciliation(
                relPath,
                generation,
                'reconcile guarded remote folder stage restore',
            );
            const restored = await this.assertRemoteFolderDeletePath(
                targetUri,
                relPath,
                record.remoteRevision,
                record.targetEntity,
                record.parentEntity,
                'restored folder delete target',
                generation,
            );
            if (restored.kind!=='missing') {
                return true;
            }
            throw error;
        }
        await this.refreshRemoteStateForReconciliation(
            relPath,
            generation,
            'verify guarded remote folder stage restore',
        );
        const restored = await this.assertRemoteFolderDeletePath(
            targetUri,
            relPath,
            record.remoteRevision,
            record.targetEntity,
            record.parentEntity,
            'restored folder delete target',
            generation,
        );
        return restored.kind!=='missing';
    }

    // This deliberately does not reuse the generic file delete helper. Folder
    // names and recursive digests are not identities: a collaborator can
    // recreate the same tree under the same name with a different folder ID.
    // Every reversible stage and the final DELETE therefore carry and verify
    // the exact folder/parent identity recorded in the durable rmdir journal.
    private async atomicDeleteRemoteFolderIfIdentity(
        relPath: string,
        record: SyncManifestPendingDirectoryDeleteOperation,
        generation = this.syncGeneration,
        confirmLocalStillAbsent?: () => Promise<boolean>,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const targetUri = this.vfs.pathToUri(relPath);
        const stagingUri = this.vfs.pathToUri(record.stagingRelPath);
        const guard: RemoteFolderDeleteGuard = {
            entity: {...record.targetEntity},
            parent: {...record.parentEntity},
            pendingOperationId: record.id,
        };
        const inspectTarget = () => this.assertRemoteFolderDeletePath(
            targetUri,
            relPath,
            record.remoteRevision,
            record.targetEntity,
            record.parentEntity,
            'folder delete target',
            generation,
        );
        const inspectStage = () => this.assertRemoteFolderDeletePath(
            stagingUri,
            record.stagingRelPath,
            record.remoteRevision,
            record.targetEntity,
            record.parentEntity,
            'folder delete stage',
            generation,
        );
        let [target, staged] = await Promise.all([inspectTarget(), inspectStage()]);
        this.requireSyncSession(generation);

        if (target.kind==='missing' && staged.kind==='missing') {
            if (await this.verifyRemoteFolderDeletePostcondition(relPath, record, generation)) {
                await this.removeRemoteDeleteOperationRecord(record.stageOperationId);
                return true;
            }
            throw new ConcurrentReplicaChangeError(
                'Overleaf moved or recreated the folder while its local delete was pending',
            );
        }

        await this.createRemoteDeleteOperationRecord({
            version: 1,
            id: record.stageOperationId,
            relPath,
            stagingRelPath: record.stagingRelPath,
            expectedRevision: record.remoteRevision,
            folderGuard: guard,
            createdAt: new Date().toISOString(),
        });

        if (staged.kind!=='missing') {
            if (target.kind!=='missing') {
                // Never discard the old staged entity merely because another
                // actor now occupies the original name. Both copies remain
                // recoverable and the caller raises a conflict.
                throw new ConcurrentReplicaChangeError(
                    'Overleaf recreated the folder while its prior entity was staged for delete',
                );
            }
        } else {
            if (target.kind==='missing') {
                throw new ConcurrentReplicaChangeError(
                    'Overleaf folder disappeared before it could be staged for delete',
                );
            }
            try {
                await this.runSessionIO(
                    generation,
                    () => this.vfs.rename(
                        targetUri,
                        stagingUri,
                        false,
                        {
                            id: record.targetEntity.id,
                            type: 'folder',
                            parentId: record.parentEntity.id,
                        },
                    ),
                );
            } catch (error) {
                await this.refreshRemoteStateForReconciliation(
                    relPath,
                    generation,
                    'reconcile ambiguous guarded remote folder stage',
                );
                [target, staged] = await Promise.all([inspectTarget(), inspectStage()]);
                this.requireSyncSession(generation);
                if (!(target.kind==='missing' && staged.kind==='directory')) {
                    throw error;
                }
                // The rename POST may have succeeded even though its response
                // was lost; the exact ID at the stage is the only acceptance
                // proof, not a same-name/digest observation.
            }
        }

        [target, staged] = await Promise.all([inspectTarget(), inspectStage()]);
        this.requireSyncSession(generation);
        if (staged.kind==='missing') {
            if (target.kind==='missing'
                && await this.verifyRemoteFolderDeletePostcondition(relPath, record, generation)
            ) {
                await this.removeRemoteDeleteOperationRecord(record.stageOperationId);
                return true;
            }
            throw new ConcurrentReplicaChangeError(
                'The guarded Overleaf folder stage disappeared before final deletion',
            );
        }
        if (target.kind!=='missing') {
            throw new ConcurrentReplicaChangeError(
                'Overleaf recreated the folder before its staged entity could be deleted',
            );
        }

        if (
            confirmLocalStillAbsent!==undefined
            && !await confirmLocalStillAbsent()
        ) {
            const restored = await this.restoreRemoteFolderDeleteStage(
                relPath,
                record,
                generation,
            );
            if (restored) {
                await this.removeRemoteDeleteOperationRecord(record.stageOperationId);
            }
            throw new LocalReadUnstableError(
                relPath,
                'vanished-during-update',
                'Local Replica folder delete was cancelled because the local tree or a child intent reappeared: ' +
                    relPath,
            );
        }

        // The last read and local-intent check were asynchronous. Re-prove both
        // remote paths immediately before the irreversible ID-scoped DELETE.
        [target, staged] = await Promise.all([inspectTarget(), inspectStage()]);
        this.requireSyncSession(generation);
        if (target.kind!=='missing' || staged.kind==='missing') {
            throw new ConcurrentReplicaChangeError(
                'Overleaf changed the guarded folder delete paths immediately before final deletion',
            );
        }

        try {
            await this.runSessionIO(
                generation,
                () => this.vfs.remove(
                    stagingUri,
                    true,
                    {
                        id: record.targetEntity.id,
                        type: 'folder',
                        parentId: record.parentEntity.id,
                    },
                ),
            );
        } catch (error) {
            if (await this.verifyRemoteFolderDeletePostcondition(relPath, record, generation)) {
                await this.removeRemoteDeleteOperationRecord(record.stageOperationId);
                return true;
            }
            try {
                const restored = await this.restoreRemoteFolderDeleteStage(
                    relPath,
                    record,
                    generation,
                );
                if (restored) {
                    await this.removeRemoteDeleteOperationRecord(record.stageOperationId);
                }
            } catch {
                // The external journal deliberately remains when restoration
                // itself cannot be proven; restart recovery will inspect it.
            }
            throw error;
        }

        if (!await this.verifyRemoteFolderDeletePostcondition(relPath, record, generation)) {
            throw new ConcurrentReplicaChangeError(
                'Overleaf did not prove the guarded folder entity was deleted',
            );
        }
        await this.removeRemoteDeleteOperationRecord(record.stageOperationId);
        return true;
    }

    // `confirmLocalStillAbsent` is consulted at the one moment that matters: after
    // the Overleaf entity has been staged aside but before it is destroyed.
    private async atomicDeleteRemotePathIfRevision(
        relPath: string,
        expectedRevision: string,
        generation = this.syncGeneration,
        confirmLocalStillAbsent?: () => Promise<boolean>,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const targetUri = this.vfs.pathToUri(relPath);
        const operationId = this.remoteDeleteOperationId(relPath, expectedRevision);
        const stagingRelPath = this.remoteDeleteStagingPath(relPath, expectedRevision);
        const stagingUri = this.vfs.pathToUri(stagingRelPath);
        let staged = await this.captureRemoteUriRevision(stagingUri, relPath, generation);
        let target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
        let remoteWasStaged = staged.kind!=='missing';
        await this.createRemoteDeleteOperationRecord({
            version: 1,
            id: operationId,
            relPath,
            stagingRelPath,
            expectedRevision,
            createdAt: new Date().toISOString(),
        });

        const deleteExpectedStaging = async () => {
            try {
                await this.runSessionIO(
                    generation,
                    () => vscode.workspace.fs.delete(stagingUri, {recursive: true}),
                );
            } catch (error) {
                await this.refreshRemoteStateForReconciliation(
                    relPath,
                    generation,
                    'reconcile ambiguous remote staging delete',
                );
                const afterDelete = await this.captureRemoteUriRevision(
                    stagingUri,
                    relPath,
                    generation,
                );
                if (afterDelete.kind==='missing') {
                    return;
                }
                throw error;
            }
        };

        const restoreChangedStaging = async (
            reason: string,
            makeError: (message: string) => Error = message => new ConcurrentReplicaChangeError(message),
        ) => {
            const restored = await this.restoreRemoteStagingPath(
                stagingUri,
                targetUri,
                relPath,
                generation,
            );
            if (!restored) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [remote staging retained] ${relPath}: ` +
                    `${reason}; recovery=${stagingUri.toString()}`,
                );
            } else {
                await this.removeRemoteDeleteOperationRecord(operationId);
            }
            throw makeError(reason);
        };

        try {
            if (staged.kind!=='missing') {
                if (staged.revision!==expectedRevision) {
                    if (target.kind==='missing') {
                        await restoreChangedStaging(
                            `Overleaf changed ${relPath} while its prior delete was being resumed`,
                        );
                    }
                    throw new ConcurrentReplicaChangeError(
                        `A retained remote delete stage for ${relPath} no longer matches its expected revision`,
                    );
                }
                if (target.kind!=='missing') {
                    await deleteExpectedStaging();
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    throw new ConcurrentReplicaChangeError(
                        `Overleaf recreated ${relPath} while its prior entity was being deleted`,
                    );
                }
            } else {
                if (target.kind==='missing') {
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    return true;
                }
                if (target.revision!==expectedRevision) {
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    throw new ConcurrentReplicaChangeError(
                        `Overleaf changed ${relPath} before it could be staged for delete`,
                    );
                }

                try {
                    await this.renameRemotePathForDelete(targetUri, stagingUri, generation);
                    remoteWasStaged = true;
                } catch (error) {
                    await this.refreshRemoteStateForReconciliation(
                        relPath,
                        generation,
                        'reconcile ambiguous remote delete rename',
                    );
                    staged = await this.captureRemoteUriRevision(stagingUri, relPath, generation);
                    target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
                    if (staged.kind==='missing' && target.kind==='missing') {
                        await this.removeRemoteDeleteOperationRecord(operationId);
                        return true;
                    }
                    if (
                        staged.revision===expectedRevision
                        && target.kind==='missing'
                    ) {
                        remoteWasStaged = true;
                        // The rename was applied but its response was lost.
                    } else if (staged.kind!=='missing' && target.kind==='missing') {
                        await restoreChangedStaging(
                            `Overleaf changed ${relPath} during an ambiguous remote rename`,
                        );
                    } else {
                        throw error;
                    }
                }
            }

            staged = await this.captureRemoteUriRevision(stagingUri, relPath, generation);
            target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
            if (staged.kind==='missing') {
                if (target.kind==='missing') {
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    return true;
                }
                await this.removeRemoteDeleteOperationRecord(operationId);
                throw new ConcurrentReplicaChangeError(
                    `Overleaf recreated ${relPath} after its staged entity disappeared`,
                );
            }
            if (staged.revision!==expectedRevision) {
                if (target.kind==='missing') {
                    await restoreChangedStaging(
                        `Overleaf changed ${relPath} during atomic delete`,
                    );
                }
                throw new ConcurrentReplicaChangeError(
                    `Overleaf changed the retained delete stage for ${relPath}`,
                );
            }
            if (target.kind!=='missing') {
                await deleteExpectedStaging();
                await this.removeRemoteDeleteOperationRecord(operationId);
                throw new ConcurrentReplicaChangeError(
                    `Overleaf recreated ${relPath} while its prior entity was being deleted`,
                );
            }

            const deleteRevision = await this.captureRemoteUriRevision(
                stagingUri,
                relPath,
                generation,
            );
            target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
            if (deleteRevision.revision!==expectedRevision) {
                if (target.kind==='missing' && deleteRevision.kind!=='missing') {
                    await restoreChangedStaging(
                        `Overleaf changed ${relPath} immediately before its staged delete`,
                    );
                }
                throw new ConcurrentReplicaChangeError(
                    `Overleaf changed the final delete stage for ${relPath}`,
                );
            }
            if (target.kind!=='missing') {
                await deleteExpectedStaging();
                await this.removeRemoteDeleteOperationRecord(operationId);
                throw new ConcurrentReplicaChangeError(
                    `Overleaf recreated ${relPath} immediately before its staged delete`,
                );
            }

            // The last reversible instant. Up to here the target has only been
            // RENAMED aside, so Overleaf still holds the same entity — its id,
            // history, comments and links are intact and a rename back restores
            // all of it. Once the staged copy is destroyed that identity is gone
            // for good, and re-uploading the bytes later creates a NEW entity
            // rather than bringing the old one back. The local absence that
            // authorized this delete was last observed several network round
            // trips ago, so it is confirmed once more here; a path that has
            // returned in the meantime un-stages the entity and defers instead.
            //
            // Residue, stated at its true size: this narrows the window, it does
            // not close it. deleteExpectedStaging() below is an awaited REMOTE
            // round trip, so a replacement landing while that call is in flight
            // still loses the entity — a network-latency window of tens to
            // hundreds of milliseconds, not microseconds. Closing it would need a
            // server-side conditional delete ("delete this entity only if the
            // client still asserts X"), which the VFS does not offer; nothing
            // achievable on this side of the wire removes it.
            if (confirmLocalStillAbsent!==undefined && !await confirmLocalStillAbsent()) {
                await restoreChangedStaging(
                    `the local path for ${relPath} reappeared before its Overleaf entity was destroyed`,
                    message => new LocalReadUnstableError(
                        relPath,
                        'vanished-during-update',
                        message,
                    ),
                );
            }
            await deleteExpectedStaging();
            await this.refreshRemoteStateForReconciliation(
                relPath,
                generation,
                'verify completed remote delete',
            );
            target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
            if (target.kind!=='missing') {
                await this.removeRemoteDeleteOperationRecord(operationId);
                throw new ConcurrentReplicaChangeError(
                    `Overleaf recreated ${relPath} while its staged entity was being deleted`,
                );
            }
            await this.removeRemoteDeleteOperationRecord(operationId);
            return true;
        } catch (error) {
            if (
                error instanceof ConcurrentReplicaChangeError
                || LocalReplicaSCMProvider.isLocalReadUnstable(error)
            ) {
                throw error;
            }
            try {
                await this.refreshRemoteStateForReconciliation(
                    relPath,
                    generation,
                    'recover failed remote delete',
                );
                staged = await this.captureRemoteUriRevision(stagingUri, relPath, generation);
                target = await this.captureRemoteUriRevision(targetUri, relPath, generation);
                if (staged.kind==='missing') {
                    if (target.kind==='missing') {
                        await this.removeRemoteDeleteOperationRecord(operationId);
                        return true;
                    }
                    if (remoteWasStaged) {
                        await this.removeRemoteDeleteOperationRecord(operationId);
                        throw new ConcurrentReplicaChangeError(
                            `Overleaf recreated ${relPath} after an ambiguous staged delete`,
                        );
                    }
                    throw error;
                }
                if (staged.revision!==expectedRevision) {
                    if (target.kind==='missing') {
                        await restoreChangedStaging(
                            `Overleaf changed ${relPath} while a failed delete was being recovered`,
                        );
                    }
                    throw new ConcurrentReplicaChangeError(
                        `Could not safely recover the changed remote delete stage for ${relPath}`,
                    );
                }
                if (target.kind==='missing') {
                    const restored = await this.restoreRemoteStagingPath(
                        stagingUri,
                        targetUri,
                        relPath,
                        generation,
                    );
                    if (!restored) {
                        throw new ConcurrentReplicaChangeError(
                            `Could not safely restore ${relPath} after a failed remote delete`,
                        );
                    }
                    await this.removeRemoteDeleteOperationRecord(operationId);
                } else {
                    await deleteExpectedStaging();
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    throw new ConcurrentReplicaChangeError(
                        `Overleaf recreated ${relPath} while a failed staged delete was being recovered`,
                    );
                }
            } catch (recoveryError) {
                if (recoveryError===error) {
                    throw error;
                }
                throw recoveryError;
            }
            throw error;
        }
    }

    private async removeRemoteReplacementStage(
        stagingUri: vscode.Uri,
        relPath: string,
        generation: number,
    ): Promise<boolean> {
        try {
            await this.runSessionIO(
                generation,
                () => vscode.workspace.fs.delete(stagingUri, {recursive: true}),
            );
            return true;
        } catch (error) {
            try {
                await this.refreshRemoteStateForReconciliation(
                    relPath,
                    generation,
                    'verify remote replacement stage cleanup',
                );
                if (!await this.remotePathExists(stagingUri, generation)) {
                    return true;
                }
            } catch {
                // Retain the durable journal when cleanup cannot be verified.
            }
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [remote replacement stage retained] ${relPath}: ` +
                `${formatUnknownError(error)}; recovery=${stagingUri.toString()}`,
            );
            return false;
        }
    }

    private async guardedReplaceRemoteBinary(
        relPath: string,
        targetUri: vscode.Uri,
        replacementContent: Uint8Array,
        remoteBaseline: Uint8Array,
        generation = this.syncGeneration,
    ): Promise<Uint8Array> {
        this.requireSyncSession(generation);
        const expectedRevision = contentDigest(remoteBaseline);
        const replacementRevision = contentDigest(replacementContent);
        const operationId = this.remoteReplacementOperationId(
            relPath,
            expectedRevision,
            replacementRevision,
        );
        const stagingRelPath = this.remoteReplacementStagingPath(
            relPath,
            expectedRevision,
            replacementRevision,
        );
        const stagingUri = this.vfs.pathToUri(stagingRelPath);
        await this.createRemoteDeleteOperationRecord({
            version: 1,
            id: operationId,
            kind: 'replace',
            relPath,
            stagingRelPath,
            expectedRevision,
            replacementRevision,
            createdAt: new Date().toISOString(),
        });

        const completedRecord: RemoteDeleteOperationRecord = {
            version: 1,
            id: operationId,
            kind: 'replace',
            relPath,
            stagingRelPath,
            expectedRevision,
            replacementRevision,
            createdAt: new Date().toISOString(),
        };
        const removeCompletedJournal = async () => {
            const removed = await this.removeRemoteReplacementStage(
                stagingUri,
                relPath,
                generation,
            );
            if (removed) {
                const verifiedTarget = await this.captureRemoteUriRevision(
                    targetUri,
                    relPath,
                    generation,
                );
                if (verifiedTarget.revision!==replacementRevision) {
                    throw new RemoteDocumentMergeConflictError(
                        `Overleaf changed ${relPath} while its completed binary replacement was finalized`,
                    );
                }
                await this.retireSupersededRemoteReplacements(
                    completedRecord,
                    generation,
                );
                await this.removeRemoteDeleteOperationRecord(operationId);
            }
        };

        try {
            let staged = await this.captureRemoteUriRevision(
                stagingUri,
                relPath,
                generation,
            );
            let target = await this.captureRemoteUriRevision(
                targetUri,
                relPath,
                generation,
            );

            if (staged.kind==='missing') {
                if (target.revision===replacementRevision) {
                    await this.retireSupersededRemoteReplacements(
                        completedRecord,
                        generation,
                    );
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    return replacementContent;
                }
                if (target.revision!==expectedRevision) {
                    if (target.kind==='missing') {
                        throw new ConcurrentReplicaChangeError(
                            `Overleaf removed ${relPath} before its binary replacement was staged`,
                        );
                    }
                    throw new RemoteDocumentMergeConflictError(
                        `Overleaf changed ${relPath} before its binary replacement was staged`,
                    );
                }
                await this.renameRemotePathForDelete(targetUri, stagingUri, generation);
                staged = await this.captureRemoteUriRevision(
                    stagingUri,
                    relPath,
                    generation,
                );
                target = await this.captureRemoteUriRevision(
                    targetUri,
                    relPath,
                    generation,
                );
            }

            if (staged.revision!==expectedRevision) {
                if (target.kind==='missing') {
                    const restored = await this.restoreRemoteStagingPath(
                        stagingUri,
                        targetUri,
                        relPath,
                        generation,
                    );
                    if (restored) {
                        await this.removeRemoteDeleteOperationRecord(operationId);
                    }
                }
                throw new ConcurrentReplicaChangeError(
                    `The retained Overleaf replacement stage for ${relPath} changed`,
                );
            }
            if (target.kind!=='missing') {
                if (target.revision===replacementRevision) {
                    await removeCompletedJournal();
                    return replacementContent;
                }
                throw new RemoteDocumentMergeConflictError(
                    `Overleaf recreated ${relPath} while its binary replacement was staged`,
                );
            }

            const pushedContent = await this.pushWithRetry(
                relPath,
                targetUri,
                replacementContent,
                generation,
                undefined,
                true,
            );
            target = await this.captureRemoteUriRevision(
                targetUri,
                relPath,
                generation,
            );
            if (target.revision!==contentDigest(pushedContent)) {
                throw new RemoteDocumentWriteAmbiguousError(
                    `Overleaf could not verify the completed binary replacement for ${relPath}`,
                );
            }
            await removeCompletedJournal();
            return pushedContent;
        } catch (error) {
            try {
                await this.refreshRemoteStateForReconciliation(
                    relPath,
                    generation,
                    'recover failed remote binary replacement',
                );
                const staged = await this.captureRemoteUriRevision(
                    stagingUri,
                    relPath,
                    generation,
                );
                const target = await this.captureRemoteUriRevision(
                    targetUri,
                    relPath,
                    generation,
                );

                if (target.revision===replacementRevision) {
                    if (staged.kind!=='missing') {
                        await removeCompletedJournal();
                    } else {
                        await this.retireSupersededRemoteReplacements(
                            completedRecord,
                            generation,
                        );
                        await this.removeRemoteDeleteOperationRecord(operationId);
                    }
                    return replacementContent;
                }
                if (
                    target.kind==='missing'
                    && staged.revision===expectedRevision
                ) {
                    const restored = await this.restoreRemoteStagingPath(
                        stagingUri,
                        targetUri,
                        relPath,
                        generation,
                    );
                    if (restored) {
                        await this.removeRemoteDeleteOperationRecord(operationId);
                    }
                    throw error;
                }
                if (
                    target.kind==='missing'
                    && staged.kind!=='missing'
                    && staged.revision!==expectedRevision
                ) {
                    const restored = await this.restoreRemoteStagingPath(
                        stagingUri,
                        targetUri,
                        relPath,
                        generation,
                    );
                    if (restored) {
                        await this.removeRemoteDeleteOperationRecord(operationId);
                    }
                    throw new ConcurrentReplicaChangeError(
                        `Overleaf changed ${relPath} while its binary replacement was being recovered`,
                    );
                }
                if (
                    staged.kind==='missing'
                    && target.revision===expectedRevision
                ) {
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    throw error;
                }
                if (
                    staged.revision===expectedRevision
                    && target.kind!=='missing'
                ) {
                    throw new RemoteDocumentMergeConflictError(
                        `Overleaf changed ${relPath} while its binary replacement was in progress; ` +
                        `the prior remote bytes remain staged at ${stagingRelPath}`,
                    );
                }
                if (staged.kind==='missing' && target.kind!=='missing') {
                    await this.removeRemoteDeleteOperationRecord(operationId);
                    throw new RemoteDocumentMergeConflictError(
                        `Overleaf changed ${relPath} while its binary replacement was being recovered`,
                    );
                }
            } catch (recoveryError) {
                if (recoveryError!==error) {
                    throw recoveryError;
                }
            }
            throw error;
        }
    }

    private async retireSupersededRemoteReplacements(
        completedRecord: RemoteDeleteOperationRecord,
        generation: number,
    ): Promise<void> {
        const records = await this.listRemoteDeleteOperationRecords();
        for (const record of records) {
            if (
                record.kind!=='replace'
                || record.relPath!==completedRecord.relPath
                || record.id===completedRecord.id
            ) {
                continue;
            }
            const supersededRecord = record.supersededByRevision===completedRecord.replacementRevision
                ? record
                : {
                    ...record,
                    supersededByRevision: completedRecord.replacementRevision,
                };
            if (supersededRecord!==record) {
                await this.updateRemoteDeleteOperationRecord(supersededRecord);
            }
            const stagingUri = this.vfs.pathToUri(record.stagingRelPath);
            const staged = await this.captureRemoteUriRevision(
                stagingUri,
                completedRecord.relPath,
                generation,
            );
            if (
                staged.kind==='missing'
                || (
                    staged.revision===record.expectedRevision
                    && await this.removeRemoteReplacementStage(
                        stagingUri,
                        completedRecord.relPath,
                        generation,
                    )
                )
            ) {
                await this.removeRemoteDeleteOperationRecord(record.id);
            }
        }
    }

    private async recoverInterruptedRemoteReplacement(
        record: RemoteDeleteOperationRecord,
        generation: number,
    ): Promise<void> {
        const stagingUri = this.vfs.pathToUri(record.stagingRelPath);
        const targetUri = this.vfs.pathToUri(record.relPath);
        const staged = await this.captureRemoteUriRevision(
            stagingUri,
            record.relPath,
            generation,
        );
        const target = await this.captureRemoteUriRevision(
            targetUri,
            record.relPath,
            generation,
        );
        if (record.supersededByRevision!==undefined) {
            if (staged.kind==='missing') {
                await this.removeRemoteDeleteOperationRecord(record.id);
                return;
            }
            if (
                staged.revision===record.expectedRevision
                && await this.removeRemoteReplacementStage(
                    stagingUri,
                    record.relPath,
                    generation,
                )
            ) {
                await this.removeRemoteDeleteOperationRecord(record.id);
            } else {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [superseded replacement stage retained] ` +
                    `${record.relPath}: recovery=${stagingUri.toString()}`,
                );
            }
            return;
        }
        if (staged.kind==='missing' && target.kind!=='missing') {
            if (target.revision===record.replacementRevision) {
                await this.retireSupersededRemoteReplacements(record, generation);
            }
            await this.removeRemoteDeleteOperationRecord(record.id);
            return;
        }
        if (staged.kind==='missing' && target.kind==='missing') {
            throw new ConcurrentReplicaChangeError(
                `Both the target and recovery stage for ${record.relPath} are missing`,
            );
        }
        if (staged.revision!==record.expectedRevision) {
            if (target.kind==='missing') {
                const restored = await this.restoreRemoteStagingPath(
                    stagingUri,
                    targetUri,
                    record.relPath,
                    generation,
                );
                if (restored) {
                    await this.removeRemoteDeleteOperationRecord(record.id);
                }
            }
            throw new ConcurrentReplicaChangeError(
                `The interrupted replacement stage for ${record.relPath} changed`,
            );
        }
        if (target.kind==='missing') {
            const restored = await this.restoreRemoteStagingPath(
                stagingUri,
                targetUri,
                record.relPath,
                generation,
            );
            if (!restored) {
                throw new ConcurrentReplicaChangeError(
                    `Could not restore ${record.relPath} after an interrupted binary replacement`,
                );
            }
            await this.removeRemoteDeleteOperationRecord(record.id);
            return;
        }

        if (target.revision!==record.replacementRevision) {
            const localState = await this.captureLocalPathRevision(
                record.relPath,
                generation,
            );
            await this.markSyncConflict(
                record.relPath,
                'Overleaf changed the file while an interrupted binary replacement was recovered',
                localState.kind==='missing'
                    ? null
                    : (localState.kind==='file' ? localState.content : undefined),
                generation,
            );
            return;
        }

        const removed = await this.removeRemoteReplacementStage(
            stagingUri,
            record.relPath,
            generation,
        );
        if (!removed) {
            throw new ConcurrentReplicaChangeError(
                `Could not clean the interrupted replacement stage for ${record.relPath}`,
            );
        }
        const verifiedTarget = await this.captureRemoteUriRevision(
            targetUri,
            record.relPath,
            generation,
        );
        if (verifiedTarget.revision!==record.replacementRevision) {
            throw new ConcurrentReplicaChangeError(
                `Overleaf changed ${record.relPath} while replacement recovery was finalized`,
            );
        }
        await this.retireSupersededRemoteReplacements(record, generation);
        await this.removeRemoteDeleteOperationRecord(record.id);
    }

    private async markCompletedReplacementSupersessions(
        records: RemoteDeleteOperationRecord[],
        generation: number,
    ): Promise<RemoteDeleteOperationRecord[]> {
        const updatedRecords = [...records];
        const replacementPaths = [...new Set(
            records
                .filter(record => record.kind==='replace')
                .map(record => record.relPath),
        )];
        for (const relPath of replacementPaths) {
            this.requireSyncSession(generation);
            const target = await this.captureRemotePathRevision(relPath, generation);
            const completed = records
                .filter(record =>
                    record.kind==='replace'
                    && record.relPath===relPath
                    && record.supersededByRevision===undefined
                    && record.replacementRevision===target.revision
                )
                .sort((left, right) =>
                    Date.parse(right.createdAt)-Date.parse(left.createdAt)
                    || right.id.localeCompare(left.id)
                )[0];
            if (!completed) { continue; }

            for (let index = 0; index<updatedRecords.length; index++) {
                const record = updatedRecords[index];
                if (
                    record.kind!=='replace'
                    || record.relPath!==relPath
                    || record.id===completed.id
                    || record.supersededByRevision!==undefined
                ) {
                    continue;
                }
                const superseded = {
                    ...record,
                    supersededByRevision: target.revision,
                };
                await this.updateRemoteDeleteOperationRecord(superseded);
                updatedRecords[index] = superseded;
            }
        }
        return updatedRecords;
    }

    private async recoverInterruptedRemoteDeletes(
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        let records = await this.listRemoteDeleteOperationRecords();
        if (records.length===0) { return false; }
        await this.refreshRemoteStateForReconciliation(
            '/',
            generation,
            'recover interrupted remote deletes',
        );
        records = await this.markCompletedReplacementSupersessions(records, generation);
        for (const record of records) {
            this.requireSyncSession(generation);
            if (record.kind==='replace') {
                try {
                    await this.recoverInterruptedRemoteReplacement(record, generation);
                } catch (error) {
                    const localState = await this.captureLocalPathRevision(
                        record.relPath,
                        generation,
                    );
                    await this.markSyncConflict(
                        record.relPath,
                        `An interrupted remote replacement could not be resumed safely: ${formatUnknownError(error)}`,
                        localState.kind==='missing'
                            ? null
                            : (localState.kind==='file' ? localState.content : undefined),
                        generation,
                    );
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [remote replacement recovery blocked] ` +
                        `${record.relPath}: ${formatUnknownError(error)}`,
                    );
                }
                continue;
            }
            if (record.folderGuard!==undefined) {
                try {
                    const pending = this.syncManifest?.pendingOperations[record.relPath];
                    if (
                        !pending
                        || pending.kind!=='rmdir'
                        || pending.id!==record.folderGuard.pendingOperationId
                        || pending.stageOperationId!==record.id
                        || pending.stagingRelPath!==record.stagingRelPath
                        || !this.remoteFolderIdentityMatches(
                            pending.targetEntity,
                            record.folderGuard.entity,
                        )
                        || !this.remoteFolderIdentityMatches(
                            pending.parentEntity,
                            record.folderGuard.parent,
                        )
                    ) {
                        throw new ConcurrentReplicaChangeError(
                            'The durable folder-delete journals no longer describe the same entity.',
                        );
                    }
                    await this.atomicDeleteRemoteFolderIfIdentity(
                        record.relPath,
                        pending,
                        generation,
                        async () => {
                            const localState = await this.captureLocalPathRevision(
                                record.relPath,
                                generation,
                            );
                            return localState.kind==='missing'
                                && this.pendingOperationAtOrBelow(
                                    record.relPath,
                                    pending.id,
                                )===undefined;
                        },
                    );
                } catch (error) {
                    const localState = await this.captureLocalPathRevision(
                        record.relPath,
                        generation,
                    );
                    await this.markSyncConflict(
                        record.relPath,
                        `An interrupted guarded folder delete could not be resumed safely: ${formatUnknownError(error)}`,
                        localState.kind==='missing'
                            ? null
                            : (localState.kind==='file' ? localState.content : undefined),
                        generation,
                    );
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [guarded folder delete recovery blocked] ` +
                        `${record.relPath}: ${formatUnknownError(error)}`,
                    );
                }
                continue;
            }
            const staging = await this.captureRemotePathRevision(
                record.stagingRelPath,
                generation,
            );
            if (staging.kind==='missing') {
                await this.removeRemoteDeleteOperationRecord(record.id);
                continue;
            }
            try {
                await this.atomicDeleteRemotePathIfRevision(
                    record.relPath,
                    record.expectedRevision,
                    generation,
                );
            } catch (error) {
                const localState = await this.captureLocalPathRevision(
                    record.relPath,
                    generation,
                );
                await this.markSyncConflict(
                    record.relPath,
                    `An interrupted remote delete could not be resumed safely: ${formatUnknownError(error)}`,
                    localState.kind==='missing'
                        ? null
                        : (localState.kind==='file' ? localState.content : undefined),
                    generation,
                );
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [remote delete recovery blocked] ${record.relPath}: ` +
                    formatUnknownError(error),
                );
            }
        }
        return true;
    }

    private isNodeErrorCode(error: unknown, code: string): boolean {
        return !!error
            && typeof error==='object'
            && 'code' in error
            && (error as {code?: string}).code===code;
    }

    private stagingToken(relPath: string): string {
        return `${contentDigest(Buffer.from(relPath)).slice(0, 10)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    }

    private async preserveConcurrentStagingPath(
        stagingPath: string,
        relPath: string,
        reason: string,
    ): Promise<string> {
        const recoveryDirectory = nodePath.join(
            this.settingsDirectoryUri.fsPath,
            'concurrent-recovery',
        );
        await nodeFs.mkdir(recoveryDirectory, {recursive: true});
        const recoveryPath = nodePath.join(
            recoveryDirectory,
            `${this.stagingToken(relPath)}-${nodePath.basename(relPath) || 'root'}`,
        );
        await this.renameDurably(stagingPath, recoveryPath);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [concurrent bytes preserved] ${relPath}: ` +
            `${reason}; recovery=${recoveryPath}`,
        );
        return recoveryPath;
    }

    private linkStagedFileWithoutOverwrite(
        stagingPath: string,
        targetPath: string,
    ): Promise<void> {
        return nodeFs.link(stagingPath, targetPath);
    }

    private async installStagedFileWithoutOverwrite(
        stagingPath: string,
        targetPath: string,
    ): Promise<'linked' | 'copied'> {
        try {
            await this.linkStagedFileWithoutOverwrite(stagingPath, targetPath);
            return 'linked';
        } catch (error) {
            if (this.isNodeErrorCode(error, 'EEXIST')) {
                throw error;
            }
            try {
                await nodeFs.copyFile(
                    stagingPath,
                    targetPath,
                    nodeFsConstants.COPYFILE_EXCL,
                );
                return 'copied';
            } catch (copyError) {
                if (!this.isNodeErrorCode(copyError, 'EEXIST')) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [local exclusive install failed] ` +
                        `link=${formatUnknownError(error)}; copy=${formatUnknownError(copyError)}`,
                    );
                }
                throw copyError;
            }
        }
    }

    private readLocalStagingFile(stagingPath: string): Promise<Buffer> {
        return nodeFs.readFile(stagingPath);
    }

    private async restoreStagedFileWithoutOverwrite(
        stagingPath: string,
        targetPath: string,
        relPath: string,
        reason: string,
        retainedSourcePath?: string,
    ): Promise<boolean> {
        const retainSource = async (retentionReason: string) => {
            if (retainedSourcePath) {
                if (stagingPath!==retainedSourcePath) {
                    await this.renameDurably(stagingPath, retainedSourcePath);
                }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local inode guard retained] ${relPath}: ` +
                    `${retentionReason}; guard=${retainedSourcePath}`,
                );
                return retainedSourcePath;
            }
            return this.preserveConcurrentStagingPath(
                stagingPath,
                relPath,
                retentionReason,
            );
        };
        let installMode: 'linked' | 'copied';
        try {
            installMode = await this.installStagedFileWithoutOverwrite(
                stagingPath,
                targetPath,
            );
        } catch (error) {
            let recoveryPath = stagingPath;
            try {
                recoveryPath = await retainSource(
                    this.isNodeErrorCode(error, 'EEXIST')
                        ? `${reason}; the original path was recreated before rollback`
                        : `${reason}; rollback installation failed`,
                );
            } catch (recoveryError) {
                throw new Error(
                    `Could not restore ${relPath}; rollback failed (${formatUnknownError(error)}) ` +
                    `and recovery retention failed (${formatUnknownError(recoveryError)}). ` +
                    `Original bytes remain at ${stagingPath}`,
                );
            }
            if (this.isNodeErrorCode(error, 'EEXIST')) {
                return false;
            }
            throw new Error(
                `Could not restore ${relPath}; rollback failed: ${formatUnknownError(error)}. ` +
                `Original bytes were recovered at ${recoveryPath}`,
            );
        }

        if (installMode==='linked') {
            await nodeFs.unlink(stagingPath);
        } else {
            await retainSource(
                `${reason}; restored with copy fallback while retaining the original inode`,
            );
        }
        return true;
    }

    private async cleanupDisplacedInstalledFile(
        displacedPath: string,
        relPath: string,
        installedRevision?: string,
    ): Promise<void> {
        try {
            const displacedContent = await this.readLocalStagingFile(displacedPath);
            if (
                installedRevision!==undefined
                && contentDigest(displacedContent)===installedRevision
            ) {
                await nodeFs.unlink(displacedPath);
            } else {
                await this.preserveConcurrentStagingPath(
                    displacedPath,
                    relPath,
                    'the newly installed inode changed while the prior local inode was restored',
                );
            }
        } catch (error) {
            if (!this.isNodeErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
    }

    private async restoreOwnedStagingFileIfTargetMissing(
        stagingPath: string,
        targetPath: string,
        relPath: string,
    ): Promise<void> {
        try {
            await nodeFs.lstat(targetPath);
            return;
        } catch (error) {
            if (!this.isNodeErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
        try {
            await this.installStagedFileWithoutOverwrite(stagingPath, targetPath);
            await nodeFs.unlink(stagingPath);
        } catch (error) {
            let recoveryPath = stagingPath;
            try {
                recoveryPath = await this.preserveConcurrentStagingPath(
                    stagingPath,
                    relPath,
                    'the installed remote copy could not be restored after rollback failure',
                );
            } catch {
                // The error below still identifies the original staging path.
            }
            throw new Error(
                `Could not restore a visible copy of ${relPath}: ${formatUnknownError(error)}. ` +
                `Recovery=${recoveryPath}`,
            );
        }
    }

    private async restoreChangedBackupAfterInstall(
        backupPath: string,
        targetPath: string,
        relPath: string,
        installedRevision: string | undefined,
        retainedSourcePath?: string,
    ): Promise<boolean> {
        const displacedPath = nodePath.join(
            nodePath.dirname(targetPath),
            `.sr-overleaf-${this.stagingToken(relPath)}.replaced`,
        );
        try {
            await this.renameDurably(targetPath, displacedPath);
        } catch (error) {
            await this.restoreStagedFileWithoutOverwrite(
                backupPath,
                targetPath,
                relPath,
                'the changed prior local inode could not replace the installed remote copy',
                retainedSourcePath,
            );
            throw new Error(
                `Could not quarantine the installed copy of ${relPath} while restoring a changed local inode: ` +
                formatUnknownError(error),
            );
        }

        let restored: boolean;
        try {
            restored = await this.restoreStagedFileWithoutOverwrite(
                backupPath,
                targetPath,
                relPath,
                'the prior local inode changed during the atomic swap',
                retainedSourcePath,
            );
        } catch (error) {
            try {
                await this.restoreOwnedStagingFileIfTargetMissing(
                    displacedPath,
                    targetPath,
                    relPath,
                );
            } catch (installedRestoreError) {
                throw new Error(
                    `${formatUnknownError(error)}; additionally failed to restore the installed copy: ` +
                    formatUnknownError(installedRestoreError),
                );
            }
            await this.cleanupDisplacedInstalledFile(
                displacedPath,
                relPath,
                installedRevision,
            );
            throw error;
        }

        await this.cleanupDisplacedInstalledFile(
            displacedPath,
            relPath,
            installedRevision,
        );
        return restored;
    }

    private async restoreStagedPathWithoutOverwrite(
        stagingPath: string,
        targetPath: string,
        relPath: string,
        kind: PathRevision['kind'],
        reason: string,
        retainedSourcePath?: string,
    ): Promise<void> {
        try {
            await nodeFs.lstat(targetPath);
            if (retainedSourcePath) {
                if (stagingPath!==retainedSourcePath) {
                    await this.renameDurably(stagingPath, retainedSourcePath);
                }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local inode guard retained] ${relPath}: ` +
                    `${reason}; guard=${retainedSourcePath}`,
                );
            } else {
                await this.preserveConcurrentStagingPath(stagingPath, relPath, reason);
            }
            return;
        } catch (error) {
            if (!this.isNodeErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
        if (kind==='file') {
            await this.restoreStagedFileWithoutOverwrite(
                stagingPath,
                targetPath,
                relPath,
                reason,
                retainedSourcePath,
            );
            return;
        }
        await this.renameDurably(stagingPath, targetPath);
    }

    private async atomicWriteLocalFileIfRevision(
        relPath: string,
        content: Uint8Array,
        expectedRevision: string,
        generation: number,
    ): Promise<boolean> {
        const targetPath = this.localUri(relPath).fsPath;
        const parentPath = nodePath.dirname(targetPath);
        const token = this.stagingToken(relPath);
        const stagePath = nodePath.join(parentPath, `.sr-overleaf-${token}.new`);
        const backupPath = nodePath.join(parentPath, `.sr-overleaf-${token}.old`);
        const operationRecord: LocalReplicaOperationRecord = {
            version: 1,
            id: token,
            kind: 'write',
            relPath,
            entityKind: 'missing',
            expectedRevision,
            installedRevision: contentDigest(content),
            stageName: nodePath.basename(stagePath),
            backupName: nodePath.basename(backupPath),
            guardName: `.sr-overleaf-${token}.guard`,
            createdAt: new Date().toISOString(),
        };
        const guardPath = this.localOperationGuardPath(operationRecord);
        let rollbackPath: string | undefined;
        let stageExists = false;
        let operationRecordExists = false;
        let operationCommitted = false;
        let operationError: unknown;

        try {
            const stageHandle = await nodeFs.open(stagePath, 'wx');
            stageExists = true;
            try {
                await stageHandle.writeFile(content);
                // Durability parity with the operation journal. Without this,
                // a crash between the write and the install can leave the
                // linked-in target holding zero-length or partial bytes, which
                // the startup reconcile reads as a local edit and force-pushes
                // over the intact Overleaf manuscript.
                await stageHandle.sync();
            } finally {
                await stageHandle.close();
            }
            const current = await this.captureLocalPathRevision(relPath, generation);
            if (current.revision!==expectedRevision) {
                return false;
            }
            operationRecord.entityKind = current.kind;
            await this.createLocalOperationRecord(operationRecord);
            operationRecordExists = true;
            if (current.kind==='file') {
                try {
                    await this.renameDurably(targetPath, backupPath);
                    rollbackPath = backupPath;
                } catch (error) {
                    if (this.isNodeErrorCode(error, 'ENOENT')) {
                        await this.removeLocalOperationRecord(operationRecord.id);
                        operationRecordExists = false;
                        return false;
                    }
                    throw error;
                }
                const movedContent = await this.readLocalStagingFile(backupPath);
                if (contentDigest(movedContent)!==expectedRevision) {
                    rollbackPath = undefined;
                    await this.restoreStagedFileWithoutOverwrite(
                        backupPath,
                        targetPath,
                        relPath,
                        'the local file changed while it was being staged for replacement',
                        guardPath,
                    );
                    operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                        operationRecord,
                    );
                    operationRecordExists = operationCommitted;
                    return false;
                }
            } else if (current.kind!=='missing') {
                return false;
            }

            try {
                await this.installStagedFileWithoutOverwrite(stagePath, targetPath);
            } catch (error) {
                if (!this.isNodeErrorCode(error, 'EEXIST')) {
                    throw error;
                }
                if (rollbackPath) {
                    const sourcePath = rollbackPath;
                    rollbackPath = undefined;
                    await this.restoreStagedFileWithoutOverwrite(
                        sourcePath,
                        targetPath,
                        relPath,
                        'the target path was recreated during the atomic swap',
                        guardPath,
                    );
                }
                operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                    operationRecord,
                );
                operationRecordExists = operationCommitted;
                return false;
            }
            await nodeFs.unlink(stagePath);
            stageExists = false;

            if (rollbackPath) {
                const finalBackupContent = await this.readLocalStagingFile(backupPath);
                if (contentDigest(finalBackupContent)!==expectedRevision) {
                    rollbackPath = undefined;
                    await this.restoreChangedBackupAfterInstall(
                        backupPath,
                        targetPath,
                        relPath,
                        contentDigest(content),
                        guardPath,
                    );
                    operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                        operationRecord,
                    );
                    operationRecordExists = operationCommitted;
                    return false;
                }
                await this.renameDurably(backupPath, guardPath);
                rollbackPath = guardPath;
                await this.markLocalOperationCommitted(operationRecord.id);
                operationCommitted = true;
                rollbackPath = undefined;
                this.scheduleUnreferencedLocalGuardCleanup(
                    operationRecord,
                    generation,
                );
            } else {
                await this.removeLocalOperationRecord(operationRecord.id);
                operationRecordExists = false;
            }
            return true;
        } catch (error) {
            operationError = error;
            throw error;
        } finally {
            const cleanupErrors: string[] = [];
            if (stageExists) {
                try {
                    await nodeFs.unlink(stagePath);
                } catch (error) {
                    if (!this.isNodeErrorCode(error, 'ENOENT')) {
                        cleanupErrors.push(
                            `new-content staging cleanup failed (${formatUnknownError(error)}; staging=${stagePath})`,
                        );
                    }
                }
            }
            if (rollbackPath) {
                const sourcePath = rollbackPath;
                rollbackPath = undefined;
                try {
                    await this.restoreStagedFileWithoutOverwrite(
                        sourcePath,
                        targetPath,
                        relPath,
                        'the atomic write exited before committing',
                        guardPath,
                    );
                    if (operationRecordExists) {
                        operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                            operationRecord,
                        );
                        operationRecordExists = operationCommitted;
                    }
                } catch (error) {
                    cleanupErrors.push(formatUnknownError(error));
                }
            }
            if (
                operationRecordExists
                && !operationCommitted
                && !await this.localPathExists(backupPath)
                && !await this.localPathExists(guardPath)
                && await this.localPathExists(targetPath)
            ) {
                try {
                    await this.removeLocalOperationRecord(operationRecord.id);
                    operationRecordExists = false;
                } catch (error) {
                    cleanupErrors.push(
                        `operation journal cleanup failed (${formatUnknownError(error)})`,
                    );
                }
            }
            if (cleanupErrors.length>0) {
                throw new Error(
                    `Local atomic write cleanup failed for ${relPath}: ${cleanupErrors.join('; ')}` +
                    (operationError===undefined
                        ? ''
                        : `; original operation failed: ${formatUnknownError(operationError)}`),
                );
            }
        }
    }

    private async writeLocalFileIfRevision(
        relPath: string,
        content: Uint8Array,
        expectedRevision: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        await this.ensureParentDirectory(relPath, generation);
        const written = await this.runSessionIO(
            generation,
            () => this.atomicWriteLocalFileIfRevision(
                relPath,
                content,
                expectedRevision,
                generation,
            ),
        );
        this.requireSyncSession(generation);
        if (!written) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [local write blocked:concurrent change] ${relPath}`,
            );
        }
        return written;
    }

    // `expectedIdentity` narrows the compare-and-swap from "the bytes still hash
    // the same" to "this is still the same file object". A same-byte atomic
    // recreate is a different inode with a fresh mtime and is a legitimate user
    // action, so a digest-only comparison would delete it.
    //
    // 'unavailable' is distinct from undefined and load-bearing. undefined means
    // the caller imposes no identity requirement; 'unavailable' means it wanted
    // one and could not get it. Collapsing the second into the first is how
    // "could not determine" turns into "nothing to worry about", so a live target
    // whose identity is 'unavailable' is refused rather than compared by digest.
    private async atomicDeleteLocalPathIfRevision(
        relPath: string,
        expectedRevision: string,
        generation = this.syncGeneration,
        expectedIdentity?: LocalReadIdentity | 'unavailable',
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const targetPath = this.localUri(relPath).fsPath;
        const parentPath = nodePath.dirname(targetPath);
        const token = this.stagingToken(relPath);
        const quarantinePath = nodePath.join(
            parentPath,
            `.sr-overleaf-${token}.deleted`,
        );
        const current = await this.captureLocalPathRevision(relPath, generation);
        if (current.kind==='missing') {
            return true;
        }
        if (current.revision!==expectedRevision) {
            return false;
        }
        // The target demonstrably exists at this point, so an identity that was
        // wanted but could not be read is a refusal, not a licence to compare
        // bytes alone. The caller turns the refusal into a conflict.
        if (
            expectedIdentity==='unavailable'
            || (
                expectedIdentity!==undefined
                && !await this.localPathIdentityMatches(targetPath, expectedIdentity, true)
            )
        ) {
            return false;
        }
        const operationRecord: LocalReplicaOperationRecord = {
            version: 1,
            id: token,
            kind: 'delete',
            relPath,
            entityKind: current.kind,
            expectedRevision,
            backupName: nodePath.basename(quarantinePath),
            guardName: `.sr-overleaf-${token}.guard`,
            createdAt: new Date().toISOString(),
        };
        const guardPath = this.localOperationGuardPath(operationRecord);
        let rollbackPath: string | undefined;
        let operationRecordExists = false;
        let operationCommitted = false;
        let operationError: unknown;
        await this.createLocalOperationRecord(operationRecord);
        operationRecordExists = true;
        try {
            try {
                await this.renameDurably(targetPath, quarantinePath);
                rollbackPath = quarantinePath;
            } catch (error) {
                if (this.isNodeErrorCode(error, 'ENOENT')) {
                    await this.removeLocalOperationRecord(operationRecord.id);
                    operationRecordExists = false;
                    return false;
                }
                throw error;
            }

            const moved = await this.captureLocalUriRevision(
                vscode.Uri.file(quarantinePath),
                relPath,
                generation,
            );
            // Authoritative check: whatever the rename captured is now pinned
            // under a private name, so this observation cannot be raced.
            // 'unavailable' cannot reach here: it is refused above, before
            // anything is staged, whenever the target exists.
            const movedIdentityMatches = expectedIdentity===undefined
                || await this.localPathIdentityMatches(
                    quarantinePath,
                    expectedIdentity,
                    false,
                );
            if (moved.revision!==expectedRevision || !movedIdentityMatches) {
                rollbackPath = undefined;
                await this.restoreStagedPathWithoutOverwrite(
                    quarantinePath,
                    targetPath,
                    relPath,
                    moved.kind,
                    'the path changed before atomic delete and was recreated before rollback',
                    guardPath,
                );
                operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                    operationRecord,
                );
                operationRecordExists = operationCommitted;
                return false;
            }

            try {
                await nodeFs.lstat(targetPath);
                const finalMoved = await this.captureLocalUriRevision(
                    vscode.Uri.file(quarantinePath),
                    relPath,
                    generation,
                );
                await this.renameDurably(quarantinePath, guardPath);
                rollbackPath = undefined;
                await this.markLocalOperationCommitted(operationRecord.id);
                operationCommitted = true;
                this.scheduleUnreferencedLocalGuardCleanup(
                    operationRecord,
                    generation,
                );
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local inode guard retained] ${relPath}: ` +
                    `${finalMoved.revision!==expectedRevision
                        ? 'the quarantined path changed while its original path was recreated'
                        : 'the original path was recreated while its prior inode was quarantined'}; ` +
                    `guard=${guardPath}`,
                );
                return false;
            } catch (error) {
                if (!this.isNodeErrorCode(error, 'ENOENT')) {
                    throw error;
                }
            }

            const finalMoved = await this.captureLocalUriRevision(
                vscode.Uri.file(quarantinePath),
                relPath,
                generation,
            );
            if (finalMoved.revision!==expectedRevision) {
                rollbackPath = undefined;
                await this.restoreStagedPathWithoutOverwrite(
                    quarantinePath,
                    targetPath,
                    relPath,
                    finalMoved.kind,
                    'the quarantined path changed before delete and its original path was recreated',
                    guardPath,
                );
                operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                    operationRecord,
                );
                operationRecordExists = operationCommitted;
                return false;
            }
            await this.renameDurably(quarantinePath, guardPath);
            rollbackPath = guardPath;
            await this.markLocalOperationCommitted(operationRecord.id);
            operationCommitted = true;
            rollbackPath = undefined;
            this.scheduleUnreferencedLocalGuardCleanup(
                operationRecord,
                generation,
            );
            return true;
        } catch (error) {
            operationError = error;
            throw error;
        } finally {
            const cleanupErrors: string[] = [];
            if (rollbackPath) {
                const sourcePath = rollbackPath;
                rollbackPath = undefined;
                try {
                    const staged = await this.captureLocalUriRevision(
                        vscode.Uri.file(sourcePath),
                        relPath,
                        generation,
                    );
                    await this.restoreStagedPathWithoutOverwrite(
                        sourcePath,
                        targetPath,
                        relPath,
                        staged.kind,
                        'atomic delete cleanup could not restore the original path',
                        guardPath,
                    );
                    if (operationRecordExists) {
                        operationCommitted = await this.retainGuardOrRemoveLocalOperation(
                            operationRecord,
                        );
                        operationRecordExists = operationCommitted;
                    }
                } catch (error) {
                    cleanupErrors.push(
                        `rollback failed (${formatUnknownError(error)}; ` +
                        `journal=${this.localOperationRecordPath(operationRecord.id)}; source=${sourcePath})`,
                    );
                }
            }
            if (cleanupErrors.length>0) {
                throw new Error(
                    `Local atomic delete cleanup failed for ${relPath}: ${cleanupErrors.join('; ')}` +
                    (operationError===undefined
                        ? ''
                        : `; original operation failed: ${formatUnknownError(operationError)}`),
                );
            }
            if (!operationCommitted && operationRecordExists && !rollbackPath) {
                const sourceExists = await this.localPathExists(quarantinePath)
                    || await this.localPathExists(guardPath);
                if (!sourceExists) {
                    await this.removeLocalOperationRecord(operationRecord.id);
                }
            }
        }
    }

    private async collectLocalReplicaSnapshot(
        directoryUri: vscode.Uri = this.baseUri,
        directoryRelPath = '/',
        snapshot: LocalReplicaSnapshot = {files: new Set(), directories: new Set()},
        generation?: number,
    ): Promise<LocalReplicaSnapshot> {
        const pendingDirectories: Array<{uri: vscode.Uri; relPath: string}> = [{
            uri: directoryUri,
            relPath: directoryRelPath,
        }];
        while (pendingDirectories.length>0) {
            if (generation!==undefined) { this.requireSyncSession(generation); }
            const batch = pendingDirectories.splice(0, 16);
            const listings = await Promise.all(batch.map(async ({uri, relPath}) => ({
                uri,
                relPath,
                entries: uri.scheme==='file'
                    ? (await nodeFs.readdir(uri.fsPath, {withFileTypes: true})).map(entry => [
                        entry.name,
                        entry.isDirectory()
                            ? vscode.FileType.Directory
                            : entry.isFile()
                                ? vscode.FileType.File
                                : entry.isSymbolicLink()
                                    ? vscode.FileType.SymbolicLink
                                    : vscode.FileType.Unknown,
                    ] as [string, vscode.FileType])
                    : await vscode.workspace.fs.readDirectory(uri),
            })));
            if (generation!==undefined) { this.requireSyncSession(generation); }
            for (const {uri, relPath: parentRelPath, entries} of listings) {
                for (const [name, fileType] of entries) {
                    const relPath = this.normalizeConfinedRelPath(
                        `${parentRelPath.replace(/\/+$/, '')}/${name}`,
                        'startup local replica scan',
                    );
                    if (
                        relPath===undefined
                        || this.matchIgnorePatterns(relPath)
                        || this.matchIgnorePatterns(`${relPath}/`)
                    ) {
                        continue;
                    }

                    const childUri = vscode.Uri.joinPath(uri, name);
                    if (fileType===vscode.FileType.Directory) {
                        snapshot.directories.add(relPath);
                        pendingDirectories.push({uri: childUri, relPath});
                    } else if (fileType===vscode.FileType.File) {
                        snapshot.files.add(relPath);
                    }
                }
            }
        }
        return snapshot;
    }

    private async findIgnoredDescendant(
        directoryUri: vscode.Uri,
        directoryRelPath: string,
        generation?: number,
    ): Promise<string | undefined> {
        if (generation!==undefined) { this.requireSyncSession(generation); }
        const entries = await vscode.workspace.fs.readDirectory(directoryUri);
        if (generation!==undefined) { this.requireSyncSession(generation); }
        for (const [name, fileType] of entries) {
            const relPath = this.requireConfinedRelPath(
                `${directoryRelPath.replace(/\/+$/, '')}/${name}`,
                'ignored descendant scan',
            );
            if (this.matchIgnorePatterns(relPath) || this.matchIgnorePatterns(`${relPath}/`)) {
                return relPath;
            }
            if (fileType===vscode.FileType.Directory) {
                const nested = await this.findIgnoredDescendant(
                    vscode.Uri.joinPath(directoryUri, name),
                    relPath,
                    generation,
                );
                if (nested) {
                    return nested;
                }
            }
        }
        return undefined;
    }

    private async localDirectoryHasChanges(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const snapshot = await this.collectLocalReplicaSnapshot(
            this.localUri(relPath),
            relPath,
            {files: new Set(), directories: new Set()},
            generation,
        );
        const manifestFiles = Object.keys(this.syncManifest?.files ?? {})
            .filter(path => path.startsWith(`${relPath}/`));
        const manifestDirectories = Object.keys(this.syncManifest?.directories ?? {})
            .filter(path => path.startsWith(`${relPath}/`));
        if (
            [...snapshot.files].some(path => this.syncManifest?.files[path]===undefined)
            || [...snapshot.directories].some(path => this.syncManifest?.directories[path]===undefined)
            || manifestFiles.some(path => !snapshot.files.has(path))
            || manifestDirectories.some(path => !snapshot.directories.has(path))
        ) {
            return true;
        }
        for (const path of snapshot.files) {
            if (!await this.isLocalUnchangedFromManifest(path)) {
                return true;
            }
            this.requireSyncSession(generation);
        }
        return false;
    }

    private async collectRemoteDirectorySnapshot(
        rootRelPath: string,
        generation = this.syncGeneration,
    ): Promise<LocalReplicaSnapshot> {
        this.requireSyncSession(generation);
        const snapshot: LocalReplicaSnapshot = {
            files: new Set(),
            directories: new Set(),
        };
        const queue = [rootRelPath];
        while (queue.length>0) {
            const directoryPath = queue.shift()!;
            const entries = await vscode.workspace.fs.readDirectory(this.vfs.pathToUri(directoryPath));
            this.requireSyncSession(generation);
            for (const [name, type] of entries) {
                const relPath = this.requireConfinedRelPath(
                    `${directoryPath.replace(/\/+$/, '')}/${name}`,
                    'remote directory conflict scan',
                );
                if (this.matchIgnorePatterns(relPath) || this.matchIgnorePatterns(`${relPath}/`)) {
                    continue;
                }
                if (type===vscode.FileType.Directory) {
                    snapshot.directories.add(relPath);
                    queue.push(relPath);
                } else if (type===vscode.FileType.File) {
                    snapshot.files.add(relPath);
                }
            }
        }
        return snapshot;
    }

    private async remoteDirectoryHasChanges(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const snapshot = await this.collectRemoteDirectorySnapshot(relPath, generation);
        const manifestFiles = Object.keys(this.syncManifest?.files ?? {})
            .filter(path => path.startsWith(`${relPath}/`));
        const manifestDirectories = Object.keys(this.syncManifest?.directories ?? {})
            .filter(path => path.startsWith(`${relPath}/`));
        if (
            [...snapshot.files].some(path => this.syncManifest?.files[path]===undefined)
            || [...snapshot.directories].some(path => this.syncManifest?.directories[path]===undefined)
            || manifestFiles.some(path => !snapshot.files.has(path))
            || manifestDirectories.some(path => !snapshot.directories.has(path))
        ) {
            return true;
        }
        for (const path of snapshot.files) {
            const entry = this.syncManifest?.files[path];
            if (!entry) { return true; }
            if (this.isLikelyBinaryRelPath(path)) {
                const fingerprint = await this.getRemoteFingerprint(path, this.vfs.pathToUri(path));
                this.requireSyncSession(generation);
                if (!fingerprint || fingerprint!==entry.remoteFingerprint) {
                    return true;
                }
            } else {
                const content = await this.pullRemoteFile(path, this.vfs.pathToUri(path), generation);
                if (contentDigest(content)!==entry.localDigest) {
                    return true;
                }
            }
        }
        return false;
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            if (error instanceof LocalReplicaFolderSelectionCancelledError) {
                return Promise.reject(error);
            }
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async validateExactBaseUri(uri: string, options?: ValidateExactBaseUriOptions): Promise<vscode.Uri> {
        try {
            const baseUri = vscode.Uri.file(uri);
            if (await LocalReplicaSCMProvider.pathExists(baseUri)) {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }

                const settingsStatus = await LocalReplicaSCMProvider.validateExistingExactReplicaSettings(baseUri, options?.projectUri);
                if (settingsStatus==='same-project') {
                    const protectedReason = await LocalReplicaSCMProvider.getProtectedExactBaseUriReasonCode(baseUri);
                    if (
                        protectedReason!==undefined
                        && protectedReason!=='workspace-root'
                        && protectedReason!=='git-repository-root'
                    ) {
                        await LocalReplicaSCMProvider.rejectDangerousExactBaseUri(baseUri);
                    }
                    return baseUri;
                }
                if (settingsStatus==='different-project') {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t(
                            'The selected folder is already configured for a different Overleaf project: {path}. Select another folder.',
                            {path: baseUri.fsPath || baseUri.toString()},
                        ),
                    );
                    throw new LocalReplicaFolderSelectionRejectedError('Selected folder belongs to another Overleaf project.');
                }
            }

            await LocalReplicaSCMProvider.rejectDangerousExactBaseUri(baseUri);
            if (await LocalReplicaSCMProvider.pathExists(baseUri)) {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
            }
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            await LocalReplicaSCMProvider.ensureEmptyExactBaseUri(baseUri, options);
            return baseUri;
        } catch (error) {
            if (
                error instanceof LocalReplicaFolderSelectionCancelledError
                || error instanceof LocalReplicaFolderSelectionRejectedError
            ) {
                return Promise.reject(error);
            }
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    private static async ensureEmptyExactBaseUri(baseUri: vscode.Uri, options?: ValidateExactBaseUriOptions): Promise<void> {
        const entries = await vscode.workspace.fs.readDirectory(baseUri);
        if (entries.length===0) { return; }

        const emptyAndContinue = vscode.l10n.t('Empty Folder and Continue');
        const selected = await vscode.window.showWarningMessage(
            vscode.l10n.t(
                'The selected Local Replica folder is not empty: {path}. Empty it before syncing?',
                {path: baseUri.fsPath || baseUri.toString()},
            ),
            {modal: true},
            emptyAndContinue,
        );
        if (selected!==emptyAndContinue) {
            throw new LocalReplicaFolderSelectionCancelledError('Selected Local Replica folder is not empty.');
        }

        await options?.beforeEmpty?.(baseUri);
        await LocalReplicaSCMProvider.emptyDirectory(baseUri);
    }

    private static async emptyDirectory(baseUri: vscode.Uri): Promise<void> {
        const entries = await vscode.workspace.fs.readDirectory(baseUri);
        for (const [name] of entries) {
            await deleteWithTrashFallback(vscode.Uri.joinPath(baseUri, name), {recursive: true});
        }
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        return pathToLocalUri(path);
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        return localUriToPath(uri);
    }

    public static async readSettings(rootUri?: vscode.Uri): Promise<any | undefined> {
        return readReplicaSettings(rootUri ?? getActiveReplicaRoot());
    }

    private normalizeConfinedRelPath(relPath: string, operation: string): string | undefined {
        const normalized = normalizeLocalReplicaRelPath(relPath);
        if (normalized===undefined) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [path rejected] ${operation}: ${relPath}`,
            );
            return undefined;
        }

        return normalized;
    }

    private requireConfinedRelPath(relPath: string, operation: string): string {
        const normalized = this.normalizeConfinedRelPath(relPath, operation);
        if (normalized===undefined) {
            throw new Error(`Invalid Local Replica path for ${operation}: ${relPath}`);
        }
        return normalized;
    }

    private relPathFromLocalFileUri(localUri: vscode.Uri, operation: string): string | undefined {
        if (localUri.scheme!=='file') { return undefined; }
        const basePath = this.baseUri.path.replace(/\/+$/, '');
        if (localUri.path===basePath || !localUri.path.startsWith(basePath + '/')) { return undefined; }
        if (isLocalReplicaMetadataUri(localUri, this.baseUri)) { return undefined; }
        return this.normalizeConfinedRelPath(localUri.path.slice(basePath.length), operation);
    }

    private async reloadCleanOpenDocumentFromDisk(
        document: vscode.TextDocument,
        diskContent: Uint8Array,
    ): Promise<boolean> {
        if (document.isDirty) { return false; }
        try {
            new TextDecoder('utf-8', {fatal: true}).decode(diskContent);
        } catch {
            return false;
        }
        const uriKey = document.uri.toString();
        const originalEditor = vscode.window.activeTextEditor;
        const originalSelection = originalEditor?.selection;
        const targetEditor = vscode.window.visibleTextEditors.find(
            editor => editor.document.uri.toString()===uriKey,
        );
        let expectedVersion = document.version;
        try {
            for (let attempt = 0; attempt<2; attempt++) {
                if (document.isDirty || document.version!==expectedVersion) {
                    return false;
                }
                const latestDiskContent = await vscode.workspace.fs.readFile(document.uri);
                let latestDiskText: string;
                try {
                    latestDiskText = new TextDecoder('utf-8', {fatal: true}).decode(latestDiskContent);
                } catch {
                    return false;
                }
                if (document.getText()===latestDiskText) {
                    return true;
                }

                // The force-revert command reloads the file model without
                // invoking save participants or emitting an editor save.
                // Re-reading immediately beforehand and verifying afterwards
                // keeps agent writes that race this startup refresh on disk.
                if (document.isDirty || document.version!==expectedVersion) {
                    return false;
                }

                // Re-focus after the asynchronous disk read. The revert
                // command operates on the active editor, so there must be no
                // await between this validation and dispatching the command.
                const focusedEditor = await vscode.window.showTextDocument(document, {
                    viewColumn: targetEditor?.viewColumn ?? vscode.ViewColumn.Active,
                    preserveFocus: false,
                    preview: false,
                    selection: targetEditor?.selection,
                });
                const activeEditor = vscode.window.activeTextEditor;
                if (
                    focusedEditor.document.uri.toString()!==uriKey
                    || document.isDirty
                    || document.version!==expectedVersion
                    || (
                        activeEditor!==undefined
                        && activeEditor.document.uri.toString()!==uriKey
                    )
                ) {
                    return false;
                }
                await vscode.commands.executeCommand('workbench.action.files.revert');
                const currentDocument = document;
                if (currentDocument.isDirty) {
                    return false;
                }
                const verifiedDiskContent = await vscode.workspace.fs.readFile(document.uri);
                let verifiedDiskText: string;
                try {
                    verifiedDiskText = new TextDecoder('utf-8', {fatal: true}).decode(verifiedDiskContent);
                } catch {
                    return false;
                }
                if (currentDocument.getText()===verifiedDiskText) {
                    return true;
                }
                document = currentDocument;
                expectedVersion = currentDocument.version;
            }
            return false;
        } finally {
            if (
                originalEditor
                && originalEditor.document.uri.toString()!==uriKey
                && (
                    vscode.window.activeTextEditor===undefined
                    || vscode.window.activeTextEditor.document.uri.toString()===uriKey
                )
            ) {
                await vscode.window.showTextDocument(originalEditor.document, {
                    viewColumn: originalEditor.viewColumn,
                    preserveFocus: false,
                    preview: false,
                    selection: originalSelection,
                });
            }
        }
    }

    private async refreshCleanOpenReplicaDocumentsFromDisk(
        generation: number,
        documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments,
    ): Promise<string[]> {
        // During a window reload, the workbench can restore a clean editor
        // model from before the initial pull even though the pull already
        // replaced the file on disk. Force-revert only stale clean models;
        // dirty editors are deliberately excluded so unsaved work survives.
        const refreshed: string[] = [];
        await new Promise(resolve => setTimeout(resolve, 50));
        for (const document of documents) {
            if (!this.isSyncSessionActive(generation) || document.isDirty) { continue; }
            const relPath = this.relPathFromLocalFileUri(document.uri, 'refresh open replica document');
            if (relPath===undefined || this.matchIgnorePatterns(relPath)) { continue; }
            try {
                const diskContent = await vscode.workspace.fs.readFile(document.uri);
                this.requireSyncSession(generation);
                const editorContent = new TextEncoder().encode(document.getText());
                if (bytesEqual(editorContent, diskContent)) { continue; }
                if (!await this.reloadCleanOpenDocumentFromDisk(document, diskContent)) {
                    continue;
                }
                this.requireSyncSession(generation);
                refreshed.push(relPath);
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [open document refresh] ${relPath}: reloaded pulled disk content`,
                );
            } catch (error) {
                if (!this.isSyncSessionActive(generation)) { return refreshed; }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [open document refresh skipped] ${relPath}: ${formatUnknownError(error)}`,
                );
            }
        }
        return refreshed;
    }

    private decodeMergeableText(content: Uint8Array): string | undefined {
        return decodeUtf8Text(content, LocalReplicaSCMProvider.maxMergeBaselineBytes);
    }

    private mergeTextContents(
        baseContent: Uint8Array,
        localContent: Uint8Array,
        remoteContent: Uint8Array,
    ): Uint8Array | undefined {
        return mergeUtf8Text(
            baseContent,
            localContent,
            remoteContent,
            LocalReplicaSCMProvider.maxMergeBaselineBytes,
        );
    }

    private manifestBaseContent(entry?: SyncManifestEntry): Uint8Array | undefined {
        if (entry?.baseContentBase64===undefined) { return undefined; }
        try {
            return Buffer.from(entry.baseContentBase64, 'base64');
        } catch {
            return undefined;
        }
    }

    private async markSyncConflict(
        relPath: string,
        reason: string,
        localContent?: Uint8Array | null,
        generation = this.syncGeneration,
        recordedRemoteState?: PathRevision,
    ) {
        this.requireSyncSession(generation);
        let conflictDigest: string;
        if (localContent===null) {
            conflictDigest = DELETE_DIGEST;
        } else if (localContent!==undefined) {
            conflictDigest = contentDigest(localContent);
        } else {
            try {
                const localRevision = await this.captureLocalPathRevision(relPath, generation);
                conflictDigest = localRevision.revision;
            } catch (error) {
                if (!this.isSyncSessionActive(generation)) {
                    throw error;
                }
                conflictDigest = `unreadable:${Date.now()}:${formatUnknownError(error)}`;
            }
        }
        let remoteState = recordedRemoteState;
        if (remoteState===undefined) {
            try {
                remoteState = await this.captureRemotePathRevision(relPath, generation);
            } catch (error) {
                if (!this.isSyncSessionActive(generation)) {
                    throw error;
                }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [sync conflict proof unavailable] ${relPath}: ` +
                    formatUnknownError(error),
                );
            }
        }
        this.requireSyncSession(generation);
        this.syncConflicts.set(relPath, reason);
        this.conflictLocalDigests.set(relPath, conflictDigest);
        if (this.syncManifest) {
            this.syncManifest.conflicts[relPath] = {
                reason,
                localDigest: conflictDigest,
                remoteKind: remoteState?.kind,
                remoteRevision: remoteState?.revision,
                updatedAt: new Date().toISOString(),
            };
            this.markSyncManifestDirty();
        }
        this.status = {
            status: 'need-attention',
            message: vscode.l10n.t('sync conflict: {relPath}', {relPath}),
        };
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [sync conflict] ${relPath}: ${reason}`,
        );
        maybeWarnSyncFailure(relPath, new Error(
            `Local Replica conflict: ${reason}. Neither the current local state nor the current Overleaf state was overwritten.`,
        ));
        // Conflict durability is a correctness property: a conflict that only
        // exists in memory stops blocking pushes after a reload, so the next
        // local save would overwrite the Overleaf copy being held. Retry once,
        // then tell the user rather than failing silently.
        try {
            await this.persistSyncManifest(false, generation);
        } catch (error) {
            if (!this.isSyncSessionActive(generation)) { throw error; }
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [sync conflict persist retry] ${relPath}: ` +
                formatUnknownError(error),
            );
            try {
                await this.persistSyncManifest(true, generation);
            } catch (retryError) {
                if (!this.isSyncSessionActive(generation)) { throw retryError; }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [sync conflict persist failed] ${relPath}: ` +
                    formatUnknownError(retryError),
                );
                maybeWarnSyncFailure(relPath, new Error(
                    'the conflict could not be recorded on disk ' +
                    `(${formatUnknownError(retryError)}); it will stop blocking syncs ` +
                    'after a window reload',
                ));
                throw retryError;
            }
        }
    }

    private async clearSyncConflict(
        relPath: string,
        generation = this.syncGeneration,
    ) {
        let changed = false;
        this.syncConflicts.delete(relPath);
        this.conflictLocalDigests.delete(relPath);
        if (this.syncManifest?.conflicts[relPath]) {
            delete this.syncManifest.conflicts[relPath];
            changed = true;
        }
        for (const conflictPath of [...this.syncConflicts.keys()]) {
            if (!conflictPath.startsWith(`${relPath}/`)) { continue; }
            // A descendant holds its own Overleaf revision, so syncing the
            // parent proves nothing about it. Dropping it unblocks
            // touchesSyncConflict and the next local save would overwrite
            // remote content that is still deliberately held.
            if (
                !this.isSyncSessionActive(generation)
                || !await this.isConflictStateResolved(conflictPath, generation)
            ) {
                continue;
            }
            this.syncConflicts.delete(conflictPath);
            this.conflictLocalDigests.delete(conflictPath);
            if (this.syncManifest?.conflicts[conflictPath]) {
                delete this.syncManifest.conflicts[conflictPath];
                changed = true;
            }
        }
        if (changed) {
            this.markSyncManifestDirty();
        }
        this.completeTrustedBaselineIfResolved();
        if (
            this.syncConflicts.size===0
            && this.status.status==='need-attention'
            && this.status.message?.startsWith('sync conflict:')
        ) {
            this.status = {status: 'idle', message: ''};
        }
    }

    // A freshly created replica becomes a trusted baseline only after the
    // authoritative initial pull has completed without conflicts or failed
    // reads. The same gate repairs an unavailable baseline after its conflicts
    // are resolved; neither state is safe for destructive local intent first.
    private completeTrustedBaselineIfResolved() {
        if (
            this.syncManifestBaselineMode==='trusted'
            || (
                this.syncManifestBaselineMode==='fresh-replica'
                && this.initialPullStatus!=='complete'
            )
            || this.syncConflicts.size!==0
            || this.failedInitialPulls.size!==0
            || !this.syncManifest
        ) {
            return;
        }
        this.syncManifestBaselineMode = 'trusted';
        if (!this.syncManifest.baselineComplete) {
            this.syncManifest.baselineComplete = true;
            this.markSyncManifestDirty();
        }
    }

    private async hasLocalConflictRevision(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const conflictDigest = this.conflictLocalDigests.get(relPath);
        if (conflictDigest===undefined) { return false; }

        try {
            const current = await this.captureLocalPathRevision(relPath, generation);
            return current.revision!==conflictDigest;
        } catch {
            return false;
        }
    }

    private hasRelatedFailedInitialPull(relPath: string): boolean {
        return [...this.failedInitialPulls].some(path =>
            this.isPathAtOrBelow(path, relPath)
            || this.isPathAtOrBelow(relPath, path)
        );
    }

    private conflictPathForPushTarget(relPath: string): string | undefined {
        return [...this.syncConflicts.keys()]
            .filter(conflictPath => this.isPathAtOrBelow(relPath, conflictPath))
            .sort((left, right) => right.split('/').length-left.split('/').length)[0];
    }

    private async prepareConflictResolutionProof(
        conflictPath: string,
        targetRelPath: string,
        generation = this.syncGeneration,
        acceptUnchangedLocalState = false,
    ): Promise<ConflictResolutionProof | undefined> {
        this.requireSyncSession(generation);
        const entry = this.syncManifest?.conflicts[conflictPath];
        if (!entry) {
            return undefined;
        }
        if (
            this.hasRelatedFailedInitialPull(conflictPath)
            || this.hasRelatedFailedInitialPull(targetRelPath)
        ) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [conflict resolution blocked:initial-pull-failed] ${conflictPath}`,
            );
            return undefined;
        }
        if (
            entry.remoteKind===undefined
            || entry.remoteRevision===undefined
        ) {
            try {
                const localState = await this.captureLocalPathRevision(conflictPath, generation);
                await this.refreshRemoteStateForReconciliation(
                    conflictPath,
                    generation,
                    'establish missing conflict proof',
                );
                const remoteState = await this.captureRemotePathRevision(
                    conflictPath,
                    generation,
                );
                await this.markSyncConflict(
                    conflictPath,
                    'An authoritative Overleaf revision was established for a legacy conflict; ' +
                        'review it and edit the local copy again to resolve',
                    localState.kind==='missing' ? null : localState.content,
                    generation,
                    remoteState,
                );
                await this.persistSyncManifest(false, generation);
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [conflict resolution blocked:remote-proof-established] ` +
                    conflictPath,
                );
            } catch (error) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [conflict resolution blocked:no-remote-proof] ` +
                    `${conflictPath}: ${formatUnknownError(error)}`,
                );
            }
            return undefined;
        }
        if (
            !acceptUnchangedLocalState
            && !await this.hasLocalConflictRevision(conflictPath, generation)
        ) {
            return undefined;
        }

        const localState = await this.captureLocalPathRevision(conflictPath, generation);
        if (localState.kind==='other') {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [conflict resolution blocked:unsupported-local-type] ${conflictPath}`,
            );
            return undefined;
        }

        await this.refreshRemoteStateForReconciliation(
            conflictPath,
            generation,
            'verify conflict resolution',
        );
        const remoteConflictState = await this.captureRemotePathRevision(
            conflictPath,
            generation,
        );
        this.requireSyncSession(generation);
        if (
            remoteConflictState.kind!==entry.remoteKind
            || remoteConflictState.revision!==entry.remoteRevision
        ) {
            const reason = 'Overleaf changed again after the conflict was recorded; ' +
                'the newer remote revision was preserved';
            await this.markSyncConflict(
                conflictPath,
                reason,
                localState.kind==='missing' ? null : localState.content,
                generation,
                remoteConflictState,
            );
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [conflict resolution blocked:remote-advanced] ${conflictPath}`,
            );
            return undefined;
        }
        if (remoteConflictState.kind==='other') {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [conflict resolution blocked:unsupported-remote-type] ${conflictPath}`,
            );
            return undefined;
        }
        const remoteTargetState = targetRelPath===conflictPath
            ? remoteConflictState
            : await this.captureRemotePathRevision(targetRelPath, generation);
        this.requireSyncSession(generation);
        if (remoteTargetState.kind==='other') {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [conflict resolution blocked:unsupported-target-type] ${targetRelPath}`,
            );
            return undefined;
        }
        return {
            conflictPath,
            remoteState: remoteTargetState,
        };
    }

    public getSyncConflictPaths(): string[] {
        return [...this.syncConflicts.keys()].sort();
    }

    private async reconcilePersistedConflictChoicesOnStartup(
        generation = this.syncGeneration,
    ): Promise<number> {
        let resolved = 0;
        const conflictPaths = [...this.syncConflicts.keys()]
            .sort((left, right) => right.split('/').length-left.split('/').length);
        for (const relPath of conflictPaths) {
            this.requireSyncSession(generation);
            if (!await this.hasLocalConflictRevision(relPath, generation)) {
                continue;
            }
            const localState = await this.captureLocalPathRevision(relPath, generation);
            if (localState.kind==='other') {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [startup conflict resolution deferred] ${relPath}: ` +
                    'the current local path type cannot be synchronized',
                );
                continue;
            }
            const event = await this.applySync(
                'push',
                localState.kind==='missing' ? 'delete' : 'update',
                relPath,
                this.localUri(relPath),
                this.vfs.pathToUri(relPath),
                {forcePush: true, reason: 'startup-conflict-resolution'},
                generation,
            );
            this.requireSyncSession(generation);
            if (event.outcome==='success') {
                resolved += 1;
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [startup conflict resolved] ${relPath}: ` +
                    'the changed local decision was applied after the recorded Overleaf revision was verified',
                );
            }
        }
        return resolved;
    }

    public async resolveConflictWithLocalState(relPath: string): Promise<boolean> {
        const generation = this.syncGeneration;
        this.requireSyncSession(generation);
        const confinedRelPath = this.normalizeConfinedRelPath(
            relPath,
            'resolve conflict using local state',
        );
        if (
            confinedRelPath===undefined
            || !this.syncConflicts.has(confinedRelPath)
        ) {
            return false;
        }
        const localState = await this.captureLocalPathRevision(
            confinedRelPath,
            generation,
        );
        if (localState.kind==='other') {
            return false;
        }
        const event = await this.enqueueSync(
            confinedRelPath,
            () => this.applySync(
                'push',
                localState.kind==='missing' ? 'delete' : 'update',
                confinedRelPath,
                this.localUri(confinedRelPath),
                this.vfs.pathToUri(confinedRelPath),
                {
                    forcePush: true,
                    resolveConflict: true,
                    acceptUnchangedLocalConflictState: true,
                    reason: 'explicit-conflict-resolution',
                },
                generation,
            ),
            generation,
        ) as Events['scmSyncCompleteEvent'] | undefined;
        return event?.outcome==='success' || event?.outcome==='suppressed';
    }

    private async refreshConflictRemoteProof(
        conflictPath: string,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const entry = this.syncManifest?.conflicts[conflictPath];
        if (!entry) { return; }
        const remoteState = await this.captureRemotePathRevision(conflictPath, generation);
        this.requireSyncSession(generation);
        entry.remoteKind = remoteState.kind;
        entry.remoteRevision = remoteState.revision;
        entry.updatedAt = new Date().toISOString();
        this.markSyncManifestDirty();
    }

    private async hydrateMissingConflictRemoteProofs(
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const missingProofs = Object.entries(this.syncManifest?.conflicts ?? {})
            .filter(([_relPath, entry]) =>
                entry.remoteKind===undefined || entry.remoteRevision===undefined
            )
            .map(([relPath]) => relPath);
        if (missingProofs.length===0) { return; }

        try {
            await this.refreshRemoteStateForReconciliation(
                '/',
                generation,
                'hydrate legacy conflict proofs',
            );
        } catch (error) {
            if (!this.isSyncSessionActive(generation)) {
                throw error;
            }
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [conflict remote proof hydration deferred] ` +
                formatUnknownError(error),
            );
            return;
        }
        for (const relPath of missingProofs) {
            this.requireSyncSession(generation);
            const entry = this.syncManifest?.conflicts[relPath];
            if (!entry) { continue; }
            try {
                const remoteState = await this.captureRemotePathRevision(
                    relPath,
                    generation,
                );
                const localState = await this.captureLocalPathRevision(
                    relPath,
                    generation,
                );
                this.requireSyncSession(generation);
                entry.localDigest = localState.revision;
                entry.remoteKind = remoteState.kind;
                entry.remoteRevision = remoteState.revision;
                entry.updatedAt = new Date().toISOString();
                this.conflictLocalDigests.set(relPath, localState.revision);
                this.markSyncManifestDirty();
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [conflict remote proof hydrated] ${relPath}`,
                );
            } catch (error) {
                if (!this.isSyncSessionActive(generation)) {
                    throw error;
                }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [conflict remote proof unavailable] ` +
                    `${relPath}: ${formatUnknownError(error)}`,
                );
            }
        }
        await this.persistSyncManifest(false, generation);
    }

    private async isConflictStateResolved(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        let localStat: vscode.FileStat | undefined;
        let remoteStat: vscode.FileStat | undefined;
        try {
            localStat = await this.statConfinedLocalUri(
                this.localUri(relPath),
                `conflict inspection of ${relPath}`,
            );
        } catch (error) {
            if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return false;
            }
        }
        this.requireSyncSession(generation);
        try {
            remoteStat = await vscode.workspace.fs.stat(this.vfs.pathToUri(relPath));
        } catch (error) {
            if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return false;
            }
        }
        this.requireSyncSession(generation);

        if (!localStat && !remoteStat) {
            return true;
        }
        if (
            localStat?.type===vscode.FileType.Directory
            || remoteStat?.type===vscode.FileType.Directory
        ) {
            try {
                if (localStat && await this.localDirectoryHasChanges(relPath, generation)) {
                    return false;
                }
                if (remoteStat && await this.remoteDirectoryHasChanges(relPath, generation)) {
                    return false;
                }
                return true;
            } catch {
                return false;
            }
        }
        if (!localStat || !remoteStat) {
            return false;
        }
        try {
            const [localContent, remoteContent] = await Promise.all([
                this.readConfinedLocalFile(relPath),
                this.pullRemoteFile(relPath, this.vfs.pathToUri(relPath), generation),
            ]);
            this.requireSyncSession(generation);
            return bytesEqual(localContent, remoteContent);
        } catch {
            return false;
        }
    }

    private async clearSyncConflictAfterSuccess(
        relPath: string,
        generation = this.syncGeneration,
    ) {
        this.requireSyncSession(generation);
        await this.clearSyncConflict(relPath, generation);
        const ancestorConflicts = [...this.syncConflicts.keys()]
            .filter(path => this.isPathAtOrBelow(relPath, path))
            .sort((left, right) => right.split('/').length-left.split('/').length);
        for (const conflictPath of ancestorConflicts) {
            const resolved = await this.isConflictStateResolved(conflictPath, generation);
            this.requireSyncSession(generation);
            if (resolved) {
                this.syncConflicts.delete(conflictPath);
                this.conflictLocalDigests.delete(conflictPath);
                if (this.syncManifest?.conflicts[conflictPath]) {
                    delete this.syncManifest.conflicts[conflictPath];
                    this.markSyncManifestDirty();
                }
            }
        }
        this.completeTrustedBaselineIfResolved();
    }

    private isPathAtOrBelow(relPath: string, parentPath: string): boolean {
        return relPath===parentPath || relPath.startsWith(`${parentPath}/`);
    }

    private hasSyncConflictAtOrBelow(relPath: string): boolean {
        return [...this.syncConflicts.keys()].some(path => this.isPathAtOrBelow(path, relPath));
    }

    /**
     * A recursive tree delete must not consume a subtree while a durable child
     * intent still needs its original path or destination. Pending move
     * destinations matter too: deleting a folder that a move is entering
     * would otherwise erase the move's verified destination precondition.
     */
    private pendingOperationAtOrBelow(
        relPath: string,
        ignoreOperationId?: string,
    ): string | undefined {
        for (const [sourceRelPath, operation] of Object.entries(
            this.syncManifest?.pendingOperations ?? {},
        )) {
            if (operation.id===ignoreOperationId) { continue; }
            if (this.isPathAtOrBelow(sourceRelPath, relPath)) {
                return operation.kind==='move' || operation.kind==='directory-move'
                    ? `${sourceRelPath} -> ${operation.destinationRelPath} (${operation.kind})`
                    : `${sourceRelPath} (${operation.kind})`;
            }
            if (
                (operation.kind==='move' || operation.kind==='directory-move')
                && this.isPathAtOrBelow(operation.destinationRelPath, relPath)
            ) {
                return `${sourceRelPath} -> ${operation.destinationRelPath} (${operation.kind})`;
            }
        }
        return undefined;
    }

    private isPendingTreeMove(
        operation: SyncManifestPendingOperation,
    ): operation is SyncManifestPendingMoveOperation | SyncManifestPendingDirectoryMoveOperation {
        return operation.kind==='move' || operation.kind==='directory-move';
    }

    private pendingOperationIntersectingPaths(
        firstRelPath: string,
        secondRelPath: string,
        ignoreOperationId?: string,
    ): string | undefined {
        for (const [sourceRelPath, operation] of Object.entries(
            this.syncManifest?.pendingOperations ?? {},
        )) {
            if (operation.id===ignoreOperationId) { continue; }
            const operationPaths = this.isPendingTreeMove(operation)
                ? [sourceRelPath, operation.destinationRelPath]
                : [sourceRelPath];
            for (const operationPath of operationPaths) {
                if (
                    this.isPathAtOrBelow(operationPath, firstRelPath)
                    || this.isPathAtOrBelow(firstRelPath, operationPath)
                    || this.isPathAtOrBelow(operationPath, secondRelPath)
                    || this.isPathAtOrBelow(secondRelPath, operationPath)
                ) {
                    return this.isPendingTreeMove(operation)
                        ? `${sourceRelPath} -> ${operation.destinationRelPath} (${operation.kind})`
                        : `${sourceRelPath} (${operation.kind})`;
                }
            }
        }
        return undefined;
    }

    private pendingDirectoryMoveCovering(
        relPath: string,
    ): {sourceRelPath: string; record: SyncManifestPendingDirectoryMoveOperation} | undefined {
        for (const [sourceRelPath, operation] of Object.entries(
            this.syncManifest?.pendingOperations ?? {},
        )) {
            if (
                operation.kind==='directory-move'
                && (
                    this.isPathAtOrBelow(relPath, sourceRelPath)
                    || this.isPathAtOrBelow(relPath, operation.destinationRelPath)
                )
            ) {
                return {sourceRelPath, record: operation};
            }
        }
        return undefined;
    }
    private replayDeferredLocalEventsAfterDirectoryMove(
        destinationRelPath: string,
        generation: number,
    ): void {
        if (!this.isSyncSessionActive(generation)) { return; }
        for (const [relPath, pending] of [...this.deferredLocalEventsDuringDirectoryMove]) {
            if (!this.isPathAtOrBelow(relPath, destinationRelPath)) { continue; }
            this.deferredLocalEventsDuringDirectoryMove.delete(relPath);
            getOutputChannel().appendLine(
                new Date().toISOString() + ' [local event replay:folder-move] ' + relPath,
            );
            this.queueForcedPush(
                relPath,
                'local-event-during-folder-move',
                pending.latestType,
                pending.latestType==='update',
            );
        }
    }


    private touchesSyncConflict(relPath: string): boolean {
        return [...this.syncConflicts.keys()].some(path =>
            this.isPathAtOrBelow(relPath, path)
            || this.isPathAtOrBelow(path, relPath)
        );
    }

    private isTrackedDirectory(relPath: string): boolean {
        return this.syncManifest?.directories[relPath]!==undefined
            || [...this.seenLocalEntities].some(path => path.startsWith(`${relPath}/`))
            || Object.keys(this.syncManifest?.files ?? {}).some(path => path.startsWith(`${relPath}/`))
            || Object.keys(this.syncManifest?.directories ?? {}).some(path => path.startsWith(`${relPath}/`));
    }

    // A compile target whose local bytes will not hold still. It blocks the
    // compile (running it would publish a stale remote copy) with the clear
    // sentinel rather than a raw internal read error, and re-arms the path so
    // the block resolves itself once the writer finishes.
    private recordUnstableCompileTarget(
        relPath: string,
        localUri: vscode.Uri,
        result: LocalReplicaPrecompileFlushResult,
        generation: number,
    ): void {
        result.blockedCount += 1;
        result.failures.push(`${relPath}: ${LOCAL_SNAPSHOT_UNSTABLE}`);
        this.scheduleLocalPushRetry(relPath, localUri, 'unstable-read', generation);
    }

    // The precompile source scan infers these deletions from a single directory
    // enumeration, exactly the evidence the degraded-watcher scan is no longer
    // allowed to act on alone. It cannot use that scan's "look again in 750ms"
    // trick because the barrier runs once, so it re-observes here instead — and
    // it re-observes the whole candidate set TOGETHER, spending one bounded
    // window for any number of paths rather than a window per path. A barrier
    // with nothing deleted pays nothing; a bulk deletion of hundreds of files
    // pays one window, not one per file. Anything that reappears is withdrawn
    // from the delete set and re-armed instead. The re-arm lands in
    // pendingLocalEvents before this barrier captures that map, so the same pass
    // reclassifies the path and uploads it — a path that materialised
    // mid-enumeration was never considered for upload, and recovering it here is
    // better than failing a compile that is otherwise fine. If it then cannot be
    // read or pushed, the existing machinery blocks the compile as usual.
    private async corroborateSynthesizedDeletes(
        synthesized: Set<string>,
        forcedDeleteTargets: Map<string, vscode.Uri>,
        result: LocalReplicaPrecompileFlushResult,
        generation: number,
    ): Promise<void> {
        let pending = [...synthesized];
        for (const delay of LocalReplicaSCMProvider.localVanishRecheckDelays) {
            if (pending.length===0) { return; }
            await this.sleepForStabilization(delay);
            this.requireSyncSession(generation);
            const stillMissing: string[] = [];
            await Promise.all(pending.map(async relPath => {
                const localUri = this.localUri(relPath);
                if (!await this.localPathExists(localUri.fsPath)) {
                    stillMissing.push(relPath);
                    return;
                }
                forcedDeleteTargets.delete(relPath);
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [compile barrier delete withdrawn] ${relPath}: ` +
                    'the path reappeared after the source scan inferred its deletion',
                );
                this.scheduleLocalPushRetry(relPath, localUri, 'unstable-read', generation);
            }));
            pending = stillMissing;
        }
    }

    private async runPrecompilePush(
        relPath: string,
        localUri: vscode.Uri,
        result: LocalReplicaPrecompileFlushResult,
        options: ApplySyncOptions,
        generation: number,
        type: 'update' | 'delete' = 'update',
    ): Promise<void> {
        this.requireSyncSession(generation);
        result.attemptedCount += 1;
        result.paths.push(relPath);
        const vfsUri = this.vfs.pathToUri(relPath);
        const queuedBehindExistingSync = this.syncQueues.has(relPath);
        let alreadySynced = false;
        // enqueueSync's catch-all consumes anything escaping the task and
        // resolves to undefined, so an unstable read in the reclassification
        // below has to be reported out of band or it would surface as the
        // misleading "no sync completion event" with nothing scheduled.
        let unstableSnapshot = false;
        const event = await this.enqueueSync(
            relPath,
            async () => {
                let currentType = type;
                if (type==='delete' || queuedBehindExistingSync) {
                    let reclassifiedType: 'update' | 'delete' | undefined;
                    try {
                        reclassifiedType = await this.localTargetNeedsPush(relPath, localUri, type);
                    } catch (error) {
                        if (!LocalReplicaSCMProvider.isLocalReadUnstable(error)) { throw error; }
                        unstableSnapshot = true;
                        return undefined;
                    }
                    this.requireSyncSession(generation);
                    if (reclassifiedType===undefined) {
                        alreadySynced = true;
                        return undefined;
                    }
                    currentType = reclassifiedType;
                }
                return this.applySync(
                    'push',
                    currentType,
                    relPath,
                    localUri,
                    vfsUri,
                    options,
                    generation,
                );
            },
            generation,
        );
        this.requireSyncSession(generation);

        if (unstableSnapshot) {
            this.recordUnstableCompileTarget(relPath, localUri, result, generation);
            return;
        }
        if (alreadySynced) {
            this.locallyDivergedPaths.delete(relPath);
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [compile barrier already synced] ${relPath}`,
            );
            return;
        }
        if (!event) {
            result.failedCount += 1;
            result.failures.push(`${relPath}: no sync completion event`);
            return;
        }

        switch (event.outcome) {
            case 'success': {
                let remainingChange: 'update' | 'delete' | undefined;
                try {
                    remainingChange = await this.localTargetNeedsPush(relPath, localUri, type);
                } catch (error) {
                    if (!LocalReplicaSCMProvider.isLocalReadUnstable(error)) { throw error; }
                    // The upload itself landed; what we cannot prove is that the
                    // local file has stopped moving since. Block rather than let
                    // the compile run against a copy that may already be behind.
                    this.recordUnstableCompileTarget(relPath, localUri, result, generation);
                    break;
                }
                this.requireSyncSession(generation);
                if (remainingChange===undefined) {
                    this.locallyDivergedPaths.delete(relPath);
                } else {
                    // The upload was a legitimate intermediate revision, but
                    // compiling it would already be stale. Treat a stable newer
                    // revision exactly like an unstable read: keep retrying and
                    // block this compile with the same user-facing sentinel.
                    this.recordUnstableCompileTarget(relPath, localUri, result, generation);
                }
                break;
            }
            case 'suppressed':
                if (options.forcePush) {
                    result.blockedCount += 1;
                    result.failures.push(`${relPath}: forced sync was suppressed`);
                } else {
                    result.suppressedCount += 1;
                }
                break;
            case 'blocked':
                result.blockedCount += 1;
                result.failures.push(`${relPath}: ${event.error ?? 'blocked'}`);
                break;
            case 'error':
                result.failedCount += 1;
                result.failures.push(`${relPath}: ${event.error ?? 'sync failed'}`);
                break;
        }
    }

    private isContentKnownSynced(relPath: string, content: Uint8Array): boolean {
        const baseContent = this.baseCache[relPath];
        if (baseContent!==undefined && bytesEqual(baseContent, content)) {
            return true;
        }
        return this.syncManifest?.files[relPath]?.localDigest===contentDigest(content);
    }

    private recordAdvancedPrecompileTreePath(
        relPath: string,
        kind: PathRevision['kind'],
        result: LocalReplicaPrecompileFlushResult,
        generation: number,
        reportedPaths: Set<string>,
    ): void {
        if (reportedPaths.has(relPath)) { return; }
        reportedPaths.add(relPath);
        result.blockedCount += 1;
        result.failures.push(
            `${relPath}: local project changed while the compile barrier was sealing; `
            + 'synchronization was re-queued',
        );
        this.scheduleLocalPushRetry(
            relPath,
            this.localUri(relPath),
            'compile-tree-advanced',
            generation,
            kind==='missing' ? 'delete' : 'update',
        );
        getOutputChannel().appendLine(
            `${new Date().toISOString()} `
            + `[compile barrier blocked:local-advanced-during-quiescence] ${relPath}`,
        );
    }

    private async verifyPrecompileTreeQuiescent(
        result: LocalReplicaPrecompileFlushResult,
        generation: number,
    ): Promise<void> {
        if (result.blockedCount>0 || result.failedCount>0) {
            return;
        }

        // One whole-tree content scan already ran before the forced pushes.
        // Give writers a quiet window, then reuse that same proven scanner once
        // more against the now-current manifest. A second pre-sleep content
        // snapshot would add a third complete project read without improving
        // the final invariant: every path at the compile cut must match the
        // remote baseline, and an unstable read must fail closed.
        await this.sleepForStabilization(LocalReplicaSCMProvider.compileQuiescenceMs);
        this.requireSyncSession(generation);
        const localFilePaths = new Set<string>();
        const localDirectoryPaths = new Set<string>();
        const advancedTargets = new Map<string, vscode.Uri>();
        await this.collectChangedLocalTargets(
            this.baseUri,
            '/',
            localFilePaths,
            localDirectoryPaths,
            advancedTargets,
            result,
            generation,
            false,
        );
        this.requireSyncSession(generation);
        if (result.blockedCount>0 || result.failedCount>0) { return; }

        const advancedKinds = new Map<string, PathRevision['kind']>(
            [...advancedTargets.keys()].map(relPath => [relPath, 'file']),
        );
        const trackedFiles = new Set([
            ...Object.keys(this.baseCache),
            ...Object.keys(this.syncManifest?.files ?? {}),
        ]);
        for (const relPath of trackedFiles) {
            if (!this.matchIgnorePatterns(relPath) && !localFilePaths.has(relPath)) {
                advancedKinds.set(relPath, 'missing');
            }
        }
        for (const relPath of Object.keys(this.syncManifest?.directories ?? {})) {
            if (!this.matchIgnorePatterns(relPath) && !localDirectoryPaths.has(relPath)) {
                advancedKinds.set(relPath, 'missing');
            }
        }

        const reportedPaths = new Set<string>();
        for (const [relPath, kind] of advancedKinds) {
            this.recordAdvancedPrecompileTreePath(
                relPath,
                kind,
                result,
                generation,
                reportedPaths,
            );
        }
    }

    private async getLocalRootRealPath(): Promise<string> {
        if (this.localRootRealPath===undefined) {
            this.localRootRealPath = LocalReplicaSCMProvider.comparableFsPath(
                await nodeFs.realpath(this.baseUri.fsPath),
            );
        }
        return this.localRootRealPath;
    }

    private async assertLocalRealPathConfined(
        actualPath: string,
        operation: string,
    ): Promise<void> {
        const rootRealPath = await this.getLocalRootRealPath();
        const comparableActualPath = LocalReplicaSCMProvider.comparableFsPath(actualPath);
        const relative = nodePath.relative(rootRealPath, comparableActualPath);
        if (
            relative==='..'
            || relative.startsWith(`..${nodePath.sep}`)
            || nodePath.isAbsolute(relative)
        ) {
            throw new Error(
                `Local Replica ${operation} escaped the selected folder: ${actualPath}`,
            );
        }
    }

    private async captureLocalPathIdentitySnapshot(
        uri: vscode.Uri,
        operation: string,
    ): Promise<LocalPathIdentitySnapshot> {
        const basePath = nodePath.resolve(this.baseUri.fsPath);
        const targetPath = nodePath.resolve(uri.fsPath);
        const lexicalRelative = nodePath.relative(basePath, targetPath);
        if (
            lexicalRelative==='..'
            || lexicalRelative.startsWith(`..${nodePath.sep}`)
            || nodePath.isAbsolute(lexicalRelative)
        ) {
            throw new Error(
                `Local Replica ${operation} escaped the selected folder: ${targetPath}`,
            );
        }

        const paths = [basePath];
        let currentPath = basePath;
        for (const part of lexicalRelative.split(nodePath.sep).filter(Boolean)) {
            currentPath = nodePath.join(currentPath, part);
            paths.push(currentPath);
        }

        const entries: LocalPathIdentitySnapshot['entries'] = [];
        let finalStat: LocalPathIdentitySnapshot['finalStat'] | undefined;
        for (let index=0; index<paths.length; index++) {
            const candidatePath = paths[index];
            const stat = await nodeFs.lstat(candidatePath, {bigint: true});
            if (stat.isSymbolicLink()) {
                throw new Error(
                    `Local Replica ${operation} refuses symbolic links: ${candidatePath}`,
                );
            }
            if (index<paths.length-1 && !stat.isDirectory()) {
                throw new Error(
                    `Local Replica ${operation} encountered a non-directory ancestor: ${candidatePath}`,
                );
            }
            const mtime = String(
                (stat as unknown as {mtimeNs?: bigint}).mtimeNs ?? stat.mtimeMs,
            );
            const ctime = String(
                (stat as unknown as {ctimeNs?: bigint}).ctimeNs ?? stat.ctimeMs,
            );
            entries.push({
                path: LocalReplicaSCMProvider.comparableFsPath(candidatePath),
                identity: [
                    stat.dev,
                    stat.ino,
                    stat.mode,
                    stat.nlink,
                    stat.size,
                    mtime,
                    ctime,
                ].join(':'),
            });
            if (index===paths.length-1) {
                finalStat = {
                    isFile: stat.isFile(),
                    isDirectory: stat.isDirectory(),
                    ctimeMs: Number(stat.ctimeMs),
                    mtimeMs: Number(stat.mtimeMs),
                    size: Number(stat.size),
                    dev: String(stat.dev),
                    ino: String(stat.ino),
                };
            }
        }
        await this.assertLocalRealPathConfined(
            await nodeFs.realpath(targetPath),
            operation,
        );
        return {entries, finalStat: finalStat!};
    }

    private localPathIdentitySnapshotsEqual(
        left: LocalPathIdentitySnapshot,
        right: LocalPathIdentitySnapshot,
    ): boolean {
        return left.entries.length===right.entries.length
            && left.entries.every((entry, index) =>
                entry.path===right.entries[index].path
                && entry.identity===right.entries[index].identity
            );
    }

    private readOpenedLocalFile(handle: nodeFs.FileHandle): Promise<Buffer> {
        return handle.readFile();
    }

    private async statConfinedLocalUri(
        uri: vscode.Uri,
        operation: string,
    ): Promise<vscode.FileStat> {
        if (uri.scheme!=='file' || this.baseUri.scheme!=='file') {
            const stat = await vscode.workspace.fs.stat(uri);
            if ((stat.type & vscode.FileType.SymbolicLink)!==0) {
                throw new Error(`Local Replica ${operation} refuses symbolic links: ${uri.toString()}`);
            }
            return stat;
        }

        const snapshot = await this.captureLocalPathIdentitySnapshot(uri, operation);
        const type = snapshot.finalStat.isFile
            ? vscode.FileType.File
            : snapshot.finalStat.isDirectory
                ? vscode.FileType.Directory
                : vscode.FileType.Unknown;
        return {
            type,
            ctime: snapshot.finalStat.ctimeMs,
            mtime: snapshot.finalStat.mtimeMs,
            size: snapshot.finalStat.size,
        };
    }

    private async readConfinedLocalFile(
        relPath: string,
        uri: vscode.Uri = this.localUri(relPath),
    ): Promise<Uint8Array> {
        return (await this.readConfinedLocalFileSnapshot(relPath, uri)).content;
    }

    // Same read, but it also hands back the metadata of the revision the bytes
    // actually came from. On the descriptor path that metadata is taken from the
    // fd whose pre/post stats were just proven identical, never from a later
    // path lstat: an atomic replace between the read and such an lstat would
    // otherwise pair one revision's bytes with another revision's mtime, and the
    // remote-delete echo check decides whether to erase the local file from
    // exactly that pairing.
    private async readConfinedLocalFileSnapshot(
        relPath: string,
        uri: vscode.Uri = this.localUri(relPath),
    ): Promise<{content: Uint8Array; stat: vscode.FileStat}> {
        if (uri.scheme!=='file' || this.baseUri.scheme!=='file') {
            const stat = await this.statConfinedLocalUri(uri, `read of ${relPath}`);
            return {content: await vscode.workspace.fs.readFile(uri), stat};
        }

        const before = await this.captureLocalPathIdentitySnapshot(
            uri,
            `read of ${relPath}`,
        );
        const flags = nodeFsConstants.O_RDONLY
            | (nodeFsConstants.O_NOFOLLOW ?? 0);
        const handle = await nodeFs.open(uri.fsPath, flags);
        try {
            const descriptorStat = await handle.stat({bigint: true});
            if (!descriptorStat.isFile()) {
                throw new Error(`Local Replica read expected a regular file: ${uri.fsPath}`);
            }
            if (
                String(descriptorStat.dev)!==before.finalStat.dev
                || String(descriptorStat.ino)!==before.finalStat.ino
            ) {
                throw new LocalReadUnstableError(
                    relPath,
                    'reopened-different-inode',
                    `Local Replica read target changed while it was opened: ${uri.fsPath}`,
                );
            }
            const descriptorPathPrefix = process.platform==='linux'
                ? '/proc/self/fd'
                : undefined;
            let descriptorPathValidated = false;
            if (descriptorPathPrefix!==undefined) {
                const descriptorPath = await nodeFs.realpath(
                    `${descriptorPathPrefix}/${handle.fd}`,
                ).catch(() => undefined);
                if (descriptorPath!==undefined) {
                    descriptorPathValidated = true;
                    await this.assertLocalRealPathConfined(
                        descriptorPath,
                        `read of ${relPath}`,
                    );
                }
            }
            const content = await this.readOpenedLocalFile(handle);
            if (descriptorPathValidated) {
                const descriptorPath = await nodeFs.realpath(
                    `${descriptorPathPrefix}/${handle.fd}`,
                );
                await this.assertLocalRealPathConfined(
                    descriptorPath,
                    `read of ${relPath}`,
                );
                const pathStat = await nodeFs.lstat(uri.fsPath, {bigint: true});
                // A symlink appearing at the path is a security refusal and stays
                // a plain, immediate error. A plain dev/ino move is just a writer
                // replacing the file, which retrying resolves.
                if (pathStat.isSymbolicLink()) {
                    throw new Error(
                        `Local Replica read refuses symbolic links: ${uri.fsPath}`,
                    );
                }
                if (
                    String(pathStat.dev)!==String(descriptorStat.dev)
                    || String(pathStat.ino)!==String(descriptorStat.ino)
                ) {
                    throw new LocalReadUnstableError(
                        relPath,
                        'path-identity-changed',
                        `Local Replica read path changed during confinement validation: ${uri.fsPath}`,
                    );
                }
                await this.assertLocalRealPathConfined(
                    await nodeFs.realpath(uri.fsPath),
                    `read of ${relPath}`,
                );
            } else {
                // captureLocalPathIdentitySnapshot has already refused symlinks
                // and escapes on its own, so anything left here is identity drift.
                const after = await this.captureLocalPathIdentitySnapshot(
                    uri,
                    `read of ${relPath}`,
                );
                if (
                    !this.localPathIdentitySnapshotsEqual(before, after)
                    || after.finalStat.dev!==String(descriptorStat.dev)
                    || after.finalStat.ino!==String(descriptorStat.ino)
                ) {
                    throw new LocalReadUnstableError(
                        relPath,
                        'path-identity-changed',
                        `Local Replica read path changed during confinement validation: ${uri.fsPath}`,
                    );
                }
            }
            const descriptorStatAfter = await handle.stat({bigint: true});
            if (
                descriptorStatAfter.dev!==descriptorStat.dev
                || descriptorStatAfter.ino!==descriptorStat.ino
                || descriptorStatAfter.size!==descriptorStat.size
                || descriptorStatAfter.mtimeNs!==descriptorStat.mtimeNs
                || descriptorStatAfter.ctimeNs!==descriptorStat.ctimeNs
            ) {
                throw new LocalReadUnstableError(
                    relPath,
                    'descriptor-changed',
                    `Local Replica read target changed while bytes were read: ${uri.fsPath}`,
                );
            }
            // Independent witness. Every field compared above can be identical
            // across a rewrite that landed inside one coarse filesystem timestamp
            // tick, so metadata alone cannot prove the read saw a single
            // revision. The byte count catches the common truncate-then-write
            // shape, where the reader can observe the file while it is short.
            // It does NOT catch a same-length in-place overwrite — nothing
            // metadata-based can — which is why recordSyncManifestEntry still
            // re-reads and byte-compares after every push.
            if (content.length!==Number(descriptorStatAfter.size)) {
                throw new LocalReadUnstableError(
                    relPath,
                    'descriptor-changed',
                    `Local Replica read returned ${content.length} bytes for a ` +
                    `${descriptorStatAfter.size}-byte revision: ${uri.fsPath}`,
                );
            }
            return {
                content,
                stat: {
                    type: vscode.FileType.File,
                    ctime: Number(descriptorStatAfter.ctimeMs),
                    mtime: Number(descriptorStatAfter.mtimeMs),
                    size: Number(descriptorStatAfter.size),
                },
            };
        } finally {
            await handle.close();
        }
    }

    private async captureLocalPathIdentity(
        fsPath: string,
    ): Promise<LocalReadIdentity | undefined> {
        try {
            const stat = await nodeFs.lstat(fsPath, {bigint: true});
            return {
                dev: String(stat.dev),
                ino: String(stat.ino),
                size: String(stat.size),
                mtimeNs: String(
                    (stat as unknown as {mtimeNs?: bigint}).mtimeNs ?? stat.mtimeMs,
                ),
                ctimeNs: String(
                    (stat as unknown as {ctimeNs?: bigint}).ctimeNs ?? stat.ctimeMs,
                ),
            };
        } catch {
            return undefined;
        }
    }

    // Does the path still hold the exact file object an earlier observation saw?
    // Bytes alone cannot answer that: an atomic recreate with identical content
    // is a different inode with a fresh mtime, and is a legitimate user action
    // rather than the revision we authorized removing. `includeCtime` is false after a
    // quarantine rename, which necessarily bumps ctime while leaving dev, ino,
    // size and mtime intact.
    private async localPathIdentityMatches(
        fsPath: string,
        expected: LocalReadIdentity,
        includeCtime: boolean,
    ): Promise<boolean> {
        try {
            const stat = await nodeFs.lstat(fsPath, {bigint: true});
            const mtimeNs = String(
                (stat as unknown as {mtimeNs?: bigint}).mtimeNs ?? stat.mtimeMs,
            );
            const ctimeNs = String(
                (stat as unknown as {ctimeNs?: bigint}).ctimeNs ?? stat.ctimeMs,
            );
            return String(stat.dev)===expected.dev
                && String(stat.ino)===expected.ino
                && String(stat.size)===expected.size
                && mtimeNs===expected.mtimeNs
                && (!includeCtime || ctimeNs===expected.ctimeNs);
        } catch {
            return false;
        }
    }

    // Bounded in-task backoff around the confined read. A read that lands in the
    // middle of someone else's write is the normal case for a compiling project,
    // so it is deferred silently here rather than reported. Exhausting the delays
    // rethrows the typed error, and the caller re-arms the path: the guarantee is
    // to retry indefinitely and upload the first revision observed to be settled,
    // not that a file being rewritten forever must eventually upload. "Settled"
    // is what the descriptor guard can witness — identity, size, timestamps and
    // byte count — which a same-length in-place overwrite inside one coarse
    // timestamp tick can still slip past; recordSyncManifestEntry's post-push
    // re-read is the backstop that turns such a slip into a re-drive.
    private async readStableConfinedLocalFile(
        relPath: string,
        uri: vscode.Uri = this.localUri(relPath),
        generation = this.syncGeneration,
    ): Promise<{content: Uint8Array; stat: vscode.FileStat}> {
        const delays = LocalReplicaSCMProvider.localReadStabilizeDelays;
        for (let attempt = 0; ; attempt++) {
            try {
                // Callers re-check the session immediately after this returns, so
                // the generation is only used to stop burning the backoff budget
                // on a session that is already gone.
                return await this.readConfinedLocalFileSnapshot(relPath, uri);
            } catch (error) {
                if (
                    !LocalReplicaSCMProvider.isLocalReadUnstable(error)
                    || attempt>=delays.length
                    || !this.isSyncSessionActive(generation)
                ) {
                    throw error;
                }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local read deferred:${error.reason}] ${relPath} ` +
                    `(attempt ${attempt+1}/${delays.length+1})`,
                );
                await this.sleepForStabilization(delays[attempt]);
                // Re-check on the way out of the sleep, not only on the way in:
                // disposal during the backoff must not be followed by another
                // round of disk I/O against a torn-down replica.
                if (!this.isSyncSessionActive(generation)) {
                    throw error;
                }
            }
        }
    }

    // A backoff sleep that a session teardown can cut short. stopSyncInputs wakes
    // every outstanding sleeper so the loop above re-checks and bails instead of
    // holding shutdown for the remainder of its delay.
    private sleepForStabilization(ms: number): Promise<void> {
        return new Promise<void>(resolve => {
            let entry!: {timer: ReturnType<typeof setTimeout>; wake: () => void};
            entry = {
                timer: setTimeout(() => {
                    this.stabilizeSleeps.delete(entry);
                    resolve();
                }, ms),
                wake: resolve,
            };
            this.stabilizeSleeps.add(entry);
        });
    }

    // An atomic temp-file replacement (latexmk, an editor's write-temp+rename)
    // can make the path vanish for microseconds. Classification already
    // concluded this path is an update, so ENOENT here is the weakest possible
    // evidence for a destructive remote delete: defer and let the re-armed push
    // re-classify against whatever is on disk once the writer is done.
    private asVanishedDuringUpdate(
        relPath: string,
        type: 'update' | 'delete',
        error: unknown,
    ): unknown {
        if (type!=='update' || !LocalReplicaSCMProvider.isFileNotFoundError(error)) {
            return error;
        }
        return new LocalReadUnstableError(
            relPath,
            'vanished-during-update',
            `Local Replica push target vanished while an update was being applied: ${relPath}`,
        );
    }

    private async statPushSourceOrDeferVanished(
        relPath: string,
        fromUri: vscode.Uri,
        type: 'update' | 'delete',
    ): Promise<vscode.FileStat> {
        try {
            return await this.statConfinedLocalUri(
                fromUri,
                `push classification of ${relPath}`,
            );
        } catch (error) {
            throw this.asVanishedDuringUpdate(relPath, type, error);
        }
    }

    private async readPushSourceOrDeferVanished(
        relPath: string,
        fromUri: vscode.Uri,
        type: 'update' | 'delete',
        generation: number,
    ): Promise<{content: Uint8Array; stat: vscode.FileStat}> {
        try {
            return await this.readStableConfinedLocalFile(relPath, fromUri, generation);
        } catch (error) {
            throw this.asVanishedDuringUpdate(relPath, type, error);
        }
    }

    // Classification and the precompile source scan both read through here, so
    // stabilizing at this one seam is what makes a mid-write file defer instead
    // of being reported as a classification failure or a scan failure.
    private readLocalFile(uri: vscode.Uri): Thenable<Uint8Array> {
        const relPath = this.relPathFromLocalFileUri(uri, 'read local file');
        if (relPath===undefined) {
            return Promise.reject(new Error(
                `Local Replica read is outside the selected folder: ${uri.toString()}`,
            ));
        }
        return this.readStableConfinedLocalFile(relPath, uri)
            .then(snapshot => snapshot.content);
    }

    // `observedType` is what the local watcher actually reported. A Change or
    // Create event for a path that is momentarily gone is an atomic replacement
    // caught mid-flight, not a user deletion, so a single ENOENT observation is
    // not enough evidence to propagate a destructive remote delete. Watchers do
    // however mislabel real deletions as changes, so the extra evidence is
    // bounded: once the path has been continuously absent across the recheck
    // window it is treated as a genuine delete.
    private async localTargetNeedsPush(
        relPath: string,
        localUri: vscode.Uri,
        observedType?: 'update' | 'delete',
    ): Promise<'update' | 'delete' | undefined> {
        const recheckDelays = LocalReplicaSCMProvider.localVanishRecheckDelays;
        // Captured once: a teardown followed quickly by a new session bumps the
        // generation, and this classification must abort rather than read again
        // on behalf of a session that no longer exists.
        const generation = this.syncGeneration;
        for (let attempt = 0; ; attempt++) {
            try {
                const stat = await this.statConfinedLocalUri(
                    localUri,
                    `classification of ${relPath}`,
                );
                if (stat.type===vscode.FileType.Directory) {
                    return this.syncManifest?.directories[relPath] ? undefined : 'update';
                }
                if (stat.type!==vscode.FileType.File) {
                    return undefined;
                }
                const content = await this.readLocalFile(localUri);
                return this.isContentKnownSynced(relPath, content) ? undefined : 'update';
            } catch (error) {
                if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                    throw error;
                }
                if (
                    !this.syncManifest?.files[relPath]
                    && !this.syncManifest?.directories[relPath]
                    && !(relPath in this.baseCache)
                    && !this.seenLocalEntities.has(relPath)
                    && !this.touchesSyncConflict(relPath)
                ) {
                    return undefined;
                }
                if (
                    observedType!=='update'
                    || attempt>=recheckDelays.length
                    || !this.isSyncSessionActive(generation)
                ) {
                    return 'delete';
                }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [classification recheck:vanished-during-update] ${relPath} ` +
                    `(attempt ${attempt+1}/${recheckDelays.length})`,
                );
                await this.sleepForStabilization(recheckDelays[attempt]);
                // Re-check on the way out of the sleep: a teardown during the
                // recheck must not be followed by another confined read.
                this.requireSyncSession(generation);
            }
        }
    }

    private cancelPendingDescendantEvents(
        action: 'push' | 'pull',
        relPath: string,
    ): void {
        const pendingEvents = action==='push'
            ? this.pendingLocalEvents
            : this.pendingVfsEvents;
        for (const [pendingPath, pending] of [...pendingEvents]) {
            if (pendingPath===relPath || !this.isPathAtOrBelow(pendingPath, relPath)) {
                continue;
            }
            clearTimeout(pending.timer);
            pendingEvents.delete(pendingPath);
        }
    }

    private async promoteDeleteToMissingTrackedDirectory(
        action: 'push' | 'pull',
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<string> {
        this.requireSyncSession(generation);
        const parts = normalizeReplicaPath(relPath).split('/').filter(Boolean);
        for (let depth=1; depth<=parts.length; depth++) {
            const candidate = `/${parts.slice(0, depth).join('/')}`;
            if (this.syncManifest?.directories[candidate]===undefined) {
                continue;
            }
            const sourceUri = action==='push'
                ? this.localUri(candidate)
                : this.vfs.pathToUri(candidate);
            try {
                const stat = await vscode.workspace.fs.stat(sourceUri);
                this.requireSyncSession(generation);
                if (stat.type!==vscode.FileType.Directory) {
                    return relPath;
                }
            } catch (error) {
                if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                    throw error;
                }
                this.cancelPendingDescendantEvents(action, candidate);
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [${action} delete coalesced] ` +
                    `${relPath} -> ${candidate}`,
                );
                return candidate;
            }
        }
        return relPath;
    }

    private async reconcileDirectoryDescendants(
        action: 'push' | 'pull',
        rootRelPath: string,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const directories: string[] = [];
        const files: string[] = [];
        const queue = [rootRelPath];
        const visitedLocalDirectories = new Set<string>();
        const localRootRealPath = action==='push' && this.baseUri.scheme==='file'
            ? LocalReplicaSCMProvider.comparableFsPath(
                await nodeFs.realpath(this.baseUri.fsPath),
            )
            : undefined;
        const inspectLocalPath = async (
            uri: vscode.Uri,
        ): Promise<Awaited<ReturnType<typeof nodeFs.lstat>> | undefined> => {
            if (action!=='push' || uri.scheme!=='file') {
                return undefined;
            }
            let stat: Awaited<ReturnType<typeof nodeFs.lstat>>;
            try {
                stat = await nodeFs.lstat(uri.fsPath);
            } catch (error) {
                if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                    return undefined;
                }
                throw error;
            }
            if (stat.isSymbolicLink()) {
                throw new Error(
                    `Local Replica directory reconciliation refuses symbolic links: ${uri.fsPath}`,
                );
            }
            const realPath = LocalReplicaSCMProvider.comparableFsPath(
                await nodeFs.realpath(uri.fsPath),
            );
            if (localRootRealPath!==undefined) {
                const relative = nodePath.relative(localRootRealPath, realPath);
                if (
                    relative==='..'
                    || relative.startsWith(`..${nodePath.sep}`)
                    || nodePath.isAbsolute(relative)
                ) {
                    throw new Error(
                        `Local Replica directory reconciliation escaped the selected folder: ${uri.fsPath}`,
                    );
                }
            }
            return stat;
        };
        while (queue.length>0) {
            const directoryPath = queue.shift()!;
            const sourceUri = action==='push'
                ? this.localUri(directoryPath)
                : this.vfs.pathToUri(directoryPath);
            if (action==='push') {
                const directoryStat = await inspectLocalPath(sourceUri);
                this.requireSyncSession(generation);
                if (directoryStat===undefined) {
                    continue;
                }
                if (!directoryStat.isDirectory()) {
                    throw new Error(
                        `Local Replica directory changed type during reconciliation: ${sourceUri.fsPath}`,
                    );
                }
                const realPath = LocalReplicaSCMProvider.comparableFsPath(
                    await nodeFs.realpath(sourceUri.fsPath),
                );
                if (visitedLocalDirectories.has(realPath)) {
                    throw new Error(
                        `Local Replica directory reconciliation encountered a directory cycle: ${sourceUri.fsPath}`,
                    );
                }
                visitedLocalDirectories.add(realPath);
            }
            const entries = await vscode.workspace.fs.readDirectory(sourceUri);
            this.requireSyncSession(generation);
            for (const [name, type] of entries) {
                const relPath = this.requireConfinedRelPath(
                    `${directoryPath.replace(/\/+$/, '')}/${name}`,
                    `${action} directory descendant reconciliation`,
                );
                if (
                    this.matchIgnorePatterns(relPath)
                    || this.matchIgnorePatterns(`${relPath}/`)
                ) {
                    continue;
                }
                const localStat = action==='push'
                    ? await inspectLocalPath(this.localUri(relPath))
                    : undefined;
                this.requireSyncSession(generation);
                if (action==='push' && localStat===undefined) {
                    continue;
                }
                const isDirectory = localStat
                    ? localStat.isDirectory()
                    : (type & vscode.FileType.Directory)===vscode.FileType.Directory;
                const isFile = localStat
                    ? localStat.isFile()
                    : (type & vscode.FileType.File)===vscode.FileType.File;
                if (isDirectory) {
                    directories.push(relPath);
                    queue.push(relPath);
                } else if (isFile) {
                    files.push(relPath);
                }
            }
        }

        for (const relPath of [...directories, ...files]) {
            this.requireSyncSession(generation);
            const localUri = this.localUri(relPath);
            const vfsUri = this.vfs.pathToUri(relPath);
            const event = await this.enqueueSync(
                relPath,
                () => this.applySync(
                    action,
                    'update',
                    relPath,
                    action==='push' ? localUri : vfsUri,
                    action==='push' ? vfsUri : localUri,
                    {skipDirectoryDescendants: true},
                    generation,
                ),
                generation,
                true,
            );
            this.requireSyncSession(generation);
            if (event===undefined) {
                throw new Error(`Could not queue ${relPath} after ${rootRelPath}`);
            }
            // A child that is being replaced or written by an agent may become
            // unstable after the parent directory enumeration. `applySync`
            // has already retained the local intent and scheduled its keyed
            // stabilization retry, so failing the whole parent reconciliation
            // here only strands an otherwise valid promoted delete/update
            // behind it. Keep the stable subset reconciled and let that child
            // retry once its writer settles.
            if (
                action==='push'
                && event.outcome==='blocked'
                && event.error===LOCAL_SNAPSHOT_UNSTABLE
            ) {
                continue;
            }
            if (event.outcome==='error' || event.outcome==='blocked') {
                throw new Error(
                    `Could not reconcile ${relPath} after ${rootRelPath}: ` +
                    `${event.error ?? event.outcome}`,
                );
            }
        }
    }

    private async collectChangedLocalTargets(
        dirUri: vscode.Uri,
        dirRelPath: string,
        localFilePaths: Set<string>,
        localDirectoryPaths: Set<string>,
        forcedTargets: Map<string, vscode.Uri>,
        result: LocalReplicaPrecompileFlushResult,
        generation: number,
        countSourceScan = true,
    ): Promise<void> {
        this.requireSyncSession(generation);
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(dirUri);
            this.requireSyncSession(generation);
        } catch (error) {
            if (!this.isSyncSessionActive(generation)) {
                throw error;
            }
            result.failedCount += 1;
            result.failures.push(`${dirRelPath}: ${formatUnknownError(error)}`);
            return;
        }

        for (const [name, fileType] of entries) {
            const relPath = this.normalizeConfinedRelPath(
                `${dirRelPath.replace(/\/+$/, '')}/${name}`,
                'precompile local source scan',
            );
            if (relPath===undefined || this.matchIgnorePatterns(relPath) || this.matchIgnorePatterns(`${relPath}/`)) {
                continue;
            }

            const uri = vscode.Uri.joinPath(dirUri, name);
            if (fileType===vscode.FileType.Directory) {
                localDirectoryPaths.add(relPath);
                if (!this.syncManifest?.directories[relPath]) {
                    forcedTargets.set(relPath, uri);
                    if (countSourceScan) { result.sourceScanCount += 1; }
                }
                await this.collectChangedLocalTargets(
                    uri,
                    relPath,
                    localFilePaths,
                    localDirectoryPaths,
                    forcedTargets,
                    result,
                    generation,
                    countSourceScan,
                );
                continue;
            }
            if (fileType!==vscode.FileType.File) {
                result.blockedCount += 1;
                result.failures.push(
                    `${relPath}: unsupported local filesystem entry cannot be synchronized`,
                );
                continue;
            }

            localFilePaths.add(relPath);
            let localContent: Uint8Array;
            try {
                localContent = await this.readLocalFile(uri);
                this.requireSyncSession(generation);
            } catch (error) {
                if (!this.isSyncSessionActive(generation)) {
                    throw error;
                }
                if (LocalReplicaSCMProvider.isLocalReadUnstable(error)) {
                    // Counted as blocked rather than failed on purpose: the scan
                    // itself is complete (relPath is already in localFilePaths,
                    // so delete synthesis cannot mistake it for missing) and
                    // [compile barrier scan incomplete] must stay reserved for a
                    // genuinely truncated enumeration.
                    this.recordUnstableCompileTarget(relPath, uri, result, generation);
                    continue;
                }
                result.failedCount += 1;
                result.failures.push(`${relPath}: ${formatUnknownError(error)}`);
                continue;
            }

            if (!this.isContentKnownSynced(relPath, localContent)) {
                forcedTargets.set(relPath, uri);
                if (countSourceScan) { result.sourceScanCount += 1; }
            }
        }
    }

    // Force the pending push for a local URI to fire NOW (cancelling its
    // debounce timer) and resolve when the resulting sync settles. If the
    // watcher hasn't fired yet, synthesise a push so callers that need the
    // VFS to reflect a just-saved file (e.g. compile-on-save) don't race
    // with the EVENT_COALESCE_MS window in syncToVFS.
    public async flushPendingPush(localUri: vscode.Uri): Promise<void> {
        const generation = this.syncGeneration;
        if (!this.isSyncSessionActive(generation)) { return; }
        const relPath = this.relPathFromLocalFileUri(localUri, 'flush pending push');
        if (relPath===undefined) { return; }
        if (this.matchIgnorePatterns(relPath)) { return; }

        const pending = this.pendingLocalEvents.get(relPath);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingLocalEvents.delete(relPath);
            const currentType = await this.localTargetNeedsPush(
                relPath,
                pending.latestUri,
                pending.latestType,
            );
            this.requireSyncSession(generation);
            if (currentType===undefined) { return; }
            const vfsUri = this.vfs.pathToUri(relPath);
            await this.enqueueSync(
                relPath,
                () => this.applySync('push', currentType, relPath, pending.latestUri, vfsUri, {}, generation),
                generation,
            );
            return;
        }

        // No debounced event yet — the watcher may simply not have fired
        // before onDidSaveTextDocument. Synthesise a push so the VFS is
        // current before the caller proceeds.
        const currentType = await this.localTargetNeedsPush(relPath, localUri, 'update');
        this.requireSyncSession(generation);
        if (currentType===undefined) { return; }
        const vfsUri = this.vfs.pathToUri(relPath);
        await this.enqueueSync(
            relPath,
            () => this.applySync('push', currentType, relPath, localUri, vfsUri, {}, generation),
            generation,
        );
    }

    public async flushBeforeCompile(localUris: vscode.Uri[] = []): Promise<LocalReplicaPrecompileFlushResult> {
        const generation = this.syncGeneration;
        this.requireSyncSession(generation);
        const result: LocalReplicaPrecompileFlushResult = {
            pendingCount: 0,
            divergedCount: 0,
            openDocCount: 0,
            sourceScanCount: 0,
            sourceScanDeleteCount: 0,
            attemptedCount: 0,
            failedCount: 0,
            blockedCount: 0,
            suppressedCount: 0,
            paths: [],
            failures: [],
        };
        await this.waitForStartupReadinessBeforeCompile(generation);
        const startupReplayPending = this.startupReplayGeneration===generation;
        const startupReplayFailure = this.startupReplayFailure?.generation===generation
            ? this.startupReplayFailure.message
            : undefined;
        if (startupReplayPending || startupReplayFailure!==undefined) {
            const state = startupReplayPending ? 'pending' : 'failed';
            const reason = startupReplayPending
                ? 'startup watcher changes are still being reconciled; wait for '
                    + '[startup buffered sync complete] before compiling'
                : 'startup watcher change reconciliation failed; reload the window to retry: '
                    + startupReplayFailure;
            result.blockedCount = 1;
            result.failures.push(reason);
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [compile barrier start] base=${this.baseUri.toString()} ` +
                'pending=0 diverged=0 openDocs=0 sourceScan=0 sourceDeletes=0 ' +
                `remoteVerify=${this.pendingInitialDocumentSubscriptions.size} startupReplay=${state}`,
            );
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [compile barrier blocked:startup-replay-${state}] ` +
                `base=${this.baseUri.toString()} reason=${reason}`,
            );
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [compile barrier end] base=${this.baseUri.toString()} ` +
                'attempted=0 suppressed=0 blocked=1 failed=0',
            );
            throw new Error(`Local Replica precompile flush failed: ${reason}`);
        }
        await this.recoverChangedCommittedLocalOperations(generation);
        const subscriptionVerificationPaths = [
            ...this.pendingInitialDocumentSubscriptions,
        ];
        for (const relPath of subscriptionVerificationPaths) {
            result.blockedCount += 1;
            result.paths.push(relPath);
            result.failures.push(
                `${relPath}: initial Overleaf document subscription is still being verified`,
            );
        }

        const forcedTargets = new Map<string, vscode.Uri>();
        const forcedDeleteTargets = new Map<string, vscode.Uri>();
        const explicitTargets = new Set<string>();
        // These classifications used to escape flushBeforeCompile entirely, so a
        // mid-write file aborted the barrier before [compile barrier end] was
        // logged and surfaced a raw internal read error. Security refusals still
        // propagate untouched.
        // 'unstable' is distinct from undefined: undefined means the path is
        // provably in sync, while unstable means we could not tell — and the
        // caller must not then clear the path's divergence.
        const classifyCompileTarget = async (
            relPath: string,
            localUri: vscode.Uri,
            observedType?: 'update' | 'delete',
        ): Promise<'update' | 'delete' | 'unstable' | undefined> => {
            try {
                return await this.localTargetNeedsPush(relPath, localUri, observedType);
            } catch (error) {
                if (!LocalReplicaSCMProvider.isLocalReadUnstable(error)) { throw error; }
                this.recordUnstableCompileTarget(relPath, localUri, result, generation);
                return 'unstable';
            }
        };
        for (const localUri of localUris) {
            const relPath = this.relPathFromLocalFileUri(localUri, 'precompile saved document flush');
            if (relPath===undefined || this.matchIgnorePatterns(relPath)) { continue; }
            explicitTargets.add(relPath);
            const type = await classifyCompileTarget(relPath, localUri, 'update');
            this.requireSyncSession(generation);
            if (type==='update') {
                forcedTargets.set(relPath, localUri);
            } else if (type==='delete') {
                forcedDeleteTargets.set(relPath, localUri);
            }
        }

        const divergedPaths = [...this.locallyDivergedPaths];
        result.divergedCount = divergedPaths.length;
        for (const relPath of divergedPaths) {
            if (this.matchIgnorePatterns(relPath)) { continue; }
            const localUri = this.localUri(relPath);
            const type = await classifyCompileTarget(relPath, localUri, 'update');
            this.requireSyncSession(generation);
            if (type==='update') {
                forcedTargets.set(relPath, localUri);
            } else if (type==='delete') {
                forcedDeleteTargets.set(relPath, localUri);
            }
        }

        const localFilePaths = new Set<string>();
        const localDirectoryPaths = new Set<string>();
        await this.collectChangedLocalTargets(
            this.baseUri,
            '/',
            localFilePaths,
            localDirectoryPaths,
            forcedTargets,
            result,
            generation,
        );
        this.requireSyncSession(generation);
        const synthesizedDeletePaths = new Set<string>();
        if (result.failedCount===0) {
            const trackedFiles = new Set([
                ...Object.keys(this.baseCache),
                ...Object.keys(this.syncManifest?.files ?? {}),
            ]);
            for (const relPath of trackedFiles) {
                if (this.matchIgnorePatterns(relPath) || localFilePaths.has(relPath)) {
                    continue;
                }
                forcedDeleteTargets.set(relPath, this.localUri(relPath));
                synthesizedDeletePaths.add(relPath);
                result.sourceScanDeleteCount += 1;
            }
            for (const relPath of Object.keys(this.syncManifest?.directories ?? {})) {
                if (this.matchIgnorePatterns(relPath) || localDirectoryPaths.has(relPath)) {
                    continue;
                }
                forcedDeleteTargets.set(relPath, this.localUri(relPath));
                synthesizedDeletePaths.add(relPath);
                result.sourceScanDeleteCount += 1;
            }
        } else {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [compile barrier scan incomplete] ` +
                `skipping delete synthesis for base=${this.baseUri.toString()}`,
            );
        }

        await this.corroborateSynthesizedDeletes(
            synthesizedDeletePaths,
            forcedDeleteTargets,
            result,
            generation,
        );
        this.requireSyncSession(generation);

        const pendingEntries = [...this.pendingLocalEvents.entries()];
        result.pendingCount = pendingEntries.length;
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [compile barrier start] base=${this.baseUri.toString()} ` +
            `pending=${result.pendingCount} diverged=${result.divergedCount} openDocs=${result.openDocCount} ` +
            `sourceScan=${result.sourceScanCount} sourceDeletes=${result.sourceScanDeleteCount} ` +
            `remoteVerify=${subscriptionVerificationPaths.length}`,
        );

        for (const [relPath, pending] of pendingEntries) {
            if (this.pendingLocalEvents.get(relPath)!==pending) { continue; }
            clearTimeout(pending.timer);
            this.pendingLocalEvents.delete(relPath);
            const currentType = await classifyCompileTarget(
                relPath,
                pending.latestUri,
                pending.latestType,
            );
            this.requireSyncSession(generation);
            if (currentType==='unstable') { continue; }
            if (currentType===undefined) {
                this.locallyDivergedPaths.delete(relPath);
                continue;
            }
            if (currentType==='update') {
                forcedDeleteTargets.delete(relPath);
                forcedTargets.set(relPath, pending.latestUri);
            } else {
                forcedTargets.delete(relPath);
                forcedDeleteTargets.set(relPath, pending.latestUri);
            }
        }

        const changedTargetPaths = new Set([
            ...forcedTargets.keys(),
            ...forcedDeleteTargets.keys(),
        ]);
        const conflictResolutionTargets = new Set<string>();
        const conflictPrerequisiteTargets = new Set<string>();
        const relevantConflicts = [...this.syncConflicts.keys()].filter(conflictPath =>
            [...changedTargetPaths].some(relPath =>
                this.isPathAtOrBelow(relPath, conflictPath)
                || this.isPathAtOrBelow(conflictPath, relPath)
            )
        );
        for (const conflictPath of relevantConflicts) {
            if (await this.isConflictStateResolved(conflictPath, generation)) {
                await this.clearSyncConflict(conflictPath, generation);
            } else {
                const matchingTargets = [...changedTargetPaths].filter(relPath =>
                    this.isPathAtOrBelow(relPath, conflictPath)
                    || this.isPathAtOrBelow(conflictPath, relPath)
                );
                const localConflictRevision = await this.hasLocalConflictRevision(
                    conflictPath,
                    generation,
                );
                for (const relPath of matchingTargets) {
                    if (
                        explicitTargets.has(relPath)
                        || (
                            localConflictRevision
                            && this.isPathAtOrBelow(relPath, conflictPath)
                        )
                    ) {
                        conflictResolutionTargets.add(relPath);
                        if (forcedTargets.has(relPath)) {
                            let ancestorPath = relPath;
                            try {
                                const targetStat = await vscode.workspace.fs.stat(this.localUri(relPath));
                                if (targetStat.type!==vscode.FileType.Directory) {
                                    ancestorPath = nodePath.posix.dirname(relPath);
                                }
                            } catch {
                                ancestorPath = nodePath.posix.dirname(relPath);
                            }
                            const ancestors: string[] = [];
                            while (
                                ancestorPath!=='/'
                                && this.isPathAtOrBelow(ancestorPath, conflictPath)
                            ) {
                                ancestors.push(ancestorPath);
                                if (ancestorPath===conflictPath) { break; }
                                ancestorPath = nodePath.posix.dirname(ancestorPath);
                            }
                            for (const candidate of ancestors.reverse()) {
                                let localDirectory = false;
                                try {
                                    localDirectory = (
                                        await vscode.workspace.fs.stat(this.localUri(candidate))
                                    ).type===vscode.FileType.Directory;
                                } catch {
                                    localDirectory = false;
                                }
                                if (!localDirectory) { continue; }
                                let remoteExists = true;
                                try {
                                    await vscode.workspace.fs.stat(this.vfs.pathToUri(candidate));
                                } catch (error) {
                                    if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                                        throw error;
                                    }
                                    remoteExists = false;
                                }
                                this.requireSyncSession(generation);
                                if (!remoteExists) {
                                    const alreadyTargeted = forcedTargets.has(candidate);
                                    forcedTargets.set(candidate, this.localUri(candidate));
                                    changedTargetPaths.add(candidate);
                                    conflictResolutionTargets.add(candidate);
                                    if (!alreadyTargeted) {
                                        conflictPrerequisiteTargets.add(candidate);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            this.requireSyncSession(generation);
        }

        for (const relPath of [...forcedTargets.keys()]) {
            if (this.touchesSyncConflict(relPath) && !conflictResolutionTargets.has(relPath)) {
                forcedTargets.delete(relPath);
            }
        }
        for (const relPath of [...forcedDeleteTargets.keys()]) {
            if (this.touchesSyncConflict(relPath) && !conflictResolutionTargets.has(relPath)) {
                forcedDeleteTargets.delete(relPath);
            }
        }

        const recursiveDeleteRoots: string[] = [];
        const deleteEntries = [...forcedDeleteTargets.entries()]
            .sort(([left], [right]) => left.split('/').length-right.split('/').length)
            .filter(([relPath]) => {
                if (recursiveDeleteRoots.some(parent => this.isPathAtOrBelow(relPath, parent))) {
                    return false;
                }
                if (this.isTrackedDirectory(relPath)) {
                    recursiveDeleteRoots.push(relPath);
                }
                return true;
            });
        for (const [relPath, localUri] of deleteEntries) {
            if (forcedTargets.has(relPath)) { continue; }
            await this.runPrecompilePush(
                relPath,
                localUri,
                result,
                {
                    forcePush: true,
                    reason: conflictResolutionTargets.has(relPath)
                        ? 'conflict-resolution'
                        : 'compile-scan',
                    resolveConflict: conflictResolutionTargets.has(relPath),
                },
                generation,
                'delete',
            );
        }

        const updateEntries = [...forcedTargets.entries()]
            .sort(([left], [right]) => left.split('/').length-right.split('/').length);
        for (const [relPath, localUri] of updateEntries) {
            await this.runPrecompilePush(
                relPath,
                localUri,
                result,
                {
                    forcePush: true,
                    reason: conflictResolutionTargets.has(relPath)
                        ? 'conflict-resolution'
                        : 'compile',
                    resolveConflict: conflictResolutionTargets.has(relPath),
                    deferConflictResolution: conflictPrerequisiteTargets.has(relPath),
                },
                generation,
            );
        }

        await this.verifyPrecompileTreeQuiescent(result, generation);
        this.requireSyncSession(generation);

        for (const [relPath, reason] of this.syncConflicts) {
            result.blockedCount += 1;
            result.failures.push(`${relPath}: ${reason}`);
        }

        getOutputChannel().appendLine(
            `${new Date().toISOString()} [compile barrier end] base=${this.baseUri.toString()} ` +
            `attempted=${result.attemptedCount} suppressed=${result.suppressedCount} ` +
            `blocked=${result.blockedCount} failed=${result.failedCount}`,
        );

        if (result.blockedCount>0 || result.failedCount>0) {
            throw new Error(`Local Replica precompile flush failed: ${result.failures.join('; ')}`);
        }

        return result;
    }

    private async waitForStartupReadinessBeforeCompile(generation: number): Promise<void> {
        const hasPendingStartupWork = () => (
            this.startupReplayGeneration===generation
            || this.pendingInitialDocumentSubscriptions.size>0
        );
        if (!hasPendingStartupWork()) { return; }

        const startedAt = Date.now();
        const timeoutMs = Math.max(0, this.precompileStartupReadinessWaitMs);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [compile barrier waiting:startup-readiness] ` +
            `base=${this.baseUri.toString()} ` +
            `startupReplay=${this.startupReplayGeneration===generation ? 'pending' : 'none'} ` +
            `remoteVerify=${this.pendingInitialDocumentSubscriptions.size} timeout=${timeoutMs}ms`,
        );

        while (hasPendingStartupWork() && this.isSyncSessionActive(generation)) {
            if (this.startupReplayFailure?.generation===generation) { break; }
            const elapsed = Date.now()-startedAt;
            if (elapsed>=timeoutMs) { break; }
            const remaining = timeoutMs-elapsed;
            const replay = this.startupReplayGeneration===generation
                ? this.startupReplayPromise
                : undefined;
            await Promise.race([
                replay?.catch(() => undefined) ?? new Promise<void>(() => undefined),
                new Promise<void>(resolve => setTimeout(resolve, Math.min(100, remaining))),
            ]);
            this.requireSyncSession(generation);
        }

        const elapsed = Date.now()-startedAt;
        const ready = !hasPendingStartupWork()
            && this.startupReplayFailure?.generation!==generation;
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [compile barrier startup-readiness ${ready ? 'ready' : 'blocked'}] ` +
            `base=${this.baseUri.toString()} elapsed=${elapsed}ms ` +
            `startupReplay=${this.startupReplayGeneration===generation ? 'pending' : 'none'} ` +
            `remoteVerify=${this.pendingInitialDocumentSubscriptions.size}`,
        );
    }

    private matchIgnorePatterns(path: string): boolean {
        if (isLocalReplicaCompileOutputPath(path)) {
            return true;
        }
        const ignorePatterns = this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of [...PROTECTED_LOCAL_REPLICA_IGNORE_PATTERNS, ...ignorePatterns]) {
            if (matchesLocalReplicaIgnorePattern(path, pattern)) {
                return true;
            }
        }
        return false;
    }

    private setBypassCache(
        relPath: string,
        content?: Uint8Array,
        action?: 'push'|'pull',
        type: 'update'|'delete' = content===undefined ? 'delete' : 'update',
    ) {
        this.setBypassCacheDigest(relPath, contentDigest(content), action, type);
    }

    private setBypassCacheDigest(
        relPath: string,
        hash: string,
        action?: 'push'|'pull',
        type: 'update'|'delete' = hash===DELETE_DIGEST ? 'delete' : 'update',
    ) {
        const key = normalizeReplicaPath(relPath);
        const date = Date.now();
        const cache = this.bypassCache.get(key) || [undefined,undefined];
        const next = {date, hash, type};
        // A directional operation advances the synchronized digest for both
        // directions. Keeping the opposite direction's older digest would
        // let A(push) -> B(pull) -> A(push) look like a duplicate of the
        // historical first push.
        if (action==='push') {
            cache[0] = next;
            if (cache[1]?.hash!==hash) {
                cache[1] = next;
            }
        } else if (action==='pull') {
            cache[1] = next;
            if (cache[0]?.hash!==hash) {
                cache[0] = next;
            }
        } else {
            cache[0] = next;
            cache[1] = next;
        }
        // write back to the cache
        this.bypassCache.set(key, cache as [FileCache,FileCache]);
    }

    private snapshotBypassCache(relPath: string): [FileCache, FileCache] | undefined {
        const cache = this.bypassCache.get(normalizeReplicaPath(relPath));
        if (!cache) { return undefined; }
        return [
            {...cache[0]},
            {...cache[1]},
        ];
    }

    private restoreBypassCache(relPath: string, snapshot?: [FileCache, FileCache]) {
        const key = normalizeReplicaPath(relPath);
        if (snapshot) {
            this.bypassCache.set(key, snapshot);
        } else {
            this.bypassCache.delete(key);
        }
    }

    private async getRemoteFingerprint(relPath: string, vfsUri: vscode.Uri): Promise<string | undefined> {
        if (!this.isLikelyBinaryRelPath(relPath)) { return undefined; }
        try {
            const {fileType, fileEntity} = await this.vfs._resolveUri(vfsUri);
            if (fileType==='file' && fileEntity?._id) {
                return `${fileType}:${fileEntity._id}`;
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    private async resolveRemoteEntityIdentity(
        vfsUri: vscode.Uri,
    ): Promise<SyncManifestRemoteEntityIdentity | undefined> {
        const {fileType, fileEntity} = await this.vfs._resolveUri(vfsUri);
        if (
            (fileType==='doc' || fileType==='file')
            && typeof fileEntity?._id==='string'
            && fileEntity._id.length>0
        ) {
            return {id: fileEntity._id, type: fileType};
        }
        return undefined;
    }

    private async getRemoteEntityIdentity(
        vfsUri: vscode.Uri,
    ): Promise<SyncManifestRemoteEntityIdentity | undefined> {
        try {
            const {fileType, fileEntity} = await this.vfs._resolveUri(vfsUri);
            if (
                (fileType==='doc' || fileType==='file')
                && typeof fileEntity?._id==='string'
                && fileEntity._id.length>0
            ) {
                return {id: fileEntity._id, type: fileType};
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    private async resolveRemoteFolderPathIdentity(
        vfsUri: vscode.Uri,
    ): Promise<RemoteFolderPathIdentity | undefined> {
        const {parentFolder, fileType, fileEntity} = await this.vfs._resolveUri(vfsUri);
        if (
            fileType!=='folder'
            || typeof fileEntity?._id!=='string'
            || fileEntity._id.length===0
            || typeof parentFolder?._id!=='string'
            || parentFolder._id.length===0
        ) {
            return undefined;
        }
        return {
            entity: {id: fileEntity._id, type: 'folder'},
            parent: {id: parentFolder._id, type: 'folder'},
        };
    }

    private remoteFolderIdentityMatches(
        actual: SyncManifestRemoteFolderIdentity | undefined,
        expected: SyncManifestRemoteFolderIdentity,
    ): boolean {
        return actual?.id===expected.id && actual.type==='folder';
    }
    private recordedRemoteFolderIdentityForPath(
        relPath: string,
    ): SyncManifestRemoteFolderIdentity | undefined {
        const manifest = this.syncManifest;
        if (!manifest) { return undefined; }
        if (relPath!=='/') {
            return manifest.directories[relPath]?.remoteEntity;
        }
        // The manifest deliberately does not use '/' as a key. Infer its
        // identity only from direct children, whose recorded parent is the
        // authoritative project root. A disagreement is an unsafe legacy or
        // corrupted baseline, not evidence to guess from.
        const candidates = Object.entries(manifest.directories)
            .filter(([path]) => nodePath.posix.dirname(path)==='/')
            .map(([, entry]) => entry.parentEntity)
            .filter((identity): identity is SyncManifestRemoteFolderIdentity =>
                identity!==undefined,
            );
        const first = candidates[0];
        if (
            !first
            || !candidates.every(candidate => this.remoteFolderIdentityMatches(candidate, first))
        ) {
            return undefined;
        }
        return {...first};
    }


    private remoteFolderPathIdentityMatches(
        actual: RemoteFolderPathIdentity | undefined,
        expectedEntity: SyncManifestRemoteFolderIdentity,
        expectedParent: SyncManifestRemoteFolderIdentity,
    ): boolean {
        return this.remoteFolderIdentityMatches(actual?.entity, expectedEntity)
            && this.remoteFolderIdentityMatches(actual?.parent, expectedParent);
    }

    private async manifestLocalStat(relPath: string): Promise<{size: number; mtime: number} | undefined> {
        try {
            const stat = await this.statConfinedLocalUri(
                this.localUri(relPath),
                `manifest inspection of ${relPath}`,
            );
            if (stat.type!==vscode.FileType.File) { return undefined; }
            return {size: stat.size, mtime: stat.mtime};
        } catch {
            return undefined;
        }
    }

    private async captureManifestLocalFileIdentity(
        relPath: string,
        localUri: vscode.Uri,
        expectedStat: vscode.FileStat,
    ): Promise<SyncManifestLocalFileIdentity | undefined> {
        if (localUri.scheme!=='file' || this.baseUri.scheme!=='file') {
            return undefined;
        }
        const snapshot = await this.captureLocalPathIdentitySnapshot(
            localUri,
            `manifest identity snapshot of ${relPath}`,
        );
        const {finalStat} = snapshot;
        if (
            !finalStat.isFile
            || finalStat.size!==expectedStat.size
            || normalizeMtimeMs(finalStat.mtimeMs)!==normalizeMtimeMs(expectedStat.mtime)
        ) {
            throw new LocalReadUnstableError(
                relPath,
                'path-identity-changed',
                `Local Replica manifest target changed while identity was recorded: ${localUri.fsPath}`,
            );
        }
        if (finalStat.ino==='0') {
            return undefined;
        }
        return {dev: finalStat.dev, ino: finalStat.ino};
    }
    private async captureManifestLocalDirectoryIdentity(
        relPath: string,
        localUri: vscode.Uri,
    ): Promise<SyncManifestLocalFileIdentity | undefined> {
        if (localUri.scheme!=='file' || this.baseUri.scheme!=='file') {
            return undefined;
        }
        let snapshot: LocalPathIdentitySnapshot;
        try {
            snapshot = await this.captureLocalPathIdentitySnapshot(
                localUri,
                `manifest directory identity snapshot of ${relPath}`,
            );
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return undefined;
            }
            throw error;
        }
        if (!snapshot.finalStat.isDirectory) {
            throw new LocalReadUnstableError(
                relPath,
                'path-identity-changed',
                `Local Replica manifest directory changed type while identity was recorded: ${localUri.fsPath}`,
            );
        }
        if (snapshot.finalStat.ino==='0') {
            return undefined;
        }
        return {
            dev: snapshot.finalStat.dev,
            ino: snapshot.finalStat.ino,
        };
    }

    private async canSkipInitialBinaryPull(
        relPath: string,
        vfsUri: vscode.Uri,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const entry = this.syncManifest?.files[relPath];
        if (!entry) { return false; }
        const remoteFingerprint = await this.getRemoteFingerprint(relPath, vfsUri);
        this.requireSyncSession(generation);
        if (!remoteFingerprint || entry.remoteFingerprint!==remoteFingerprint) { return false; }
        if (!await this.isLocalUnchangedFromManifest(relPath)) { return false; }
        this.requireSyncSession(generation);
        const localContent = await this.readFile(relPath);
        this.requireSyncSession(generation);
        if (localContent===undefined) { return false; }

        this.baseCache[relPath] = localContent;
        this.seenLocalEntities.add(relPath);
        this.setBypassCacheDigest(relPath, entry.localDigest);
        this.clearRemoteDelete(relPath);
        return true;
    }

    private async isLocalUnchangedFromManifest(relPath: string): Promise<boolean> {
        const entry = this.syncManifest?.files[relPath];
        if (!entry) { return false; }
        const localStat = await this.manifestLocalStat(relPath);
        if (!localStat || localStat.size!==entry.localSize) { return false; }
        const localContent = await this.readFile(relPath);
        return localContent!==undefined && contentDigest(localContent)===entry.localDigest;
    }

    private async recordSyncManifestEntry(
        relPath: string,
        vfsUri: vscode.Uri,
        content: Uint8Array,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        if (!this.syncManifest) { return false; }
        const remoteEntity = await this.getRemoteEntityIdentity(vfsUri);
        const remoteFingerprint = this.isLikelyBinaryRelPath(relPath)
            ? remoteEntity?.type==='file' ? `file:${remoteEntity.id}` : undefined
            : `content:${contentDigest(content)}`;
        this.requireSyncSession(generation);
        const localUri = this.localUri(relPath);
        let localStatBefore: vscode.FileStat;
        let localContent: Uint8Array;
        let localStatAfter: vscode.FileStat;
        let localIdentity: SyncManifestLocalFileIdentity | undefined;
        try {
            localStatBefore = await this.statConfinedLocalUri(
                localUri,
                `manifest snapshot of ${relPath}`,
            );
            localContent = await this.readConfinedLocalFile(relPath, localUri);
            localStatAfter = await this.statConfinedLocalUri(
                localUri,
                `manifest snapshot of ${relPath}`,
            );
            localIdentity = await this.captureManifestLocalFileIdentity(
                relPath,
                localUri,
                localStatAfter,
            );
            this.requireSyncSession(generation);
        } catch {
            if (!this.isSyncSessionActive(generation)) {
                throw new Error('Local Replica sync session is no longer active.');
            }
            this.removeSyncManifestEntry(relPath);
            this.locallyDivergedPaths.add(relPath);
            return false;
        }
        const stableLocalSnapshot = localStatBefore.type===vscode.FileType.File
            && localStatAfter.type===vscode.FileType.File
            && localStatBefore.size===localStatAfter.size
            && normalizeMtimeMs(localStatBefore.mtime)===normalizeMtimeMs(localStatAfter.mtime)
            && localStatAfter.size===localContent.length
            && bytesEqual(localContent, content);
        if (!remoteFingerprint || !stableLocalSnapshot) {
            // The local file changed while the remote operation was in
            // flight. Keep the remote bytes as the merge baseline, but do
            // not bless unrelated size/mtime metadata as synchronized.
            this.removeSyncManifestEntry(relPath);
            this.locallyDivergedPaths.add(relPath);
            return false;
        }
        this.syncManifest.files[relPath] = {
            remoteFingerprint,
            localSize: localStatAfter.size,
            localMtime: localStatAfter.mtime,
            localDigest: contentDigest(content),
            remoteEntity,
            localIdentity,
            baseContentBase64: this.decodeMergeableText(content)===undefined
                ? undefined
                : Buffer.from(content).toString('base64'),
            updatedAt: new Date().toISOString(),
        };
        this.markSyncManifestDirty();
        return true;
    }

    // A watcher event is only an observation. Once a stable local file snapshot
    // is available, retain that intent before any remote I/O so a restart can
    // re-check the authoritative Overleaf state instead of forgetting it.
    private async journalPendingFilePushOperation(
        relPath: string,
        kind: 'update' | 'delete',
        localRevision: string,
        remoteState: PathRevision | undefined,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        if (!this.syncManifest) { return; }
        const localKind = kind==='update' ? 'file' : 'missing';
        if (
            (kind==='update' && !/^[a-f0-9]{40}$/.test(localRevision))
            || (kind==='delete' && localRevision!==DELETE_DIGEST)
        ) {
            throw new Error(`Invalid stable local revision for pending ${kind}: ${relPath}`);
        }
        const existing = this.syncManifest.pendingOperations[relPath];
        const sameLocalIntent = existing?.kind===kind
            && existing.localKind===localKind
            && existing.localRevision===localRevision;
        // Keep an already-observed precondition when this retry has not yet
        // reached remote inspection. A changed local intent intentionally drops
        // the old precondition: it described a different source snapshot.
        const remoteKind = remoteState?.kind
            ?? (sameLocalIntent ? existing?.remoteKind : undefined);
        const remoteRevision = remoteState?.revision
            ?? (sameLocalIntent ? existing?.remoteRevision : undefined);
        const unchanged = sameLocalIntent
            && existing?.remoteKind===remoteKind
            && existing?.remoteRevision===remoteRevision;
        if (unchanged) {
            this.locallyDivergedPaths.add(relPath);
            this.refreshDerivedSyncStatusWhenNotActive();
            return;
        }
        const now = new Date().toISOString();
        this.syncManifest.pendingOperations[relPath] = {
            version: 1,
            id: sameLocalIntent && existing
                ? existing.id
                : crypto.randomBytes(16).toString('hex'),
            kind,
            localKind,
            localRevision,
            remoteKind,
            remoteRevision,
            createdAt: sameLocalIntent && existing
                ? existing.createdAt
                : now,
            updatedAt: now,
        };
        this.locallyDivergedPaths.add(relPath);
        this.markSyncManifestDirty();
        // This write is deliberately before a possible socket/HTTP mutation.
        // If it cannot be persisted, fail closed rather than making the remote
        // change impossible to recover after a process crash.
        await this.persistSyncManifest(false, generation);
        this.refreshDerivedSyncStatusWhenNotActive();
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [pending operation journaled] ${relPath} ` +
            `kind=${kind} local=${localRevision.slice(0, 12)} ` +
            `remote=${remoteKind ?? 'unobserved'}`,
        );
    }

    // A move is a project-tree mutation, not a delete plus unrelated create.
    // Persist the exact source entity, its local inode/digest, and a missing
    // destination before invoking the Overleaf rename/move API. This is the
    // durable proof replay needs after an interrupted request.
    private async journalPendingLocalFileMove(
        sourceRelPath: string,
        destinationRelPath: string,
        sourceEntry: SyncManifestEntry,
        sourceRemoteState: PathRevision,
        generation = this.syncGeneration,
    ): Promise<SyncManifestPendingMoveOperation> {
        this.requireSyncSession(generation);
        if (!this.syncManifest) {
            throw new Error('Local Replica move journal requires an active manifest.');
        }
        if (!this.isCanonicalReplicaRelPath(destinationRelPath)) {
            throw new Error('Invalid Local Replica move destination: ' + destinationRelPath);
        }
        const sourceEntity = sourceEntry.remoteEntity;
        const sourceLocalIdentity = sourceEntry.localIdentity;
        if (!sourceEntity || !sourceLocalIdentity || sourceRemoteState.kind!=='file') {
            throw new Error('Local Replica move has incomplete source identity: ' + sourceRelPath);
        }
        const existing = this.syncManifest.pendingOperations[sourceRelPath];
        const sameIntent = existing?.kind==='move'
            && existing.destinationRelPath===destinationRelPath
            && existing.localRevision===sourceEntry.localDigest
            && existing.sourceEntity.id===sourceEntity.id
            && existing.sourceEntity.type===sourceEntity.type
            && existing.sourceLocalIdentity.dev===sourceLocalIdentity.dev
            && existing.sourceLocalIdentity.ino===sourceLocalIdentity.ino;
        if (sameIntent) {
            this.locallyDivergedPaths.add(sourceRelPath);
            this.locallyDivergedPaths.add(destinationRelPath);
            this.refreshDerivedSyncStatusWhenNotActive();
            return existing;
        }
        if (existing || this.syncManifest.pendingOperations[destinationRelPath]) {
            throw new Error('A different Local Replica operation is already pending for this move.');
        }
        const now = new Date().toISOString();
        const record: SyncManifestPendingMoveOperation = {
            version: 2,
            id: crypto.randomBytes(16).toString('hex'),
            kind: 'move',
            localKind: 'file',
            localRevision: sourceEntry.localDigest,
            sourceEntity: {...sourceEntity},
            sourceLocalIdentity: {...sourceLocalIdentity},
            destinationRelPath,
            sourceRemoteKind: sourceRemoteState.kind,
            sourceRemoteRevision: sourceRemoteState.revision,
            createdAt: now,
            updatedAt: now,
        };
        this.syncManifest.pendingOperations[sourceRelPath] = record;
        this.locallyDivergedPaths.add(sourceRelPath);
        this.locallyDivergedPaths.add(destinationRelPath);
        this.markSyncManifestDirty();
        await this.persistSyncManifest(false, generation);
        this.refreshDerivedSyncStatusWhenNotActive();
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [pending move journaled] ' +
            sourceRelPath + ' -> ' + destinationRelPath +
            ' entity=' + sourceEntity.type + ':' + sourceEntity.id,
        );
        return record;
    }

    private async journalPendingLocalDirectoryMove(
        sourceRelPath: string,
        destinationRelPath: string,
        sourceEntry: SyncManifestDirectoryEntry,
        localRevision: string,
        destinationParentEntity: SyncManifestRemoteFolderIdentity,
        generation = this.syncGeneration,
    ): Promise<SyncManifestPendingDirectoryMoveOperation> {
        this.requireSyncSession(generation);
        const manifest = this.syncManifest;
        if (!manifest) {
            throw new Error('Local Replica folder move journal requires an active manifest.');
        }
        if (
            !this.isCanonicalReplicaRelPath(sourceRelPath)
            || !this.isCanonicalReplicaRelPath(destinationRelPath)
            || sourceRelPath===destinationRelPath
            || this.isPathAtOrBelow(destinationRelPath, sourceRelPath)
            || this.isPathAtOrBelow(sourceRelPath, destinationRelPath)
            || !/^directory:[a-f0-9]{40}$/.test(localRevision)
        ) {
            throw new Error('Invalid Local Replica folder move paths or revision.');
        }
        const sourceEntity = sourceEntry.remoteEntity;
        const sourceParentEntity = sourceEntry.parentEntity;
        const sourceLocalIdentity = sourceEntry.localIdentity;
        if (!sourceEntity || !sourceParentEntity || !sourceLocalIdentity) {
            throw new Error('Local Replica folder move has incomplete source identity: ' + sourceRelPath);
        }
        const existing = manifest.pendingOperations[sourceRelPath];
        const sameIntent = existing?.kind==='directory-move'
            && existing.destinationRelPath===destinationRelPath
            && existing.localRevision===localRevision
            && this.remoteFolderIdentityMatches(existing.sourceEntity, sourceEntity)
            && this.remoteFolderIdentityMatches(existing.sourceParentEntity, sourceParentEntity)
            && this.remoteFolderIdentityMatches(
                existing.destinationParentEntity,
                destinationParentEntity,
            )
            && this.localMoveIdentityMatches(
                existing.sourceLocalIdentity,
                sourceLocalIdentity,
            );
        if (sameIntent) {
            this.locallyDivergedPaths.add(sourceRelPath);
            this.locallyDivergedPaths.add(destinationRelPath);
            this.refreshDerivedSyncStatusWhenNotActive();
            return existing;
        }
        if (existing) {
            throw new Error('A different Local Replica operation is already pending for this folder move.');
        }
        const pending = this.pendingOperationIntersectingPaths(
            sourceRelPath,
            destinationRelPath,
        );
        if (pending!==undefined) {
            throw new Error('A descendant Local Replica operation blocks this folder move: ' + pending);
        }
        if (Object.keys(manifest.files).some(path => this.isPathAtOrBelow(path, destinationRelPath))
            || Object.keys(manifest.directories).some(path => this.isPathAtOrBelow(path, destinationRelPath))) {
            throw new Error('The Local Replica folder move destination is already tracked.');
        }
        const now = new Date().toISOString();
        const record: SyncManifestPendingDirectoryMoveOperation = {
            version: 1,
            id: crypto.randomBytes(16).toString('hex'),
            kind: 'directory-move',
            localKind: 'directory',
            localRevision,
            sourceEntity: {...sourceEntity},
            sourceParentEntity: {...sourceParentEntity},
            sourceLocalIdentity: {...sourceLocalIdentity},
            destinationRelPath,
            destinationParentEntity: {...destinationParentEntity},
            sourceRemoteKind: 'directory',
            sourceRemoteRevision: localRevision,
            createdAt: now,
            updatedAt: now,
        };
        manifest.pendingOperations[sourceRelPath] = record;
        this.locallyDivergedPaths.add(sourceRelPath);
        this.locallyDivergedPaths.add(destinationRelPath);
        this.markSyncManifestDirty();
        await this.persistSyncManifest(false, generation);
        this.refreshDerivedSyncStatusWhenNotActive();
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [pending folder move journaled] ' +
            sourceRelPath + ' -> ' + destinationRelPath +
            ' entity=folder:' + sourceEntity.id,
        );
        return record;
    }

    // A folder create is a tree entity mutation. The journal proves that the
    // intended path was missing under this exact remote parent before the POST;
    // a name match after a lost response is deliberately not enough proof.
    private async journalPendingLocalDirectoryCreate(
        relPath: string,
        localRevision: string,
        parentEntity: SyncManifestRemoteFolderIdentity,
        generation = this.syncGeneration,
    ): Promise<SyncManifestPendingDirectoryCreateOperation> {
        this.requireSyncSession(generation);
        if (!this.syncManifest) {
            throw new Error('Local Replica mkdir journal requires an active manifest.');
        }
        if (
            !this.isCanonicalReplicaRelPath(relPath)
            || !localRevision.startsWith('directory:')
            || !this.isValidRecordedPathRevision(localRevision)
        ) {
            throw new Error('Invalid stable local folder revision for pending mkdir: ' + relPath);
        }
        const existing = this.syncManifest.pendingOperations[relPath];
        // Child files can appear while the parent mkdir is in flight. The
        // folder is still the same local intent as long as it remains a
        // directory beneath the same authoritative parent; its recursive
        // fingerprint is diagnostic, not a second create precondition.
        const sameIntent = existing?.kind==='mkdir'
            && this.remoteFolderIdentityMatches(existing.parentEntity, parentEntity);
        if (sameIntent) {
            this.locallyDivergedPaths.add(relPath);
            this.refreshDerivedSyncStatusWhenNotActive();
            return existing;
        }
        if (existing) {
            throw new Error('A different Local Replica operation is already pending for this folder.');
        }
        const now = new Date().toISOString();
        const record: SyncManifestPendingDirectoryCreateOperation = {
            version: 1,
            id: crypto.randomBytes(16).toString('hex'),
            kind: 'mkdir',
            localKind: 'directory',
            localRevision,
            remoteKind: 'missing',
            remoteRevision: DELETE_DIGEST,
            parentEntity: {...parentEntity},
            createdAt: now,
            updatedAt: now,
        };
        this.syncManifest.pendingOperations[relPath] = record;
        this.locallyDivergedPaths.add(relPath);
        this.markSyncManifestDirty();
        await this.persistSyncManifest(false, generation);
        this.refreshDerivedSyncStatusWhenNotActive();
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [pending mkdir journaled] ' +
            relPath + ' parent=folder:' + parentEntity.id,
        );
        return record;
    }

    private async markPendingLocalDirectoryCreateEntity(
        relPath: string,
        record: SyncManifestPendingDirectoryCreateOperation,
        createdEntity: SyncManifestRemoteFolderIdentity,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const current = this.syncManifest?.pendingOperations[relPath];
        if (
            !current
            || current.kind!=='mkdir'
            || current.id!==record.id
            || !this.remoteFolderIdentityMatches(current.parentEntity, record.parentEntity)
        ) {
            throw new Error('Local Replica mkdir journal changed before its server acknowledgement.');
        }
        if (
            current.createdEntity!==undefined
            && !this.remoteFolderIdentityMatches(current.createdEntity, createdEntity)
        ) {
            throw new RemoteDocumentMergeConflictError(
                'Overleaf returned a different folder identity for the pending local create.',
            );
        }
        current.createdEntity = {...createdEntity};
        current.updatedAt = new Date().toISOString();
        this.markSyncManifestDirty();
        // Persist the server-issued ID before any postcondition lookup. A crash
        // after this point can safely recognize only this exact entity on replay.
        await this.persistSyncManifest(false, generation);
    }

    private async removePendingLocalDirectoryCreate(
        relPath: string,
        reason: string,
        generation = this.syncGeneration,
        expected?: Pick<SyncManifestPendingDirectoryCreateOperation, 'id'>,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const current = this.syncManifest?.pendingOperations[relPath];
        if (
            !current
            || current.kind!=='mkdir'
            || (expected!==undefined && current.id!==expected.id)
        ) {
            return false;
        }
        delete this.syncManifest!.pendingOperations[relPath];
        this.markSyncManifestDirty();
        await this.persistSyncManifest(false, generation);
        this.refreshDerivedSyncStatusWhenNotActive();
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [pending mkdir acknowledged] ' +
            relPath + ': ' + reason,
        );
        return true;
    }

    // The manifest already contains each tracked child's verified digest, so
    // reconstruct the same recursive revision used by captureRemotePathRevision
    // without doing network I/O. This is what makes a proven offline rmdir
    // intent durable rather than a timestamp-based guess.
    private manifestDirectoryRevision(relPath: string): string | undefined {
        const manifest = this.syncManifest;
        if (
            !manifest
            || !manifest.baselineComplete
            || this.syncManifestBaselineMode!=='trusted'
            || this.failedInitialPulls.size>0
        ) {
            return undefined;
        }
        const visiting = new Set<string>();
        const visit = (directoryPath: string): string | undefined => {
            if (!manifest.directories[directoryPath] || visiting.has(directoryPath)) {
                return undefined;
            }
            visiting.add(directoryPath);
            const children = new Map<string, {kind: 'file' | 'directory'; revision: string}>();
            for (const [path, entry] of Object.entries(manifest.files)) {
                if (nodePath.posix.dirname(path)!==directoryPath) { continue; }
                const name = nodePath.posix.basename(path);
                if (children.has(name)) {
                    visiting.delete(directoryPath);
                    return undefined;
                }
                children.set(name, {kind: 'file', revision: entry.localDigest});
            }
            for (const path of Object.keys(manifest.directories)) {
                if (nodePath.posix.dirname(path)!==directoryPath) { continue; }
                const name = nodePath.posix.basename(path);
                if (children.has(name)) {
                    visiting.delete(directoryPath);
                    return undefined;
                }
                const revision = visit(path);
                if (!revision) {
                    visiting.delete(directoryPath);
                    return undefined;
                }
                children.set(name, {kind: 'directory', revision});
            }
            visiting.delete(directoryPath);
            const entries = [...children.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name, child]) => `${name}\0${child.kind}\0${child.revision}`);
            return 'directory:' + contentDigest(Buffer.from(entries.join('\n')));
        };
        return visit(relPath);
    }

    // Persist a recursive local delete before observing or mutating Overleaf.
    // Unlike a file, the deleted directory has no bytes left locally; only the
    // last trusted manifest tree and exact remote folder identities can prove
    // which entity the user intended to remove after reconnect.
    private async journalPendingLocalDirectoryDelete(
        relPath: string,
        generation = this.syncGeneration,
    ): Promise<SyncManifestPendingDirectoryDeleteOperation> {
        this.requireSyncSession(generation);
        const manifest = this.syncManifest;
        if (!manifest) {
            throw new Error('Local Replica rmdir journal requires an active manifest.');
        }
        const entry = manifest.directories[relPath];
        const remoteRevision = this.manifestDirectoryRevision(relPath);
        if (
            !entry?.remoteEntity
            || !entry.parentEntity
            || remoteRevision===undefined
        ) {
            throw new RemoteDocumentMergeConflictError(
                'Local Replica cannot prove the authoritative folder identity for an offline delete. ' +
                'Reconnect and complete an initial pull before deleting this folder.',
            );
        }
        const stageOperationId = this.remoteDeleteOperationId(
            relPath,
            remoteRevision,
            entry.remoteEntity.id,
        );
        const stagingRelPath = this.remoteDeleteStagingPath(
            relPath,
            remoteRevision,
            entry.remoteEntity.id,
        );
        const existing = manifest.pendingOperations[relPath];
        const sameIntent = existing?.kind==='rmdir'
            && existing.remoteRevision===remoteRevision
            && this.remoteFolderIdentityMatches(existing.targetEntity, entry.remoteEntity)
            && this.remoteFolderIdentityMatches(existing.parentEntity, entry.parentEntity)
            && existing.stageOperationId===stageOperationId
            && existing.stagingRelPath===stagingRelPath;
        if (sameIntent) {
            this.locallyDivergedPaths.add(relPath);
            this.refreshDerivedSyncStatusWhenNotActive();
            return existing;
        }
        if (existing) {
            throw new Error('A different Local Replica operation is already pending for this folder.');
        }
        const now = new Date().toISOString();
        const record: SyncManifestPendingDirectoryDeleteOperation = {
            version: 1,
            id: crypto.randomBytes(16).toString('hex'),
            kind: 'rmdir',
            localKind: 'missing',
            localRevision: DELETE_DIGEST,
            remoteKind: 'directory',
            remoteRevision,
            targetEntity: {...entry.remoteEntity},
            parentEntity: {...entry.parentEntity},
            stageOperationId,
            stagingRelPath,
            createdAt: now,
            updatedAt: now,
        };
        manifest.pendingOperations[relPath] = record;
        this.locallyDivergedPaths.add(relPath);
        this.markSyncManifestDirty();
        await this.persistSyncManifest(false, generation);
        this.refreshDerivedSyncStatusWhenNotActive();
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [pending rmdir journaled] ' +
            relPath + ' entity=folder:' + record.targetEntity.id +
            ' parent=folder:' + record.parentEntity.id,
        );
        return record;
    }

    // An explicit “Keep Local” decision is different from an automatic replay:
    // the user has just reviewed the current Overleaf folder revision. Rebind
    // the still-local delete intent to that proven entity/tree, but never
    // overwrite an external stage journal that may already have moved data.
    private async rebasePendingLocalDirectoryDeleteForConflictResolution(
        relPath: string,
        record: SyncManifestPendingDirectoryDeleteOperation,
        remoteState: PathRevision,
        generation = this.syncGeneration,
    ): Promise<SyncManifestPendingDirectoryDeleteOperation> {
        this.requireSyncSession(generation);
        if (remoteState.kind!=='directory') {
            throw new RemoteDocumentMergeConflictError(
                'The reviewed Overleaf path is no longer a folder, so the local folder delete cannot be rebased.',
            );
        }
        const current = this.syncManifest?.pendingOperations[relPath];
        if (!current || current.kind!=='rmdir' || current.id!==record.id) {
            throw new RemoteDocumentMergeConflictError(
                'The guarded local folder-delete intent changed before the reviewed decision could be applied.',
            );
        }
        if (await this.localPathExists(
            this.remoteDeleteOperationRecordPath(record.stageOperationId),
        )) {
            throw new RemoteDocumentMergeConflictError(
                'The prior guarded folder delete is already staged remotely and must be recovered before choosing a new remote revision.',
            );
        }
        const identity = await this.resolveRemoteFolderPathIdentity(
            this.vfs.pathToUri(relPath),
        );
        this.requireSyncSession(generation);
        if (!identity) {
            throw new RemoteDocumentMergeConflictError(
                'Overleaf did not provide the reviewed folder identity needed for the local delete.',
            );
        }
        const stageOperationId = this.remoteDeleteOperationId(
            relPath,
            remoteState.revision,
            identity.entity.id,
        );
        const rebased: SyncManifestPendingDirectoryDeleteOperation = {
            ...record,
            remoteRevision: remoteState.revision,
            targetEntity: {...identity.entity},
            parentEntity: {...identity.parent},
            stageOperationId,
            stagingRelPath: this.remoteDeleteStagingPath(
                relPath,
                remoteState.revision,
                identity.entity.id,
            ),
            updatedAt: new Date().toISOString(),
        };
        this.syncManifest!.pendingOperations[relPath] = rebased;
        this.markSyncManifestDirty();
        await this.persistSyncManifest(false, generation);
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [pending rmdir rebased:explicit-resolution] ' +
            relPath + ' entity=folder:' + rebased.targetEntity.id,
        );
        return rebased;
    }
    private async removePendingLocalDirectoryDelete(
        relPath: string,
        reason: string,
        generation = this.syncGeneration,
        expected?: Pick<SyncManifestPendingDirectoryDeleteOperation, 'id'>,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const current = this.syncManifest?.pendingOperations[relPath];
        if (
            !current
            || current.kind!=='rmdir'
            || (expected!==undefined && current.id!==expected.id)
        ) {
            return false;
        }
        delete this.syncManifest!.pendingOperations[relPath];
        this.markSyncManifestDirty();
        await this.persistSyncManifest(false, generation);
        this.refreshDerivedSyncStatusWhenNotActive();
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [pending rmdir acknowledged] ' +
            relPath + ': ' + reason,
        );
        return true;
    }

    private async finalizeAcceptedPendingLocalDirectoryDelete(
        relPath: string,
        record: SyncManifestPendingDirectoryDeleteOperation,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const surviving = this.vfs._resolveById(record.targetEntity.id);
        if (surviving!==undefined) {
            throw new RemoteDocumentMergeConflictError(
                'The original Overleaf folder still exists at a different path after its local delete.',
            );
        }
        this.setBypassCache(relPath, undefined, 'push', 'delete');
        this.clearRemoteDelete(relPath);
        // Preserve watcher events: a local re-creation that landed after the
        // final absence check must queue a fresh guarded update, never vanish
        // with the deleted tree's bookkeeping.
        this.clearReplicaState(relPath, true, true);
        const removed = await this.removePendingLocalDirectoryDelete(
            relPath,
            'Overleaf accepted the guarded local folder delete',
            generation,
            record,
        );
        if (!removed) {
            throw new Error('Local Replica rmdir journal changed before final acknowledgement.');
        }
        await this.persistSyncManifest(false, generation);
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [local rmdir accepted] ' +
            relPath + ' entity=folder:' + record.targetEntity.id,
        );
    }

    private async removePendingFilePushOperation(
        relPath: string,
        reason: string,
        generation = this.syncGeneration,
        expected?: Pick<SyncManifestPendingFileOperation, 'kind' | 'localRevision'>,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const entry = this.syncManifest?.pendingOperations[relPath];
        if (
            !entry
            || (entry.kind!=='update' && entry.kind!=='delete')
            || (
                expected!==undefined
                && (
                    entry.kind!==expected.kind
                    || entry.localRevision!==expected.localRevision
                )
            )
        ) {
            return false;
        }
        delete this.syncManifest!.pendingOperations[relPath];
        this.markSyncManifestDirty();
        await this.persistSyncManifest(false, generation);
        this.refreshDerivedSyncStatusWhenNotActive();
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [pending operation acknowledged] ${relPath}: ${reason}`,
        );
        return true;
    }

    private async removePendingLocalFileMove(
        sourceRelPath: string,
        reason: string,
        generation = this.syncGeneration,
        expected?: Pick<SyncManifestPendingMoveOperation,
            'id' | 'destinationRelPath' | 'localRevision'>,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const entry = this.syncManifest?.pendingOperations[sourceRelPath];
        if (
            !entry
            || entry.kind!=='move'
            || (
                expected!==undefined
                && (
                    entry.id!==expected.id
                    || entry.destinationRelPath!==expected.destinationRelPath
                    || entry.localRevision!==expected.localRevision
                )
            )
        ) {
            return false;
        }
        delete this.syncManifest!.pendingOperations[sourceRelPath];
        this.markSyncManifestDirty();
        await this.persistSyncManifest(false, generation);
        this.refreshDerivedSyncStatusWhenNotActive();
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [pending move acknowledged] ' +
            sourceRelPath + ': ' + reason,
        );
        return true;
    }

    private localMoveIdentityMatches(
        left: SyncManifestLocalFileIdentity,
        right: SyncManifestLocalFileIdentity,
    ): boolean {
        return left.dev===right.dev && left.ino===right.ino;
    }

    private async removePendingLocalDirectoryMove(
        sourceRelPath: string,
        reason: string,
        generation = this.syncGeneration,
        expected?: Pick<SyncManifestPendingDirectoryMoveOperation,
            'id' | 'destinationRelPath' | 'localRevision'>,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const entry = this.syncManifest?.pendingOperations[sourceRelPath];
        if (
            !entry
            || entry.kind!=='directory-move'
            || (
                expected!==undefined
                && (
                    entry.id!==expected.id
                    || entry.destinationRelPath!==expected.destinationRelPath
                    || entry.localRevision!==expected.localRevision
                )
            )
        ) {
            return false;
        }
        delete this.syncManifest!.pendingOperations[sourceRelPath];
        this.markSyncManifestDirty();
        await this.persistSyncManifest(false, generation);
        this.refreshDerivedSyncStatusWhenNotActive();
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [pending folder move acknowledged] ' +
            sourceRelPath + ': ' + reason,
        );
        return true;
    }

    private remoteMoveEntityMatches(
        actual: SyncManifestRemoteEntityIdentity | undefined,
        expected: SyncManifestRemoteEntityIdentity,
    ): boolean {
        return actual?.id===expected.id && actual.type===expected.type;
    }

    // A cross-parent basename change is two server mutations. The current VFS
    // performs rename first, then move. Older builds could leave the inverse
    // intermediate (moved under its old basename), so recognize both entity-
    // proven states when replaying an already durable local move intent.
    private pendingLocalMoveIntermediateRelPaths(
        sourceRelPath: string,
        destinationRelPath: string,
    ): string[] {
        const sourceParent = nodePath.posix.dirname(sourceRelPath);
        const destinationParent = nodePath.posix.dirname(destinationRelPath);
        const sourceName = nodePath.posix.basename(sourceRelPath);
        const destinationName = nodePath.posix.basename(destinationRelPath);
        if (sourceParent===destinationParent || sourceName===destinationName) {
            return [];
        }
        return [
            nodePath.posix.join(sourceParent, destinationName),
            nodePath.posix.join(destinationParent, sourceName),
        ].filter((relPath, index, candidates) =>
            this.isCanonicalReplicaRelPath(relPath)
            && candidates.indexOf(relPath)===index,
        );
    }

    private async inspectPendingLocalFileMove(
        sourceRelPath: string,
        record: SyncManifestPendingMoveOperation,
        generation = this.syncGeneration,
    ): Promise<PendingLocalMoveInspection> {
        this.requireSyncSession(generation);
        const destinationRelPath = record.destinationRelPath;
        const [sourceState, destinationState] = await Promise.all([
            this.captureRemotePathRevision(sourceRelPath, generation),
            this.captureRemotePathRevision(destinationRelPath, generation),
        ]);
        this.requireSyncSession(generation);
        let accepted = false;
        let ready = false;
        let resumeSourceRelPath: string | undefined;
        if (
            sourceState.kind==='missing'
            && destinationState.kind==='file'
            && destinationState.revision===record.localRevision
        ) {
            const destinationEntity = await this.resolveRemoteEntityIdentity(
                this.vfs.pathToUri(destinationRelPath),
            );
            this.requireSyncSession(generation);
            accepted = this.remoteMoveEntityMatches(
                destinationEntity,
                record.sourceEntity,
            );
        } else if (
            sourceState.kind==='file'
            && destinationState.kind==='missing'
            && record.sourceRemoteKind==='file'
            && record.sourceRemoteRevision!==undefined
            && sourceState.revision===record.sourceRemoteRevision
        ) {
            const sourceEntity = await this.resolveRemoteEntityIdentity(
                this.vfs.pathToUri(sourceRelPath),
            );
            this.requireSyncSession(generation);
            ready = this.remoteMoveEntityMatches(sourceEntity, record.sourceEntity);
        }
        if (
            !accepted
            && !ready
            && sourceState.kind==='missing'
            && destinationState.kind==='missing'
        ) {
            for (const intermediateRelPath of this.pendingLocalMoveIntermediateRelPaths(
                sourceRelPath,
                destinationRelPath,
            )) {
                const intermediateState = await this.captureRemotePathRevision(
                    intermediateRelPath,
                    generation,
                );
                this.requireSyncSession(generation);
                if (
                    intermediateState.kind!=='file'
                    || intermediateState.revision!==record.localRevision
                ) {
                    continue;
                }
                const intermediateEntity = await this.resolveRemoteEntityIdentity(
                    this.vfs.pathToUri(intermediateRelPath),
                );
                this.requireSyncSession(generation);
                if (this.remoteMoveEntityMatches(intermediateEntity, record.sourceEntity)) {
                    ready = true;
                    resumeSourceRelPath = intermediateRelPath;
                    break;
                }
            }
        }
        return {sourceState, destinationState, accepted, ready, resumeSourceRelPath};
    }

    private async finalizeAcceptedLocalFileMove(
        sourceRelPath: string,
        record: SyncManifestPendingMoveOperation,
        destinationContent: Uint8Array,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const destinationRelPath = record.destinationRelPath;
        this.removeSyncManifestEntry(sourceRelPath);
        delete this.baseCache[sourceRelPath];
        this.seenLocalEntities.delete(sourceRelPath);
        if (this.pendingInitialDocumentSubscriptions.delete(sourceRelPath)) {
            this.pendingInitialDocumentSubscriptions.add(destinationRelPath);
        }
        this.setBypassCache(sourceRelPath, undefined, 'push', 'delete');
        this.clearRemoteDelete(sourceRelPath);
        this.baseCache[destinationRelPath] = destinationContent;
        this.seenLocalEntities.add(destinationRelPath);
        this.setBypassCache(destinationRelPath, destinationContent, 'push');
        this.clearRemoteDelete(destinationRelPath);
        const stable = await this.recordSyncManifestEntry(
            destinationRelPath,
            this.vfs.pathToUri(destinationRelPath),
            destinationContent,
            generation,
        );
        this.requireSyncSession(generation);
        this.locallyDivergedPaths.delete(sourceRelPath);
        if (stable) {
            this.locallyDivergedPaths.delete(destinationRelPath);
            this.clearLocalStabilizeState(destinationRelPath);
        } else {
            this.locallyDivergedPaths.add(destinationRelPath);
        }
        await this.removePendingLocalFileMove(
            sourceRelPath,
            'Overleaf accepted the entity-preserving local move',
            generation,
            record,
        );
        await this.persistSyncManifest(false, generation);
        if (!stable) {
            this.scheduleLocalPushRetry(
                destinationRelPath,
                this.localUri(destinationRelPath),
                'local-advanced-during-push',
                generation,
            );
        }
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [local move accepted] ' +
            sourceRelPath + ' -> ' + destinationRelPath +
            ' entity=' + record.sourceEntity.type + ':' + record.sourceEntity.id,
        );
    }

    private async executePendingLocalFileMove(
        sourceRelPath: string,
        record: SyncManifestPendingMoveOperation,
        destinationContent: Uint8Array,
        generation = this.syncGeneration,
    ): Promise<'accepted' | 'deferred' | 'conflict'> {
        let inspection: PendingLocalMoveInspection;
        try {
            inspection = await this.inspectPendingLocalFileMove(
                sourceRelPath,
                record,
                generation,
            );
        } catch (error) {
            getOutputChannel().appendLine(
                new Date().toISOString() + ' [pending move inspection deferred] ' +
                sourceRelPath + ' -> ' + record.destinationRelPath + ': ' +
                formatUnknownError(error),
            );
            return 'deferred';
        }
        if (inspection.accepted) {
            await this.finalizeAcceptedLocalFileMove(
                sourceRelPath,
                record,
                destinationContent,
                generation,
            );
            return 'accepted';
        }
        if (!inspection.ready) {
            await this.markSyncConflict(
                record.destinationRelPath,
                'A local move could not prove its original Overleaf entity and destination state',
                destinationContent,
                generation,
                inspection.destinationState,
            );
            return 'conflict';
        }

        let mutationError: unknown;
        try {
            await this.vfs.ensureConnectedForWrite();
            const mutationSourceRelPath = inspection.resumeSourceRelPath ?? sourceRelPath;
            this.requireSyncSession(generation);
            await this.runSessionIO(
                generation,
                () => this.vfs.rename(
                    this.vfs.pathToUri(mutationSourceRelPath),
                    this.vfs.pathToUri(record.destinationRelPath),
                    false,
                    record.sourceEntity,
                ),
            );
            this.requireSyncSession(generation);
        } catch (error) {
            mutationError = error;
        }

        try {
            inspection = await this.inspectPendingLocalFileMove(
                sourceRelPath,
                record,
                generation,
            );
        } catch (error) {
            getOutputChannel().appendLine(
                new Date().toISOString() + ' [pending move verification deferred] ' +
                sourceRelPath + ' -> ' + record.destinationRelPath + ': ' +
                formatUnknownError(error),
            );
            return 'deferred';
        }
        if (inspection.accepted) {
            await this.finalizeAcceptedLocalFileMove(
                sourceRelPath,
                record,
                destinationContent,
                generation,
            );
            return 'accepted';
        }
        if (!inspection.ready) {
            await this.markSyncConflict(
                record.destinationRelPath,
                'Overleaf changed while the local entity move was being applied',
                destinationContent,
                generation,
                inspection.destinationState,
            );
            return 'conflict';
        }
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [pending move deferred] ' +
            sourceRelPath + ' -> ' + record.destinationRelPath + ': ' +
            (mutationError===undefined
                ? 'Overleaf did not expose the move postcondition yet'
                : formatUnknownError(mutationError)),
        );
        return 'deferred';
    }

    private async inspectPendingLocalDirectoryMoveLocalState(
        sourceRelPath: string,
        record: SyncManifestPendingDirectoryMoveOperation,
        generation = this.syncGeneration,
    ): Promise<'stable' | 'advanced' | 'invalid'> {
        const [sourceState, destinationState] = await Promise.all([
            this.captureLocalPathRevision(sourceRelPath, generation),
            this.captureLocalPathRevision(record.destinationRelPath, generation),
        ]);
        this.requireSyncSession(generation);
        if (sourceState.kind!=='missing' || destinationState.kind!=='directory') {
            return 'invalid';
        }
        const destinationIdentity = await this.captureManifestLocalDirectoryIdentity(
            record.destinationRelPath,
            this.localUri(record.destinationRelPath),
        );
        this.requireSyncSession(generation);
        if (
            !destinationIdentity
            || !this.localMoveIdentityMatches(destinationIdentity, record.sourceLocalIdentity)
        ) {
            return 'invalid';
        }
        return destinationState.revision===record.localRevision ? 'stable' : 'advanced';
    }

    private async inspectPendingLocalDirectoryMove(
        sourceRelPath: string,
        record: SyncManifestPendingDirectoryMoveOperation,
        generation = this.syncGeneration,
    ): Promise<PendingLocalMoveInspection> {
        this.requireSyncSession(generation);
        const destinationRelPath = record.destinationRelPath;
        const [sourceState, destinationState] = await Promise.all([
            this.captureRemotePathRevision(sourceRelPath, generation),
            this.captureRemotePathRevision(destinationRelPath, generation),
        ]);
        this.requireSyncSession(generation);
        let accepted = false;
        let ready = false;
        let resumeSourceRelPath: string | undefined;
        if (
            sourceState.kind==='missing'
            && destinationState.kind==='directory'
            && destinationState.revision===record.localRevision
        ) {
            const destinationIdentity = await this.resolveRemoteFolderPathIdentity(
                this.vfs.pathToUri(destinationRelPath),
            );
            this.requireSyncSession(generation);
            accepted = this.remoteFolderPathIdentityMatches(
                destinationIdentity,
                record.sourceEntity,
                record.destinationParentEntity,
            );
        } else if (
            sourceState.kind==='directory'
            && destinationState.kind==='missing'
            && sourceState.revision===record.sourceRemoteRevision
        ) {
            const sourceIdentity = await this.resolveRemoteFolderPathIdentity(
                this.vfs.pathToUri(sourceRelPath),
            );
            this.requireSyncSession(generation);
            ready = this.remoteFolderPathIdentityMatches(
                sourceIdentity,
                record.sourceEntity,
                record.sourceParentEntity,
            );
        }
        if (
            !accepted
            && !ready
            && sourceState.kind==='missing'
            && destinationState.kind==='missing'
        ) {
            const sourceParentPath = nodePath.posix.dirname(sourceRelPath);
            for (const intermediateRelPath of this.pendingLocalMoveIntermediateRelPaths(
                sourceRelPath,
                destinationRelPath,
            )) {
                const intermediateState = await this.captureRemotePathRevision(
                    intermediateRelPath,
                    generation,
                );
                this.requireSyncSession(generation);
                if (
                    intermediateState.kind!=='directory'
                    || intermediateState.revision!==record.localRevision
                ) {
                    continue;
                }
                const intermediateIdentity = await this.resolveRemoteFolderPathIdentity(
                    this.vfs.pathToUri(intermediateRelPath),
                );
                this.requireSyncSession(generation);
                const expectedParent = nodePath.posix.dirname(intermediateRelPath)===sourceParentPath
                    ? record.sourceParentEntity
                    : record.destinationParentEntity;
                if (this.remoteFolderPathIdentityMatches(
                    intermediateIdentity,
                    record.sourceEntity,
                    expectedParent,
                )) {
                    ready = true;
                    resumeSourceRelPath = intermediateRelPath;
                    break;
                }
            }
        }
        return {sourceState, destinationState, accepted, ready, resumeSourceRelPath};
    }

    private async finalizeAcceptedLocalDirectoryMove(
        sourceRelPath: string,
        record: SyncManifestPendingDirectoryMoveOperation,
        localAdvanced: boolean,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const manifest = this.syncManifest;
        if (!manifest) {
            throw new Error('Local Replica folder move acknowledgement lost its manifest.');
        }
        const destinationRelPath = record.destinationRelPath;
        const pendingDescendant = this.pendingOperationIntersectingPaths(
            sourceRelPath,
            destinationRelPath,
            record.id,
        );
        if (pendingDescendant!==undefined) {
            throw new RemoteDocumentMergeConflictError(
                'A descendant operation appeared while the folder move was being acknowledged: ' +
                pendingDescendant,
            );
        }
        const movePath = (path: string) => destinationRelPath + path.slice(sourceRelPath.length);
        const rekeyRecord = <T>(
            values: Record<string, T>,
            copy: (value: T, oldPath: string, newPath: string) => T,
        ) => {
            const moved = Object.entries(values)
                .filter(([path]) => this.isPathAtOrBelow(path, sourceRelPath));
            const movedPaths = new Set(moved.map(([path]) => path));
            for (const [oldPath] of moved) {
                const newPath = movePath(oldPath);
                if (
                    !movedPaths.has(newPath)
                    && Object.prototype.hasOwnProperty.call(values, newPath)
                ) {
                    throw new RemoteDocumentMergeConflictError(
                        'The folder move destination already has synchronized local state: ' + newPath,
                    );
                }
            }
            for (const [oldPath] of moved) { delete values[oldPath]; }
            for (const [oldPath, value] of moved) {
                const newPath = movePath(oldPath);
                values[newPath] = copy(value, oldPath, newPath);
            }
        };
        const rekeyMap = <T>(values: Map<string, T>) => {
            const moved = [...values.entries()]
                .filter(([path]) => this.isPathAtOrBelow(path, sourceRelPath));
            const movedPaths = new Set(moved.map(([path]) => path));
            for (const [oldPath] of moved) {
                const newPath = movePath(oldPath);
                if (!movedPaths.has(newPath) && values.has(newPath)) {
                    throw new RemoteDocumentMergeConflictError(
                        'The folder move destination already has synchronized local state: ' + newPath,
                    );
                }
            }
            for (const [oldPath] of moved) { values.delete(oldPath); }
            for (const [oldPath, value] of moved) { values.set(movePath(oldPath), value); }
        };
        const rekeySet = (values: Set<string>) => {
            const moved = [...values].filter(path => this.isPathAtOrBelow(path, sourceRelPath));
            for (const oldPath of moved) { values.delete(oldPath); }
            for (const oldPath of moved) { values.add(movePath(oldPath)); }
        };

        rekeyRecord(manifest.files, entry => ({
            ...entry,
            remoteEntity: entry.remoteEntity && {...entry.remoteEntity},
            localIdentity: entry.localIdentity && {...entry.localIdentity},
        }));
        rekeyRecord(manifest.directories, (entry, oldPath) => {
            if (oldPath!==sourceRelPath) {
                return {
                    ...entry,
                    remoteEntity: entry.remoteEntity && {...entry.remoteEntity},
                    parentEntity: entry.parentEntity && {...entry.parentEntity},
                    localIdentity: entry.localIdentity && {...entry.localIdentity},
                };
            }
            return {
                ...entry,
                remoteEntity: {...record.sourceEntity},
                parentEntity: {...record.destinationParentEntity},
                localIdentity: {...record.sourceLocalIdentity},
                updatedAt: new Date().toISOString(),
            };
        });
        rekeyRecord(this.baseCache, entry => entry);
        rekeyMap(this.bypassCache);
        rekeyMap(this.remoteDeleteTombstones);
        rekeyMap(this.localStabilizeState);
        rekeySet(this.seenLocalEntities);
        rekeySet(this.pendingInitialDocumentSubscriptions);
        rekeySet(this.failedInitialPulls);
        rekeySet(this.scannerAbsentPaths);
        for (const path of [...this.locallyDivergedPaths]) {
            if (
                this.isPathAtOrBelow(path, sourceRelPath)
                || this.isPathAtOrBelow(path, destinationRelPath)
            ) {
                this.locallyDivergedPaths.delete(path);
            }
        }
        this.markSyncManifestDirty();
        const removed = await this.removePendingLocalDirectoryMove(
            sourceRelPath,
            'Overleaf accepted the entity-preserving local folder move',
            generation,
            record,
        );
        if (!removed) {
            throw new Error('Local Replica folder move journal changed before final acknowledgement.');
        }
        this.releasePendingLocalMoveDelete(sourceRelPath);
        this.replayDeferredLocalEventsAfterDirectoryMove(
            destinationRelPath,
            generation,
        );
        if (localAdvanced) {
            this.locallyDivergedPaths.add(destinationRelPath);
            this.queueForcedPush(
                destinationRelPath,
                'local-change-during-folder-move',
                'update',
                true,
            );
        }
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [local folder move accepted] ' +
            sourceRelPath + ' -> ' + destinationRelPath +
            ' entity=folder:' + record.sourceEntity.id,
        );
    }

    private async executePendingLocalDirectoryMove(
        sourceRelPath: string,
        record: SyncManifestPendingDirectoryMoveOperation,
        generation = this.syncGeneration,
    ): Promise<'accepted' | 'deferred' | 'conflict'> {
        let inspection: PendingLocalMoveInspection;
        try {
            inspection = await this.inspectPendingLocalDirectoryMove(
                sourceRelPath,
                record,
                generation,
            );
        } catch (error) {
            getOutputChannel().appendLine(
                new Date().toISOString() + ' [pending folder move inspection deferred] ' +
                sourceRelPath + ' -> ' + record.destinationRelPath + ': ' +
                formatUnknownError(error),
            );
            return 'deferred';
        }
        let localState: 'stable' | 'advanced' | 'invalid';
        try {
            localState = await this.inspectPendingLocalDirectoryMoveLocalState(
                sourceRelPath,
                record,
                generation,
            );
        } catch (error) {
            getOutputChannel().appendLine(
                new Date().toISOString() + ' [pending folder move local inspection deferred] ' +
                sourceRelPath + ' -> ' + record.destinationRelPath + ': ' +
                formatUnknownError(error),
            );
            return 'deferred';
        }
        if (localState==='invalid') {
            await this.markSyncConflict(
                sourceRelPath,
                'A pending local folder move cannot replay because its source was recreated or destination inode changed',
                undefined,
                generation,
            );
            return 'conflict';
        }
        const pendingDescendant = this.pendingOperationIntersectingPaths(
            sourceRelPath,
            record.destinationRelPath,
            record.id,
        );
        if (pendingDescendant!==undefined) {
            getOutputChannel().appendLine(
                new Date().toISOString() + ' [pending folder move deferred:pending-descendant] ' +
                sourceRelPath + ': ' + pendingDescendant,
            );
            return 'deferred';
        }
        if (inspection.accepted) {
            await this.finalizeAcceptedLocalDirectoryMove(
                sourceRelPath,
                record,
                localState==='advanced',
                generation,
            );
            return 'accepted';
        }
        if (!inspection.ready) {
            await this.markSyncConflict(
                record.destinationRelPath,
                'A local folder move could not prove its original Overleaf folder and destination state',
                undefined,
                generation,
                inspection.destinationState,
            );
            return 'conflict';
        }

        let mutationError: unknown;
        try {
            await this.vfs.ensureConnectedForWrite();
            const mutationSourceRelPath = inspection.resumeSourceRelPath ?? sourceRelPath;
            const mutationIdentity = await this.resolveRemoteFolderPathIdentity(
                this.vfs.pathToUri(mutationSourceRelPath),
            );
            this.requireSyncSession(generation);
            if (
                !mutationIdentity
                || !this.remoteFolderIdentityMatches(mutationIdentity.entity, record.sourceEntity)
            ) {
                throw new RemoteDocumentMergeConflictError(
                    'Overleaf folder identity changed immediately before the local move was submitted.',
                );
            }
            await this.runSessionIO(
                generation,
                () => this.vfs.rename(
                    this.vfs.pathToUri(mutationSourceRelPath),
                    this.vfs.pathToUri(record.destinationRelPath),
                    false,
                    {
                        id: record.sourceEntity.id,
                        type: 'folder',
                        parentId: mutationIdentity.parent.id,
                    },
                ),
            );
            this.requireSyncSession(generation);
        } catch (error) {
            mutationError = error;
        }

        try {
            inspection = await this.inspectPendingLocalDirectoryMove(
                sourceRelPath,
                record,
                generation,
            );
            localState = await this.inspectPendingLocalDirectoryMoveLocalState(
                sourceRelPath,
                record,
                generation,
            );
        } catch (error) {
            getOutputChannel().appendLine(
                new Date().toISOString() + ' [pending folder move verification deferred] ' +
                sourceRelPath + ' -> ' + record.destinationRelPath + ': ' +
                formatUnknownError(error),
            );
            return 'deferred';
        }
        if (localState==='invalid') {
            await this.markSyncConflict(
                sourceRelPath,
                'Local folder state changed while its Overleaf move was being applied',
                undefined,
                generation,
            );
            return 'conflict';
        }
        if (inspection.accepted) {
            await this.finalizeAcceptedLocalDirectoryMove(
                sourceRelPath,
                record,
                localState==='advanced',
                generation,
            );
            return 'accepted';
        }
        if (!inspection.ready) {
            await this.markSyncConflict(
                record.destinationRelPath,
                'Overleaf changed while the local folder move was being applied',
                undefined,
                generation,
                inspection.destinationState,
            );
            return 'conflict';
        }
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [pending folder move deferred] ' +
            sourceRelPath + ' -> ' + record.destinationRelPath + ': ' +
            (mutationError===undefined
                ? 'Overleaf did not expose the folder move postcondition yet'
                : formatUnknownError(mutationError)),
        );
        return 'deferred';
    }


    private async reconcilePendingLocalDirectoryMove(
        sourceRelPath: string,
        record: SyncManifestPendingDirectoryMoveOperation,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        if (
            this.touchesSyncConflict(sourceRelPath)
            || this.touchesSyncConflict(record.destinationRelPath)
        ) {
            return false;
        }
        return (await this.executePendingLocalDirectoryMove(
            sourceRelPath,
            record,
            generation,
        ))==='accepted';
    }

    private async recordSyncManifestDirectory(
        relPath: string,
        remoteIdentity?: RemoteFolderPathIdentity,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const manifest = this.syncManifest;
        if (!manifest) { return; }
        const localIdentity = await this.captureManifestLocalDirectoryIdentity(
            relPath,
            this.localUri(relPath),
        );
        this.requireSyncSession(generation);
        const entry: SyncManifestDirectoryEntry = remoteIdentity===undefined
            ? {
                updatedAt: new Date().toISOString(),
            }
            : {
                remoteEntity: {...remoteIdentity.entity},
                parentEntity: {...remoteIdentity.parent},
                updatedAt: new Date().toISOString(),
            };
        if (localIdentity!==undefined) {
            entry.localIdentity = localIdentity;
        }
        manifest.directories[relPath] = entry;
        this.markSyncManifestDirty();
    }

    private async finalizeAcceptedPendingLocalDirectoryCreate(
        relPath: string,
        record: SyncManifestPendingDirectoryCreateOperation,
        remoteIdentity: RemoteFolderPathIdentity,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        if (
            !record.createdEntity
            || !this.remoteFolderPathIdentityMatches(
                remoteIdentity,
                record.createdEntity,
                record.parentEntity,
            )
        ) {
            throw new RemoteDocumentMergeConflictError(
                'Overleaf folder identity changed before the pending local create was verified.',
            );
        }
        await this.recordSyncManifestDirectory(relPath, remoteIdentity, generation);
        this.seenLocalEntities.add(relPath);
        this.clearRemoteDelete(relPath);
        this.locallyDivergedPaths.delete(relPath);
        const removed = await this.removePendingLocalDirectoryCreate(
            relPath,
            'Overleaf accepted the guarded local folder create',
            generation,
            record,
        );
        if (!removed) {
            throw new Error('Local Replica mkdir journal changed before final acknowledgement.');
        }
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [local mkdir accepted] ' +
            relPath + ' entity=folder:' + remoteIdentity.entity.id,
        );
    }

    // Do not replace an active push/pull progress indicator mid-I/O. A direct
    // watcher move has no applySync envelope, so its durable journal must
    // explicitly refresh the at-rest status after it is persisted.
    private refreshDerivedSyncStatusWhenNotActive(): void {
        if (this.status.status==='push' || this.status.status==='pull') { return; }
        this.refreshDerivedSyncStatus();
    }

    private refreshDerivedSyncStatus(): void {
        if (this.syncConflicts.size>0) {
            this.status = {
                status: 'need-attention',
                message: vscode.l10n.t('{count} sync conflicts', {
                    count: this.syncConflicts.size,
                }),
            };
            return;
        }
        if (this.failedInitialPulls.size>0) {
            this.status = {
                status: 'need-attention',
                message: vscode.l10n.t('{count} files failed to download', {
                    count: this.failedInitialPulls.size,
                }),
            };
            return;
        }
        const pendingCount = Object.keys(
            this.syncManifest?.pendingOperations ?? {},
        ).length;
        if (pendingCount===0) {
            this.status = {status: 'idle', message: ''};
            return;
        }
        if (this.vfs.connectionState==='disconnected') {
            this.status = {
                status: 'offline',
                message: vscode.l10n.t(
                    '{count} local changes queued for Overleaf',
                    {count: pendingCount},
                ),
            };
            return;
        }
        if (
            this.vfs.connectionState==='initial'
            || this.vfs.connectionState==='reconnecting'
        ) {
            this.status = {
                status: 'pending',
                message: vscode.l10n.t(
                    'Reconciling {count} local changes with Overleaf',
                    {count: pendingCount},
                ),
            };
            return;
        }
        this.status = {
            status: 'pending',
            message: vscode.l10n.t(
                '{count} local changes pending upload to Overleaf',
                {count: pendingCount},
            ),
        };
    }

    private reportPushFailure(relPath: string, error: unknown): void {
        if (
            this.vfs.connectionState==='disconnected'
            || this.vfs.connectionState==='reconnecting'
            || this.vfs.connectionState==='initial'
        ) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [push queued:connection] ` +
                `${relPath}: ${formatUnknownError(error)}`,
            );
            return;
        }
        maybeWarnSyncFailure(relPath, error);
    }

    private async acknowledgePendingFilePushOperationFromAuthoritativeState(
        relPath: string,
        expected: Pick<SyncManifestPendingFileOperation, 'kind' | 'localRevision'>,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const entry = this.syncManifest?.pendingOperations[relPath];
        if (
            !entry
            || entry.kind!==expected.kind
            || entry.localRevision!==expected.localRevision
        ) {
            return false;
        }
        try {
            const [localState, remoteState] = await Promise.all([
                this.captureLocalPathRevision(relPath, generation),
                this.captureRemotePathRevision(relPath, generation),
            ]);
            this.requireSyncSession(generation);
            const acknowledgedUpdate = expected.kind==='update'
                && localState.kind==='file'
                && remoteState.kind==='file'
                && localState.revision===expected.localRevision
                && remoteState.revision===expected.localRevision;
            const acknowledgedDelete = expected.kind==='delete'
                && localState.kind==='missing'
                && remoteState.kind==='missing';
            if (!acknowledgedUpdate && !acknowledgedDelete) {
                return false;
            }
            return await this.removePendingFilePushOperation(
                relPath,
                'authoritative Overleaf state matches the pending local intent',
                generation,
                expected,
            );
        } catch (error) {
            if (this.isSyncSessionActive(generation)) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [pending operation acknowledgement deferred] ` +
                    `${relPath}: ${formatUnknownError(error)}`,
                );
            }
            return false;
        }
    }

    private removeSyncManifestEntry(relPath: string) {
        if (this.syncManifest?.files[relPath]) {
            delete this.syncManifest.files[relPath];
            this.markSyncManifestDirty();
        }
    }

    private removeSyncManifestDirectory(relPath: string) {
        if (this.syncManifest?.directories[relPath]) {
            delete this.syncManifest.directories[relPath];
            this.markSyncManifestDirty();
        }
    }

    private clearReplicaState(
        relPath: string,
        recursive = false,
        preservePendingEvents = false,
    ) {
        const matches = (path: string) => recursive
            ? this.isPathAtOrBelow(path, relPath)
            : path===relPath;
        for (const path of Object.keys(this.baseCache)) {
            if (matches(path)) { delete this.baseCache[path]; }
        }
        for (const path of [...this.seenLocalEntities]) {
            if (matches(path)) { this.seenLocalEntities.delete(path); }
        }
        for (const path of [...this.locallyDivergedPaths]) {
            if (matches(path)) { this.locallyDivergedPaths.delete(path); }
        }
        for (const path of [...this.localStabilizeState.keys()]) {
            if (matches(path)) { this.clearLocalStabilizeState(path); }
        }
        for (const path of [...this.scannerAbsentPaths]) {
            if (matches(path)) { this.scannerAbsentPaths.delete(path); }
        }
        for (const path of Object.keys(this.syncManifest?.files ?? {})) {
            if (matches(path)) { this.removeSyncManifestEntry(path); }
        }
        for (const path of Object.keys(this.syncManifest?.directories ?? {})) {
            if (matches(path)) { this.removeSyncManifestDirectory(path); }
        }
        for (const path of [...this.syncConflicts.keys()]) {
            if (matches(path)) {
                this.syncConflicts.delete(path);
                this.conflictLocalDigests.delete(path);
                if (this.syncManifest?.conflicts[path]) {
                    delete this.syncManifest.conflicts[path];
                    this.markSyncManifestDirty();
                }
            }
        }
        for (const [sourcePath, pending] of [...this.pendingLocalMoveDeletes]) {
            if (!matches(sourcePath)) { continue; }
            clearTimeout(pending.timer);
            pending.resolve();
            this.pendingLocalMoveDeletes.delete(sourcePath);
        }
        for (const path of [...this.bypassCache.keys()]) {
            if (matches(path)) { this.bypassCache.delete(path); }
        }
        for (const path of [...this.failedInitialPulls]) {
            if (matches(path)) { this.failedInitialPulls.delete(path); }
        }
        for (const path of [...this.pendingInitialDocumentSubscriptions]) {
            if (matches(path)) { this.pendingInitialDocumentSubscriptions.delete(path); }
        }
        for (const path of [...this.remoteDeleteTombstones.keys()]) {
            if (recursive && path.startsWith(`${relPath}/`)) {
                this.remoteDeleteTombstones.delete(path);
            }
        }
        if (!preservePendingEvents) {
            for (const [path, pending] of [...this.pendingVfsEvents]) {
                if (!matches(path)) { continue; }
                clearTimeout(pending.timer);
                this.pendingVfsEvents.delete(path);
            }
            for (const [path, pending] of [...this.pendingLocalEvents]) {
                if (!matches(path)) { continue; }
                clearTimeout(pending.timer);
                this.pendingLocalEvents.delete(path);
            }
        }
        if (this.initialPullStatus==='partial' && this.failedInitialPulls.size===0) {
            this.initialPullStatus = 'complete';
            this.partialPullToastGeneration = undefined;
        }
    }

    private async reconcilePendingLocalDirectoryCreate(
        relPath: string,
        record: SyncManifestPendingDirectoryCreateOperation,
        generation = this.syncGeneration,
    ): Promise<boolean> {
        this.requireSyncSession(generation);
        const localState = await this.captureLocalPathRevision(relPath, generation);
        if (localState.kind!=='directory') {
            await this.markSyncConflict(
                relPath,
                'A pending local folder create cannot replay because that local path changed type or disappeared',
                undefined,
                generation,
            );
            return false;
        }
        const remoteState = await this.captureRemotePathRevision(relPath, generation);
        this.requireSyncSession(generation);
        if (remoteState.kind==='directory') {
            const actual = await this.resolveRemoteFolderPathIdentity(
                this.vfs.pathToUri(relPath),
            );
            this.requireSyncSession(generation);
            if (
                record.createdEntity!==undefined
                && this.remoteFolderPathIdentityMatches(
                    actual,
                    record.createdEntity,
                    record.parentEntity,
                )
            ) {
                await this.finalizeAcceptedPendingLocalDirectoryCreate(
                    relPath,
                    record,
                    actual!,
                    generation,
                );
                return true;
            }
            await this.markSyncConflict(
                relPath,
                record.createdEntity===undefined
                    ? 'Overleaf folder appeared after an unacknowledged local create; its identity is not proven'
                    : 'Overleaf folder identity changed while the local create was being verified',
                undefined,
                generation,
                remoteState,
            );
            return false;
        }
        if (remoteState.kind!=='missing') {
            await this.markSyncConflict(
                relPath,
                'Overleaf path changed type while the local folder create was pending',
                undefined,
                generation,
                remoteState,
            );
            return false;
        }

        const parentRelPath = nodePath.posix.dirname(relPath);
        const actualParent = await this.resolveRemoteFolderPathIdentity(
            this.vfs.pathToUri(parentRelPath),
        );
        this.requireSyncSession(generation);
        if (!this.remoteFolderIdentityMatches(actualParent?.entity, record.parentEntity)) {
            await this.markSyncConflict(
                relPath,
                'Overleaf parent folder changed before the pending local create could be applied',
                undefined,
                generation,
            );
            return false;
        }

        let creation: Awaited<ReturnType<VirtualFileSystem['createDirectoryIfMissing']>>;
        try {
            creation = await this.withRetry('push', relPath, async () => {
                await this.vfs.ensureConnectedForWrite();
                this.requireSyncSession(generation);
                return this.runSessionIO(
                    generation,
                    () => this.vfs.createDirectoryIfMissing(this.vfs.pathToUri(relPath)),
                );
            }, {
                delays: LocalReplicaSCMProvider.pushRetryDelays,
                generation,
                betweenAttempts: async () => {
                    await this.waitForConnectedOrTimeout(
                        LocalReplicaSCMProvider.pushReconnectWaitMs,
                    );
                },
            });
        } catch (error) {
            if (!(error instanceof RemoteDocumentMergeConflictError)) {
                throw error;
            }
            await this.markSyncConflict(
                relPath,
                error.message,
                undefined,
                generation,
            );
            return false;
        }
        if (
            !creation.created
            || typeof creation.entityId!=='string'
            || creation.entityId.length===0
            || creation.parentId!==record.parentEntity.id
        ) {
            await this.markSyncConflict(
                relPath,
                'Overleaf did not prove that the pending local folder create produced the expected entity',
                undefined,
                generation,
            );
            return false;
        }

        const createdEntity: SyncManifestRemoteFolderIdentity = {
            id: creation.entityId,
            type: 'folder',
        };
        await this.markPendingLocalDirectoryCreateEntity(
            relPath,
            record,
            createdEntity,
            generation,
        );
        const verified = await this.resolveRemoteFolderPathIdentity(
            this.vfs.pathToUri(relPath),
        );
        this.requireSyncSession(generation);
        if (!this.remoteFolderPathIdentityMatches(
            verified,
            createdEntity,
            record.parentEntity,
        )) {
            await this.markSyncConflict(
                relPath,
                'Overleaf did not retain the created folder identity at the requested path',
                undefined,
                generation,
            );
            return false;
        }
        await this.finalizeAcceptedPendingLocalDirectoryCreate(
            relPath,
            record,
            verified!,
            generation,
        );
        return true;
    }

    private async reconcilePendingLocalDirectoryDelete(
        relPath: string,
        record: SyncManifestPendingDirectoryDeleteOperation,
        generation = this.syncGeneration,
        options: {allowRemoteDivergence?: boolean} = {},
    ): Promise<'accepted' | 'deferred' | 'conflict'> {
        this.requireSyncSession(generation);
        const localState = await this.captureLocalPathRevision(relPath, generation);
        if (localState.kind!=='missing') {
            await this.markSyncConflict(
                relPath,
                'A pending local folder delete cannot replay because the local folder was recreated',
                undefined,
                generation,
            );
            return 'conflict';
        }
        const pendingDescendant = this.pendingOperationAtOrBelow(relPath, record.id);
        if (pendingDescendant!==undefined) {
            getOutputChannel().appendLine(
                new Date().toISOString() + ' [pending rmdir deferred:pending-descendant] ' +
                relPath + ': ' + pendingDescendant,
            );
            return 'deferred';
        }

        const remoteState = await this.captureRemotePathRevision(relPath, generation);
        this.requireSyncSession(generation);
        if (remoteState.kind==='missing') {
            if (!await this.verifyRemoteFolderDeletePostcondition(relPath, record, generation)) {
                await this.markSyncConflict(
                    relPath,
                    'Overleaf removed the folder path but the recorded folder identity was not proven deleted',
                    undefined,
                    generation,
                );
                return 'conflict';
            }
            await this.finalizeAcceptedPendingLocalDirectoryDelete(relPath, record, generation);
            return 'accepted';
        }
        if (remoteState.kind==='directory') {
            const ignoredDescendant = await this.findIgnoredDescendant(
                this.vfs.pathToUri(relPath),
                relPath,
                generation,
            );
            this.requireSyncSession(generation);
            if (ignoredDescendant) {
                await this.markSyncConflict(
                    relPath,
                    'The local folder was deleted, but ignored Overleaf content must be preserved (' +
                        ignoredDescendant + ')',
                    null,
                    generation,
                );
                return 'conflict';
            }
        }
        if (
            remoteState.kind!=='directory'
            || remoteState.revision!==record.remoteRevision
        ) {
            await this.markSyncConflict(
                relPath,
                'The local folder was deleted while its Overleaf contents also changed',
                undefined,
                generation,
                remoteState,
            );
            return 'conflict';
        }

        try {
            await this.assertRemoteFolderDeletePath(
                this.vfs.pathToUri(relPath),
                relPath,
                record.remoteRevision,
                record.targetEntity,
                record.parentEntity,
                'pending folder delete target',
                generation,
            );
            if (
                !options.allowRemoteDivergence
                && await this.remoteDirectoryHasChanges(relPath, generation)
            ) {
                this.requireSyncSession(generation);
                await this.markSyncConflict(
                    relPath,
                    'The local folder was deleted while its Overleaf contents also changed',
                    null,
                    generation,
                );
                return 'conflict';
            }
            // The directory scan above itself awaits every child. A
            // collaborator can land a new entity immediately after its last
            // read, so take one final full-tree+identity snapshot before the
            // stage journal is allowed to mutate the remote tree.
            const finalRemoteState = await this.captureRemotePathRevision(
                relPath,
                generation,
            );
            this.requireSyncSession(generation);
            if (
                finalRemoteState.kind!=='directory'
                || finalRemoteState.revision!==record.remoteRevision
            ) {
                await this.markSyncConflict(
                    relPath,
                    'Overleaf changed the folder tree immediately before the local delete could be staged',
                    null,
                    generation,
                    finalRemoteState,
                );
                return 'conflict';
            }
            await this.assertRemoteFolderDeletePath(
                this.vfs.pathToUri(relPath),
                relPath,
                record.remoteRevision,
                record.targetEntity,
                record.parentEntity,
                'final pending folder delete target',
                generation,
            );

            await this.withRetry('push', relPath, async () => {
                await this.vfs.ensureConnectedForWrite();
                this.requireSyncSession(generation);
                return this.atomicDeleteRemoteFolderIfIdentity(
                    relPath,
                    record,
                    generation,
                    async () => {
                        const currentLocal = await this.captureLocalPathRevision(
                            relPath,
                            generation,
                        );
                        return currentLocal.kind==='missing'
                            && this.pendingOperationAtOrBelow(relPath, record.id)===undefined;
                    },
                );
            }, {
                delays: LocalReplicaSCMProvider.pushRetryDelays,
                generation,
                betweenAttempts: async () => {
                    await this.waitForConnectedOrTimeout(
                        LocalReplicaSCMProvider.pushReconnectWaitMs,
                    );
                },
            });
        } catch (error) {
            if (LocalReplicaSCMProvider.isLocalReadUnstable(error)) {
                const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                const laterPending = this.pendingOperationAtOrBelow(relPath, record.id);
                if (latestLocal.kind==='missing' && laterPending!==undefined) {
                    getOutputChannel().appendLine(
                        new Date().toISOString() + ' [pending rmdir replay deferred] ' +
                        relPath + ': ' + laterPending,
                    );
                    return 'deferred';
                }
            }
            if (
                error instanceof ConcurrentReplicaChangeError
                || error instanceof RemoteDocumentMergeConflictError
                || LocalReplicaSCMProvider.isLocalReadUnstable(error)
            ) {
                await this.markSyncConflict(
                    relPath,
                    'The guarded local folder delete could not be applied safely: ' +
                        formatUnknownError(error),
                    undefined,
                    generation,
                );
                return 'conflict';
            }
            throw error;
        }

        this.requireSyncSession(generation);
        const localRecreated = (
            await this.captureLocalPathRevision(relPath, generation)
        ).kind!=='missing';
        const pendingLocalChange = [...this.pendingLocalEvents.keys()]
            .some(path => this.isPathAtOrBelow(path, relPath));
        await this.finalizeAcceptedPendingLocalDirectoryDelete(relPath, record, generation);
        if (localRecreated || pendingLocalChange) {
            this.locallyDivergedPaths.add(relPath);
            this.queueForcedPush(
                relPath,
                'local-change-during-guarded-folder-delete',
                localRecreated ? 'update' : 'delete',
            );
        }
        return 'accepted';
    }

    private async reconcilePendingFilePushOperations(
        generation = this.syncGeneration,
    ): Promise<void> {
        const pending = Object.entries(this.syncManifest?.pendingOperations ?? {})
            .sort(([left], [right]) => left.localeCompare(right));
        if (pending.length===0) { return; }
        let recovered = 0;
        for (const [relPath, recorded] of pending) {
            if (!this.isSyncSessionActive(generation)) { return; }
            if (this.touchesSyncConflict(relPath)) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [pending operation blocked:conflict] ${relPath}`,
                );
                continue;
            }
            if (recorded.kind==='rmdir') {
                try {
                    if (await this.reconcilePendingLocalDirectoryDelete(
                        relPath,
                        recorded,
                        generation,
                    )==='accepted') {
                        recovered += 1;
                    }
                } catch (error) {
                    this.locallyDivergedPaths.add(relPath);
                    getOutputChannel().appendLine(
                        new Date().toISOString() + ' [pending rmdir replay deferred] ' +
                        relPath + ': ' + formatUnknownError(error),
                    );
                }
                continue;
            }
            if (recorded.kind==='mkdir') {
                try {
                    if (await this.reconcilePendingLocalDirectoryCreate(
                        relPath,
                        recorded,
                        generation,
                    )) {
                        recovered += 1;
                    }
                } catch (error) {
                    this.locallyDivergedPaths.add(relPath);
                    getOutputChannel().appendLine(
                        new Date().toISOString() + ' [pending mkdir replay deferred] ' +
                        relPath + ': ' + formatUnknownError(error),
                    );
                }
                continue;
            }
            if (recorded.kind==='move') {
                try {
                    if (await this.reconcilePendingLocalFileMove(
                        relPath,
                        recorded,
                        generation,
                    )) {
                        recovered += 1;
                    }
                } catch (error) {
                    this.locallyDivergedPaths.add(relPath);
                    this.locallyDivergedPaths.add(recorded.destinationRelPath);
                    getOutputChannel().appendLine(
                        new Date().toISOString() + ' [pending move replay deferred] ' +
                        relPath + ' -> ' + recorded.destinationRelPath + ': ' +
                        formatUnknownError(error),
                    );
                }
                continue;
            }
            if (recorded.kind==='directory-move') {
                try {
                    if (await this.reconcilePendingLocalDirectoryMove(
                        relPath,
                        recorded,
                        generation,
                    )) {
                        recovered += 1;
                    }
                } catch (error) {
                    this.locallyDivergedPaths.add(relPath);
                    this.locallyDivergedPaths.add(recorded.destinationRelPath);
                    getOutputChannel().appendLine(
                        new Date().toISOString() + ' [pending folder move replay deferred] ' +
                        relPath + ' -> ' + recorded.destinationRelPath + ': ' +
                        formatUnknownError(error),
                    );
                }
                continue;
            }

            try {
                const localState = await this.captureLocalPathRevision(relPath, generation);
                if (localState.kind!=='file' && localState.kind!=='missing') {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [pending operation deferred:local-type] ${relPath} ` +
                        `kind=${localState.kind}`,
                    );
                    continue;
                }
                const remoteState = await this.captureRemotePathRevision(relPath, generation);
                this.requireSyncSession(generation);
                const statesMatch = (
                    localState.kind==='missing'
                    && remoteState.kind==='missing'
                ) || (
                    localState.kind==='file'
                    && remoteState.kind==='file'
                    && localState.revision===remoteState.revision
                );
                if (statesMatch) {
                    if (localState.kind==='file') {
                        const stable = await this.recordSyncManifestEntry(
                            relPath,
                            this.vfs.pathToUri(relPath),
                            localState.content!,
                            generation,
                        );
                        if (!stable) { continue; }
                        this.baseCache[relPath] = localState.content!;
                        this.seenLocalEntities.add(relPath);
                    } else {
                        delete this.baseCache[relPath];
                        this.seenLocalEntities.delete(relPath);
                        this.removeSyncManifestEntry(relPath);
                        this.removeSyncManifestDirectory(relPath);
                    }
                    this.clearRemoteDelete(relPath);
                    this.locallyDivergedPaths.delete(relPath);
                    if (await this.removePendingFilePushOperation(
                        relPath,
                        'current local state already matches authoritative Overleaf',
                        generation,
                    )) {
                        recovered += 1;
                    }
                    continue;
                }

                const remotePreconditionChanged = recorded.remoteKind!==undefined
                    && (
                        recorded.remoteKind!==remoteState.kind
                        || recorded.remoteRevision!==remoteState.revision
                    );
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [pending operation replay] ${relPath} ` +
                    `kind=${localState.kind==='missing' ? 'delete' : 'update'} ` +
                    `remotePrecondition=${remotePreconditionChanged ? 'advanced' : 'current'}`,
                );
                const event = await this.applySync(
                    'push',
                    localState.kind==='missing' ? 'delete' : 'update',
                    relPath,
                    this.localUri(relPath),
                    this.vfs.pathToUri(relPath),
                    {forcePush: true, reason: 'pending-operation-recovery'},
                    generation,
                );
                if (
                    (event.outcome==='success' || event.outcome==='suppressed')
                    && this.syncManifest?.pendingOperations[relPath]===undefined
                ) {
                    recovered += 1;
                }
            } catch (error) {
                if (!this.isSyncSessionActive(generation)) { return; }
                this.locallyDivergedPaths.add(relPath);
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [pending operation replay deferred] ${relPath}: ` +
                    formatUnknownError(error),
                );
            }
        }
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [pending operation replay complete] ` +
            `recovered=${recovered} remaining=${Object.keys(
                this.syncManifest?.pendingOperations ?? {},
            ).length}`,
        );
    }
    private requestPendingFilePushOperationReplay(
        generation = this.syncGeneration,
    ): Promise<void> {
        const existing = this.pendingOperationReplay;
        if (existing?.generation===generation) {
            return existing.promise;
        }
        const record: {
            generation: number;
            started: boolean;
            promise: Promise<void>;
        } = {
            generation,
            started: false,
            promise: Promise.resolve(),
        };
        const replay = (async () => {
            // Drain operations accepted before the connection transition. Once
            // `started` is true, enqueueSync fences later watcher work behind
            // this replay so one path cannot race its own durable intent.
            await this.drainPendingSyncWork();
            if (!this.isSyncSessionActive(generation)) { return; }
            record.started = true;
            await this.reconcilePendingFilePushOperations(generation);
        })().catch(error => {
            if (this.isSyncSessionActive(generation)) {
                getOutputChannel().appendLine(
                    new Date().toISOString() +
                    ' [pending operation replay failed] ' +
                    formatUnknownError(error),
                );
            }
        }).finally(() => {
            if (this.pendingOperationReplay===record) {
                this.pendingOperationReplay = undefined;
            }
            if (this.isSyncSessionActive(generation)) {
                this.refreshDerivedSyncStatus();
            }
        });
        record.promise = replay;
        this.pendingOperationReplay = record;
        return replay;
    }


    private rememberRemoteDelete(relPath: string, content?: Uint8Array, staleLocalMtime?: number) {
        if (content===undefined) {
            this.remoteDeleteTombstones.delete(relPath);
            return;
        }
        this.remoteDeleteTombstones.set(relPath, {
            digest: contentDigest(content),
            staleLocalMtime: staleLocalMtime===undefined ? undefined : normalizeMtimeMs(staleLocalMtime),
            deletedAt: Date.now(),
        });
    }

    private clearRemoteDelete(relPath: string) {
        this.remoteDeleteTombstones.delete(relPath);
    }

    private clearFailedInitialPullAfterAuthoritativeSync(
        relPath: string,
        generation = this.syncGeneration,
    ) {
        this.requireSyncSession(generation);
        this.pendingInitialDocumentSubscriptions.delete(relPath);
        if (!this.failedInitialPulls.delete(relPath)) { return; }

        if (this.failedInitialPulls.size===0) {
            this.initialPullStatus = 'complete';
            this.partialPullToastGeneration = undefined;
            this.completeTrustedBaselineIfResolved();
            if (this.syncConflicts.size===0) {
                this.status = {status: 'idle', message: ''};
            }
            this.armLocalWatcher?.();
        } else if (this.initialPullStatus==='partial' && this.syncConflicts.size===0) {
            this.status = {
                status: 'need-attention',
                message: vscode.l10n.t(
                    '{count} files failed to download',
                    {count: this.failedInitialPulls.size},
                ),
            };
        }
    }

    private shouldPropagate(
        action: 'push'|'pull',
        type: 'update'|'delete',
        relPath: string,
        content?: Uint8Array,
        options?: ApplySyncOptions,
    ): boolean {
        const key = normalizeReplicaPath(relPath);
        const now = Date.now();
        const cache = this.bypassCache.get(key);
        if (cache) {
            const thisHash = contentDigest(content);
            const ownCache = action==='push' ? cache[0] : cache[1];
            const oppositeCache = action==='push' ? cache[1] : cache[0];
            if (options?.forcePush && action==='push') {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [push forced:${options.reason ?? 'manual'}] ${relPath} ` +
                    `(bypassing echo suppression)`,
                );
                this.setBypassCache(key, content, action, type);
                return true;
            }
            // Same-direction match: the last operation in THIS direction
            // already produced these exact bytes. Suppress as a redundant
            // no-op (avoids re-uploading identical bytes on bare Ctrl-S,
            // which matters for large binaries). No time bound here — a
            // duplicate save days later is still a duplicate.
            const matchesCurrentBaseline = content===undefined
                || this.isContentKnownSynced(key, content)
                || this.syncManifest?.directories[key]!==undefined;
            if (
                ownCache?.hash===thisHash
                && ownCache.type===type
                && matchesCurrentBaseline
            ) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [${action} suppressed:own-echo] ${relPath} ` +
                    `(age=${now-ownCache.date}ms, ${type} hash unchanged since prior ${action})`,
                );
                return false;
            }
            // Cross-direction match: the opposite side just produced these
            // bytes — this fire is the watcher reacting to that write. Only
            // honour while fresh so a stale divergent cache can't swallow a
            // later undo/redo save back to that state.
            if (
                oppositeCache?.hash===thisHash
                && oppositeCache.type===type
                && now-oppositeCache.date<ECHO_WINDOW_MS
            ) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [${action} suppressed:cross-echo] ${relPath} ` +
                    `(age=${now-oppositeCache.date}ms, ${type} within ${ECHO_WINDOW_MS}ms window)`,
                );
                this.setBypassCache(key, content, action, type);
                return false;
            }
        }
        this.setBypassCache(key, content, action, type);
        return true;
    }

    private enqueueSync<T>(
        relPath: string,
        task: () => Promise<T>,
        generation = this.syncGeneration,
        acceptedBeforeRemoval = false,
    ): Promise<T | undefined> {
        if (
            this.removalPendingGeneration===generation
            && !acceptedBeforeRemoval
        ) {
            return Promise.resolve(undefined);
        }
        const pendingOperationReplay = this.pendingOperationReplay;
        const replayFence = (
            pendingOperationReplay?.generation===generation
            && pendingOperationReplay.started
        )
            ? pendingOperationReplay.promise
            : undefined;
        const previous = this.syncQueues.get(relPath) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(async () => {
                if (replayFence) { await replayFence; }
                this.requireSyncSession(generation);
                return task();
            })
            .catch(error => {
                console.error(error);
                // applySync reports its own failures. Anything surfacing here
                // escaped outside it — delete promotion, a VFS Unavailable
                // during reconnect, EACCES/ELOOP — and used to vanish with no
                // output line, no toast and nothing queued for retry, leaving a
                // pull-side delete recoverable only by restarting the window.
                if (this.isSyncSessionActive(generation)) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [sync intent dropped] ${relPath}: ` +
                        formatUnknownError(error),
                    );
                    this.locallyDivergedPaths.add(relPath);
                    // A deferred read has already been re-armed by whoever threw
                    // it; toasting here would turn a normal mid-write read into
                    // a user-visible sync failure.
                    if (!LocalReplicaSCMProvider.isLocalReadUnstable(error)) {
                        this.reportPushFailure(relPath, error);
                    }
                }
                return undefined;
            })
            .finally(() => {
                if (this.syncQueues.get(relPath)===next) {
                    this.syncQueues.delete(relPath);
                }
            });
        this.syncQueues.set(relPath, next);
        return next;
    }

    private deferAcceptedSync<T>(
        relPath: string,
        task: () => Promise<T>,
        generation: number,
    ): void {
        let deferred!: Promise<void>;
        deferred = new Promise<void>(resolve => {
            setTimeout(() => {
                if (!this.isSyncSessionActive(generation)) {
                    resolve();
                    return;
                }
                void this.enqueueSync(
                    relPath,
                    task,
                    generation,
                    true,
                ).then(() => resolve(), () => resolve());
            }, 0);
        }).finally(() => {
            this.deferredSyncWork.delete(deferred);
        });
        this.deferredSyncWork.add(deferred);
    }

    private async prefetchInitialRemoteBootstrap(
        root: string,
        generation = this.syncGeneration,
    ): Promise<InitialRemoteBootstrap> {
        const startedAt = Date.now();
        const files: [string, string][] = [];
        const directories: string[] = [];
        const queue: string[] = [root];
        while (queue.length!==0) {
            this.requireSyncSession(generation);
            const nextRoot = queue.shift()!;
            const vfsUri = this.vfs.pathToUri(nextRoot);
            const items = await this.withFileSystemContext(
                'Read remote directory',
                vfsUri,
                () => typeof this.vfs.list==='function'
                    ? this.vfs.list(vfsUri)
                    : vscode.workspace.fs.readDirectory(vfsUri),
            );
            this.requireSyncSession(generation);
            for (const [name, type] of items) {
                const relPath = this.normalizeConfinedRelPath(nextRoot + name, 'initial pull');
                if (relPath===undefined || this.matchIgnorePatterns(relPath)) {
                    continue;
                }
                if (type===vscode.FileType.Directory) {
                    directories.push(relPath);
                    queue.push(`${relPath}/`);
                } else {
                    files.push([name, relPath]);
                }
            }
        }
        const remoteTreeElapsedMs = Date.now()-startedAt;
        let documentSnapshots: Map<string, Uint8Array> | undefined;
        let documentBatchElapsedMs = 0;
        const downloadDocumentSnapshots = this.vfs.downloadDocumentSnapshots;
        if (typeof downloadDocumentSnapshots==='function') {
            const batchStartedAt = Date.now();
            try {
                documentSnapshots = await this.withRetry(
                    'pull',
                    '/ (initial document batch)',
                    () => downloadDocumentSnapshots.call(
                        this.vfs,
                        files.map(([_name, relPath]) => this.vfs.pathToUri(relPath)),
                    ),
                    {
                        delays: LocalReplicaSCMProvider.pullRetryDelays,
                        generation,
                        betweenAttempts: async () => {
                            await this.waitForConnectedOrTimeout(
                                LocalReplicaSCMProvider.pullReconnectWaitMs,
                            );
                        },
                    },
                );
                this.requireSyncSession(generation);
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [initial document batch complete] ` +
                    `transport=${this.vfs.documentSnapshotTransport} ` +
                    `files=${documentSnapshots.size} ` +
                    `elapsed=${Date.now()-batchStartedAt}ms`,
                );
            } catch (error) {
                if (!this.isSyncSessionActive(generation)) { throw error; }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [initial document batch fallback] ` +
                    `${formatUnknownError(error)}`,
                );
            } finally {
                documentBatchElapsedMs = Date.now()-batchStartedAt;
            }
        }
        return {
            files,
            directories,
            documentSnapshots,
            remoteTreeElapsedMs,
            documentBatchElapsedMs,
        };
    }

    private async overwrite(
        root: string='/',
        options: InitializeLocalReplicaOptions = {},
        generation = this.syncGeneration,
        remoteBootstrapPromise?: Promise<InitialRemoteBootstrapOutcome>,
    ): Promise<boolean|undefined> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Sync Files'),
            cancellable: true,
        }, async (progress, token) => {
            const overwriteStartedAt = Date.now();
            const cancelled = () => token.isCancellationRequested || !this.isSyncSessionActive(generation);
            const resetLocalFilesToRemote = options.resetLocalFilesToRemote ?? false;
            const preserveExistingLocalFiles = (options.preserveExistingLocalFiles ?? false)
                && !resetLocalFilesToRemote;
            const baselineUnavailable = preserveExistingLocalFiles
                && this.syncManifestBaselineMode==='unavailable';
            const bootstrapWaitStartedAt = Date.now();
            let remoteBootstrap: InitialRemoteBootstrap;
            if (remoteBootstrapPromise) {
                const outcome = await remoteBootstrapPromise;
                if ('error' in outcome) { throw outcome.error; }
                remoteBootstrap = outcome.value;
            } else {
                remoteBootstrap = await this.prefetchInitialRemoteBootstrap(root, generation);
            }
            if (cancelled()) { return undefined; }
            const bootstrapWaitElapsedMs = Date.now()-bootstrapWaitStartedAt;
            const {
                files,
                directories,
                documentSnapshots: initialDocumentSnapshots,
                remoteTreeElapsedMs,
                documentBatchElapsedMs,
            } = remoteBootstrap;

            const localSnapshotStartedAt = Date.now();
            const localSnapshot = preserveExistingLocalFiles
                ? await this.collectLocalReplicaSnapshot(
                    this.baseUri,
                    '/',
                    {files: new Set(), directories: new Set()},
                    generation,
                )
                : undefined;
            const localSnapshotElapsedMs = Date.now()-localSnapshotStartedAt;
            const pendingMoveSources = new Set<string>();
            const pendingMoveDestinations = new Set<string>();
            const pendingDirectoryMoveRoots = new Set<string>();
            for (const [sourceRelPath, operation] of Object.entries(this.syncManifest?.pendingOperations ?? {})) {
                if (operation.kind==='move') {
                    pendingMoveSources.add(sourceRelPath);
                    pendingMoveDestinations.add(operation.destinationRelPath);
                } else if (operation.kind==='directory-move') {
                    pendingMoveSources.add(sourceRelPath);
                    pendingMoveDestinations.add(operation.destinationRelPath);
                    pendingDirectoryMoveRoots.add(sourceRelPath);
                    pendingDirectoryMoveRoots.add(operation.destinationRelPath);
                }
            }
            const isPendingDirectoryMovePath = (relPath: string) =>
                [...pendingDirectoryMoveRoots].some(directoryPath =>
                    this.isPathAtOrBelow(relPath, directoryPath),
                );


            if (initialDocumentSnapshots) {
                for (const [_name, relPath] of files) {
                    if (pendingMoveSources.has(relPath) || isPendingDirectoryMovePath(relPath)) { continue; }
                    if (initialDocumentSnapshots.has(
                        this.vfs.pathToUri(relPath).toString(),
                    )) {
                        this.pendingInitialDocumentSubscriptions.add(relPath);
                    }
                }
            }
            const pullInitialFile = (relPath: string, vfsUri: vscode.Uri) =>
                this.pullInitialRemoteFile(
                    relPath,
                    vfsUri,
                    generation,
                    initialDocumentSnapshots,
                );
            const remoteFilePaths = new Set(files.map(([_name, relPath]) => relPath));
            const remoteDirectoryPaths = new Set(directories);
            const startupPushPaths = new Set<string>();
            const startupPushDirectoryPaths = new Set<string>();
            const startupRemoteDeletePaths = new Set<string>();
            const startupLocalDeletePaths = new Set<string>();
            const startupRemoteDirectoryDeletePaths = new Set<string>();
            const startupLocalDirectoryDeletePaths = new Set<string>();
            const blockedDirectoryRoots = new Set<string>(this.syncConflicts.keys());
            for (const relPath of pendingDirectoryMoveRoots) {
                blockedDirectoryRoots.add(relPath);
            }

            const requireStartupSync = (
                event: Events['scmSyncCompleteEvent'],
                operation: string,
                relPath: string,
            ) => {
                if (
                    event.outcome==='error'
                    || event.outcome==='blocked'
                    || event.outcome==='suppressed'
                ) {
                    throw new Error(`${operation} failed for ${relPath}: ${event.error ?? event.outcome}`);
                }
            };

            if (resetLocalFilesToRemote) {
                if (cancelled()) { return false; }
                await this.clearLocalProjectFilesForRemoteReset(generation);
                if (cancelled()) { return false; }
                this.syncManifest = this.emptySyncManifest();
                this.syncConflicts.clear();
                this.conflictLocalDigests.clear();
                this.markSyncManifestDirty();
            }

            const pathIsBlockedByDirectory = (relPath: string) =>
                [...blockedDirectoryRoots].some(directoryPath => this.isPathAtOrBelow(relPath, directoryPath));
            const remoteDirectoryIsUnchanged = async (directoryPath: string) => {
                this.requireSyncSession(generation);
                const remoteDescendantFiles = [...remoteFilePaths]
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const remoteDescendantDirectories = [...remoteDirectoryPaths]
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const manifestFiles = Object.keys(this.syncManifest?.files ?? {})
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const manifestDirectories = Object.keys(this.syncManifest?.directories ?? {})
                    .filter(path => path.startsWith(`${directoryPath}/`));
                if (
                    remoteDescendantFiles.some(path => this.syncManifest?.files[path]===undefined)
                    || remoteDescendantDirectories.some(path => this.syncManifest?.directories[path]===undefined)
                    || manifestFiles.some(path => !remoteFilePaths.has(path))
                    || manifestDirectories.some(path => !remoteDirectoryPaths.has(path))
                ) {
                    return false;
                }
                for (const path of remoteDescendantFiles) {
                    const entry = this.syncManifest?.files[path];
                    if (!entry) { return false; }
                    if (this.isLikelyBinaryRelPath(path)) {
                        const fingerprint = await this.getRemoteFingerprint(path, this.vfs.pathToUri(path));
                        this.requireSyncSession(generation);
                        if (!fingerprint || fingerprint!==entry.remoteFingerprint) {
                            return false;
                        }
                    } else {
                        const content = await pullInitialFile(
                            path,
                            this.vfs.pathToUri(path),
                        );
                        if (contentDigest(content)!==entry.localDigest) {
                            return false;
                        }
                    }
                }
                this.requireSyncSession(generation);
                return true;
            };
            const localDirectoryIsUnchanged = async (directoryPath: string) => {
                this.requireSyncSession(generation);
                if (!localSnapshot) { return false; }
                const localDescendantFiles = [...localSnapshot.files]
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const localDescendantDirectories = [...localSnapshot.directories]
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const manifestFiles = Object.keys(this.syncManifest?.files ?? {})
                    .filter(path => path.startsWith(`${directoryPath}/`));
                const manifestDirectories = Object.keys(this.syncManifest?.directories ?? {})
                    .filter(path => path.startsWith(`${directoryPath}/`));
                if (
                    localDescendantFiles.some(path => this.syncManifest?.files[path]===undefined)
                    || localDescendantDirectories.some(path => this.syncManifest?.directories[path]===undefined)
                    || manifestFiles.some(path => !localSnapshot.files.has(path))
                    || manifestDirectories.some(path => !localSnapshot.directories.has(path))
                ) {
                    return false;
                }
                for (const path of localDescendantFiles) {
                    if (!await this.isLocalUnchangedFromManifest(path)) {
                        return false;
                    }
                    this.requireSyncSession(generation);
                }
                return true;
            };

            if (preserveExistingLocalFiles && localSnapshot) {
                for (const relPath of localSnapshot.files) {
                    if (!remoteDirectoryPaths.has(relPath) || pathIsBlockedByDirectory(relPath)) {
                        continue;
                    }
                    blockedDirectoryRoots.add(relPath);
                    const localContent = await this.readLocalFileInSession(relPath, generation);
                    await this.markSyncConflict(
                        relPath,
                        'Overleaf contains a folder where the local replica contains a file',
                        localContent,
                        generation,
                    );
                }
                for (const relPath of localSnapshot.directories) {
                    if (!remoteFilePaths.has(relPath) || pathIsBlockedByDirectory(relPath)) {
                        continue;
                    }
                    blockedDirectoryRoots.add(relPath);
                    await this.markSyncConflict(
                        relPath,
                        'Overleaf contains a file where the local replica contains a folder',
                        undefined,
                        generation,
                    );
                }
                if (baselineUnavailable) {
                    const unknownDirectories = new Set([
                        ...localSnapshot.directories,
                        ...remoteDirectoryPaths,
                    ]);
                    const orderedUnknownDirectories = [...unknownDirectories]
                        .sort((left, right) => left.split('/').length-right.split('/').length);
                    for (const relPath of orderedUnknownDirectories) {
                        if (pathIsBlockedByDirectory(relPath)) { continue; }
                        if (this.syncManifest?.directories[relPath]!==undefined) { continue; }
                        const localExists = localSnapshot.directories.has(relPath);
                        const remoteExists = remoteDirectoryPaths.has(relPath);
                        if (localExists===remoteExists) { continue; }
                        blockedDirectoryRoots.add(relPath);
                        await this.markSyncConflict(
                            relPath,
                            localExists
                                ? 'The local folder exists only on one side and no trusted sync baseline is available'
                                : 'The Overleaf folder exists only on one side and no trusted sync baseline is available',
                            localExists ? undefined : null,
                            generation,
                        );
                    }
                }
                const baselineDirectories = Object.keys(this.syncManifest?.directories ?? {})
                    .sort((left, right) => left.split('/').length-right.split('/').length);
                for (const relPath of baselineDirectories) {
                    if (pathIsBlockedByDirectory(relPath)) { continue; }
                    const localExists = localSnapshot.directories.has(relPath);
                    const remoteExists = remoteDirectoryPaths.has(relPath);
                    if (!localExists && remoteExists) {
                        blockedDirectoryRoots.add(relPath);
                        if (await remoteDirectoryIsUnchanged(relPath)) {
                            this.requireSyncSession(generation);
                            startupRemoteDirectoryDeletePaths.add(relPath);
                        } else {
                            await this.markSyncConflict(
                                relPath,
                                'The local folder was deleted while its Overleaf contents also changed',
                                null,
                                generation,
                            );
                        }
                    } else if (localExists && !remoteExists) {
                        blockedDirectoryRoots.add(relPath);
                        if (await localDirectoryIsUnchanged(relPath)) {
                            this.requireSyncSession(generation);
                            startupLocalDirectoryDeletePaths.add(relPath);
                        } else {
                            await this.markSyncConflict(
                                relPath,
                                'Overleaf deleted the folder while its local contents also changed',
                                undefined,
                                generation,
                            );
                        }
                    }
                }
            }

            for (const relPath of directories) {
                if (cancelled()) { return false; }
                if (pathIsBlockedByDirectory(relPath)) { continue; }
                this.setBypassCache(relPath, new Uint8Array(), 'pull');
                const localUri = this.localUri(relPath);
                await this.withFileSystemContext(
                    'Create local directory',
                    localUri,
                    () => this.runSessionIO(
                        generation,
                        () => localUri.scheme==='file'
                            ? nodeFs.mkdir(localUri.fsPath, {recursive: true}).then(() => undefined)
                            : vscode.workspace.fs.createDirectory(localUri),
                    ),
                );
                this.requireSyncSession(generation);
                const remoteIdentity = await this.resolveRemoteFolderPathIdentity(
                    this.vfs.pathToUri(relPath),
                );
                this.requireSyncSession(generation);
                if (!remoteIdentity) {
                    throw new Error(
                        'Could not resolve the authoritative Overleaf folder identity for ' + relPath,
                    );
                }
                this.seenLocalEntities.add(relPath);
                await this.recordSyncManifestDirectory(relPath, remoteIdentity, generation);
            }

            // sync the files
            const total = files.length;
            // Documents dominate initial-pull latency: each text file costs one
            // joinDoc round-trip (binaries usually skip via the manifest
            // fingerprint), so a sequential pull costs documents x RTT. The
            // per-file work below touches only per-path state - baseCache keys,
            // per-path sets, and the queued manifest publisher - so a bounded
            // worker pool changes elapsed time, not outcomes.
            const initialPullConcurrency = Math.max(1, Math.min(
                16,
                getConfiguredValue<number>('localReplica.initialPullConcurrency', 6),
            ));
            const initialPullFilePhaseStartedAt = Date.now();
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [initial pull setup complete] ` +
                `elapsed=${initialPullFilePhaseStartedAt-overwriteStartedAt}ms ` +
                `bootstrapWait=${bootstrapWaitElapsedMs}ms ` +
                `remoteTree=${remoteTreeElapsedMs}ms ` +
                `documentBatch=${documentBatchElapsedMs}ms ` +
                `localSnapshot=${localSnapshotElapsedMs}ms ` +
                `reconcile=${initialPullFilePhaseStartedAt-overwriteStartedAt
                    -bootstrapWaitElapsedMs-localSnapshotElapsedMs}ms`,
            );
            const initialPullTimings: Array<{relPath: string; elapsedMs: number}> = [];
            let initialPullCancelled = false;
            let initialPullError: unknown;
            const pullFileAtIndex = async (index: number): Promise<void> => {
                const [_name, relPath] = files[index];
                const vfsUri = this.vfs.pathToUri(relPath);
                if (cancelled()) { initialPullCancelled = true; return; }
                if (pathIsBlockedByDirectory(relPath)) { return; }
                if (pendingMoveSources.has(relPath)) { return; }
                progress.report({increment: 100/total, message: relPath});
                //
                const manifestEntry = this.syncManifest?.files[relPath];
                const existedLocallyAtStart = localSnapshot?.files.has(relPath) ?? false;
                if (
                    baselineUnavailable
                    && manifestEntry===undefined
                    && !existedLocallyAtStart
                ) {
                    await this.markSyncConflict(
                        relPath,
                        'The Overleaf file exists only on one side and no trusted sync baseline is available',
                        null,
                        generation,
                    );
                    return;
                }
                if (preserveExistingLocalFiles && manifestEntry && !existedLocallyAtStart) {
                    let remoteChanged = true;
                    try {
                        if (this.isLikelyBinaryRelPath(relPath)) {
                            const remoteFingerprint = await this.getRemoteFingerprint(relPath, vfsUri);
                            this.requireSyncSession(generation);
                            remoteChanged = remoteFingerprint===undefined
                                || remoteFingerprint!==manifestEntry.remoteFingerprint;
                        } else {
                            const remoteContent = await pullInitialFile(relPath, vfsUri);
                            remoteChanged = contentDigest(remoteContent)!==manifestEntry.localDigest;
                        }
                    } catch (error) {
                        if (cancelled()) { initialPullCancelled = true; return; }
                        this.failedInitialPulls.add(relPath);
                        await this.markSyncConflict(
                            relPath,
                            `Could not verify a local deletion against Overleaf: ${formatUnknownError(error)}`,
                            null,
                            generation,
                        );
                        return;
                    }
                    if (remoteChanged) {
                        await this.markSyncConflict(
                            relPath,
                            'The local copy was deleted while the Overleaf copy was also edited',
                            null,
                            generation,
                        );
                    } else {
                        startupRemoteDeletePaths.add(relPath);
                    }
                    return;
                }
                if (
                    !resetLocalFilesToRemote
                    && await this.canSkipInitialBinaryPull(relPath, vfsUri, generation)
                ) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [initial pull skip] ${relPath}: manifest fingerprint unchanged`,
                    );
                    return;
                }
                if (preserveExistingLocalFiles && existedLocallyAtStart) {
                    const preservedContent = await this.readLocalFileInSession(relPath, generation);
                    this.requireSyncSession(generation);
                    if (preservedContent!==undefined) {
                        if (this.isLikelyBinaryRelPath(relPath)) {
                            if (manifestEntry===undefined) {
                                const remoteContent = await pullInitialFile(
                                    relPath,
                                    vfsUri,
                                );
                                if (bytesEqual(preservedContent, remoteContent)) {
                                    this.baseCache[relPath] = preservedContent;
                                    this.seenLocalEntities.add(relPath);
                                    this.setBypassCache(relPath, preservedContent);
                                    this.clearRemoteDelete(relPath);
                                    await this.recordSyncManifestEntry(
                                        relPath,
                                        vfsUri,
                                        preservedContent,
                                        generation,
                                    );
                                } else {
                                    this.seenLocalEntities.add(relPath);
                                    await this.markSyncConflict(
                                        relPath,
                                        'Local and Overleaf binary/media copies differ but no common baseline is available',
                                        preservedContent,
                                        generation,
                                    );
                                }
                                return;
                            }
                            const localChanged = manifestEntry===undefined
                                || contentDigest(preservedContent)!==manifestEntry.localDigest;
                            const remoteFingerprint = await this.getRemoteFingerprint(relPath, vfsUri);
                            this.requireSyncSession(generation);
                            const remoteChanged = manifestEntry===undefined
                                || remoteFingerprint===undefined
                                || remoteFingerprint!==manifestEntry.remoteFingerprint;
                            if (localChanged && remoteChanged) {
                                this.seenLocalEntities.add(relPath);
                                await this.markSyncConflict(
                                    relPath,
                                    'Local and Overleaf binary/media copies were both changed while disconnected',
                                    preservedContent,
                                    generation,
                                );
                                return;
                            }
                            if (localChanged) {
                                const remoteBaseContent = await pullInitialFile(relPath, vfsUri);
                                this.baseCache[relPath] = remoteBaseContent;
                                this.seenLocalEntities.add(relPath);
                                this.setBypassCache(relPath, preservedContent);
                                this.clearRemoteDelete(relPath);
                                startupPushPaths.add(relPath);
                                return;
                            }
                            if (!remoteChanged) {
                                this.baseCache[relPath] = preservedContent;
                                this.seenLocalEntities.add(relPath);
                                this.setBypassCache(relPath, preservedContent);
                                this.clearRemoteDelete(relPath);
                                return;
                            }
                        } else {
                            let remoteContent: Uint8Array;
                            try {
                                remoteContent = await pullInitialFile(relPath, vfsUri);
                            } catch (error) {
                                if (cancelled()) { initialPullCancelled = true; return; }
                                getOutputChannel().appendLine(
                                    `${new Date().toISOString()} [initial pull failed] ${relPath}: ${formatUnknownError(error)}`,
                                );
                                this.failedInitialPulls.add(relPath);
                                this.locallyDivergedPaths.add(relPath);
                                return;
                            }

                            const localDigest = contentDigest(preservedContent);
                            const remoteDigest = contentDigest(remoteContent);
                            const localChanged = manifestEntry===undefined
                                || localDigest!==manifestEntry.localDigest;
                            const remoteChanged = manifestEntry===undefined
                                || remoteDigest!==manifestEntry.localDigest;

                            if (bytesEqual(preservedContent, remoteContent)) {
                                this.baseCache[relPath] = preservedContent;
                                this.seenLocalEntities.add(relPath);
                                this.setBypassCache(relPath, preservedContent);
                                this.clearRemoteDelete(relPath);
                                await this.recordSyncManifestEntry(relPath, vfsUri, preservedContent, generation);
                            } else if (!localChanged && remoteChanged) {
                                const wroteRemoteContent = await this.writeLocalFileIfRevision(
                                    relPath,
                                    remoteContent,
                                    localDigest,
                                    generation,
                                );
                                if (!wroteRemoteContent) {
                                    const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                    await this.markSyncConflict(
                                        relPath,
                                        'The local file changed while an initial Overleaf update was being applied',
                                        latestLocal.kind==='file' ? latestLocal.content : undefined,
                                        generation,
                                    );
                                    return;
                                }
                                this.setBypassCache(relPath, remoteContent, 'pull');
                                this.baseCache[relPath] = remoteContent;
                                this.seenLocalEntities.add(relPath);
                                this.clearRemoteDelete(relPath);
                                await this.recordSyncManifestEntry(relPath, vfsUri, remoteContent, generation);
                            } else if (localChanged && !remoteChanged) {
                                this.baseCache[relPath] = remoteContent;
                                this.seenLocalEntities.add(relPath);
                                this.setBypassCache(relPath, preservedContent);
                                this.clearRemoteDelete(relPath);
                                startupPushPaths.add(relPath);
                            } else {
                                const baseContent = this.manifestBaseContent(manifestEntry);
                                const mergedContent = baseContent===undefined
                                    ? undefined
                                    : this.mergeTextContents(baseContent, preservedContent, remoteContent);
                                if (mergedContent===undefined) {
                                    if (baseContent!==undefined) {
                                        this.baseCache[relPath] = baseContent;
                                    }
                                    this.seenLocalEntities.add(relPath);
                                    await this.markSyncConflict(
                                        relPath,
                                        manifestEntry
                                            ? 'Local and Overleaf text copies were both changed and could not be merged automatically'
                                            : 'Local and Overleaf text copies differ but no common baseline is available',
                                        preservedContent,
                                        generation,
                                    );
                                } else {
                                    const wroteMergedContent = await this.writeLocalFileIfRevision(
                                        relPath,
                                        mergedContent,
                                        localDigest,
                                        generation,
                                    );
                                    if (!wroteMergedContent) {
                                        const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                        await this.markSyncConflict(
                                            relPath,
                                            'The local file changed while an initial merged update was being applied',
                                            latestLocal.kind==='file' ? latestLocal.content : undefined,
                                            generation,
                                        );
                                        return;
                                    }
                                    this.setBypassCache(relPath, mergedContent, 'pull');
                                    this.baseCache[relPath] = remoteContent;
                                    this.seenLocalEntities.add(relPath);
                                    this.clearRemoteDelete(relPath);
                                    if (bytesEqual(mergedContent, remoteContent)) {
                                        await this.recordSyncManifestEntry(relPath, vfsUri, mergedContent, generation);
                                    } else {
                                        startupPushPaths.add(relPath);
                                    }
                                }
                            }
                            return;
                        }
                    }
                }

                const localStateBeforePull = await this.captureLocalPathRevision(relPath, generation);
                let remoteContent: Uint8Array;
                try {
                    remoteContent = await pullInitialFile(relPath, vfsUri);
                } catch (error) {
                    if (cancelled()) { initialPullCancelled = true; return; }
                    // Even after Layer 1 retries the read failed. Record the
                    // failed path so the rest of the system refuses to act on
                    // any local event for it (the delete-guard layers and the
                    // deferred-local-watcher layer key off this set), then
                    // continue the BFS so other files still get pulled.
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [initial pull failed] ${relPath}: ${formatUnknownError(error)}`,
                    );
                    this.failedInitialPulls.add(relPath);
                    return;
                }
                const latestLocalState = await this.captureLocalPathRevision(relPath, generation);
                if (latestLocalState.revision!==localStateBeforePull.revision) {
                    if (
                        latestLocalState.kind==='file'
                        && latestLocalState.content!==undefined
                        && bytesEqual(latestLocalState.content, remoteContent)
                    ) {
                        this.setBypassCache(relPath, remoteContent);
                    } else {
                        const baseContent = this.manifestBaseContent(manifestEntry);
                        if (baseContent!==undefined) {
                            this.baseCache[relPath] = baseContent;
                        }
                        this.seenLocalEntities.add(relPath);
                        await this.markSyncConflict(
                            relPath,
                            'The local path changed while the initial Overleaf pull was in flight',
                            latestLocalState.kind==='file' ? latestLocalState.content : undefined,
                            generation,
                        );
                        return;
                    }
                } else {
                    const wroteRemoteContent = await this.writeLocalFileIfRevision(
                        relPath,
                        remoteContent,
                        localStateBeforePull.revision,
                        generation,
                    );
                    if (!wroteRemoteContent) {
                        const concurrentLocalState = await this.captureLocalPathRevision(relPath, generation);
                        await this.markSyncConflict(
                            relPath,
                            'The local path changed immediately before the initial Overleaf pull was written',
                            concurrentLocalState.kind==='file' ? concurrentLocalState.content : undefined,
                            generation,
                        );
                        return;
                    }
                    this.setBypassCache(relPath, remoteContent);
                }
                this.baseCache[relPath] = remoteContent;
                this.seenLocalEntities.add(relPath);
                this.clearRemoteDelete(relPath);
                await this.recordSyncManifestEntry(relPath, vfsUri, remoteContent, generation);
            };
            let nextFileIndex = 0;
            await Promise.all(Array.from(
                {length: Math.max(1, Math.min(initialPullConcurrency, total))},
                async () => {
                    while (!initialPullCancelled && initialPullError===undefined) {
                        const index = nextFileIndex;
                        nextFileIndex += 1;
                        if (index>=total) { return; }
                        const relPath = files[index][1];
                        const startedAt = Date.now();
                        try {
                            await pullFileAtIndex(index);
                        } catch (error) {
                            if (initialPullError===undefined) { initialPullError = error; }
                            return;
                        } finally {
                            initialPullTimings.push({
                                relPath,
                                elapsedMs: Date.now()-startedAt,
                            });
                        }
                    }
                },
            ));
            const slowestInitialPulls = initialPullTimings
                .sort((left, right) => right.elapsedMs-left.elapsedMs)
                .slice(0, 5)
                .map(entry => `${entry.relPath}:${entry.elapsedMs}ms`)
                .join(', ');
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [initial pull files complete] ` +
                `concurrency=${initialPullConcurrency} files=${initialPullTimings.length} ` +
                `elapsed=${Date.now()-initialPullFilePhaseStartedAt}ms ` +
                `slowest=${slowestInitialPulls || 'none'}`,
            );
            if (initialPullError!==undefined) { throw initialPullError; }
            if (initialPullCancelled) { return false; }

            // A conflict can be decided while the extension host is stopped.
            // In particular, deleting a retained local copy means "accept the
            // verified Overleaf deletion". The ordinary manifest/base entries
            // were intentionally removed when the conflict was created, so no
            // startup file loop can infer this decision. Re-drive only paths
            // whose local revision changed, and let applySync re-verify the
            // persisted Overleaf revision before it mutates or clears anything.
            await this.reconcilePersistedConflictChoicesOnStartup(generation);
            this.requireSyncSession(generation);
            for (const relPath of [...blockedDirectoryRoots]) {
                if (!this.syncConflicts.has(relPath) && !pendingDirectoryMoveRoots.has(relPath)) {
                    blockedDirectoryRoots.delete(relPath);
                }
            }

            if (localSnapshot) {
                for (const relPath of localSnapshot.files) {
                    if (pathIsBlockedByDirectory(relPath)) { continue; }
                    if (pendingMoveDestinations.has(relPath)) { continue; }
                    if (remoteFilePaths.has(relPath)) { continue; }
                    const manifestEntry = this.syncManifest?.files[relPath];
                    if (manifestEntry && await this.isLocalUnchangedFromManifest(relPath)) {
                        startupLocalDeletePaths.add(relPath);
                    } else if (manifestEntry) {
                        const baseContent = this.manifestBaseContent(manifestEntry);
                        if (baseContent!==undefined) {
                            this.baseCache[relPath] = baseContent;
                        }
                        this.seenLocalEntities.add(relPath);
                        const localContent = await this.readLocalFileInSession(relPath, generation);
                        await this.markSyncConflict(
                            relPath,
                            'Overleaf deleted the file while the local saved copy was also edited',
                            localContent,
                            generation,
                        );
                    } else if (baselineUnavailable) {
                        const localContent = await this.readLocalFileInSession(relPath, generation);
                        await this.markSyncConflict(
                            relPath,
                            'The local file exists only on one side and no trusted sync baseline is available',
                            localContent,
                            generation,
                        );
                    } else {
                        startupPushPaths.add(relPath);
                    }
                }

                for (const relPath of Object.keys(this.syncManifest?.files ?? {})) {
                    if (pathIsBlockedByDirectory(relPath)) { continue; }
                    if (!remoteFilePaths.has(relPath) && !localSnapshot.files.has(relPath)) {
                        this.removeSyncManifestEntry(relPath);
                    }
                }

                for (const relPath of localSnapshot.directories) {
                    if (pathIsBlockedByDirectory(relPath)) { continue; }
                    if (remoteDirectoryPaths.has(relPath)) {
                        const remoteIdentity = await this.resolveRemoteFolderPathIdentity(
                            this.vfs.pathToUri(relPath),
                        );
                        this.requireSyncSession(generation);
                        if (!remoteIdentity) {
                            throw new Error(
                                'Could not resolve the authoritative Overleaf folder identity for ' + relPath,
                            );
                        }
                        this.seenLocalEntities.add(relPath);
                        await this.recordSyncManifestDirectory(relPath, remoteIdentity, generation);
                    } else if (this.syncManifest?.directories[relPath]===undefined) {
                        startupPushDirectoryPaths.add(relPath);
                    }
                }

                for (const relPath of Object.keys(this.syncManifest?.directories ?? {})) {
                    if (
                        !remoteDirectoryPaths.has(relPath)
                        && !localSnapshot.directories.has(relPath)
                        && !pathIsBlockedByDirectory(relPath)
                    ) {
                        this.removeSyncManifestDirectory(relPath);
                    }
                }

                for (const relPath of startupRemoteDirectoryDeletePaths) {
                    if (cancelled()) { return false; }
                    this.seenLocalEntities.add(relPath);
                    const event = await this.applySync(
                        'push',
                        'delete',
                        relPath,
                        this.localUri(relPath),
                        this.vfs.pathToUri(relPath),
                        {forcePush: true, reason: 'startup-reconcile'},
                        generation,
                    );
                    requireStartupSync(event, 'startup remote directory delete', relPath);
                }

                for (const relPath of startupLocalDirectoryDeletePaths) {
                    if (cancelled()) { return false; }
                    this.seenLocalEntities.add(relPath);
                    const event = await this.applySync(
                        'pull',
                        'delete',
                        relPath,
                        this.vfs.pathToUri(relPath),
                        this.localUri(relPath),
                        {},
                        generation,
                    );
                    requireStartupSync(event, 'startup local directory delete', relPath);
                }

                for (const relPath of startupRemoteDeletePaths) {
                    if (cancelled()) { return false; }
                    const baseContent = this.manifestBaseContent(this.syncManifest?.files[relPath]);
                    if (baseContent!==undefined) {
                        this.baseCache[relPath] = baseContent;
                    }
                    this.seenLocalEntities.add(relPath);
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [startup reconcile:push-delete] ${relPath}`,
                    );
                    const event = await this.applySync(
                        'push',
                        'delete',
                        relPath,
                        this.localUri(relPath),
                        this.vfs.pathToUri(relPath),
                        {forcePush: true, reason: 'startup-reconcile'},
                        generation,
                    );
                    requireStartupSync(event, 'startup remote delete', relPath);
                }

                for (const relPath of startupLocalDeletePaths) {
                    if (cancelled()) { return false; }
                    const localContent = await this.readLocalFileInSession(relPath, generation);
                    if (localContent!==undefined) {
                        this.baseCache[relPath] = localContent;
                    }
                    this.seenLocalEntities.add(relPath);
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [startup reconcile:pull-delete] ${relPath}`,
                    );
                    const event = await this.applySync(
                        'pull',
                        'delete',
                        relPath,
                        this.vfs.pathToUri(relPath),
                        this.localUri(relPath),
                        {},
                        generation,
                    );
                    requireStartupSync(event, 'startup local delete', relPath);
                }

                const requiredRemoteDirectories = new Set<string>();
                for (const relPath of startupPushDirectoryPaths) {
                    requiredRemoteDirectories.add(relPath);
                }
                for (const relPath of startupPushPaths) {
                    const segments = relPath.split('/').filter(Boolean);
                    for (let index=1; index<segments.length; index++) {
                        requiredRemoteDirectories.add('/' + segments.slice(0, index).join('/'));
                    }
                }
                const orderedRemoteDirectories = [...requiredRemoteDirectories]
                    .sort((left, right) => left.split('/').length-right.split('/').length);
                for (const relPath of orderedRemoteDirectories) {
                    if (remoteDirectoryPaths.has(relPath)) { continue; }
                    const event = await this.applySync(
                        'push',
                        'update',
                        relPath,
                        this.localUri(relPath),
                        this.vfs.pathToUri(relPath),
                        {forcePush: true, reason: 'startup-reconcile'},
                        generation,
                    );
                    requireStartupSync(event, 'startup remote directory creation', relPath);
                    remoteDirectoryPaths.add(relPath);
                }

                for (const relPath of startupPushPaths) {
                    if (cancelled()) { return false; }
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [startup reconcile:push-update] ${relPath}`,
                    );
                    const event = await this.applySync(
                        'push',
                        'update',
                        relPath,
                        this.localUri(relPath),
                        this.vfs.pathToUri(relPath),
                        {forcePush: true, reason: 'startup-reconcile'},
                        generation,
                    );
                    requireStartupSync(event, 'startup remote update', relPath);
                }
            }

            return true;
        });
    }

    private localRelPathFromUri(uri: vscode.Uri): string {
        const basePath = this.baseUri.path.replace(/\/+$/, '');
        return normalizeReplicaPath(uri.path.slice(basePath.length));
    }

    private shouldPreserveLocalPathForRemoteReset(uri: vscode.Uri): boolean {
        if (isLocalReplicaMetadataUri(uri, this.baseUri)) {
            return true;
        }

        const relPath = this.localRelPathFromUri(uri);
        const segments = relPath.split('/').filter(Boolean);
        if (segments.some(segment => segment.startsWith('.'))) {
            return true;
        }

        return relPath==='/AGENTS.md' || relPath==='/CLAUDE.md';
    }

    private async clearLocalProjectEntryForRemoteReset(
        uri: vscode.Uri,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        if (this.shouldPreserveLocalPathForRemoteReset(uri)) {
            return;
        }

        const stat = await vscode.workspace.fs.stat(uri);
        this.requireSyncSession(generation);
        if (stat.type===vscode.FileType.Directory) {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            this.requireSyncSession(generation);
            for (const [name] of entries) {
                await this.clearLocalProjectEntryForRemoteReset(
                    vscode.Uri.joinPath(uri, name),
                    generation,
                );
            }

            const remainingEntries = await vscode.workspace.fs.readDirectory(uri);
            this.requireSyncSession(generation);
            if (remainingEntries.length!==0) {
                return;
            }
        }

        const relPath = this.localRelPathFromUri(uri);
        this.setBypassCache(relPath, undefined, 'pull');
        await this.withFileSystemContext(
            'Delete local file before remote-authoritative sync',
            uri,
            () => this.runSessionIO(
                generation,
                () => deleteWithTrashFallback(uri, {recursive: false}),
            ),
        );
        this.requireSyncSession(generation);
    }

    private async clearLocalProjectFilesForRemoteReset(
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        const entries = await vscode.workspace.fs.readDirectory(this.baseUri);
        this.requireSyncSession(generation);
        for (const [name] of entries) {
            await this.clearLocalProjectEntryForRemoteReset(
                vscode.Uri.joinPath(this.baseUri, name),
                generation,
            );
        }

        this.baseCache = {};
        this.seenLocalEntities.clear();
        this.remoteDeleteTombstones.clear();
        this.locallyDivergedPaths.clear();
        this.localStabilizeState.clear();
        this.scannerAbsentPaths.clear();
        this.syncConflicts.clear();
        this.conflictLocalDigests.clear();
        this.pendingLocalEvents.forEach(pending => clearTimeout(pending.timer));
        this.pendingLocalEvents.clear();
    }

    private bypassSync(
        action:'push'|'pull',
        type:'update'|'delete',
        relPath: string,
        content?: Uint8Array,
        options?: ApplySyncOptions,
    ): boolean {
        // bypass ignore files
        if (this.matchIgnorePatterns(relPath)) {
            return true;
        }
        // synchronization propagation check
        if (!this.shouldPropagate(action, type, relPath, content, options)) {
            return true;
        }
        // otherwise, log the synchronization
        console.log(`${new Date().toLocaleString()} [${action}] ${type} "${relPath}"`);
        return false;
    }

    // Wait until the VFS is back to 'connected', or give up after a timeout.
    // Used between pull-retry attempts INSTEAD of forcing a reconnect:
    // forcing a reconnect from every per-file retry causes a storm because
    // VirtualFileSystem.reconnect() clears the entire project state on each
    // call. Multiple parallel pulls each calling reconnect cascade-destroy
    // each other's init. Awaiting the existing connection-state machine is
    // race-free (we re-check after subscribing).
    private async waitForConnectedOrTimeout(timeoutMs: number): Promise<boolean> {
        if (this.vfs.connectionState==='connected') { return true; }
        if (this.vfs.connectionState==='disconnected') { return false; }
        return new Promise<boolean>(resolve => {
            let settled = false;
            const settle = (value: boolean) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                sub.dispose();
                resolve(value);
            };
            const timer = setTimeout(() => settle(false), timeoutMs);
            const sub = this.vfs.onDidChangeConnection(state => {
                if (state==='connected') { settle(true); }
                else if (state==='disconnected') { settle(false); }
            });
            // Re-check after subscribing to close the listener-installation
            // gap in both directions: a transition to 'connected' OR
            // 'disconnected' between our initial check and the .event()
            // subscription would otherwise stick us on the 5s timeout.
            if (this.vfs.connectionState==='connected') { settle(true); }
            else if (this.vfs.connectionState==='disconnected') { settle(false); }
        });
    }

    // Generic bounded-retry helper. Used by both push and pull paths so a stale
    // or reconnecting socket doesn't drop an operation silently. The optional
    // `betweenAttempts` callback runs between failed attempts — both push and
    // pull now passively await the existing connection state machine (no
    // per-attempt reconnect — see waitForConnectedOrTimeout). Callers may still
    // force a one-shot reconnect inside the task itself.
    private async withRetry<T>(
        label: 'push' | 'pull',
        relPath: string,
        task: () => Promise<T>,
        opts?: {
            delays?: number[];
            betweenAttempts?: () => Promise<void>;
            generation?: number;
        },
    ): Promise<T> {
        const generation = opts?.generation ?? this.syncGeneration;
        const delays = opts?.delays ?? LocalReplicaSCMProvider.pushRetryDelays;
        const betweenAttempts = opts?.betweenAttempts;
        let lastError: unknown;
        for (let attempt = 0; attempt<delays.length; attempt++) {
            const delay = delays[attempt];
            if (delay>0) { await new Promise(resolve => setTimeout(resolve, delay)); }
            this.requireSyncSession(generation);
            try {
                const result = await task();
                this.requireSyncSession(generation);
                if (lastError) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [${label} recovered] ${relPath} after retry`,
                    );
                }
                return result;
            } catch (error) {
                if (
                    error instanceof ConcurrentReplicaChangeError
                    || error instanceof RemoteDocumentMergeConflictError
                    || error instanceof RemoteDocumentWriteAmbiguousError
                    || (error as {retryable?: boolean})?.retryable===false
                ) {
                    throw error;
                }
                lastError = error;
                if (attempt<delays.length-1 && betweenAttempts) {
                    try {
                        await betweenAttempts();
                    } catch (cbError) {
                        lastError = cbError;
                    }
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async pushWithRetry(
        relPath: string,
        toUri: vscode.Uri,
        content: Uint8Array,
        generation = this.syncGeneration,
        remoteBaseline?: Uint8Array,
        expectedRemoteMissing = false,
    ): Promise<Uint8Array> {
        return this.withRetry('push', relPath, async () => {
            await this.vfs.ensureConnectedForWrite();
            this.requireSyncSession(generation);
            return this.runSessionIO(
                generation,
                () => this.vfs.writeFileFromRemoteBaseline(
                    toUri,
                    content,
                    remoteBaseline,
                    expectedRemoteMissing,
                ),
            );
        }, {
            delays: LocalReplicaSCMProvider.pushRetryDelays,
            generation,
            // Match the pull-retry pattern: wait passively for the connection
            // state machine to settle rather than firing reconnect() on every
            // attempt. The task itself already calls ensureConnectedForWrite()
            // which is a one-shot reconnect when state is 'disconnected', and
            // back-to-back reconnect() calls clear the entire project state
            // (see VirtualFileSystem.reconnect — root and initializing both
            // get nulled). One-shot at task entry plus passive wait between
            // attempts mirrors how pull handles a flapping socket without
            // amplifying the failure into a socket storm.
            betweenAttempts: async () => {
                await this.waitForConnectedOrTimeout(LocalReplicaSCMProvider.pushReconnectWaitMs);
            },
        });
    }

    // Pull binary files with a wider backoff. Binary VFS reads occasionally
    // return Unknown / zero bytes during socket reconnects; surface those as
    // failures the outer code can retry rather than silently writing empty
    // files into the replica. Push now matches the same budget so a
    // 1-2 second socket reconnect doesn't silently lose accepted edits — the
    // prior 0.9s budget meant push gave up while pull was still recovering.
    private static readonly pullRetryDelays = [0, 300, 900, 2400];
    private static readonly pushRetryDelays = [0, 300, 900, 2400];
    private static readonly pullReconnectWaitMs = 5000;
    private static readonly pushReconnectWaitMs = 5000;

    private isLikelyBinaryRelPath(relPath: string): boolean {
        return /\.(pdf|png|jpe?g|gif|svg|webp|bmp|tiff?|eps|ps|zip|tar|gz|bz2|7z|rar|mp[34]|wav|ogg|woff2?|ttf|otf|ico)$/i.test(relPath);
    }

    // Whether a push must go through the compare-and-swap replacement instead
    // of a plain write. Overleaf `file` entities have no OT channel, so
    // writeFileFromRemoteBaseline discards remoteBaseline for them and
    // overwrites blindly. The entity type decides that, not the extension: a
    // data.csv / results.json / table.xlsx uploaded as a file is exactly as
    // unguarded as a .png. The extension heuristic remains the fallback for
    // when the remote type cannot be resolved.
    private async remoteEntityNeedsGuardedReplace(
        relPath: string,
        vfsUri: vscode.Uri,
    ): Promise<boolean> {
        try {
            const {fileType} = await this.vfs._resolveUri(vfsUri);
            if (fileType==='doc') { return false; }
            if (fileType==='file') { return true; }
        } catch {
            // Fall through to the extension heuristic.
        }
        return this.isLikelyBinaryRelPath(relPath);
    }

    private async pullRemoteFile(
        relPath: string,
        vfsUri: vscode.Uri,
        generation = this.syncGeneration,
    ): Promise<Uint8Array> {
        return this.withRetry('pull', relPath, async () => {
            const content = await this.withFileSystemContext(
                'Read remote file',
                vfsUri,
                () => vscode.workspace.fs.readFile(vfsUri),
            );
            // A 0-byte payload for a binary is almost certainly a transient
            // failure rather than a genuinely empty file (no real PDF/PNG is
            // 0 bytes). Throw so the retry loop tries again; if all attempts
            // come back empty we let the caller decide what to do.
            if (this.isLikelyBinaryRelPath(relPath) && content.length===0) {
                throw new Error(`empty binary payload for ${relPath}`);
            }
            return content;
        }, {
            delays: LocalReplicaSCMProvider.pullRetryDelays,
            generation,
            // Critical: do NOT call vfs.reconnect() between attempts. Parallel
            // pulls each issuing reconnect() cascade-clear the project state
            // and produce a socket storm severe enough that Overleaf rate-limits
            // us. Instead, wait passively for the existing reconnect cycle to
            // resolve (it does on its own via the VFS's internal logic).
            betweenAttempts: async () => {
                await this.waitForConnectedOrTimeout(LocalReplicaSCMProvider.pullReconnectWaitMs);
            },
        });
    }

    private async pullInitialRemoteFile(
        relPath: string,
        vfsUri: vscode.Uri,
        generation = this.syncGeneration,
        prefetchedSnapshots?: Map<string, Uint8Array>,
    ): Promise<Uint8Array> {
        const prefetched = prefetchedSnapshots?.get(vfsUri.toString());
        if (prefetched!==undefined) {
            this.requireSyncSession(generation);
            this.pendingInitialDocumentSubscriptions.add(relPath);
            return prefetched;
        }
        const downloadSnapshot = this.vfs.downloadDocumentSnapshot;
        if (typeof downloadSnapshot==='function') {
            try {
                const {fileType} = await this.vfs._resolveUri(vfsUri);
                this.requireSyncSession(generation);
                if (fileType==='doc') {
                    const content = await this.withRetry('pull', relPath, () =>
                        downloadSnapshot.call(this.vfs, vfsUri), {
                        delays: LocalReplicaSCMProvider.pullRetryDelays,
                        generation,
                        betweenAttempts: async () => {
                            await this.waitForConnectedOrTimeout(
                                LocalReplicaSCMProvider.pullReconnectWaitMs,
                            );
                        },
                    });
                    this.requireSyncSession(generation);
                    this.pendingInitialDocumentSubscriptions.add(relPath);
                    return content;
                }
            } catch (error) {
                if (!this.isSyncSessionActive(generation)) { throw error; }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [initial document snapshot fallback] ` +
                    `${relPath}: ${formatUnknownError(error)}`,
                );
            }
        }
        // Binary/file entities still use their authenticated file endpoint, and
        // a failed document snapshot falls back to joinDoc. The VFS serializes
        // that socket RPC, so a fallback cannot race another document join.
        return this.pullRemoteFile(relPath, vfsUri, generation);
    }

    private retainLocalPushIntentAfterClassificationFailure(
        relPath: string,
        localUri: vscode.Uri,
        observedType: 'update' | 'delete',
        error: unknown,
        generation: number,
    ): void {
        if (!this.isSyncSessionActive(generation)) { return; }
        // A writer holding the file is not a classification failure. It gets the
        // silent deferral path instead: no toast, no outcome:'error' event, and
        // the same single re-arm through pendingLocalEvents.
        if (LocalReplicaSCMProvider.isLocalReadUnstable(error)) {
            this.scheduleLocalPushRetry(
                relPath,
                localUri,
                'unstable-read',
                generation,
                observedType,
            );
            return;
        }
        const errorMessage = formatUnknownError(error);
        this.locallyDivergedPaths.add(relPath);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [push classification failed] ${relPath}: ${errorMessage}`,
        );
        maybeWarnSyncFailure(relPath, error);
        EventBus.fire('scmSyncCompleteEvent', {
            rootUri: this.baseUri,
            relPath,
            direction: 'push',
            type: observedType,
            outcome: 'error',
            error: errorMessage,
        });

        const existing = this.pendingLocalEvents.get(relPath);
        if (existing) {
            clearTimeout(existing.timer);
        }
        const firstEventAt = existing?.firstEventAt ?? Date.now();
        const timer = setTimeout(() => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const pending = this.pendingLocalEvents.get(relPath);
            if (!pending || pending.timer!==timer) { return; }
            this.pendingLocalEvents.delete(relPath);
            void this.syncToVFS(pending.latestUri, pending.latestType);
        }, LocalReplicaSCMProvider.fallbackScanIntervalMs);
        this.pendingLocalEvents.set(relPath, {
            timer,
            firstEventAt,
            latestType: observedType,
            latestUri: localUri,
        });
    }

    // The single re-arm point for a push that could not obtain (or could not
    // keep) a coherent local snapshot. Everything that detects the condition
    // funnels through here so watcher events and retries share one
    // pendingLocalEvents entry and cannot fan out into duplicate uploads.
    private scheduleLocalPushRetry(
        relPath: string,
        localUri: vscode.Uri,
        reason:
            | 'unstable-read'
            | 'local-advanced-during-push'
            | 'local-advanced-before-echo-delete'
            | 'compile-tree-advanced',
        generation: number,
        observedType: 'update' | 'delete' = 'update',
    ): void {
        if (!this.isSyncSessionActive(generation)) { return; }
        // Stay visibly dirty: the compile barrier and the degraded-watcher scan
        // both read this set, and neither may believe the path is settled.
        this.locallyDivergedPaths.add(relPath);
        const state = this.localStabilizeState.get(relPath)
            ?? {firstUnstableAt: Date.now(), attempts: 0};
        state.attempts += 1;
        const unstableForMs = Date.now()-state.firstUnstableAt;
        // Continuous writes are an expected Local Replica workflow: an agent,
        // formatter, generator, or local compiler may legitimately keep one
        // path moving for minutes. Keep the path visibly dirty and keep retrying,
        // but do not report a recoverable stabilization wait as "sync failed".
        // A compile request still fails closed with LOCAL_SNAPSHOT_UNSTABLE,
        // which is the point at which the user needs an actionable message.
        this.localStabilizeState.set(relPath, state);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [push deferred:${reason}] ${relPath} ` +
            `(attempt=${state.attempts}, unstableFor=${unstableForMs}ms)`,
        );

        const existing = this.pendingLocalEvents.get(relPath);
        if (existing) {
            clearTimeout(existing.timer);
        }
        // Restart the coalescing window rather than inheriting an exhausted
        // firstEventAt: computeDebounceDelay would otherwise return 0 and the
        // re-arm would fire immediately, spinning on a file that is still busy.
        const firstEventAt = Date.now();
        const timer = setTimeout(() => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const pending = this.pendingLocalEvents.get(relPath);
            if (!pending || pending.timer!==timer) { return; }
            this.pendingLocalEvents.delete(relPath);
            // Deliberately syncToVFS and not queueForcedPush: the
            // enqueueLocalPendingEvent classification behind it clears
            // locallyDivergedPaths when the path turns out to be synced after
            // all, so a file that settles back to the pushed bytes stops being
            // reported as diverged. queueForcedPush leaves it set.
            void this.syncToVFS(pending.latestUri, pending.latestType);
        }, LocalReplicaSCMProvider.localReadStabilizeRearmMs);
        this.pendingLocalEvents.set(relPath, {
            timer,
            firstEventAt,
            latestType: observedType,
            latestUri: localUri,
        });
    }

    private clearLocalStabilizeState(relPath: string): void {
        this.localStabilizeState.delete(relPath);
    }

    // Consume recordSyncManifestEntry's stability verdict instead of discarding
    // it. `false` means the local file moved while the remote operation was in
    // flight, so the delivered bytes are already a past revision: the push
    // succeeded, but it is not the last one this path needs.
    private async recordPushManifestEntry(
        relPath: string,
        vfsUri: vscode.Uri,
        localUri: vscode.Uri,
        content: Uint8Array,
        generation: number,
    ): Promise<void> {
        const stable = await this.recordSyncManifestEntry(
            relPath,
            vfsUri,
            content,
            generation,
        );
        if (stable) {
            this.clearLocalStabilizeState(relPath);
            return;
        }
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [push intermediate] ${relPath}: ` +
            `${content.length} bytes delivered; local advanced while the sync was in flight`,
        );
        // The outcome stays 'success' — the bytes that landed on Overleaf are a
        // legitimate revision. What is missing is the next one.
        this.scheduleLocalPushRetry(
            relPath,
            localUri,
            'local-advanced-during-push',
            generation,
        );
    }

    private retainRemotePullIntentAfterClassificationFailure(
        relPath: string,
        vfsUri: vscode.Uri,
        observedType: 'update' | 'delete',
        error: unknown,
        generation: number,
    ): void {
        if (!this.isSyncSessionActive(generation)) { return; }
        const errorMessage = formatUnknownError(error);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [pull classification failed] ${relPath}: ${errorMessage}`,
        );
        maybeWarnSyncFailure(relPath, error);
        EventBus.fire('scmSyncCompleteEvent', {
            rootUri: this.baseUri,
            relPath,
            direction: 'pull',
            type: observedType,
            outcome: 'error',
            error: errorMessage,
        });

        const existing = this.pendingVfsEvents.get(relPath);
        if (existing) {
            clearTimeout(existing.timer);
        }
        const firstEventAt = existing?.firstEventAt ?? Date.now();
        const timer = setTimeout(() => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const pending = this.pendingVfsEvents.get(relPath);
            if (!pending || pending.timer!==timer) { return; }
            this.pendingVfsEvents.delete(relPath);
            this.syncFromVFS(pending.latestUri, pending.latestType);
        }, LocalReplicaSCMProvider.fallbackScanIntervalMs);
        this.pendingVfsEvents.set(relPath, {
            timer,
            firstEventAt,
            latestType: observedType,
            latestUri: vfsUri,
        });
    }

    private queueForcedPush(
        relPath: string,
        reason: string,
        observedType: 'update' | 'delete' = 'update',
        forceDirectoryUpdate = false,
    ): void {
        if (!this.isSyncSessionActive()) { return; }
        const generation = this.syncGeneration;
        const localUri = this.localUri(relPath);
        const vfsUri = this.vfs.pathToUri(relPath);
        void this.enqueueSync(
            relPath,
            async () => {
                let type: 'update' | 'delete' | undefined;
                try {
                    if (forceDirectoryUpdate) {
                        const stat = await this.statConfinedLocalUri(
                            localUri,
                            `forced directory reconciliation of ${relPath}`,
                        );
                        if (stat.type===vscode.FileType.Directory) {
                            type = 'update';
                        }
                    }
                    type ??= await this.localTargetNeedsPush(relPath, localUri, observedType);
                    this.requireSyncSession(generation);
                } catch (error) {
                    this.retainLocalPushIntentAfterClassificationFailure(
                        relPath,
                        localUri,
                        observedType,
                        error,
                        generation,
                    );
                    return undefined;
                }
                if (type===undefined) { return undefined; }
                return this.applySync('push', type, relPath, localUri, vfsUri, {
                    forcePush: true,
                    reason,
                }, generation);
            },
            generation,
        );
    }

    private async applySync(
        action:'push'|'pull',
        type: 'update'|'delete',
        relPath:string,
        fromUri: vscode.Uri,
        toUri: vscode.Uri,
        options: ApplySyncOptions = {},
        generation = this.syncGeneration,
    ): Promise<Events['scmSyncCompleteEvent']> {
        const originalRelPath = relPath;
        const confinedRelPath = this.normalizeConfinedRelPath(relPath, `${action} ${type}`);
        if (confinedRelPath===undefined) {
            this.status = {status: 'idle', message: ''};
            const event: Events['scmSyncCompleteEvent'] = {
                rootUri: this.baseUri,
                relPath: normalizeReplicaPath(originalRelPath),
                direction: action,
                type,
                outcome: 'blocked',
                error: 'invalid replica path',
            };
            EventBus.fire('scmSyncCompleteEvent', event);
            return event;
        }
        relPath = confinedRelPath;
        if (!this.isSyncSessionActive(generation)) {
            const event: Events['scmSyncCompleteEvent'] = {
                rootUri: this.baseUri,
                relPath,
                direction: action,
                type,
                outcome: 'blocked',
                error: 'sync session inactive',
            };
            EventBus.fire('scmSyncCompleteEvent', event);
            return event;
        }
        if (action==='pull') {
            toUri = this.localUri(relPath);
        }
        const bypassCacheSnapshot = this.snapshotBypassCache(relPath);
        this.status = {status: action, message: `${type}: ${relPath}`};

        // Track the terminal outcome so we can fire a single scmSyncCompleteEvent
        // after the IIFE settles. Each early `return` along a guard/suppress
        // path updates `outcome` first; the catch updates `outcome` + `error`.
        // Subscribers (compileManager, status UI, tests) can wait on a specific
        // (relPath, direction, outcome) without polling status.
        let outcome: 'success' | 'error' | 'blocked' | 'suppressed' = 'success';
        let errorMessage: string | undefined;
        let authoritativePullCompleted = false;
        let resolveConflict = false;
        let acknowledgedPendingFilePush: Pick<SyncManifestPendingFileOperation, 'kind' | 'localRevision'> | undefined;
        let conflictResolutionProof: ConflictResolutionProof | undefined;

        try {
            await (async () => {
            const conflictPath = action==='push'
                ? this.conflictPathForPushTarget(relPath)
                : undefined;
            if (
                action==='push'
                && conflictPath!==undefined
                && (
                    options.resolveConflict===true
                    || await this.hasLocalConflictRevision(conflictPath, generation)
                )
            ) {
                conflictResolutionProof = await this.prepareConflictResolutionProof(
                    conflictPath,
                    relPath,
                    generation,
                    options.acceptUnchangedLocalConflictState===true,
                );
                resolveConflict = conflictResolutionProof!==undefined;
                if (resolveConflict) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [conflict resolution verified] ${relPath} ` +
                        `(conflict=${conflictPath}): ` +
                        'the local decision was reviewed and the recorded Overleaf revision is still current',
                    );
                }
            }
            if (
                action==='push'
                && this.touchesSyncConflict(relPath)
                && !resolveConflict
            ) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [push blocked:unresolved-conflict] ${relPath}`,
                );
                outcome = 'blocked';
                errorMessage = 'unresolved sync conflict';
                return;
            }
            if (type==='delete') {
                const newContent = undefined;
                // The manifest fallback matters most here: a path with a
                // manifest entry but no baseCache entry (conflict-marked media,
                // files over the merge-baseline limit, paths blocked during
                // startup) would otherwise look baseline-free and skip the
                // concurrent-edit guard below entirely.
                const previousBaseContent = this.baseCache[relPath]
                    ?? this.manifestBaseContent(this.syncManifest?.files[relPath]);
                const directoryDelete = this.isTrackedDirectory(relPath);
                let targetAlreadyMissing = false;
                let expectedLocalDeleteRevision: string | undefined;
                let expectedLocalDeleteIdentity: LocalReadIdentity | 'unavailable' | undefined;
                let expectedRemoteDeleteRevision: string | undefined;
                let localDeleteState: PathRevision | undefined;
                let remoteDeleteState: PathRevision | undefined;

                // Folder deletes carry a durable entity identity from the
                // manifest, rather than falling through to the file-oriented
                // path/revision staging helper. This applies on a live local
                // delete and when an inbound delete arrives while that local
                // intent is still awaiting acknowledgement.
                const pendingDirectoryDelete = this.syncManifest?.pendingOperations[relPath];
                if (
                    directoryDelete
                    && (
                        action==='push'
                        || pendingDirectoryDelete?.kind==='rmdir'
                    )
                ) {
                    let record: SyncManifestPendingDirectoryDeleteOperation | undefined;
                    try {
                        if (action==='push') {
                            const localState = await this.captureLocalPathRevision(
                                relPath,
                                generation,
                            );
                            if (localState.kind!=='missing') {
                                throw new LocalReadUnstableError(
                                    relPath,
                                    'vanished-during-update',
                                    'Local Replica folder delete target reappeared before its intent was journaled: ' +
                                        relPath,
                                );
                            }
                            // A one-off ENOENT is a normal atomic-save shape.
                            // Require a second absence before a recursive rmdir
                            // becomes durable; after that point a re-creation is
                            // a real competing intent and is conflict-preserved.
                            if (pendingDirectoryDelete?.kind!=='rmdir') {
                                const confirmedLocalState = await this.captureLocalPathRevision(
                                    relPath,
                                    generation,
                                );
                                if (confirmedLocalState.kind!=='missing') {
                                    throw new LocalReadUnstableError(
                                        relPath,
                                        'vanished-during-update',
                                        'Local Replica folder delete target reappeared during absence corroboration: ' +
                                            relPath,
                                    );
                                }
                            }
                            const pendingDescendant = this.pendingOperationAtOrBelow(
                                relPath,
                                pendingDirectoryDelete?.kind==='rmdir'
                                    ? pendingDirectoryDelete.id
                                    : undefined,
                            );
                            if (pendingDescendant!==undefined) {
                                getOutputChannel().appendLine(
                                    new Date().toISOString() +
                                    ' [folder delete deferred:pending-descendant] ' +
                                    relPath + ': ' + pendingDescendant,
                                );
                                outcome = 'blocked';
                                errorMessage = 'unresolved descendant local operation';
                                return;
                            }
                            record = pendingDirectoryDelete?.kind==='rmdir'
                                ? pendingDirectoryDelete
                                : await this.journalPendingLocalDirectoryDelete(
                                    relPath,
                                    generation,
                                );
                        } else {
                            if (pendingDirectoryDelete?.kind!=='rmdir') {
                                // An ordinary remote delete uses the existing
                                // pull path. Only a matching pending local
                                // rmdir gets the durable acknowledgement flow.
                                record = undefined;
                            } else {
                                record = pendingDirectoryDelete;
                            }
                        }
                    } catch (error) {
                        if (LocalReplicaSCMProvider.isLocalReadUnstable(error)) {
                            this.scheduleLocalPushRetry(
                                relPath,
                                fromUri,
                                'unstable-read',
                                generation,
                                'delete',
                            );
                            outcome = 'blocked';
                            errorMessage = LOCAL_SNAPSHOT_UNSTABLE;
                            return;
                        }
                        if (error instanceof RemoteDocumentMergeConflictError) {
                            await this.markSyncConflict(
                                relPath,
                                formatUnknownError(error),
                                undefined,
                                generation,
                            );
                            outcome = 'blocked';
                            errorMessage = this.syncConflicts.get(relPath)
                                ?? 'sync conflict: guarded local folder delete could not be journaled';
                            return;
                        }
                        throw error;
                    }
                    if (record!==undefined) {
                        try {
                            if (
                                action==='push'
                                && resolveConflict
                                && conflictResolutionProof?.remoteState.kind==='directory'
                            ) {
                                record = await this.rebasePendingLocalDirectoryDeleteForConflictResolution(
                                    relPath,
                                    record,
                                    conflictResolutionProof.remoteState,
                                    generation,
                                );
                            }
                        } catch (error) {
                            await this.markSyncConflict(
                                relPath,
                                'The explicit local folder-delete decision could not be applied safely: ' +
                                    formatUnknownError(error),
                                undefined,
                                generation,
                            );
                            outcome = 'blocked';
                            errorMessage = this.syncConflicts.get(relPath)
                                ?? 'sync conflict: guarded local folder delete resolution failed';
                            return;
                        }
                        const result = await this.reconcilePendingLocalDirectoryDelete(
                            relPath,
                            record,
                            generation,
                            {allowRemoteDivergence: resolveConflict},
                        );
                        if (result==='accepted') {
                            if (action==='pull') {
                                authoritativePullCompleted = true;
                            }
                            return;
                        }
                        outcome = 'blocked';
                        errorMessage = result==='deferred'
                            ? 'unresolved descendant local operation'
                            : this.syncConflicts.get(relPath)
                                ?? 'sync conflict: guarded local folder delete conflict';
                        return;
                    }
                }

                if (directoryDelete) {
                    const pendingDescendant = this.pendingOperationAtOrBelow(relPath);
                    if (pendingDescendant!==undefined) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [folder delete deferred:pending-descendant] ` +
                            `${relPath}: ${pendingDescendant}`,
                        );
                        outcome = 'blocked';
                        errorMessage = 'unresolved descendant local operation';
                        return;
                    }
                }

                // Layer 3 — suppress a pull-delete for a path we never
                // authoritatively replicated. The cascade starts here: a VFS
                // Deleted event for a file that wasn't pulled locally would
                // otherwise call workspace.fs.delete(localUri), which fires
                // the local watcher and echoes back as a remote delete. We
                // refuse to act on it and seed the bypass cache so any
                // spurious echo gets suppressed too.
                if (action==='pull') {
                    // Digest alone is not enough to authorize removing a file: a
                    // same-byte atomic recreation hashes identically while being a
                    // different file somebody deliberately put there. The identity
                    // is taken BEFORE the revision on purpose — if the path is
                    // replaced between the two observations the identity is the
                    // older file's, so the checks below refuse; taking it
                    // afterwards would instead bless the replacement.
                    const capturedDeleteIdentity = await this.captureLocalPathIdentity(
                        this.localUri(relPath).fsPath,
                    );
                    localDeleteState = await this.captureLocalPathRevision(relPath, generation);
                    const localExists = localDeleteState.kind!=='missing';
                    expectedLocalDeleteRevision = localDeleteState.revision;
                    // A live path whose identity could not be read is 'unavailable',
                    // never undefined: undefined would read as "no identity needed".
                    expectedLocalDeleteIdentity = localExists
                        ? capturedDeleteIdentity ?? 'unavailable'
                        : undefined;
                    const everReplicated = relPath in this.baseCache
                        || this.syncManifest?.files[relPath]!==undefined
                        || this.syncManifest?.directories[relPath]!==undefined;
                    if (!localExists) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [pull delete applied:local-missing] ${relPath}: ` +
                            `everReplicated=${everReplicated} failedInitialPull=${this.failedInitialPulls.has(relPath)}`,
                        );
                        this.setBypassCache(relPath, undefined);
                        this.rememberRemoteDelete(relPath, previousBaseContent);
                        this.clearFailedInitialPullAfterAuthoritativeSync(relPath, generation);
                        this.clearReplicaState(relPath, directoryDelete);
                        await this.persistSyncManifest(false, generation);
                        authoritativePullCompleted = true;
                        return;
                    }
                    if (!everReplicated || this.failedInitialPulls.has(relPath)) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [pull delete suppressed] ${relPath}: ` +
                            `localExists=${localExists} everReplicated=${everReplicated} ` +
                            `failedInitialPull=${this.failedInitialPulls.has(relPath)}`,
                        );
                        this.setBypassCache(relPath, undefined);
                        this.failedInitialPulls.add(relPath);
                        this.initialPullStatus = 'partial';
                        const localConflictContent = directoryDelete
                            ? undefined
                            : await this.readFile(relPath);
                        this.requireSyncSession(generation);
                        await this.markSyncConflict(
                            relPath,
                            'Overleaf deleted a path whose local copy was never verified',
                            localConflictContent,
                            generation,
                        );
                        outcome = 'suppressed';
                        return;
                    }
                    // A conflict at this path or above it means both copies are
                    // being preserved on purpose. Applying the Overleaf delete
                    // would destroy the preserved local copy and the
                    // post-success cleanup would then drop the conflict record,
                    // so hold the delete until the user resolves it.
                    const blockingConflictPath = [...this.syncConflicts.keys()]
                        .find(conflictPath => this.isPathAtOrBelow(relPath, conflictPath));
                    if (blockingConflictPath!==undefined) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [pull delete blocked:unresolved-conflict] ` +
                            `${relPath} (conflict=${blockingConflictPath})`,
                        );
                        outcome = 'blocked';
                        errorMessage = 'unresolved sync conflict';
                        return;
                    }
                    if (directoryDelete) {
                        const ignoredDescendant = await this.findIgnoredDescendant(toUri, relPath, generation);
                        this.requireSyncSession(generation);
                        if (ignoredDescendant) {
                            await this.markSyncConflict(
                                relPath,
                                `Overleaf deleted the folder, but local ignored content must be preserved (${ignoredDescendant})`,
                                undefined,
                                generation,
                            );
                            outcome = 'blocked';
                            errorMessage = 'remote folder delete contains ignored local content';
                            return;
                        }
                    }
                    if (directoryDelete && await this.localDirectoryHasChanges(relPath, generation)) {
                        this.requireSyncSession(generation);
                        await this.markSyncConflict(
                            relPath,
                            'Overleaf deleted the folder while its local contents also changed',
                            undefined,
                            generation,
                        );
                        outcome = 'blocked';
                        errorMessage = 'concurrent remote folder delete and local edits';
                        return;
                    }
                    if (previousBaseContent!==undefined) {
                        const localContent = localDeleteState.content;
                        if (localContent!==undefined && !bytesEqual(localContent, previousBaseContent)) {
                            await this.markSyncConflict(
                                relPath,
                                'Overleaf deleted the file while the local saved copy was also edited',
                                localContent,
                                generation,
                            );
                            outcome = 'blocked';
                            errorMessage = 'concurrent remote delete and local edit';
                            return;
                        }
                    } else if (!directoryDelete) {
                        // The path was replicated and still exists locally, but
                        // no baseline survives to prove the local bytes are the
                        // ones Overleaf deleted. Deleting on that evidence can
                        // discard local work, so the uncertainty becomes a
                        // conflict instead of a silent winner.
                        await this.markSyncConflict(
                            relPath,
                            'Overleaf deleted the file and no sync baseline is available to prove ' +
                                'the local copy was unmodified',
                            localDeleteState.kind==='file' ? localDeleteState.content : undefined,
                            generation,
                        );
                        outcome = 'blocked';
                        errorMessage = 'missing remote delete baseline';
                        return;
                    }
                }

                // Layer 4 — refuse a push-delete without local-write
                // provenance. If we never wrote this file locally (no entry in
                // baseCache and no seenLocalEntities trace), the local-watcher
                // event is an echo, not user intent. A verified conflict
                // resolution is the exception: markSyncConflict deliberately
                // removes ordinary tracking, and the changed local revision plus
                // unchanged remote proof is the provenance for the user's choice.
                if (action==='push') {
                    if (this.failedInitialPulls.has(relPath)) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [push delete blocked] ${relPath}: initial pull failed; refusing to mutate remote`,
                        );
                        maybeWarnSyncFailure(relPath, new Error(
                            'Remote delete blocked: initial pull failed for this file. Use "Retry Pull" before deleting.',
                        ));
                        outcome = 'blocked';
                        errorMessage = 'initial pull failed';
                        return;
                    }
                    if (
                        !resolveConflict
                        && !this.seenLocalEntities.has(relPath)
                        && !(relPath in this.baseCache)
                        && this.syncManifest?.files[relPath]===undefined
                        && this.syncManifest?.directories[relPath]===undefined
                    ) {
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [push delete blocked] ${relPath}: no local-write trace; treating as echo`,
                        );
                        outcome = 'suppressed';
                        return;
                    }
                    if (!directoryDelete) {
                        const localDeleteSnapshot = await this.captureLocalPathRevision(
                            relPath,
                            generation,
                        );
                        if (localDeleteSnapshot.kind==='missing') {
                            await this.journalPendingFilePushOperation(
                                relPath, 'delete', DELETE_DIGEST, undefined, generation,
                            );
                        }
                    }
                    remoteDeleteState = resolveConflict
                        ? conflictResolutionProof?.remoteState
                        : await this.captureRemotePathRevision(relPath, generation);
                    if (!remoteDeleteState) {
                        outcome = 'blocked';
                        errorMessage = 'missing verified remote conflict revision';
                        return;
                    }
                    if (!directoryDelete) {
                        await this.journalPendingFilePushOperation(
                            relPath, 'delete', DELETE_DIGEST, remoteDeleteState, generation,
                        );
                    }
                    if (remoteDeleteState.kind==='missing') {
                        targetAlreadyMissing = true;
                    } else {
                        expectedRemoteDeleteRevision = remoteDeleteState.revision;
                    }
                    if (directoryDelete && !targetAlreadyMissing) {
                        try {
                            const ignoredDescendant = await this.findIgnoredDescendant(toUri, relPath, generation);
                            this.requireSyncSession(generation);
                            if (ignoredDescendant) {
                                await this.markSyncConflict(
                                    relPath,
                                    `The local folder was deleted, but ignored Overleaf content must be preserved (${ignoredDescendant})`,
                                    null,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'local folder delete contains ignored remote content';
                                return;
                            }
                            if (
                                !resolveConflict
                                && await this.remoteDirectoryHasChanges(relPath, generation)
                            ) {
                                this.requireSyncSession(generation);
                                await this.markSyncConflict(
                                    relPath,
                                    'The local folder was deleted while its Overleaf contents also changed',
                                    null,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'concurrent local folder delete and remote edits';
                                return;
                            }
                        } catch (error) {
                            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                                targetAlreadyMissing = true;
                            } else {
                                throw error;
                            }
                        }
                    } else if (
                        !resolveConflict
                        && !targetAlreadyMissing
                        && previousBaseContent!==undefined
                    ) {
                        const remoteContent = remoteDeleteState.content;
                        if (remoteContent!==undefined && !bytesEqual(remoteContent, previousBaseContent)) {
                            await this.markSyncConflict(
                                relPath,
                                'The local copy was deleted while the Overleaf copy was also edited',
                                null,
                                generation,
                            );
                            outcome = 'blocked';
                            errorMessage = 'concurrent local delete and remote edit';
                            return;
                        }
                    }
                }

                if (this.bypassSync(action, type, relPath, newContent, options)) {
                    outcome = 'suppressed';
                    return;
                }
                let staleLocalMtime: number | undefined;
                if (action==='pull') {
                    try {
                        const deleteTargetStat = await vscode.workspace.fs.stat(toUri);
                        this.requireSyncSession(generation);
                        if (deleteTargetStat.type===vscode.FileType.File) {
                            staleLocalMtime = deleteTargetStat.mtime;
                        }
                    } catch {
                        staleLocalMtime = undefined;
                    }
                }
                if (action==='push') {
                    // Re-check after the awaited remote revision capture above:
                    // a session swap there must abort before we mutate Overleaf.
                    this.requireSyncSession(generation);
                    // Stronger evidence before a destructive delete. The ENOENT
                    // that produced this classification can be an atomic
                    // temp-file replacement, and everything since then has been
                    // awaited I/O. If a real file is back at the path, the
                    // deletion would destroy it on Overleaf, so defer and let
                    // the re-armed push classify against what is actually there.
                    // Directories are included: a recursive remote folder delete
                    // is strictly more destructive than a single file, and a
                    // folder that a tool momentarily removed and recreated
                    // deserves the same corroboration. When the path really is
                    // gone the capture is a single failed stat, so covering
                    // directories costs nothing in the common case.
                    {
                        let currentLocalState = await this.captureLocalPathRevision(
                            relPath,
                            generation,
                        );
                        // Some classifications MANUFACTURE 'delete' from a single
                        // directory listing (the degraded-watcher scan and the
                        // precompile source scan) rather than from a watcher
                        // unlink notification, which is materially weaker
                        // evidence. Rather than make every such classification
                        // pay a recheck window — it would fan out across paths
                        // that never reach a delete — the corroboration is spent
                        // here, once per actual deletion, at the last moment
                        // before the remote is mutated. One probe outlasts an
                        // atomic replacement's unlinked window by orders of
                        // magnitude; a genuine deletion still propagates, just
                        // that much later.
                        if (currentLocalState.kind==='missing') {
                            await this.sleepForStabilization(
                                LocalReplicaSCMProvider.localDeleteCorroborationMs,
                            );
                            this.requireSyncSession(generation);
                            currentLocalState = await this.captureLocalPathRevision(
                                relPath,
                                generation,
                            );
                        }
                        if (currentLocalState.kind!=='missing') {
                            throw new LocalReadUnstableError(
                                relPath,
                                'vanished-during-update',
                                'Local Replica delete target reappeared before the '
                                + `Overleaf copy was removed: ${relPath}`,
                            );
                        }
                    }
                }
                if (action==='push' && !targetAlreadyMissing) {
                    try {
                        await this.withRetry('push', relPath, async () => {
                            await this.vfs.ensureConnectedForWrite();
                            this.requireSyncSession(generation);
                            if (expectedRemoteDeleteRevision===undefined) {
                                throw new ConcurrentReplicaChangeError(
                                    `Missing expected Overleaf revision for ${relPath}`,
                                );
                            }
                            await this.atomicDeleteRemotePathIfRevision(
                                relPath,
                                expectedRemoteDeleteRevision,
                                generation,
                                async () => (
                                    await this.captureLocalPathRevision(relPath, generation)
                                ).kind==='missing',
                            );
                        }, {
                            delays: LocalReplicaSCMProvider.pushRetryDelays,
                            generation,
                            betweenAttempts: async () => {
                                await this.waitForConnectedOrTimeout(LocalReplicaSCMProvider.pushReconnectWaitMs);
                            },
                        });
                    } catch (error) {
                        if (!(error instanceof ConcurrentReplicaChangeError)) {
                            throw error;
                        }
                        await this.markSyncConflict(
                            relPath,
                            'The Overleaf path changed immediately before the local delete could be applied',
                            null,
                            generation,
                        );
                        outcome = 'blocked';
                        errorMessage = 'concurrent remote change before delete';
                        return;
                    }
                } else if (action==='pull') {
                    const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                    // Same fail-closed rule: a path that is present but whose
                    // identity could not be acquired counts as changed, never as
                    // unchanged.
                    const localIdentityUnchanged = latestLocal.kind==='missing'
                        || (
                            expectedLocalDeleteIdentity!==undefined
                            && expectedLocalDeleteIdentity!=='unavailable'
                            && await this.localPathIdentityMatches(
                                this.localUri(relPath).fsPath,
                                expectedLocalDeleteIdentity,
                                true,
                            )
                        );
                    if (
                        expectedLocalDeleteRevision!==undefined
                        && (
                            latestLocal.revision!==expectedLocalDeleteRevision
                            || !localIdentityUnchanged
                        )
                    ) {
                        await this.markSyncConflict(
                            relPath,
                            'The local path changed immediately before the Overleaf delete could be applied',
                            latestLocal.kind==='file' ? latestLocal.content : undefined,
                            generation,
                        );
                        outcome = 'blocked';
                        errorMessage = 'concurrent local change before delete';
                        return;
                    }
                    const deleted = await this.runSessionIO(
                        generation,
                        () => this.atomicDeleteLocalPathIfRevision(
                            relPath,
                            expectedLocalDeleteRevision!,
                            generation,
                            expectedLocalDeleteIdentity,
                        ),
                    );
                    if (!deleted) {
                        const concurrentLocal = await this.captureLocalPathRevision(relPath, generation);
                        await this.markSyncConflict(
                            relPath,
                            'The local path changed during atomic application of the Overleaf delete',
                            concurrentLocal.kind==='file' ? concurrentLocal.content : undefined,
                            generation,
                        );
                        outcome = 'blocked';
                        errorMessage = 'concurrent local change during atomic delete';
                        return;
                    }
                }
                this.requireSyncSession(generation);
                let localRecreatedDuringPushDelete = false;
                let pendingLocalChangeDuringPushDelete = false;
                if (action==='push') {
                    localRecreatedDuringPushDelete = (
                        await this.captureLocalPathRevision(relPath, generation)
                    ).kind!=='missing';
                    pendingLocalChangeDuringPushDelete = [...this.pendingLocalEvents.keys()]
                        .some(path => directoryDelete
                            ? this.isPathAtOrBelow(path, relPath)
                            : path===relPath
                        );
                }
                this.setBypassCache(relPath, undefined);
                if (action==='pull') {
                    this.rememberRemoteDelete(relPath, previousBaseContent, staleLocalMtime);
                } else {
                    this.clearRemoteDelete(relPath);
                }
                this.clearReplicaState(
                    relPath,
                    directoryDelete,
                    action==='push',
                );
                if (action==='pull') {
                    authoritativePullCompleted = true;
                }
                if (action==='push' && !directoryDelete) {
                    acknowledgedPendingFilePush = {
                        kind: 'delete',
                        localRevision: DELETE_DIGEST,
                    };
                }
                await this.persistSyncManifest(false, generation);
                this.requireSyncSession(generation);
                if (
                    action==='push'
                    && (localRecreatedDuringPushDelete || pendingLocalChangeDuringPushDelete)
                ) {
                    this.locallyDivergedPaths.add(relPath);
                    this.queueForcedPush(
                        relPath,
                        'local-change-during-remote-delete',
                        localRecreatedDuringPushDelete ? 'update' : 'delete',
                    );
                }
            } else {
                // Layer 4b — refuse a push-update for a path whose initial
                // pull failed. The local replica never authoritatively held
                // this file's remote contents, so propagating local bytes
                // would clobber the remote with whatever happens to be on
                // disk (often nothing, or a stale snapshot). The symmetric
                // delete-side check lives above inside the `type==='delete'`
                // branch; this guards the update path so the local watcher
                // can be armed unconditionally without risk.
                if (
                    action==='push'
                    && this.failedInitialPulls.has(relPath)
                ) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [push update blocked] ${relPath}: initial pull failed; refusing to mutate remote`,
                    );
                    maybeWarnSyncFailure(relPath, new Error(
                        'Remote update blocked: initial pull failed for this file. Use "Retry Pull" before editing.',
                    ));
                    outcome = 'blocked';
                    errorMessage = 'initial pull failed';
                    return;
                }
                const stat = action==='push'
                    ? await this.statPushSourceOrDeferVanished(relPath, fromUri, type)
                    : await vscode.workspace.fs.stat(fromUri);
                this.requireSyncSession(generation);
                const isRemotePull = action==='pull';
                const isDirectory = LocalReplicaSCMProvider.isSyncStatType(
                    stat,
                    vscode.FileType.Directory,
                    isRemotePull,
                );
                const isFile = LocalReplicaSCMProvider.isSyncStatType(
                    stat,
                    vscode.FileType.File,
                    isRemotePull,
                );
                let directoryCreateAlreadyFinalized = false;
                let observedRemoteDirectoryIdentity: RemoteFolderPathIdentity | undefined;
                if (isDirectory) {
                    const newContent = new Uint8Array();
                    if (this.bypassSync(action, type, relPath, newContent, options)) {
                        outcome = 'suppressed';
                        return;
                    }
                    if (action==='push') {
                        const localState = await this.captureLocalPathRevision(
                            relPath,
                            generation,
                        );
                        if (localState.kind!=='directory') {
                            throw new LocalReadUnstableError(
                                relPath,
                                'directory-changed-during-create',
                                'Local Replica folder changed before the Overleaf create could be journaled: ' +
                                    relPath,
                            );
                        }
                        const remoteState = await this.captureRemotePathRevision(
                            relPath,
                            generation,
                        );
                        this.requireSyncSession(generation);
                        const reconcilePendingCreate = async (
                            record: SyncManifestPendingDirectoryCreateOperation,
                        ) => {
                            let accepted = false;
                            try {
                                accepted = await this.reconcilePendingLocalDirectoryCreate(
                                    relPath,
                                    record,
                                    generation,
                                );
                            } catch (error) {
                                if (!(error instanceof RemoteDocumentMergeConflictError)) {
                                    throw error;
                                }
                                await this.markSyncConflict(
                                    relPath,
                                    error.message,
                                    undefined,
                                    generation,
                                );
                            }
                            if (!accepted) {
                                outcome = 'blocked';
                                errorMessage = 'guarded local folder create was not accepted';
                                return false;
                            }
                            directoryCreateAlreadyFinalized = true;
                            return true;
                        };
                        if (remoteState.kind==='directory') {
                            const pending = this.syncManifest?.pendingOperations[relPath];
                            if (pending?.kind==='mkdir') {
                                if (!await reconcilePendingCreate(pending)) {
                                    return;
                                }
                            } else if (pending!==undefined) {
                                await this.markSyncConflict(
                                    relPath,
                                    'A non-folder Local Replica operation is pending at an existing Overleaf folder',
                                    undefined,
                                    generation,
                                    remoteState,
                                );
                                outcome = 'blocked';
                                errorMessage = 'pending operation has incompatible folder type';
                                return;
                            } else {
                                // No unacknowledged local mkdir exists. This is
                                // an already-authoritative shared container
                                // (often a watcher echo or an ancestor created
                                // while reconciling a child), so do not treat
                                // its name alone as a competing mutation.
                                observedRemoteDirectoryIdentity =
                                    await this.resolveRemoteFolderPathIdentity(toUri);
                                this.requireSyncSession(generation);
                                if (!observedRemoteDirectoryIdentity) {
                                    throw new Error(
                                        'Could not resolve the authoritative Overleaf folder identity for ' +
                                        relPath,
                                    );
                                }
                            }
                        } else if (remoteState.kind!=='missing') {
                            await this.markSyncConflict(
                                relPath,
                                'Overleaf path has a different type before the local folder create could be applied',
                                undefined,
                                generation,
                                remoteState,
                            );
                            outcome = 'blocked';
                            errorMessage = 'concurrent untracked path type conflict';
                            return;
                        } else {
                            const parentRelPath = nodePath.posix.dirname(relPath);
                            const parentIdentity = await this.resolveRemoteFolderPathIdentity(
                                this.vfs.pathToUri(parentRelPath),
                            );
                            this.requireSyncSession(generation);
                            if (!parentIdentity) {
                                throw new Error(
                                    'Could not resolve the authoritative Overleaf parent folder for ' + relPath,
                                );
                            }
                            const record = await this.journalPendingLocalDirectoryCreate(
                                relPath,
                                localState.revision,
                                parentIdentity.entity,
                                generation,
                            );
                            if (!await reconcilePendingCreate(record)) {
                                return;
                            }
                        }
                    } else {
                        observedRemoteDirectoryIdentity =
                            await this.resolveRemoteFolderPathIdentity(fromUri);
                        this.requireSyncSession(generation);
                        if (!observedRemoteDirectoryIdentity) {
                            throw new Error(
                                'Could not resolve the authoritative Overleaf folder identity for ' +
                                    relPath,
                            );
                        }
                        await this.runSessionIO(
                            generation,
                            () => vscode.workspace.fs.createDirectory(toUri),
                        );
                    }
                    this.requireSyncSession(generation);
                    if (action==='pull') {
                        authoritativePullCompleted = true;
                    }
                    if (!directoryCreateAlreadyFinalized) {
                        this.seenLocalEntities.add(relPath);
                        this.clearRemoteDelete(relPath);
                        this.locallyDivergedPaths.delete(relPath);
                        await this.recordSyncManifestDirectory(
                            relPath,
                            observedRemoteDirectoryIdentity,
                            generation,
                        );
                        await this.persistSyncManifest(false, generation);
                    }
                    if (
                        !options.skipDirectoryDescendants
                        && !options.resolveConflict
                    ) {
                        await this.reconcileDirectoryDescendants(
                            action,
                            relPath,
                            generation,
                        );
                    }
                }
                else if (isFile) {
                    try {
                        // Pull reads go through the retrying helper since
                        // transient binary failures are the trigger for the
                        // whole cascade we are guarding against. Push reads
                        // defer and re-read while a writer holds the file, and
                        // hand back the metadata of the revision they actually
                        // returned — `stat` above was taken before the deferrals
                        // and may describe an earlier revision entirely.
                        let newContent: Uint8Array;
                        let readStat = stat;
                        if (action==='pull') {
                            newContent = await this.pullRemoteFile(relPath, fromUri, generation);
                        } else {
                            const snapshot = await this.readPushSourceOrDeferVanished(
                                relPath,
                                fromUri,
                                type,
                                generation,
                            );
                            newContent = snapshot.content;
                            readStat = snapshot.stat;
                        }
                        this.requireSyncSession(generation);
                        if (action==='pull') {
                            authoritativePullCompleted = true;
                        }
                        if (action==='push') {
                            await this.journalPendingFilePushOperation(
                                relPath, 'update', contentDigest(newContent), undefined, generation,
                            );
                        }
                        let writeMergedContentBackToLocal = false;
                        let remoteBaselineForPush: Uint8Array | undefined;
                        let expectedRemoteMissingForPush = false;
                        let expectedLocalWriteRevision = action==='push'
                            ? contentDigest(newContent)
                            : undefined;
                        if (action==='push') {
                            const tombstone = this.remoteDeleteTombstones.get(relPath);
                            // The mtime MUST come from the same observation as the
                            // digest below it. Pairing fresh bytes with the older
                            // pre-read stat classifies a legitimately recreated
                            // file as a tombstone echo and deletes it locally.
                            //
                            // A tombstone carries an mtime only when we ourselves
                            // deleted a local file with that mtime, so by the time
                            // this runs the revision it describes is gone from the
                            // path. The original cannot walk back on its own: a
                            // later event for a missing path classifies as a
                            // delete, and a push that finds it missing defers. So
                            // the only thing this branch has to recognise is a
                            // RESTORED COPY of the deleted revision — from the OS
                            // trash, from our own operation guard, from a backup
                            // tool — and every one of those carries the deleted
                            // revision's timestamp forward with it.
                            //
                            // Hence the comparison is not "close to" but "not
                            // newer than". A user re-creating the file gets the
                            // moment of creation, which is necessarily later than
                            // the revision we removed; any forward tolerance here
                            // is precisely the window in which that user's own
                            // work is mistaken for the copy we deleted, and is
                            // then destroyed. There is no corresponding need for
                            // tolerance in the other direction: an older timestamp
                            // is even stronger evidence of a restore.
                            //
                            // A restore that does NOT preserve the original
                            // timestamp is indistinguishable from a fresh
                            // creation by content metadata alone. The bounded
                            // prompt-recreation window below covers the observed
                            // remote-delete/local-guard race and surfaces it as a
                            // conflict. Once that window has passed, a newer file
                            // is treated as a fresh local decision and pushed.
                            const staleLocalBytes = tombstone!==undefined
                                && tombstone.digest===contentDigest(newContent)
                                && tombstone.staleLocalMtime!==undefined
                                && normalizeMtimeMs(readStat.mtime)<=tombstone.staleLocalMtime;
                            const promptLocalRecreation = tombstone!==undefined
                                && Date.now()-tombstone.deletedAt
                                    <= LocalReplicaSCMProvider.remoteDeleteConflictWindowMs;
                            if (staleLocalBytes || promptLocalRecreation) {
                                // Both readings of this state fit the evidence: a
                                // restore tool put the deleted revision back with
                                // its original timestamp, or a person did.
                                // Timestamps cannot separate them, and neither can
                                // identity — every restore route that preserves an
                                // mtime (cp -p, a backup, the OS trash) also
                                // produces a new inode, exactly like a hand
                                // re-creation.
                                //
                                // What IS certain is that the file was created
                                // after our delete finished. The pull-delete
                                // emptied the path; a later event for a missing
                                // path classifies as a delete, and a push that
                                // finds it missing defers. Nothing arrives here on
                                // its own, so there is no subset that is provably
                                // our own echo left to suppress.
                                //
                                // The point of this branch is to avoid
                                // RESURRECTING the file on Overleaf, and declining
                                // to push achieves that. Destroying the local copy
                                // is a separate and irreversible choice made on
                                // ambiguous evidence, so it becomes a conflict
                                // instead: nothing is uploaded, nothing is
                                // removed, and whoever created the file decides.
                                getOutputChannel().appendLine(
                                    `${new Date().toISOString()} ` +
                                    `[push update blocked:remote-delete-restored] ${relPath}`,
                                );
                                await this.markSyncConflict(
                                    relPath,
                                    promptLocalRecreation
                                        ? 'Overleaf deleted this file while it was promptly recreated locally; '
                                            + 'keep the local file to restore it, or delete it to accept the removal'
                                        : 'Overleaf deleted this file and a copy of the deleted contents '
                                            + 'is present locally again; keep it to restore the file, or '
                                            + 'delete it to accept the removal',
                                    newContent,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'remote delete with a restored local copy';
                                return;
                            }

                            if (resolveConflict) {
                                const verifiedRemoteState = conflictResolutionProof?.remoteState;
                                if (!verifiedRemoteState) {
                                    outcome = 'blocked';
                                    errorMessage = 'missing verified remote conflict revision';
                                    return;
                                }
                                if (verifiedRemoteState.kind==='file') {
                                    remoteBaselineForPush = verifiedRemoteState.content;
                                } else if (verifiedRemoteState.kind==='missing') {
                                    expectedRemoteMissingForPush = true;
                                } else {
                                    outcome = 'blocked';
                                    errorMessage = 'conflicting Overleaf path is not a file';
                                    return;
                                }
                            }

                            const baseContent = resolveConflict
                                ? undefined
                                : this.baseCache[relPath]
                                    ?? this.manifestBaseContent(this.syncManifest?.files[relPath]);
                            if (baseContent!==undefined) {
                                const remoteContent = await this.pullRemoteFile(relPath, toUri, generation);
                                this.requireSyncSession(generation);
                                remoteBaselineForPush = remoteContent;
                                if (bytesEqual(newContent, remoteContent)) {
                                    // A watcher push can beat the save-triggered compile barrier.
                                    // Treat an exact remote readback as proof of delivery instead of
                                    // issuing a redundant OT update with a potentially stale version.
                                    this.setBypassCache(relPath, newContent, 'pull');
                                    this.baseCache[relPath] = newContent;
                                    this.seenLocalEntities.add(relPath);
                                    this.clearRemoteDelete(relPath);
                                    this.locallyDivergedPaths.delete(relPath);
                                    await this.recordPushManifestEntry(
                                        relPath,
                                        toUri,
                                        fromUri,
                                        newContent,
                                        generation,
                                    );
                                    await this.removePendingFilePushOperation(
                                        relPath,
                                        'current local state already matches authoritative Overleaf',
                                        generation,
                                        {kind: 'update', localRevision: contentDigest(newContent)},
                                    );
                                    await this.persistSyncManifest(false, generation);
                                    this.requireSyncSession(generation);
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [push verified] ${relPath}: remote already matches local`,
                                    );
                                    return;
                                }
                                const localChanged = !bytesEqual(newContent, baseContent);
                                const remoteChanged = !bytesEqual(remoteContent, baseContent);
                                if (!localChanged && remoteChanged) {
                                    const wroteRemoteContent = await this.writeLocalFileIfRevision(
                                        relPath,
                                        remoteContent,
                                        expectedLocalWriteRevision!,
                                        generation,
                                    );
                                    if (!wroteRemoteContent) {
                                        const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                        await this.markSyncConflict(
                                            relPath,
                                            'The local file changed while a newer Overleaf version was being applied',
                                            latestLocal.kind==='file' ? latestLocal.content : undefined,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'concurrent local edit during pull conversion';
                                        return;
                                    }
                                    this.setBypassCache(relPath, remoteContent, 'pull');
                                    this.baseCache[relPath] = remoteContent;
                                    this.seenLocalEntities.add(relPath);
                                    this.locallyDivergedPaths.delete(relPath);
                                    await this.recordPushManifestEntry(
                                        relPath,
                                        toUri,
                                        fromUri,
                                        remoteContent,
                                        generation,
                                    );
                                    await this.removePendingFilePushOperation(
                                        relPath,
                                        'local intent was superseded by an authoritative Overleaf update',
                                        generation,
                                    );
                                    await this.persistSyncManifest(false, generation);
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [push converted-to-pull] ${relPath}: remote changed, local remained at baseline`,
                                    );
                                    return;
                                }
                                if (localChanged && remoteChanged && !bytesEqual(newContent, remoteContent)) {
                                    const mergedContent = this.isLikelyBinaryRelPath(relPath)
                                        ? undefined
                                        : this.mergeTextContents(baseContent, newContent, remoteContent);
                                    if (mergedContent===undefined) {
                                        await this.markSyncConflict(
                                            relPath,
                                            'Local and Overleaf copies were edited concurrently and could not be merged automatically',
                                            newContent,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'concurrent edits conflict';
                                        return;
                                    }
                                    newContent = mergedContent;
                                    writeMergedContentBackToLocal = true;
                                }
                            } else if (!resolveConflict) {
                                const remoteState = await this.captureRemotePathRevision(
                                    relPath,
                                    generation,
                                );
                                this.requireSyncSession(generation);
                                if (remoteState.kind==='file') {
                                    if (bytesEqual(newContent, remoteState.content!)) {
                                        this.setBypassCache(relPath, newContent, 'pull');
                                        this.baseCache[relPath] = newContent;
                                        this.seenLocalEntities.add(relPath);
                                        this.clearRemoteDelete(relPath);
                                        this.locallyDivergedPaths.delete(relPath);
                                        await this.recordPushManifestEntry(
                                            relPath,
                                            toUri,
                                            fromUri,
                                            newContent,
                                            generation,
                                        );
                                        await this.removePendingFilePushOperation(
                                            relPath,
                                            'current local state already matches authoritative Overleaf',
                                            generation,
                                            {kind: 'update', localRevision: contentDigest(newContent)},
                                        );
                                        await this.persistSyncManifest(false, generation);
                                        getOutputChannel().appendLine(
                                            `${new Date().toISOString()} [push verified] ${relPath}: ` +
                                            'untracked remote already matches local',
                                        );
                                        return;
                                    }
                                    await this.markSyncConflict(
                                        relPath,
                                        'Local and Overleaf files appeared concurrently without a common baseline',
                                        newContent,
                                        generation,
                                    );
                                    outcome = 'blocked';
                                    errorMessage = 'concurrent untracked local and remote files';
                                    return;
                                }
                                if (remoteState.kind!=='missing') {
                                    await this.markSyncConflict(
                                        relPath,
                                        'Local and Overleaf paths appeared concurrently with different file types',
                                        newContent,
                                        generation,
                                    );
                                    outcome = 'blocked';
                                    errorMessage = 'concurrent untracked path type conflict';
                                    return;
                                }
                                expectedRemoteMissingForPush = true;
                            }
                        }
                        // Content-equality short-circuit for pull. The bypass
                        // cache already suppresses this case via its sha1
                        // digest, but doing the explicit byte compare here
                        // (a) keeps the optimisation honest if the bypass
                        // cache is ever evicted/cleared, and (b) emits a
                        // forensic [pull noop] log line that makes "VFS is
                        // noisy but content is stable" diagnosable.
                        let forcePullWrite = false;
                        if (action==='pull') {
                            const existing = this.baseCache[relPath]
                                ?? this.manifestBaseContent(this.syncManifest?.files[relPath]);
                            const localState = await this.captureLocalPathRevision(relPath, generation);
                            expectedLocalWriteRevision = localState.revision;
                            if (localState.kind==='directory' || localState.kind==='other') {
                                await this.markSyncConflict(
                                    relPath,
                                    'Overleaf could not update a local path with a different file type',
                                    undefined,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'local path type conflict';
                                return;
                            }
                            const localContent = localState.content;
                            if (localContent===undefined) {
                                if (existing!==undefined) {
                                    const remoteChanged = !bytesEqual(newContent, existing);
                                    if (remoteChanged) {
                                        await this.markSyncConflict(
                                            relPath,
                                            'The local copy was deleted while the Overleaf copy was also edited',
                                            null,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'concurrent local delete and remote edit';
                                        return;
                                    }
                                    this.locallyDivergedPaths.add(relPath);
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [pull noop:local-deleted] ${relPath} ` +
                                        '(remote unchanged; queued local delete)',
                                    );
                                    this.queueForcedPush(
                                        relPath,
                                        'local-delete-before-pull',
                                        'delete',
                                    );
                                    outcome = 'suppressed';
                                    return;
                                }
                                forcePullWrite = true;
                                getOutputChannel().appendLine(
                                    `${new Date().toISOString()} [pull repair] ${relPath}: untracked local file missing`,
                                );
                            } else if (existing!==undefined) {
                                const localChanged = !bytesEqual(localContent, existing);
                                const remoteChanged = !bytesEqual(newContent, existing);
                                if (!localChanged && !remoteChanged) {
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [pull noop] ${relPath} (${newContent.length} bytes, content unchanged)`,
                                    );
                                    outcome = 'suppressed';
                                    return;
                                }
                                if (localChanged && !remoteChanged) {
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [pull noop:local-diverged] ${relPath} (${newContent.length} bytes, remote unchanged)`,
                                    );
                                    this.locallyDivergedPaths.add(relPath);
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [pull local-diverged queued-push] ${relPath}`,
                                    );
                                    this.queueForcedPush(relPath, 'local-diverged');
                                    outcome = 'suppressed';
                                    return;
                                }
                                if (localChanged && remoteChanged) {
                                    if (bytesEqual(localContent, newContent)) {
                                        this.baseCache[relPath] = newContent;
                                        this.seenLocalEntities.add(relPath);
                                        this.locallyDivergedPaths.delete(relPath);
                                        await this.recordSyncManifestEntry(relPath, fromUri, newContent, generation);
                                        await this.persistSyncManifest(false, generation);
                                        return;
                                    }
                                    let mergedContent = this.isLikelyBinaryRelPath(relPath)
                                        ? undefined
                                        : this.mergeTextContents(existing, localContent, newContent);
                                    if (mergedContent===undefined) {
                                        await this.markSyncConflict(
                                            relPath,
                                            'Local and Overleaf copies were edited concurrently and could not be merged automatically',
                                            localContent,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'concurrent edits conflict';
                                        return;
                                    }

                                    // Re-check after the awaited local revision
                                    // capture above before pushing the merge.
                                    this.requireSyncSession(generation);
                                    try {
                                        mergedContent = await this.pushWithRetry(
                                            relPath,
                                            fromUri,
                                            mergedContent,
                                            generation,
                                            newContent,
                                        );
                                    } catch (error) {
                                        if (
                                            !(error instanceof RemoteDocumentMergeConflictError)
                                            && !(error instanceof RemoteDocumentWriteAmbiguousError)
                                        ) {
                                            throw error;
                                        }
                                        await this.markSyncConflict(
                                            relPath,
                                            error.message,
                                            localContent,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'remote changed during merged pull';
                                        return;
                                    }
                                    this.setBypassCache(relPath, mergedContent, 'push');
                                    const wroteMergedContent = await this.writeLocalFileIfRevision(
                                        relPath,
                                        mergedContent,
                                        expectedLocalWriteRevision!,
                                        generation,
                                    );
                                    if (!wroteMergedContent) {
                                        const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                        await this.markSyncConflict(
                                            relPath,
                                            'The local file changed while a merged Overleaf update was being applied',
                                            latestLocal.kind==='file' ? latestLocal.content : undefined,
                                            generation,
                                        );
                                        outcome = 'blocked';
                                        errorMessage = 'concurrent local edit during merged pull';
                                        return;
                                    }
                                    this.setBypassCache(relPath, mergedContent, 'pull');
                                    this.baseCache[relPath] = mergedContent;
                                    this.seenLocalEntities.add(relPath);
                                    this.clearRemoteDelete(relPath);
                                    this.locallyDivergedPaths.delete(relPath);
                                    await this.recordSyncManifestEntry(relPath, fromUri, mergedContent, generation);
                                    await this.persistSyncManifest(false, generation);
                                    this.requireSyncSession(generation);
                                    getOutputChannel().appendLine(
                                        `${new Date().toISOString()} [pull merged] ${relPath}: concurrent non-overlapping edits`,
                                    );
                                    return;
                                }
                            } else if (!bytesEqual(localContent, newContent)) {
                                await this.markSyncConflict(
                                    relPath,
                                    'Local and Overleaf copies differ but no common baseline is available',
                                    localContent,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'missing merge baseline';
                                return;
                            }
                        }
                        if (forcePullWrite) {
                            this.setBypassCache(relPath, newContent, 'pull');
                        } else {
                            if (options.forcePush && action==='push') {
                                getOutputChannel().appendLine(
                                    `${new Date().toISOString()} [push forced:${options.reason ?? 'manual'}] ${relPath}`,
                                );
                            }
                            if (this.bypassSync(action, type, relPath, newContent, options)) {
                                outcome = 'suppressed';
                                return;
                            }
                        }
                        if (action==='push') {
                            // Guard the remote write below: the branches above
                            // await disk and network I/O that can outlive the
                            // sync session.
                            this.requireSyncSession(generation);
                            const pendingPushRevision = contentDigest(newContent);
                            const pendingRemoteState = await this.captureRemotePathRevision(
                                relPath,
                                generation,
                            );
                            await this.journalPendingFilePushOperation(
                                relPath, 'update', pendingPushRevision, pendingRemoteState, generation,
                            );
                            // Push with bounded retry so a transient socket blip doesn't
                            // silently lose the accepted edit.
                            try {
                                const pushedContent = (
                                    remoteBaselineForPush!==undefined
                                    && await this.remoteEntityNeedsGuardedReplace(relPath, toUri)
                                )
                                    ? await this.guardedReplaceRemoteBinary(
                                        relPath,
                                        toUri,
                                        newContent,
                                        remoteBaselineForPush,
                                        generation,
                                    )
                                    : await this.pushWithRetry(
                                        relPath,
                                        toUri,
                                        newContent,
                                        generation,
                                        remoteBaselineForPush,
                                        expectedRemoteMissingForPush,
                                    );
                                if (!bytesEqual(pushedContent, newContent)) {
                                    newContent = pushedContent;
                                    writeMergedContentBackToLocal = true;
                                }
                            } catch (error) {
                                if (
                                    !(error instanceof RemoteDocumentMergeConflictError)
                                    && !(error instanceof RemoteDocumentWriteAmbiguousError)
                                ) {
                                    throw error;
                                }
                                await this.markSyncConflict(
                                    relPath,
                                    error.message,
                                    newContent,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'remote changed during rebased push';
                                return;
                            }
                            if (options.forcePush) {
                                this.setBypassCache(relPath, newContent, 'push');
                            }
                            if (writeMergedContentBackToLocal) {
                                const wroteMergedContent = await this.writeLocalFileIfRevision(
                                    relPath,
                                    newContent,
                                    expectedLocalWriteRevision!,
                                    generation,
                                );
                                if (!wroteMergedContent) {
                                    const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                    await this.markSyncConflict(
                                        relPath,
                                        'The local file changed while a merged push was being written back',
                                        latestLocal.kind==='file' ? latestLocal.content : undefined,
                                        generation,
                                    );
                                    outcome = 'blocked';
                                    errorMessage = 'concurrent local edit during merged push';
                                    return;
                                }
                                this.setBypassCache(relPath, newContent, 'pull');
                            }
                            acknowledgedPendingFilePush = {
                                kind: 'update',
                                localRevision: pendingPushRevision,
                            };
                        } else {
                            const wroteRemoteContent = await this.writeLocalFileIfRevision(
                                relPath,
                                newContent,
                                expectedLocalWriteRevision!,
                                generation,
                            );
                            if (!wroteRemoteContent) {
                                const latestLocal = await this.captureLocalPathRevision(relPath, generation);
                                await this.markSyncConflict(
                                    relPath,
                                    'The local file changed while an Overleaf update was being applied',
                                    latestLocal.kind==='file' ? latestLocal.content : undefined,
                                    generation,
                                );
                                outcome = 'blocked';
                                errorMessage = 'concurrent local edit during pull';
                                return;
                            }
                            this.setBypassCache(relPath, newContent, 'pull');
                        }
                        this.baseCache[relPath] = newContent;
                        this.seenLocalEntities.add(relPath);
                        this.clearRemoteDelete(relPath);
                        this.locallyDivergedPaths.delete(relPath);
                        if (action==='push') {
                            await this.recordPushManifestEntry(
                                relPath,
                                toUri,
                                fromUri,
                                newContent,
                                generation,
                            );
                        } else {
                            await this.recordSyncManifestEntry(
                                relPath,
                                fromUri,
                                newContent,
                                generation,
                            );
                        }
                        await this.persistSyncManifest(false, generation);
                        if (action==='push') {
                            try {
                                await vscode.workspace.fs.readFile(toUri); // update remote cache
                            } catch (cacheError) {
                                getOutputChannel().appendLine(
                                    `${new Date().toISOString()} [push cache refresh skipped] ${relPath}: ${formatUnknownError(cacheError)}`,
                                );
                            }
                            this.requireSyncSession(generation);
                        }
                    } catch (error) {
                        // A writer holding the local file is not a failure: no
                        // toast, no outcome:'error' event, no raw internal string
                        // in the compile barrier — just a deferral and one re-arm.
                        if (LocalReplicaSCMProvider.isLocalReadUnstable(error)) {
                            this.scheduleLocalPushRetry(
                                relPath,
                                action==='push' ? fromUri : toUri,
                                'unstable-read',
                                generation,
                                type,
                            );
                            // 'blocked', not 'error', so runPrecompilePush counts
                            // it as a compile blocker rather than a sync failure.
                            outcome = 'blocked';
                            errorMessage = LOCAL_SNAPSHOT_UNSTABLE;
                            return;
                        }
                        // Previously this swallowed every error silently, so an accepted
                        // change could land on disk yet never reach Overleaf. Now we
                        // log to the shared output channel and surface one toast per
                        // (file × message) per 60s so the user is never left in the dark.
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [${action} ${type}] ${relPath}: ${formatUnknownError(error)}`,
                        );
                        if (action==='push' && this.isSyncSessionActive(generation)) {
                            this.locallyDivergedPaths.add(relPath);
                            this.reportPushFailure(relPath, error);
                        }
                        console.error(error);
                        outcome = 'error';
                        errorMessage = formatUnknownError(error);
                    }
                }
                else {
                    console.error(`Unknown file type: ${stat.type}`);
                    outcome = 'error';
                    errorMessage = `unknown file type: ${stat.type}`;
                }
            }
            })();
        } catch (error) {
            // No `return` here: everything below — status restoration and the
            // single terminal scmSyncCompleteEvent this function is declared to
            // resolve with — still has to run.
            if (LocalReplicaSCMProvider.isLocalReadUnstable(error)) {
                this.scheduleLocalPushRetry(
                    relPath,
                    action==='push' ? fromUri : toUri,
                    'unstable-read',
                    generation,
                    type,
                );
                outcome = 'blocked';
                errorMessage = LOCAL_SNAPSHOT_UNSTABLE;
            } else {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [${action} ${type}] ${relPath}: ${formatUnknownError(error)}`,
                );
                if (action==='push' && this.isSyncSessionActive(generation)) {
                    this.locallyDivergedPaths.add(relPath);
                    this.reportPushFailure(relPath, error);
                }
                console.error(error);
                outcome = 'error';
                errorMessage = formatUnknownError(error);
            }
        }

        if (
            action==='push'
            && outcome==='success'
            && acknowledgedPendingFilePush!==undefined
            && this.isSyncSessionActive(generation)
        ) {
            try {
                await this.removePendingFilePushOperation(
                    relPath,
                    'Overleaf accepted the local operation',
                    generation,
                    acknowledgedPendingFilePush,
                );
            } catch (error) {
                getOutputChannel().appendLine(
                    new Date().toISOString() + ' [pending operation acknowledgement deferred] '
                    + relPath + ': ' + formatUnknownError(error),
                );
            }
        }
        if (
            new Set<string>(['success', 'suppressed']).has(outcome)
            && action==='pull'
            && authoritativePullCompleted
            && this.isSyncSessionActive(generation)
        ) {
            try {
                const pendingOperation = this.syncManifest?.pendingOperations[relPath];
                if (
                    pendingOperation
                    && (pendingOperation.kind==='update' || pendingOperation.kind==='delete')
                ) {
                    await this.acknowledgePendingFilePushOperationFromAuthoritativeState(
                        relPath,
                        pendingOperation,
                        generation,
                    );
                }
                this.requireSyncSession(generation);
                this.clearFailedInitialPullAfterAuthoritativeSync(relPath, generation);
                await this.persistSyncManifest(false, generation);
            } catch (error) {
                outcome = 'error';
                errorMessage = formatUnknownError(error);
            }
        }
        if (outcome==='success' && this.isSyncSessionActive(generation)) {
            try {
                if (
                    action==='push'
                    && resolveConflict
                    && conflictResolutionProof
                    && (
                        options.deferConflictResolution
                        || conflictResolutionProof.conflictPath!==relPath
                    )
                ) {
                    await this.refreshConflictRemoteProof(
                        conflictResolutionProof.conflictPath,
                        generation,
                    );
                }
                if (!options.deferConflictResolution) {
                    await this.clearSyncConflictAfterSuccess(relPath, generation);
                }
                await this.persistSyncManifest(false, generation);
            } catch (error) {
                outcome = 'error';
                errorMessage = formatUnknownError(error);
            }
        }
        const operationStillActive = this.isSyncSessionActive(generation);
        if (!operationStillActive) {
            outcome = 'error';
            errorMessage = 'Local Replica sync session is no longer active.';
        } else {
            if (new Set<string>(['error', 'blocked']).has(outcome)) {
                this.restoreBypassCache(relPath, bypassCacheSnapshot);
                if (action==='push') {
                    this.locallyDivergedPaths.add(relPath);
                }
            }
            this.refreshDerivedSyncStatus();
        }
        const event: Events['scmSyncCompleteEvent'] = {
            rootUri: this.baseUri,
            relPath,
            direction: action,
            type,
            outcome,
            error: errorMessage,
        };
        EventBus.fire('scmSyncCompleteEvent', event);
        return event;
    }

    // Compute the debounce delay for the next firing of a path's pending
    // event. Returns the smaller of EVENT_COALESCE_MS and the remaining
    // budget under EVENT_MAX_WAIT_MS, clamped to 0. Returning 0 means "fire
    // on the next tick" — the queueing through setTimeout(_, 0) is still
    // serialised against further inflight events for the same path because
    // the `pending` map entry is the source of truth.
    private computeDebounceDelay(firstEventAt: number): number {
        const elapsed = Date.now() - firstEventAt;
        const remainingBudget = LocalReplicaSCMProvider.eventMaxWaitMs - elapsed;
        return Math.max(0, Math.min(LocalReplicaSCMProvider.eventCoalesceMs, remainingBudget));
    }

    private syncFromVFS(vfsUri: vscode.Uri, type: 'update'|'delete') {
        if (!this.isSyncSessionActive()) { return; }
        const generation = this.syncGeneration;
        const {pathParts} = parseUri(vfsUri);
        pathParts.at(-1)==='' && pathParts.pop(); // remove the last empty string
        const relPath = this.normalizeConfinedRelPath('/' + pathParts.join('/'), 'sync from Overleaf');
        if (relPath===undefined) { return; }
        // Early ignore-pattern short-circuit. Without this, ignored paths
        // (compile artifacts under /.output/*, .aux, .log, etc.) still flow
        // through enqueueSync + applySync's stat + readFile before the
        // bypassSync check rejects them — wasting socket traffic and adding
        // retry/reconnect pressure during compile cycles.
        if (this.matchIgnorePatterns(relPath)) { return; }

        // Coalesce rapid-fire VFS events for the same path. Overleaf's VFS
        // fires Change events for every compile touch even when bytes are
        // unchanged; without debouncing we readFile the same file 3-4 times
        // per second during a compile cycle.
        const existing = this.pendingVfsEvents.get(relPath);
        if (existing) { clearTimeout(existing.timer); }
        const firstEventAt = existing?.firstEventAt ?? Date.now();
        const delay = this.computeDebounceDelay(firstEventAt);
        const timer = setTimeout(() => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const pending = this.pendingVfsEvents.get(relPath);
            if (!pending) { return; } // disposed or already drained
            this.pendingVfsEvents.delete(relPath);
            const localUri = this.localUri(relPath);
            void this.enqueueSync(
                relPath,
                async () => {
                    let currentType = pending.latestType;
                    try {
                        currentType = await this.remoteTargetEventType(pending.latestUri);
                        this.requireSyncSession(generation);
                    } catch (error) {
                        this.retainRemotePullIntentAfterClassificationFailure(
                            relPath,
                            pending.latestUri,
                            pending.latestType,
                            error,
                            generation,
                        );
                        return undefined;
                    }
                    if (currentType==='delete') {
                        const promotedRelPath = await this.promoteDeleteToMissingTrackedDirectory(
                            'pull',
                            relPath,
                            generation,
                        );
                        if (promotedRelPath!==relPath) {
                            const promotedVfsUri = this.vfs.pathToUri(promotedRelPath);
                            const promotedLocalUri = this.localUri(promotedRelPath);
                            this.deferAcceptedSync(
                                promotedRelPath,
                                async () => {
                                    const promotedType = await this.remoteTargetEventType(
                                        promotedVfsUri,
                                    );
                                    this.requireSyncSession(generation);
                                    if (promotedType!=='delete') {
                                        return this.applySync(
                                            'pull',
                                            promotedType,
                                            promotedRelPath,
                                            promotedVfsUri,
                                            promotedLocalUri,
                                            {},
                                            generation,
                                        );
                                    }
                                    return this.applySync(
                                        'pull',
                                        'delete',
                                        promotedRelPath,
                                        promotedVfsUri,
                                        promotedLocalUri,
                                        {},
                                        generation,
                                    );
                                },
                                generation,
                            );
                            return undefined;
                        }
                    }
                    return this.applySync(
                        'pull',
                        currentType,
                        relPath,
                        pending.latestUri,
                        localUri,
                        {},
                        generation,
                    );
                },
                generation,
            );
        }, delay);
        this.pendingVfsEvents.set(relPath, { timer, firstEventAt, latestType: type, latestUri: vfsUri });
    }

    private async remoteTargetEventType(
        vfsUri: vscode.Uri,
    ): Promise<'update' | 'delete'> {
        try {
            await vscode.workspace.fs.stat(vfsUri);
            return 'update';
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return 'delete';
            }
            throw error;
        }
    }

    private releasePendingLocalMoveDelete(sourceRelPath: string): void {
        const pending = this.pendingLocalMoveDeletes.get(sourceRelPath);
        if (!pending) { return; }
        clearTimeout(pending.timer);
        this.pendingLocalMoveDeletes.delete(sourceRelPath);
        pending.resolve();
    }

    // The same short candidate window used for regular files may collect an
    // unlink/create pair for a directory. The directory's recorded inode and
    // full recursive revision—not the delay—later prove that it is a move.
    private holdLocalDirectoryMoveDelete(
        sourceRelPath: string,
        generation: number,
    ): boolean {
        const sourceEntry = this.syncManifest?.directories[sourceRelPath];
        const pendingOperation = this.syncManifest?.pendingOperations[sourceRelPath];
        if (pendingOperation?.kind==='directory-move') {
            this.locallyDivergedPaths.add(sourceRelPath);
            return true;
        }
        // Removal intentionally stops accepting new watcher pairs, so a held
        // delete must drain now instead of waiting for a destination that can
        // no longer arrive.
        if (this.removalPendingGeneration===generation) { return false; }
        if (
            !sourceEntry?.remoteEntity
            || !sourceEntry.parentEntity
            || !sourceEntry.localIdentity
            || this.manifestDirectoryRevision(sourceRelPath)===undefined
            || pendingOperation!==undefined
            || this.pendingOperationAtOrBelow(sourceRelPath)!==undefined
            || this.touchesSyncConflict(sourceRelPath)
        ) {
            return false;
        }
        if (this.pendingLocalMoveDeletes.has(sourceRelPath)) {
            return true;
        }
        let resolve!: () => void;
        const completion = new Promise<void>(done => { resolve = done; });
        let pending!: PendingLocalMoveDelete;
        const timer = setTimeout(() => {
            if (this.pendingLocalMoveDeletes.get(sourceRelPath)!==pending) {
                resolve();
                return;
            }
            this.pendingLocalMoveDeletes.delete(sourceRelPath);
            if (!this.isSyncSessionActive(generation)) {
                resolve();
                return;
            }
            void this.enqueueLocalPendingEvent(
                sourceRelPath,
                {latestType: 'delete', latestUri: this.localUri(sourceRelPath)},
                generation,
                false,
                true,
            ).finally(resolve);
        }, LocalReplicaSCMProvider.localMoveCandidateWindowMs);
        pending = {timer, resolve};
        this.pendingLocalMoveDeletes.set(sourceRelPath, pending);
        let tracked!: Promise<void>;
        tracked = completion.finally(() => {
            this.preQueueSyncWork.delete(tracked);
        });
        this.preQueueSyncWork.add(tracked);
        this.locallyDivergedPaths.add(sourceRelPath);
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [local folder move candidate held] ' + sourceRelPath,
        );
        return true;
    }


    // Hold only a verified tracked-file deletion long enough for a matching
    // watcher update to arrive. The timer is never rename evidence; expiry
    // simply resumes the existing guarded delete path.
    private holdLocalFileMoveDelete(
        sourceRelPath: string,
        generation: number,
    ): boolean {
        const sourceEntry = this.syncManifest?.files[sourceRelPath];
        const pendingOperation = this.syncManifest?.pendingOperations[sourceRelPath];
        if (pendingOperation?.kind==='move') {
            this.locallyDivergedPaths.add(sourceRelPath);
            return true;
        }
        // Removal intentionally stops accepting new watcher pairs, so a held
        // delete must drain now instead of waiting for a destination that can
        // no longer arrive.
        if (this.removalPendingGeneration===generation) { return false; }
        if (
            !sourceEntry?.remoteEntity
            || !sourceEntry.localIdentity
            || pendingOperation!==undefined
            || this.touchesSyncConflict(sourceRelPath)
        ) {
            return false;
        }
        if (this.pendingLocalMoveDeletes.has(sourceRelPath)) {
            return true;
        }
        let resolve!: () => void;
        const completion = new Promise<void>(done => { resolve = done; });
        let pending!: PendingLocalMoveDelete;
        const timer = setTimeout(() => {
            if (this.pendingLocalMoveDeletes.get(sourceRelPath)!==pending) {
                resolve();
                return;
            }
            this.pendingLocalMoveDeletes.delete(sourceRelPath);
            if (!this.isSyncSessionActive(generation)) {
                resolve();
                return;
            }
            void this.enqueueLocalPendingEvent(
                sourceRelPath,
                {latestType: 'delete', latestUri: this.localUri(sourceRelPath)},
                generation,
                false,
                true,
            ).finally(resolve);
        }, LocalReplicaSCMProvider.localMoveCandidateWindowMs);
        pending = {timer, resolve};
        this.pendingLocalMoveDeletes.set(sourceRelPath, pending);
        let tracked!: Promise<void>;
        tracked = completion.finally(() => {
            this.preQueueSyncWork.delete(tracked);
        });
        this.preQueueSyncWork.add(tracked);
        this.locallyDivergedPaths.add(sourceRelPath);
        getOutputChannel().appendLine(
            new Date().toISOString() + ' [local move candidate held] ' + sourceRelPath,
        );
        return true;
    }

    private async readStableLocalMoveDestination(
        destinationRelPath: string,
        destinationUri: vscode.Uri,
        generation: number,
    ): Promise<{content: Uint8Array; identity: SyncManifestLocalFileIdentity} | undefined> {
        const snapshot = await this.readStableConfinedLocalFile(
            destinationRelPath,
            destinationUri,
            generation,
        );
        this.requireSyncSession(generation);
        const identity = await this.captureManifestLocalFileIdentity(
            destinationRelPath,
            destinationUri,
            snapshot.stat,
        );
        this.requireSyncSession(generation);
        return identity===undefined ? undefined : {content: snapshot.content, identity};
    }

    private async findLocalDirectoryMoveSourceForDestination(
        destinationRelPath: string,
        destinationRevision: string,
        destinationIdentity: SyncManifestLocalFileIdentity,
        generation: number,
    ): Promise<{
        relPath: string;
        entry: SyncManifestDirectoryEntry;
        destinationParentEntity: SyncManifestRemoteFolderIdentity;
    } | undefined> {
        const manifest = this.syncManifest;
        const destinationParentRelPath = nodePath.posix.dirname(destinationRelPath);
        const destinationParentEntity = this.recordedRemoteFolderIdentityForPath(
            destinationParentRelPath,
        );
        if (
            !manifest
            || !destinationParentEntity
            || manifest.pendingOperations[destinationRelPath]!==undefined
            || this.touchesSyncConflict(destinationRelPath)
            || Object.keys(manifest.files).some(path =>
                this.isPathAtOrBelow(path, destinationRelPath),
            )
            || Object.keys(manifest.directories).some(path =>
                this.isPathAtOrBelow(path, destinationRelPath),
            )
        ) {
            return undefined;
        }
        const candidates: Array<{
            relPath: string;
            entry: SyncManifestDirectoryEntry;
            destinationParentEntity: SyncManifestRemoteFolderIdentity;
        }> = [];
        for (const [sourceRelPath, sourceEntry] of Object.entries(manifest.directories)) {
            if (
                sourceRelPath===destinationRelPath
                || this.isPathAtOrBelow(destinationRelPath, sourceRelPath)
                || this.isPathAtOrBelow(sourceRelPath, destinationRelPath)
                || !sourceEntry.remoteEntity
                || !sourceEntry.parentEntity
                || !sourceEntry.localIdentity
                || !this.localMoveIdentityMatches(sourceEntry.localIdentity, destinationIdentity)
                || this.touchesSyncConflict(sourceRelPath)
            ) {
                continue;
            }
            const sourceRevision = this.manifestDirectoryRevision(sourceRelPath);
            if (sourceRevision===undefined || sourceRevision!==destinationRevision) {
                continue;
            }
            const sourceLocalState = await this.captureLocalPathRevision(
                sourceRelPath,
                generation,
            );
            this.requireSyncSession(generation);
            if (sourceLocalState.kind!=='missing') { continue; }
            candidates.push({
                relPath: sourceRelPath,
                entry: sourceEntry,
                destinationParentEntity,
            });
            if (candidates.length>1) {
                // Inode reuse or a corrupted baseline is ambiguous ownership.
                // Keep the existing guarded delete/create reconciliation.
                return undefined;
            }
        }
        return candidates[0];
    }

    private async tryApplyLocalDirectoryMove(
        destinationRelPath: string,
        destinationUri: vscode.Uri,
        generation: number,
    ): Promise<boolean> {
        if (this.hasAncestorSyncQueue(destinationRelPath)) { return false; }
        let destinationState: PathRevision;
        let destinationIdentity: SyncManifestLocalFileIdentity | undefined;
        try {
            destinationState = await this.captureLocalPathRevision(
                destinationRelPath,
                generation,
            );
            if (destinationState.kind!=='directory') { return false; }
            destinationIdentity = await this.captureManifestLocalDirectoryIdentity(
                destinationRelPath,
                destinationUri,
            );
            this.requireSyncSession(generation);
        } catch (error) {
            if (LocalReplicaSCMProvider.isLocalReadUnstable(error)) {
                this.scheduleLocalPushRetry(
                    destinationRelPath,
                    destinationUri,
                    'unstable-read',
                    generation,
                );
                return true;
            }
            throw error;
        }
        if (!destinationIdentity) { return false; }
        const source = await this.findLocalDirectoryMoveSourceForDestination(
            destinationRelPath,
            destinationState.revision,
            destinationIdentity,
            generation,
        );
        if (!source) { return false; }
        const pendingDescendant = this.pendingOperationIntersectingPaths(
            source.relPath,
            destinationRelPath,
        );
        if (pendingDescendant!==undefined) {
            await this.markSyncConflict(
                destinationRelPath,
                'A local folder move cannot begin while a descendant operation is unresolved: ' +
                    pendingDescendant,
                undefined,
                generation,
            );
            return true;
        }
        const record = await this.journalPendingLocalDirectoryMove(
            source.relPath,
            destinationRelPath,
            source.entry,
            destinationState.revision,
            source.destinationParentEntity,
            generation,
        );
        this.releasePendingLocalMoveDelete(source.relPath);
        await this.executePendingLocalDirectoryMove(
            source.relPath,
            record,
            generation,
        );
        return true;
    }


    private async findLocalMoveSourceForDestination(
        destinationRelPath: string,
        destinationContent: Uint8Array,
        destinationIdentity: SyncManifestLocalFileIdentity,
        generation: number,
    ): Promise<{relPath: string; entry: SyncManifestEntry} | undefined> {
        if (
            !this.syncManifest
            || this.syncManifest.pendingOperations[destinationRelPath]!==undefined
            || this.touchesSyncConflict(destinationRelPath)
        ) {
            return undefined;
        }
        const destinationDigest = contentDigest(destinationContent);
        const candidates: Array<{relPath: string; entry: SyncManifestEntry}> = [];
        for (const [sourceRelPath, sourceEntry] of Object.entries(this.syncManifest.files)) {
            if (
                sourceRelPath===destinationRelPath
                || sourceEntry.localDigest!==destinationDigest
                || !sourceEntry.remoteEntity
                || !sourceEntry.localIdentity
                || !this.localMoveIdentityMatches(sourceEntry.localIdentity, destinationIdentity)
                || this.syncManifest.pendingOperations[sourceRelPath]!==undefined
                || this.touchesSyncConflict(sourceRelPath)
            ) {
                continue;
            }
            const sourceLocalState = await this.captureLocalPathRevision(
                sourceRelPath,
                generation,
            );
            this.requireSyncSession(generation);
            if (sourceLocalState.kind!=='missing') { continue; }
            candidates.push({relPath: sourceRelPath, entry: sourceEntry});
            if (candidates.length>1) {
                // A hardlink or an inode-reuse edge has ambiguous source
                // ownership. Preserve normal delete/create semantics instead.
                return undefined;
            }
        }
        return candidates[0];
    }

    // A local mv is already a durable local fact. If Overleaf cannot be read
    // at that instant, retain that intent with the last known manifest digest
    // and defer the remote proof to the guarded replay. We never infer that
    // the source is current: replay re-reads the source entity/revision and
    // turns a collaborator change into a conflict instead of moving it.
    private async captureMoveSourceRemoteStateOrDefer(
        sourceRelPath: string,
        sourceEntry: SyncManifestEntry,
        generation: number,
    ): Promise<PathRevision> {
        try {
            return await this.captureRemotePathRevision(sourceRelPath, generation);
        } catch (error) {
            this.requireSyncSession(generation);
            getOutputChannel().appendLine(
                new Date().toISOString() + ' [pending move remote proof deferred] ' +
                sourceRelPath + ': ' + formatUnknownError(error),
            );
            return {
                kind: 'file',
                revision: sourceEntry.localDigest,
            };
        }
    }

    // A directory watcher event is handled by the existing recursive
    // reconciliation path. Never try to open it as a candidate file move.
    // Re-checking after an unexpected read error also covers an atomic
    // replacement that changed a former file into a directory.
    private async isRegularLocalFileMoveDestination(
        destinationRelPath: string,
        destinationUri: vscode.Uri,
        generation: number,
    ): Promise<boolean> {
        try {
            const stat = await this.statConfinedLocalUri(
                destinationUri,
                `local move destination inspection of ${destinationRelPath}`,
            );
            this.requireSyncSession(generation);
            return LocalReplicaSCMProvider.isSyncStatType(
                stat,
                vscode.FileType.File,
                false,
            );
        } catch (error) {
            if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) { throw error; }
            this.requireSyncSession(generation);
            return false;
        }
    }

    // A folder reconciliation owns all of its descendants through the parent
    // queue. A file move nested below it would be a concurrent tree mutation,
    // so retain the safe existing delete/create reconciliation for that case.
    // The queue relationship is only a serialization guard; it is never used
    // as evidence that a watcher pair is a move.
    private hasAncestorSyncQueue(relPath: string): boolean {
        return [...this.syncQueues.keys()].some(queuedRelPath =>
            queuedRelPath!==relPath
            && this.isPathAtOrBelow(relPath, queuedRelPath),
        );
    }

    private async tryApplyLocalFileMove(
        destinationRelPath: string,
        destinationUri: vscode.Uri,
        generation: number,
    ): Promise<boolean> {
        if (this.hasAncestorSyncQueue(destinationRelPath)) { return false; }
        if (!await this.isRegularLocalFileMoveDestination(
            destinationRelPath, destinationUri, generation,
        )) { return false; }
        let destination: {content: Uint8Array; identity: SyncManifestLocalFileIdentity} | undefined;
        try {
            destination = await this.readStableLocalMoveDestination(
                destinationRelPath,
                destinationUri,
                generation,
            );
        } catch (error) {
            if (LocalReplicaSCMProvider.isLocalReadUnstable(error)) {
                this.scheduleLocalPushRetry(
                    destinationRelPath,
                    destinationUri,
                    'unstable-read',
                    generation,
                );
                return true;
            }
            if (!await this.isRegularLocalFileMoveDestination(
                destinationRelPath, destinationUri, generation,
            )) { return false; }
            throw error;
        }
        if (!destination) { return false; }
        const source = await this.findLocalMoveSourceForDestination(
            destinationRelPath,
            destination.content,
            destination.identity,
            generation,
        );
        if (!source) { return false; }
        const sourceRemoteState = await this.captureMoveSourceRemoteStateOrDefer(
            source.relPath,
            source.entry,
            generation,
        );
        this.requireSyncSession(generation);
        if (sourceRemoteState.kind!=='file') {
            await this.markSyncConflict(
                destinationRelPath,
                'The local move source no longer exists as the expected Overleaf file',
                destination.content,
                generation,
            );
            this.releasePendingLocalMoveDelete(source.relPath);
            return true;
        }
        const record = await this.journalPendingLocalFileMove(
            source.relPath,
            destinationRelPath,
            source.entry,
            sourceRemoteState,
            generation,
        );
        this.releasePendingLocalMoveDelete(source.relPath);
        await this.executePendingLocalFileMove(
            source.relPath,
            record,
            destination.content,
            generation,
        );
        return true;
    }

    private async reconcilePendingLocalFileMove(
        sourceRelPath: string,
        record: SyncManifestPendingMoveOperation,
        generation: number,
    ): Promise<boolean> {
        if (
            this.touchesSyncConflict(sourceRelPath)
            || this.touchesSyncConflict(record.destinationRelPath)
        ) {
            return false;
        }
        const sourceLocalState = await this.captureLocalPathRevision(sourceRelPath, generation);
        if (sourceLocalState.kind!=='missing') {
            await this.markSyncConflict(
                sourceRelPath,
                'A pending local move cannot replay because its source was recreated locally',
                sourceLocalState.kind==='file' ? sourceLocalState.content : undefined,
                generation,
            );
            return false;
        }
        const destination = await this.readStableLocalMoveDestination(
            record.destinationRelPath,
            this.localUri(record.destinationRelPath),
            generation,
        );
        if (
            !destination
            || contentDigest(destination.content)!==record.localRevision
            || !this.localMoveIdentityMatches(destination.identity, record.sourceLocalIdentity)
        ) {
            await this.markSyncConflict(
                record.destinationRelPath,
                'A pending local move cannot replay because its destination changed locally',
                destination?.content ?? null,
                generation,
            );
            return false;
        }
        const outcome = await this.executePendingLocalFileMove(
            sourceRelPath,
            record,
            destination.content,
            generation,
        );
        return outcome==='accepted';
    }

    private enqueueLocalPendingEvent(
        relPath: string,
        pending: Pick<PendingEvent, 'latestType' | 'latestUri'>,
        generation: number,
        acceptedBeforeRemoval = false,
        skipLocalMoveHold = false,
    ): Promise<unknown> {
        const vfsUri = this.vfs.pathToUri(relPath);
        const classify = async (
            targetRelPath: string,
            targetLocalUri: vscode.Uri,
            observedType: 'update' | 'delete',
        ): Promise<'update' | 'delete' | undefined> => {
            try {
                const removalSensitive = acceptedBeforeRemoval
                    || this.removalPendingGeneration===generation;
                const currentType = removalSensitive
                    ? await this.withRetry(
                        'push',
                        targetRelPath,
                        () => this.localTargetNeedsPush(
                            targetRelPath,
                            targetLocalUri,
                            observedType,
                        ),
                        {
                            delays:
                                LocalReplicaSCMProvider.localClassificationRetryDelays,
                            generation,
                        },
                    )
                    : await this.localTargetNeedsPush(
                        targetRelPath,
                        targetLocalUri,
                        observedType,
                    );
                this.removalAcceptedSyncErrors.delete(targetRelPath);
                return currentType;
            } catch (error) {
                this.retainLocalPushIntentAfterClassificationFailure(
                    targetRelPath,
                    targetLocalUri,
                    observedType,
                    error,
                    generation,
                );
                if (
                    acceptedBeforeRemoval
                    || this.removalPendingGeneration===generation
                ) {
                    this.removalAcceptedSyncErrors.set(targetRelPath, {
                        generation,
                        error: formatUnknownError(error),
                    });
                }
                throw error;
            }
        };
        return this.enqueueSync(
            relPath,
            async () => {
                let currentType: 'update' | 'delete' | undefined;
                try {
                    currentType = await classify(
                        relPath,
                        pending.latestUri,
                        pending.latestType,
                    );
                    this.requireSyncSession(generation);
                } catch {
                    return undefined;
                }
                const pendingDirectoryMove = this.pendingDirectoryMoveCovering(relPath);
                if (pendingDirectoryMove!==undefined) {
                    this.locallyDivergedPaths.add(relPath);
                    if (this.isPathAtOrBelow(
                        relPath,
                        pendingDirectoryMove.record.destinationRelPath,
                    )) {
                        this.deferredLocalEventsDuringDirectoryMove.set(relPath, {
                            latestType: pending.latestType,
                            latestUri: pending.latestUri,
                        });
                    }
                    getOutputChannel().appendLine(
                        new Date().toISOString() + ' [local event deferred:pending-folder-move] ' +
                        relPath + ' under ' + pendingDirectoryMove.sourceRelPath +
                        ' -> ' + pendingDirectoryMove.record.destinationRelPath,
                    );
                    return undefined;
                }
                if (
                    currentType==='update'
                    && await this.tryApplyLocalDirectoryMove(
                        relPath,
                        pending.latestUri,
                        generation,
                    )
                ) {
                    return undefined;
                }
                if (
                    currentType==='update'
                    && await this.tryApplyLocalFileMove(relPath, pending.latestUri, generation)
                ) {
                    return undefined;
                }

                if (currentType==='delete') {
                    const promotedRelPath = await this.promoteDeleteToMissingTrackedDirectory(
                        'push',
                        relPath,
                        generation,
                    );
                    if (promotedRelPath!==relPath) {
                        if (!skipLocalMoveHold && this.holdLocalDirectoryMoveDelete(
                            promotedRelPath,
                            generation,
                        )) {
                            return undefined;
                        }
                        const promotedLocalUri = this.localUri(promotedRelPath);
                        const promotedVfsUri = this.vfs.pathToUri(promotedRelPath);
                        this.deferAcceptedSync(
                            promotedRelPath,
                            async () => {
                                let promotedType: 'update' | 'delete' | undefined;
                                try {
                                    promotedType = await classify(
                                        promotedRelPath,
                                        promotedLocalUri,
                                        'delete',
                                    );
                                } catch {
                                    return undefined;
                                }
                                this.requireSyncSession(generation);
                                if (promotedType===undefined) {
                                    return undefined;
                                }
                                return this.applySync(
                                    'push',
                                    promotedType,
                                    promotedRelPath,
                                    promotedLocalUri,
                                    promotedVfsUri,
                                    {},
                                    generation,
                                );
                            },
                            generation,
                        );
                        return undefined;
                    }
                    if (
                        !skipLocalMoveHold
                        && (this.holdLocalDirectoryMoveDelete(relPath, generation)
                            || this.holdLocalFileMoveDelete(relPath, generation))
                    ) {
                        return undefined;
                    }
                }
                if (currentType===undefined) {
                    // Reached by a stabilization re-arm whose file settled back
                    // to bytes we already delivered: the path is clean, so drop
                    // its deferral history along with its divergence mark.
                    this.locallyDivergedPaths.delete(relPath);
                    this.clearLocalStabilizeState(relPath);
                    return undefined;
                }
                return this.applySync(
                    'push',
                    currentType,
                    relPath,
                    pending.latestUri,
                    vfsUri,
                    {},
                    generation,
                );
            },
            generation,
            acceptedBeforeRemoval,
        );
    }

    private syncToVFS(
        localUri: vscode.Uri,
        type: 'update'|'delete',
    ): Promise<void> {
        if (!this.isSyncSessionActive()) { return Promise.resolve(); }
        const generation = this.syncGeneration;
        let tracked!: Promise<void>;
        tracked = this.syncToVFSAccepted(localUri, type, generation)
            .catch(error => {
                console.error(error);
            })
            .finally(() => {
                this.preQueueSyncWork.delete(tracked);
            });
        this.preQueueSyncWork.add(tracked);
        return tracked;
    }

    private async syncToVFSAccepted(
        localUri: vscode.Uri,
        type: 'update'|'delete',
        generation: number,
    ): Promise<void> {
        if (isLocalReplicaMetadataUri(localUri, this.baseUri)) {
            return;
        }
        if (!await this.hasLocalReplicaSettings()) {
            console.warn(`Local replica settings missing under "${this.baseUri.toString()}"; local change was not propagated.`);
            return;
        }
        if (!this.isSyncSessionActive(generation)) { return; }
        // Compute the path relative to baseUri. Trailing-slash normalisation on
        // baseUri can otherwise drop the leading slash, producing a relPath
        // shape that disagrees with the pull side and defeats the bypass cache.
        const basePath = this.baseUri.path.replace(/\/+$/, '');
        if (localUri.path===basePath || !localUri.path.startsWith(basePath + '/')) { return; }
        const relPath = this.normalizeConfinedRelPath(localUri.path.slice(basePath.length), 'sync to Overleaf');
        if (relPath===undefined) { return; }
        // Same early-ignore short-circuit as syncFromVFS — no point enqueueing
        // work that bypassSync would reject anyway.
        if (this.matchIgnorePatterns(relPath)) { return; }

        if (this.removalPendingGeneration===generation) {
            await this.enqueueLocalPendingEvent(
                relPath,
                {latestType: type, latestUri: localUri},
                generation,
                true,
            );
            return;
        }

        // Debounce local watcher events too. Editors save by write-temp+
        // rename which can fire Change+Create+Change for the same file in
        // milliseconds; coalescing means one applySync per intent.
        const existing = this.pendingLocalEvents.get(relPath);
        if (existing) { clearTimeout(existing.timer); }
        const firstEventAt = existing?.firstEventAt ?? Date.now();
        const delay = this.computeDebounceDelay(firstEventAt);
        const timer = setTimeout(() => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const pending = this.pendingLocalEvents.get(relPath);
            if (!pending) { return; }
            this.pendingLocalEvents.delete(relPath);
            void this.enqueueLocalPendingEvent(relPath, pending, generation);
        }, delay);
        this.pendingLocalEvents.set(relPath, { timer, firstEventAt, latestType: type, latestUri: localUri });
    }

    public async initializeLocalReplica(
        options?: InitializeLocalReplicaOptions,
        generation?: number,
    ): Promise<boolean> {
        const activeGeneration = generation
            ?? (this.syncSessionActive ? this.syncGeneration : await this.beginSyncSession());
        if (!this.isSyncSessionActive(activeGeneration)) { return false; }
        const preflightStartedAt = Date.now();
        const initializationOptions = {
            resetLocalFilesToRemote: false,
            ...definedInitializationOptions(this.initializationOptions),
            ...definedInitializationOptions(options),
        };
        // Remote document snapshots and local settings/manifest reads are
        // independent. Start both immediately after watcher registration so
        // network latency is hidden behind Remote SSH filesystem preflight.
        let remoteBootstrapPromise: Promise<InitialRemoteBootstrapOutcome> =
            this.prefetchInitialRemoteBootstrap('/', activeGeneration).then(
                value => ({value}),
                error => ({error}),
            );
        await this.ensureLocalReplicaSettings(activeGeneration);
        if (!this.isSyncSessionActive(activeGeneration)) { return false; }
        const settingsReadyAt = Date.now();
        await this.loadSyncManifest(activeGeneration);
        if (!this.isSyncSessionActive(activeGeneration)) { return false; }
        const manifestReadyAt = Date.now();
        this.initialPullStatus = 'pending';
        // Per-file failures accumulate in failedInitialPulls; reset before each
        // attempt so a fresh init starts from a clean slate.
        this.failedInitialPulls.clear();
        this.pendingInitialDocumentSubscriptions.clear();
        try {
            await this.recoverInterruptedLocalOperations(activeGeneration);
            if (!this.isSyncSessionActive(activeGeneration)) { return false; }
            const recoveredRemoteOperation = await this.recoverInterruptedRemoteDeletes(
                activeGeneration,
            );
            if (recoveredRemoteOperation) {
                // The speculative tree/snapshot may describe the staged state
                // from before crash recovery. Discard it and bootstrap again
                // from the now-authoritative remote tree.
                remoteBootstrapPromise = this.prefetchInitialRemoteBootstrap(
                    '/',
                    activeGeneration,
                ).then(
                    value => ({value}),
                    error => ({error}),
                );
            }
            await this.hydrateMissingConflictRemoteProofs(activeGeneration);
            const recoveryReadyAt = Date.now();
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [initial pull preflight complete] ` +
                `elapsed=${recoveryReadyAt-preflightStartedAt}ms ` +
                `settings=${settingsReadyAt-preflightStartedAt}ms ` +
                `manifest=${manifestReadyAt-settingsReadyAt}ms ` +
                `recovery=${recoveryReadyAt-manifestReadyAt}ms`,
            );
            const completed = await this.overwrite(
                '/',
                initializationOptions,
                activeGeneration,
                remoteBootstrapPromise,
            );
            if (completed!==true || !this.isSyncSessionActive(activeGeneration)) { return false; }
            await this.reconcilePendingFilePushOperations(activeGeneration);
            if (!this.isSyncSessionActive(activeGeneration)) { return false; }
        } catch (error) {
            if (!this.isSyncSessionActive(activeGeneration)) { return false; }
            this.initialPullStatus = 'partial';
            this.status = {
                status: 'need-attention',
                message: vscode.l10n.t('initial pull failed'),
            };
            const message = formatUnknownError(error);
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [initial pull failed] ${message}`,
            );
            vscode.window.showWarningMessage(
                vscode.l10n.t(
                    'Local Replica is attached, but the initial remote pull failed: {message}',
                    {message},
                ),
                vscode.l10n.t('Show Output'),
            ).then((choice) => {
                if (choice==='Show Output') { getOutputChannel().show(true); }
            });
            await this.persistSyncManifest(false, activeGeneration);
            return false;
        }
        if (!this.isSyncSessionActive(activeGeneration)) { return false; }
        if (this.failedInitialPulls.size>0) {
            this.initialPullStatus = 'partial';
            this.syncManifestBaselineMode = 'unavailable';
            if (this.syncManifest?.baselineComplete) {
                this.syncManifest.baselineComplete = false;
                this.markSyncManifestDirty();
            }
            this.status = {
                status: 'need-attention',
                message: vscode.l10n.t('{count} files failed to download', {count: this.failedInitialPulls.size}),
            };
            this.surfacePartialPullToast(activeGeneration);
        } else {
            this.initialPullStatus = 'complete';
            this.partialPullToastGeneration = undefined;
        }
        this.completeTrustedBaselineIfResolved();
        await this.persistSyncManifest(false, activeGeneration);
        if (this.isSyncSessionActive(activeGeneration)) {
            await this.refreshCleanOpenReplicaDocumentsFromDisk(activeGeneration);
            this.refreshDerivedSyncStatus();
        }
        return this.isSyncSessionActive(activeGeneration);
    }

    private async verifyInitialDocumentSubscriptions(
        generation = this.syncGeneration,
    ): Promise<void> {
        const total = this.pendingInitialDocumentSubscriptions.size;
        if (total===0) { return; }
        const startedAt = Date.now();
        let lastDeferredLogAt = 0;
        while (
            this.isSyncSessionActive(generation)
            && this.pendingInitialDocumentSubscriptions.size>0
        ) {
            let progressed = false;
            let latestError: unknown;
            const targets = [...this.pendingInitialDocumentSubscriptions];
            for (const relPath of targets) {
                if (!this.isSyncSessionActive(generation)) { return; }
                const vfsUri = this.vfs.pathToUri(relPath);
                const localUri = this.localUri(relPath);
                try {
                    const event = await this.enqueueSync(
                        relPath,
                        async () => {
                            const type = await this.remoteTargetEventType(vfsUri);
                            this.requireSyncSession(generation);
                            if (type==='update') {
                                // The HTTP snapshot made the local tree ready,
                                // but only joinDoc subscribes this socket to OT
                                // updates. VFS serializes the call and caches the
                                // authoritative result; applySync then performs
                                // the ordinary guarded merge from that cache.
                                await this.pullRemoteFile(relPath, vfsUri, generation);
                                this.requireSyncSession(generation);
                            }
                            return this.applySync(
                                'pull',
                                type,
                                relPath,
                                vfsUri,
                                localUri,
                                {},
                                generation,
                            );
                        },
                        generation,
                    );
                    this.requireSyncSession(generation);
                    if (
                        event
                        && (event.outcome==='success' || event.outcome==='suppressed')
                    ) {
                        this.pendingInitialDocumentSubscriptions.delete(relPath);
                        progressed = true;
                    }
                } catch (error) {
                    latestError = error;
                }
            }
            if (this.pendingInitialDocumentSubscriptions.size===0) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [initial document subscriptions live] ` +
                    `files=${total} elapsed=${Date.now()-startedAt}ms`,
                );
                return;
            }
            const now = Date.now();
            if (lastDeferredLogAt===0 || now-lastDeferredLogAt>=30_000) {
                lastDeferredLogAt = now;
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [initial document subscriptions deferred] ` +
                    `pending=${this.pendingInitialDocumentSubscriptions.size}` +
                    (latestError===undefined ? '' : `: ${formatUnknownError(latestError)}`),
                );
            }
            await this.sleepForStabilization(progressed ? 100 : 1_000);
        }
    }

    private surfacePartialPullToast(generation = this.syncGeneration) {
        if (
            !this.isSyncSessionActive(generation)
            || this.partialPullToastGeneration===generation
        ) {
            return;
        }
        this.partialPullToastGeneration = generation;
        const count = this.failedInitialPulls.size;
        const retry = vscode.l10n.t('Retry Pull');
        const ignore = vscode.l10n.t('Ignore These Files');
        const showOutput = vscode.l10n.t('Show Output');
        vscode.window.showWarningMessage(
            vscode.l10n.t(
                '{count} files failed to download from Overleaf. Edits to those specific files will not push to remote until you Retry Pull or Ignore them; the rest of the project syncs normally.',
                {count},
            ),
            retry, ignore, showOutput,
        ).then(async (choice) => {
            if (
                !this.isSyncSessionActive(generation)
                || this.partialPullToastGeneration!==generation
            ) {
                return;
            }
            if (choice===retry) {
                this.partialPullToastGeneration = undefined;
                await this.retryFailedInitialPulls();
            } else if (choice===ignore) {
                void this.ignoreFailedInitialPulls(generation);
            } else if (choice===showOutput) {
                this.partialPullToastGeneration = undefined;
                getOutputChannel().show(true);
            } else {
                this.partialPullToastGeneration = undefined;
            }
        });
    }

    public async retryFailedInitialPulls(): Promise<{recovered: string[]; stillFailed: string[]}> {
        const generation = this.syncGeneration;
        if (!this.isSyncSessionActive(generation)) {
            return {recovered: [], stillFailed: [...this.failedInitialPulls]};
        }
        const recovered: string[] = [];
        const stillFailed: string[] = [];
        const targets = [...this.failedInitialPulls];
        for (const relPath of targets) {
            if (!this.isSyncSessionActive(generation)) {
                stillFailed.push(...targets.slice(targets.indexOf(relPath)));
                break;
            }
            const vfsUri = this.vfs.pathToUri(relPath);
            try {
                let type: 'update' | 'delete' = 'update';
                try {
                    await vscode.workspace.fs.stat(vfsUri);
                } catch (error) {
                    if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                        throw error;
                    }
                    type = 'delete';
                }
                this.requireSyncSession(generation);
                const event = await this.enqueueSync(
                    relPath,
                    () => this.applySync(
                        'pull',
                        type,
                        relPath,
                        vfsUri,
                        this.localUri(relPath),
                        {},
                        generation,
                    ),
                    generation,
                );
                this.requireSyncSession(generation);
                if (
                    event
                    && (event.outcome==='success' || event.outcome==='suppressed')
                    && !this.failedInitialPulls.has(relPath)
                ) {
                    recovered.push(relPath);
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [pull recovered] ${relPath} via retryFailedInitialPulls`,
                    );
                } else {
                    stillFailed.push(relPath);
                }
            } catch (error) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [pull retry failed] ${relPath}: ${formatUnknownError(error)}`,
                );
                stillFailed.push(relPath);
            }
        }
        if (!this.isSyncSessionActive(generation)) {
            return {recovered, stillFailed};
        }
        if (this.failedInitialPulls.size===0) {
            this.initialPullStatus = 'complete';
            this.status = {status: 'idle', message: ''};
            this.partialPullToastGeneration = undefined;
            // Initial pull is now complete — arm the local watcher if it was
            // deferred. This is the unique recovery edge that flips us from
            // 'partial' to 'complete' at runtime.
            this.armLocalWatcher?.();
        } else {
            this.status = {
                status: 'need-attention',
                message: vscode.l10n.t('{count} files failed to download', {count: this.failedInitialPulls.size}),
            };
        }
        await this.persistSyncManifest(false, generation);
        this.requireSyncSession(generation);
        return {recovered, stillFailed};
    }

    public async ignoreFailedInitialPulls(
        generation = this.syncGeneration,
    ): Promise<void> {
        if (!this.isSyncSessionActive(generation) || this.failedInitialPulls.size===0) { return; }
        const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || [...this.ignorePatterns]).slice();
        for (const relPath of this.failedInitialPulls) {
            // Exact path patterns; minimatch with dot:true treats these as literal.
            if (!ignorePatterns.includes(relPath)) { ignorePatterns.push(relPath); }
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [failed pull ignored] ${relPath}`,
            );
        }
        this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
        this.failedInitialPulls.clear();
        this.initialPullStatus = 'complete';
        this.status = {status: 'idle', message: ''};
        this.partialPullToastGeneration = undefined;
        this.completeTrustedBaselineIfResolved();
        await this.persistSyncManifest(false, generation);
        // User opted in: the failed paths are now ignored, so it is safe to
        // arm the local watcher for the rest of the project.
        this.armLocalWatcher?.();
    }

    private async replayBufferedVfsEvents(
        events: Iterable<{uri: vscode.Uri; type: 'update' | 'delete'}>,
        generation: number,
    ): Promise<number> {
        const targets: Array<{
            relPath: string;
            uri: vscode.Uri;
            type: 'update' | 'delete';
        }> = [];
        for (const event of events) {
            const {pathParts} = parseUri(event.uri);
            if (pathParts.at(-1)==='') { pathParts.pop(); }
            const relPath = this.normalizeConfinedRelPath(
                '/' + pathParts.join('/'),
                'replay buffered Overleaf watcher event',
            );
            if (relPath===undefined || this.matchIgnorePatterns(relPath)) { continue; }
            let type: 'update' | 'delete' = event.type;
            try {
                await vscode.workspace.fs.stat(event.uri);
                type = 'update';
            } catch (error) {
                if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                    throw error;
                }
                type = 'delete';
            }
            this.requireSyncSession(generation);
            targets.push({relPath, uri: event.uri, type});
        }
        targets.sort((left, right) => {
            if (left.type!==right.type) {
                return left.type==='update' ? -1 : 1;
            }
            const depthDelta = left.relPath.split('/').length-right.relPath.split('/').length;
            return left.type==='update' ? depthDelta : -depthDelta;
        });
        for (const target of targets) {
            await this.enqueueSync(
                target.relPath,
                () => this.applySync(
                    'pull',
                    target.type,
                    target.relPath,
                    target.uri,
                    this.localUri(target.relPath),
                    {},
                    generation,
                ),
                generation,
            );
            this.requireSyncSession(generation);
        }
        return targets.length;
    }

    private recordUnscannableLocalPath(relPath: string, error: unknown): void {
        const firstFailedAt = this.unscannableLocalPaths.get(relPath) ?? Date.now();
        this.unscannableLocalPaths.set(relPath, firstFailedAt);
        this.locallyDivergedPaths.add(relPath);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [local scan skipped] ${relPath}: ` +
            formatUnknownError(error),
        );
        if (
            Date.now()-firstFailedAt
            >=LocalReplicaSCMProvider.unscannablePathWarnMs
        ) {
            // The degraded-watcher warning promised a periodic content scan
            // covers closed-file changes. It does not cover this path, and the
            // user must not be left believing otherwise.
            maybeWarnSyncFailure(relPath, new Error(
                'the periodic local content scan cannot read this path, so its ' +
                `changes are not reaching Overleaf: ${formatUnknownError(error)}`,
            ));
        }
    }

    private async replayBufferedLocalEvents(
        events: Iterable<{uri: vscode.Uri; type: 'update' | 'delete'}>,
        generation: number,
    ): Promise<number> {
        const targets: Array<{
            relPath: string;
            uri: vscode.Uri;
            type: 'update' | 'delete';
        }> = [];
        for (const event of events) {
            const relPath = this.relPathFromLocalFileUri(
                event.uri,
                'replay buffered local watcher event',
            );
            if (relPath===undefined || this.matchIgnorePatterns(relPath)) { continue; }
            let type: 'update' | 'delete' | undefined;
            try {
                type = await this.localTargetNeedsPush(relPath, event.uri, event.type);
            } catch (error) {
                // While the watcher is degraded this loop is the only thing
                // syncing local edits at all, so one path that refuses to be
                // classified must be skipped, not allowed to abort the scan.
                this.requireSyncSession(generation);
                this.recordUnscannableLocalPath(relPath, error);
                continue;
            }
            this.requireSyncSession(generation);
            this.unscannableLocalPaths.delete(relPath);
            if (type!==undefined) {
                targets.push({relPath, uri: event.uri, type});
            }
        }
        targets.sort((left, right) => {
            if (left.type!==right.type) {
                return left.type==='update' ? -1 : 1;
            }
            const depthDelta = left.relPath.split('/').length-right.relPath.split('/').length;
            return left.type==='update' ? depthDelta : -depthDelta;
        });
        for (const target of targets) {
            await this.enqueueSync(
                target.relPath,
                () => this.applySync(
                    'push',
                    target.type,
                    target.relPath,
                    target.uri,
                    this.vfs.pathToUri(target.relPath),
                    {},
                    generation,
                ),
                generation,
            );
            this.requireSyncSession(generation);
        }
        return targets.length;
    }

    private startBufferedStartupReplay(
        remoteEvents: ReadonlyArray<{uri: vscode.Uri; type: 'update' | 'delete'}>,
        localEvents: ReadonlyArray<{uri: vscode.Uri; type: 'update' | 'delete'}>,
        generation: number,
    ): boolean {
        if (remoteEvents.length===0 && localEvents.length===0) {
            return false;
        }

        this.startupReplayGeneration = generation;
        this.startupReplayFailure = undefined;
        let work!: Promise<void>;
        work = (async () => {
            const replayedRemote = await this.replayBufferedVfsEvents(remoteEvents, generation);
            const replayedLocal = await this.replayBufferedLocalEvents(localEvents, generation);
            // Pull replay can update clean restored editor models. Dirty
            // buffers remain authoritative and are deliberately untouched.
            await this.refreshCleanOpenReplicaDocumentsFromDisk(generation);
            this.requireSyncSession(generation);
            if (this.startupReplayGeneration!==generation) { return; }
            this.startupReplayGeneration = undefined;
            this.startupReplayFailure = undefined;
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [startup buffered sync complete] ` +
                `replayedRemote=${replayedRemote} replayedLocal=${replayedLocal}`,
            );
            // Subscribe only after buffered events have established their
            // guarded merge order. The subscription set independently keeps
            // compilation fail-closed until every text document is verified.
            void this.verifyInitialDocumentSubscriptions(generation).catch(error => {
                if (!this.isSyncSessionActive(generation)) { return; }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [initial document subscription failed] ` +
                    `${formatUnknownError(error)}`,
                );
            });
        })().catch(error => {
            if (!this.isSyncSessionActive(generation)) { return; }
            const message = formatUnknownError(error);
            if (this.startupReplayGeneration===generation) {
                this.startupReplayGeneration = undefined;
            }
            this.startupReplayFailure = {generation, message};
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [startup buffered sync failed] ${message}`,
            );
            maybeWarnSyncFailure('/', new Error(
                `startup watcher changes could not be reconciled: ${message}`,
            ));
        }).finally(() => {
            this.deferredSyncWork.delete(work);
            if (this.startupReplayPromise===work) {
                this.startupReplayPromise = undefined;
            }
        });
        this.startupReplayPromise = work;
        this.deferredSyncWork.add(work);
        return true;
    }

    private observeLocalWatcherProbe(uri: vscode.Uri): boolean {
        const probe = this.localWatcherProbe;
        if (!probe || probe.uri!==uri.toString()) {
            return false;
        }
        probe.resolve();
        return true;
    }

    private directLocalWatcherUri(filename: string | Buffer | null): vscode.Uri | undefined {
        if (filename===null) { return undefined; }
        const relativeName = Buffer.isBuffer(filename) ? filename.toString('utf8') : filename;
        if (!relativeName || relativeName.includes('\0')) { return undefined; }

        try {
            const rootPath = nodePath.resolve(this.baseUri.fsPath);
            const targetPath = nodePath.resolve(rootPath, relativeName);
            const relativePath = nodePath.relative(rootPath, targetPath);
            if (
                relativePath===''
                || relativePath==='..'
                || relativePath.startsWith(`..${nodePath.sep}`)
                || nodePath.isAbsolute(relativePath)
            ) {
                return undefined;
            }
            return vscode.Uri.file(targetPath);
        } catch {
            return undefined;
        }
    }

    private startDirectLocalWatcher(
        generation: number,
        onEvent: (uri: vscode.Uri) => void,
    ): void {
        if (
            !this.isSyncSessionActive(generation)
            || this.baseUri.scheme!=='file'
            || !LocalReplicaSCMProvider.shouldUseDirectLocalWatcher()
            || this.directLocalWatcherGeneration===generation
        ) {
            return;
        }

        let watcher: DirectLocalWatcher;
        try {
            watcher = LocalReplicaSCMProvider.createDirectLocalWatcher(
                this.baseUri.fsPath,
                (_eventType, filename) => {
                    if (
                        !this.isSyncSessionActive(generation)
                        || this.directLocalWatcher!==watcher
                    ) {
                        return;
                    }
                    const uri = this.directLocalWatcherUri(filename);
                    if (uri) {
                        onEvent(uri);
                    }
                },
            );
        } catch (error) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [direct local watcher unavailable] ` +
                `${this.baseUri.toString()}: ${formatUnknownError(error)}`,
            );
            return;
        }

        this.directLocalWatcher = watcher;
        this.directLocalWatcherGeneration = generation;
        watcher.on('error', error => {
            if (
                !this.isSyncSessionActive(generation)
                || this.directLocalWatcher!==watcher
            ) {
                return;
            }
            try {
                watcher.close();
            } catch {
                // The error may have closed the watcher already.
            }
            this.directLocalWatcher = undefined;
            this.directLocalWatcherGeneration = undefined;
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [direct local watcher failed] ` +
                `${this.baseUri.toString()}: ${formatUnknownError(error)}`,
            );
            this.markLocalWatcherDegraded(generation);
        });
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [direct local watcher active] ${this.baseUri.toString()}`,
        );
    }

    private async scanLocalChangesWithoutWatcher(generation: number): Promise<number> {
        this.requireSyncSession(generation);
        const snapshot = await this.collectLocalReplicaSnapshot(
            this.baseUri,
            '/',
            {files: new Set(), directories: new Set()},
            generation,
        );
        this.requireSyncSession(generation);

        const candidates = new Map<string, {uri: vscode.Uri; type: 'update' | 'delete'}>();
        for (const relPath of [...snapshot.directories, ...snapshot.files]) {
            // Present again: whatever absence we had recorded is void.
            this.scannerAbsentPaths.delete(relPath);
            candidates.set(relPath, {
                uri: this.localUri(relPath),
                type: 'update',
            });
        }
        const trackedPaths = new Set([
            ...Object.keys(this.baseCache),
            ...Object.keys(this.syncManifest?.files ?? {}),
            ...Object.keys(this.syncManifest?.directories ?? {}),
            ...this.seenLocalEntities,
            ...this.locallyDivergedPaths,
            ...this.syncConflicts.keys(),
        ]);
        for (const relPath of trackedPaths) {
            if (
                relPath==='/'
                || snapshot.files.has(relPath)
                || snapshot.directories.has(relPath)
                || this.matchIgnorePatterns(relPath)
                || this.matchIgnorePatterns(`${relPath}/`)
            ) {
                continue;
            }
            // Corroborate before claiming a delete. A watcher-reported delete is
            // the kernel telling us an unlink happened; this is only "the path
            // was not in one listing", which an unlink/rename save in flight
            // produces just as readily. Requiring a second consecutive scan to
            // agree buys a fully independent observation a whole scan interval
            // later — far stronger evidence than any in-line wait — and costs no
            // per-path latency, so a bulk deletion of hundreds of files still
            // propagates in one extra scan rather than serialising a recheck
            // window per path. By the time this emits 'delete', that label is
            // honest and downstream may treat it as an observed delete.
            if (!this.scannerAbsentPaths.has(relPath)) {
                this.scannerAbsentPaths.add(relPath);
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local scan absence unconfirmed] ${relPath}: ` +
                    'waiting for a second scan before treating it as a deletion',
                );
                continue;
            }
            candidates.set(relPath, {
                uri: this.localUri(relPath),
                type: 'delete',
            });
        }

        return this.replayBufferedLocalEvents(candidates.values(), generation);
    }

    private stopLocalWatcherFallback(generation: number): void {
        if (this.fallbackScanGeneration!==generation) { return; }
        this.fallbackScanGeneration = undefined;
        if (this.fallbackScanTimer) {
            clearTimeout(this.fallbackScanTimer);
            this.fallbackScanTimer = undefined;
        }
    }

    private markLocalWatcherHealthy(generation: number): void {
        if (!this.isSyncSessionActive(generation)) { return; }
        const previous = this.localWatcherHealthState;
        this.localWatcherHealthState = 'healthy';
        this.stopLocalWatcherFallback(generation);
        if (previous!==this.localWatcherHealthState) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [local watcher ${previous==='degraded' ? 'recovered' : 'healthy'}] ` +
                `${this.baseUri.toString()}`,
            );
        }
    }

    private markLocalWatcherDegraded(generation: number): void {
        if (
            !this.isSyncSessionActive(generation)
            || this.localWatcherHealthState==='degraded'
        ) {
            return;
        }
        this.localWatcherHealthState = 'degraded';
        this.startLocalWatcherFallback(generation);
    }

    private startLocalWatcherFallback(generation: number): void {
        if (
            !this.isSyncSessionActive(generation)
            || this.fallbackScanGeneration===generation
        ) {
            return;
        }
        this.fallbackScanGeneration = generation;
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [local watcher degraded] ${this.baseUri.toString()} ` +
            `using ${LocalReplicaSCMProvider.fallbackScanIntervalMs}ms content scans`,
        );
        if (!this.localWatcherWarningShown) {
            this.localWatcherWarningShown = true;
            void vscode.window.showWarningMessage(vscode.l10n.t(
                'Local Replica file watching is unavailable. Closed-file changes will use a periodic content scan.',
            ));
        }

        const schedule = (delay: number) => {
            if (
                !this.isSyncSessionActive(generation)
                || this.fallbackScanGeneration!==generation
            ) {
                return;
            }
            this.fallbackScanTimer = setTimeout(() => {
                this.fallbackScanTimer = undefined;
                if (
                    !this.isSyncSessionActive(generation)
                    || this.fallbackScanGeneration!==generation
                ) {
                    return;
                }
                if (this.fallbackScanRunningGeneration===generation) {
                    schedule(LocalReplicaSCMProvider.fallbackScanIntervalMs);
                    return;
                }
                this.fallbackScanRunningGeneration = generation;
                void this.scanLocalChangesWithoutWatcher(generation)
                    .then(changedCount => {
                        if (changedCount>0 && this.isSyncSessionActive(generation)) {
                            getOutputChannel().appendLine(
                                `${new Date().toISOString()} [fallback scan synced] ` +
                                `${changedCount} local path(s)`,
                            );
                        }
                    })
                    .catch(error => {
                        if (this.isSyncSessionActive(generation)) {
                            getOutputChannel().appendLine(
                                `${new Date().toISOString()} [fallback scan failed] ` +
                                `${formatUnknownError(error)}`,
                            );
                        }
                    })
                    .finally(() => {
                        if (this.fallbackScanRunningGeneration===generation) {
                            this.fallbackScanRunningGeneration = undefined;
                        }
                        if (this.fallbackScanGeneration===generation) {
                            schedule(LocalReplicaSCMProvider.fallbackScanIntervalMs);
                        }
                    });
            }, delay);
        };
        schedule(0);
    }

    private async verifyLocalWatcherHealth(generation: number): Promise<boolean> {
        this.requireSyncSession(generation);
        // Probe inside the project tree itself. Probing only inside
        // .semantic-researcher-overleaf/ reported a healthy watcher whenever
        // that one directory was watched, even when files.watcherExclude hid
        // the replica's actual content — and then the content-scan fallback
        // never engaged. The .sr-overleaf-* prefix keeps the probe inside the
        // protected ignore patterns so no sync path can act on it.
        const probeUri = vscode.Uri.joinPath(
            this.baseUri,
            `.sr-overleaf-watcher-probe-${generation}-${crypto.randomBytes(6).toString('hex')}.tmp`,
        );
        let observed = false;
        let resolveObserved!: () => void;
        const observedPromise = new Promise<void>(resolve => {
            resolveObserved = resolve;
        });
        const probe = {
            generation,
            uri: probeUri.toString(),
            timeout: undefined as ReturnType<typeof setTimeout> | undefined,
            resolve: () => {
                observed = true;
                resolveObserved();
            },
        };
        this.localWatcherProbe = probe;

        try {
            await vscode.workspace.fs.writeFile(
                probeUri,
                new TextEncoder().encode(`${Date.now()}\n`),
            );
            this.requireSyncSession(generation);
            await Promise.race([
                observedPromise,
                new Promise<void>(resolve => {
                    probe.timeout = setTimeout(
                        resolve,
                        LocalReplicaSCMProvider.watcherProbeTimeoutMs,
                    );
                }),
            ]);
        } catch (error) {
            if (this.isSyncSessionActive(generation)) {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [local watcher probe failed] ${formatUnknownError(error)}`,
                );
            }
        } finally {
            if (probe.timeout) {
                clearTimeout(probe.timeout);
                probe.timeout = undefined;
            }
            try {
                await vscode.workspace.fs.delete(probeUri, {recursive: false});
            } catch {
                // The probe may have failed before creation or already be gone.
            }
            if (this.localWatcherProbe===probe) {
                this.localWatcherProbe = undefined;
            }
        }

        return this.isSyncSessionActive(generation) && observed;
    }

    private scheduleLocalWatcherHealthCheck(generation: number, delay = 0): void {
        if (!this.isSyncSessionActive(generation)) { return; }
        if (this.localWatcherHealthTimer) {
            clearTimeout(this.localWatcherHealthTimer);
        }
        this.localWatcherHealthTimer = setTimeout(() => {
            this.localWatcherHealthTimer = undefined;
            if (!this.isSyncSessionActive(generation)) { return; }
            void this.runSessionIO(
                generation,
                () => this.verifyLocalWatcherHealth(generation),
            )
                .then(observed => {
                    if (!this.isSyncSessionActive(generation)) { return; }
                    if (observed) {
                        this.markLocalWatcherHealthy(generation);
                    } else {
                        this.markLocalWatcherDegraded(generation);
                    }
                })
                .catch(error => {
                    if (!this.isSyncSessionActive(generation)) { return; }
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [local watcher health check failed] ` +
                        `${formatUnknownError(error)}`,
                    );
                    this.markLocalWatcherDegraded(generation);
                })
                .finally(() => {
                    if (this.isSyncSessionActive(generation)) {
                        this.scheduleLocalWatcherHealthCheck(
                            generation,
                            LocalReplicaSCMProvider.watcherHealthIntervalMs,
                        );
                    }
                });
        }, delay);
    }

    private async initWatch(): Promise<vscode.Disposable[]> {
        const generation = await this.beginSyncSession();
        let bufferingStartupEvents = true;
        const bufferedVfsEvents = new Map<string, {uri: vscode.Uri; type: 'update' | 'delete'}>();
        const bufferedLocalEvents = new Map<string, {uri: vscode.Uri; type: 'update' | 'delete'}>();
        const bufferOrRun = (
            direction: 'pull' | 'push',
            uri: vscode.Uri,
            type: 'update' | 'delete',
        ) => {
            if (direction==='push' && this.observeLocalWatcherProbe(uri)) {
                return;
            }
            if (direction==='push') {
                this.markLocalWatcherHealthy(generation);
                if (!this.localWatcherProbe) {
                    this.scheduleLocalWatcherHealthCheck(
                        generation,
                        LocalReplicaSCMProvider.watcherHealthIntervalMs,
                    );
                }
            }
            if (bufferingStartupEvents) {
                const target = direction==='pull' ? bufferedVfsEvents : bufferedLocalEvents;
                target.set(uri.toString(), {uri, type});
                return;
            }
            if (direction==='pull') {
                this.syncFromVFS(uri, type);
            } else {
                void this.syncToVFS(uri, type);
            }
        };

        // Register both watchers before the initial reconciliation. Events
        // emitted by agent writes, remote collaborators, or our own pull are
        // buffered until the manifest and merge baselines are ready, then
        // replayed through the normal guarded sync path.
        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.vfs.origin, '**/*'),
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.baseUri.fsPath, '**/*'),
        );
        const disposables: vscode.Disposable[] = [
            this.vfsWatcher.onDidChange(uri => bufferOrRun('pull', uri, 'update')),
            this.vfsWatcher.onDidCreate(uri => bufferOrRun('pull', uri, 'update')),
            this.vfsWatcher.onDidDelete(uri => bufferOrRun('pull', uri, 'delete')),
        ];
        this.dynamicLocalDisposables.push(
            this.localWatcher,
            this.localWatcher.onDidChange(uri => bufferOrRun('push', uri, 'update')),
            this.localWatcher.onDidCreate(uri => bufferOrRun('push', uri, 'update')),
            this.localWatcher.onDidDelete(uri => bufferOrRun('push', uri, 'delete')),
        );
        this.armLocalWatcher = () => undefined;
        this.startDirectLocalWatcher(generation, uri => bufferOrRun('push', uri, 'update'));

        let initialized: boolean;
        try {
            initialized = await this.initializeLocalReplica(undefined, generation);
        } catch (error) {
            this.deactivateSyncSession(generation);
            throw error;
        }
        if (!this.isSyncSessionActive(generation)) { return []; }
        if (!initialized) {
            this.deactivateSyncSession(generation);
            throw new Error('Local Replica initial pull did not complete; buffered sync watchers were stopped.');
        }

        bufferingStartupEvents = false;
        const startupRemoteEvents = [...bufferedVfsEvents.values()];
        const startupLocalEvents = [...bufferedLocalEvents.values()];
        bufferedVfsEvents.clear();
        bufferedLocalEvents.clear();
        const startupReplayPending = this.startBufferedStartupReplay(
            startupRemoteEvents,
            startupLocalEvents,
            generation,
        );
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [sync watchers live] ` +
            `bufferedRemote=${startupRemoteEvents.length} bufferedLocal=${startupLocalEvents.length} ` +
            `startupReplay=${startupReplayPending ? 'pending' : 'none'} ` +
            `initialPullStatus=${this.initialPullStatus} ` +
            `remoteVerify=${this.pendingInitialDocumentSubscriptions.size}`,
        );
        // The local tree is already an authoritative HTTP snapshot. Join the
        // document rooms after readiness, one at a time. When buffered events
        // exist, the background replay starts this verification after they are
        // reconciled; otherwise start it immediately.
        if (!startupReplayPending) {
            void this.verifyInitialDocumentSubscriptions(generation).catch(error => {
                if (!this.isSyncSessionActive(generation)) { return; }
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [initial document subscription failed] ` +
                    `${formatUnknownError(error)}`,
                );
            });
            await this.refreshCleanOpenReplicaDocumentsFromDisk(generation);
            this.requireSyncSession(generation);
        }
        if (this.initialPullStatus!=='complete') {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [partial pull active] ${this.failedInitialPulls.size} files pending; ` +
                `their local edits will be rejected by Layer 4/4b until retry/ignore. Other files push normally.`,
            );
        }

        // Keep probing asynchronously so startup and edits never wait for
        // watcher diagnostics. A failed probe enables exact-content scans;
        // a later successful probe stops them, and continued probes detect a
        // watcher that dies after startup.
        this.scheduleLocalWatcherHealthCheck(generation);

        // Auto-recover on reconnect: a transient socket drop that left files
        // in failedInitialPulls is the typical case, and the connection is now
        // available again. Try once per (re)connect.
        const connSub = this.vfs.onDidChangeConnection(state => {
            if (!this.isSyncSessionActive(generation)) { return; }
            this.refreshDerivedSyncStatus();
            if (state!=='connected') { return; }
            void (async () => {
                const pendingCount = Object.keys(
                    this.syncManifest?.pendingOperations ?? {},
                ).length;
                if (pendingCount>0) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [pending operation replay on reconnect] ` +
                        `${pendingCount} file changes`,
                    );
                    await this.requestPendingFilePushOperationReplay(generation);
                }
                if (
                    this.isSyncSessionActive(generation)
                    && this.failedInitialPulls.size>0
                ) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [pull retry on reconnect] ${this.failedInitialPulls.size} files`,
                    );
                    await this.retryFailedInitialPulls();
                }
            })().catch(error => {
                if (this.isSyncSessionActive(generation)) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [reconnect recovery failed] ` +
                        formatUnknownError(error),
                    );
                }
            });
        });
        disposables.push(connSub);

        // Dispose-sentinel for the dynamic list so trigger teardown cleans up.
        // Also drops any pending debounce timers — without this a fire-after-
        // dispose would call applySync against a torn-down SCM. The map
        // .get() check inside the timer callback handles in-flight timers
        // that fire between clearTimeout and our Map.clear() (the entry is
        // gone, so the callback bails).
        disposables.push({
            dispose: () => {
                this.deactivateSyncSession(generation);
            },
        });

        return disposables;
    }

    private localUri(relPath: string): vscode.Uri {
        const confinedRelPath = this.requireConfinedRelPath(relPath, 'local URI resolution');
        return vscode.Uri.joinPath(this.baseUri, ...confinedRelPath.replace(/^\/+/, '').split('/'));
    }

    private async withFileSystemContext<T>(
        operation: string,
        uri: vscode.Uri,
        task: () => Thenable<T> | Promise<T>,
    ): Promise<T> {
        try {
            return await task();
        } catch (error) {
            throw new Error(`${operation} failed for ${uri.toString()}: ${formatUnknownError(error)}`);
        }
    }

    private async ensureParentDirectory(
        relPath: string,
        generation = this.syncGeneration,
    ) {
        this.requireSyncSession(generation);
        const confinedRelPath = this.requireConfinedRelPath(relPath, 'create local parent directory');
        const pathParts = confinedRelPath.replace(/^\/+/, '').split('/');
        if (pathParts.length<=1) { return; }
        const parentUri = vscode.Uri.joinPath(this.baseUri, ...pathParts.slice(0, -1));
        await this.withFileSystemContext(
            'Create local parent directory',
            parentUri,
            () => this.runSessionIO(
                generation,
                () => vscode.workspace.fs.createDirectory(parentUri),
            ),
        );
    }

    async writeFile(
        relPath: string,
        content: Uint8Array,
        generation = this.syncGeneration,
    ): Promise<void> {
        this.requireSyncSession(generation);
        await this.ensureParentDirectory(relPath, generation);
        this.requireSyncSession(generation);
        const uri = this.localUri(relPath);
        await this.withFileSystemContext(
            'Write local file',
            uri,
            () => this.runSessionIO(
                generation,
                () => vscode.workspace.fs.writeFile(uri, content),
            ),
        );
        this.requireSyncSession(generation);
    }

    readFile(relPath: string): Thenable<Uint8Array|undefined> {
        try {
            this.localUri(relPath);
        } catch {
            return Promise.resolve(undefined);
        }
        return new Promise(async (resolve, reject) => {
            try {
                const content = await this.readConfinedLocalFile(relPath);
                resolve(content);
            } catch (error) {
                resolve(undefined);
            }
        });
    }

    get triggers(): Promise<vscode.Disposable[]> {
        if (this.activationPromise) {
            return this.activationPromise;
        }
        const activation = this.initWatch().then((watches) => {
            if (this.vfsWatcher===undefined) {
                // initWatch should always create the vfsWatcher; if not, bail.
                return [];
            }
            return [this.vfsWatcher, ...watches];
        });
        const trackedActivation = activation.finally(() => {
            if (this.activationPromise===trackedActivation) {
                this.activationPromise = undefined;
            }
        });
        this.activationPromise = trackedActivation;
        return trackedActivation;
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = nodePath.sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., local parent folder');
        inputBox.value = os.homedir()+sep;

        let lookupTimer: ReturnType<typeof setTimeout> | undefined;
        let lookupRequest = 0;
        const stripTrailingSeparator = (value: string) => {
            const normalized = value.replace(/[\\/]+$/, '');
            return normalized==='' ? value : normalized;
        };
        const getDirectoryRequest = (value: string) => {
            const trimmed = value.trim();
            if (trimmed==='') {
                return undefined;
            }
            const browsingDirectory = /[\\/]$/.test(trimmed);
            const directory = browsingDirectory
                ? stripTrailingSeparator(trimmed)
                : nodePath.dirname(trimmed);
            const prefix = browsingDirectory ? '' : nodePath.basename(trimmed);
            return {
                directory: directory==='' ? sep : directory,
                prefix,
            };
        };
        const readDirectoryWithTimeout = async (uri: vscode.Uri) => {
            return Promise.race([
                vscode.workspace.fs.readDirectory(uri),
                new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 3000)),
            ]);
        };

        // enable auto-complete
        inputBox.onDidChangeValue(value => {
            if (lookupTimer) {
                clearTimeout(lookupTimer);
                lookupTimer = undefined;
            }
            const request = getDirectoryRequest(value);
            const currentRequest = ++lookupRequest;
            inputBox.activeItems = [];
            if (!request) {
                inputBox.items = [];
                inputBox.busy = false;
                return;
            }
            inputBox.busy = true;
            lookupTimer = setTimeout(async () => {
                try {
                    const items = await readDirectoryWithTimeout(vscode.Uri.file(request.directory));
                    if (currentRequest!==lookupRequest) { return; }
                    if (!items) {
                        inputBox.items = [];
                        return;
                    }
                    const prefixLower = request.prefix.toLowerCase();
                    const subDirs = items
                        .filter(([name, type]) => type===vscode.FileType.Directory && name.toLowerCase().startsWith(prefixLower))
                        .slice(0, 200);
                    const candidates = subDirs.map(([name]) => ({label:name, alwaysShow:true, picked:false}));
                    if (request.directory!==nodePath.dirname(request.directory)) {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                } catch {
                    if (currentRequest===lookupRequest) {
                        inputBox.items = [];
                    }
                } finally {
                    if (currentRequest===lookupRequest) {
                        inputBox.busy = false;
                    }
                }
            }, 150);
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const request = getDirectoryRequest(inputBox.value);
                if (!request) { return; }
                const nextPath = selected.label==='..'
                    ? nodePath.dirname(stripTrailingSeparator(request.directory))
                    : nodePath.join(request.directory, selected.label);
                inputBox.value = nextPath.endsWith(sep) ? nextPath : `${nextPath}${sep}`;
            }
        });
        inputBox.onDidHide(() => {
            if (lookupTimer) {
                clearTimeout(lookupTimer);
                lookupTimer = undefined;
            }
            lookupRequest++;
            inputBox.busy = false;
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            {
                label: vscode.l10n.t('Resolve a sync conflict using local state ...'),
                callback: async () => {
                    const conflicts = this.getSyncConflictPaths();
                    if (conflicts.length===0) {
                        vscode.window.showInformationMessage(
                            vscode.l10n.t('There are no Local Replica sync conflicts.'),
                        );
                        return;
                    }
                    const relPath = await vscode.window.showQuickPick(conflicts, {
                        ignoreFocusOut: true,
                        title: vscode.l10n.t('Select a conflict to resolve using the current local state'),
                    });
                    if (!relPath) { return; }
                    const confirmation = await vscode.window.showWarningMessage(
                        vscode.l10n.t(
                            'Apply the current local state for "{relPath}" to Overleaf? This may overwrite or delete the remote path.',
                            {relPath},
                        ),
                        {modal: true},
                        vscode.l10n.t('Apply Local State'),
                    );
                    if (confirmation!==vscode.l10n.t('Apply Local State')) {
                        return;
                    }
                    const resolved = await this.resolveConflictWithLocalState(relPath);
                    if (!resolved) {
                        vscode.window.showWarningMessage(
                            vscode.l10n.t(
                                'The conflict for "{relPath}" could not be resolved because its state changed. Review it again.',
                                {relPath},
                            ),
                        );
                    }
                },
            },
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
