import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { REPLICA_SETTINGS_DIR, ROOT_NAME } from '../consts';

/**
 * One-time upgrade cleanup for the removed Agent Review feature.
 *
 * While Agent Review existed it wrote a delimited managed block into the
 * workspace `AGENTS.md`/`CLAUDE.md` and installed a helper script plus a
 * registry under global storage. The block instructs coding agents to edit a
 * *draft copy* instead of the real file and to treat a successful `submit` as a
 * finished task. Nothing in this build imports drafts any more, so after the
 * upgrade an agent that follows those instructions does real manuscript work
 * that never reaches the user's file or Overleaf, and still reports success.
 * Both instruction files are hard-ignored by replica sync
 * (`PROTECTED_LOCAL_REPLICA_IGNORE_PATTERNS`), so the stale instructions would
 * otherwise survive indefinitely.
 *
 * The cleanup removes exactly what misleads — our own delimited block and the
 * helper that keeps "accepting" submissions — and preserves everything that may
 * hold real work (draft copies, pending proposals), telling the user once where
 * it is.
 *
 * Every mutation here races the user and their coding agents, who may be saving
 * the very files we rewrite. So the instruction-file edits use node's `fs`
 * rather than `vscode.workspace.fs`: they need a held file descriptor, inode
 * identity and non-clobbering `link`/`rename`, none of which the workspace
 * FileSystem API exposes. That is safe because only `file:`-scheme roots are
 * ever scanned.
 */

// Copied verbatim from the removed `src/agentReview/instructionFiles.ts`; these
// literals are the contract with every file that build wrote.
const MANAGED_BLOCK_START = '<!-- semantic-researcher-overleaf-agent-review:start -->';
const MANAGED_BLOCK_END = '<!-- semantic-researcher-overleaf-agent-review:end -->';

// The removed `AgentReviewInstructionFiles.ensureWorkspace` wrote the block into
// these two files at a workspace-folder root, and nowhere else.
const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'];

// Layout of the removed feature's storage, from
// `AgentReviewWorkspaceInstructionManager` and `AgentReviewProposalStore`.
const AGENT_REVIEW_DIR = 'agent-review';
const HELPER_NAME = 'overleaf-agent-review';
const DRAFTS_DIR = 'drafts';
const PROPOSALS_DIR = 'proposals';

const CLEANUP_VERSION = 1;
// Which workspace folders have been fully cleaned, as URI strings. Per folder,
// not one bit for the whole window: a folder added to a multi-root workspace
// later still carries its own stale block and its own legacy helper, and a
// single "done" flag would silently skip it forever.
const INSTRUCTION_CLEANUP_ROOTS_KEY = `${ROOT_NAME}.agentReviewInstructionCleanupRoots`;
// Global storage is shared by every window, so its marker is global.
const STORAGE_CLEANUP_KEY = `${ROOT_NAME}.agentReviewStorageCleanup`;
// Storage locations already named in a notification, so no location is ever
// announced twice and no location is silently dropped.
const PRESERVED_NOTICE_KEY = `${ROOT_NAME}.agentReviewPreservedNoticeLocations`;

// Sibling name used to hold a file's bytes while proving it is safe to delete.
// The `.sr-overleaf-*` prefix is in `PROTECTED_LOCAL_REPLICA_IGNORE_PATTERNS`,
// so a transient temporary can never be pushed to Overleaf.
const ASIDE_PREFIX = '.sr-overleaf-agent-review-cleanup-';

type InstructionCleanupResult =
    /** No such file. Nothing to do now and nothing to retry. */
    | 'absent'
    /** Readable, no managed block. */
    | 'unchanged'
    | 'cleaned'
    /** The file exists but could not be read, so a stale block may still be in it. */
    | 'unreadable'
    /** Someone else changed the file while we worked; theirs wins, we retry. */
    | 'deferred'
    /** The rewrite itself failed. */
    | 'failed';

interface FileIdentity {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
}

function errorCode(error: unknown): string {
    return typeof error==='object' && error!==null && 'code' in error
        ? String((error as {code?: unknown}).code)
        : '';
}

function identityOf(stat: {dev: number, ino: number, size: number, mtimeMs: number}): FileIdentity {
    return {dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs};
}

/**
 * `ino`/`dev` catch an atomic replace, `size`/`mtimeMs` an in-place rewrite.
 * Some Windows filesystems report `ino` as 0; the size and timestamp checks and
 * the byte re-read below still stand on their own there.
 */
function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
    return sameInode(a, b) && a.size===b.size && a.mtimeMs===b.mtimeMs;
}

/**
 * "Still the same file", ignoring content. Used after our own write, which
 * necessarily changed the size and timestamp.
 */
function sameInode(a: FileIdentity, b: FileIdentity): boolean {
    return a.dev===b.dev && a.ino===b.ino;
}

/**
 * Removes every well-formed managed block, and only that. Returns `undefined`
 * when there is nothing to do so callers never rewrite an untouched file.
 *
 * A start marker without a matching end marker (or an end marker before the
 * start) is malformed: the extent of "our" text is then unknown, so the file is
 * left exactly as the user has it.
 */
function stripManagedBlocks(existing: string): string | undefined {
    let result = existing;
    let changed = false;

    for (;;) {
        const start = result.indexOf(MANAGED_BLOCK_START);
        const end = result.indexOf(MANAGED_BLOCK_END);
        if (start<0 || end<start) {
            break;
        }

        const before = result.slice(0, start);
        let after = result.slice(end + MANAGED_BLOCK_END.length);
        // The writer emitted `<block>\n` followed by a `\n` separator before any
        // preserved user content. Drop only that separator: removing the block
        // must not leave a blank-line scar, and must not eat a blank line the
        // user typed themselves.
        if (after.startsWith('\r\n\r\n')) {
            after = after.slice(4);
        } else if (after.startsWith('\n\n')) {
            after = after.slice(2);
        } else if (after.startsWith('\r\n')) {
            after = after.slice(2);
        } else if (after.startsWith('\n')) {
            after = after.slice(1);
        }

        result = `${before}${after}`;
        changed = true;
    }

    return changed ? result : undefined;
}

/** Reads the whole file through an explicit position, so it can be re-read. */
async function readAllFromHandle(handle: fs.FileHandle, size: number): Promise<string> {
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset<size) {
        const {bytesRead} = await handle.read(buffer, offset, size-offset, offset);
        if (bytesRead===0) {
            break;
        }
        offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
}

/**
 * Puts a file we moved aside back where it was, without ever overwriting
 * whatever may now occupy that path. `link` is the primitive that makes this
 * safe: it fails with EEXIST instead of clobbering.
 */
async function restoreAside(asidePath: string, filePath: string): Promise<void> {
    try {
        await fs.link(asidePath, filePath);
        // The content is back at its own path; a leftover alias is only litter.
        await fs.unlink(asidePath).catch(() => undefined);
        return;
    } catch (error) {
        if (errorCode(error)==='EEXIST') {
            // Something new lives at the original path. Their file wins; ours
            // stays beside it rather than being destroyed.
            console.warn(`Agent Review cleanup left the previous ${filePath} at ${asidePath}: a new file now occupies that path.`);
            return;
        }
        // Filesystems without hard links (some network/FUSE mounts): fall back
        // to a rename, but only when the destination is demonstrably free.
    }

    if (!await pathExists(filePath)) {
        try {
            await fs.rename(asidePath, filePath);
            return;
        } catch (error) {
            console.warn(`Agent Review cleanup could not restore ${filePath} from ${asidePath}:`, error);
            return;
        }
    }
    console.warn(`Agent Review cleanup left the previous ${filePath} at ${asidePath}; move it back manually.`);
}

/**
 * Deletes a file only after proving its bytes are still exactly the block-only
 * content we validated.
 *
 * A stat-then-unlink check cannot make that promise: an editor saving between
 * the check and the unlink loses its write into an unlinked inode. Moving the
 * file aside first is atomic and reversible — after the rename nothing can
 * reach those bytes through the original name, so they can be re-read and
 * compared at leisure, and anything unexpected is put back.
 *
 * If the process dies mid-sequence the bytes survive under the aside name
 * rather than being destroyed, and in this branch those bytes are by definition
 * nothing but our own managed block, so nothing of the user's is at stake.
 */
async function deleteIfStillBlockOnly(filePath: string, expected: string): Promise<InstructionCleanupResult> {
    const asidePath = path.join(path.dirname(filePath), `${ASIDE_PREFIX}${crypto.randomUUID()}`);
    try {
        await fs.rename(filePath, asidePath);
    } catch (error) {
        console.warn(`Could not set ${filePath} aside for Agent Review cleanup:`, error);
        return 'deferred';
    }

    let moved: string | undefined;
    try {
        moved = await fs.readFile(asidePath, 'utf8');
    } catch (error) {
        console.warn(`Could not re-read ${filePath} after setting it aside:`, error);
    }

    if (moved===expected) {
        try {
            await fs.unlink(asidePath);
            return 'cleaned';
        } catch (error) {
            console.warn(`Could not delete the emptied ${filePath}:`, error);
            await restoreAside(asidePath, filePath);
            return 'failed';
        }
    }

    // Not what we read: a newer revision, or bytes we could not verify. Put it
    // back untouched and try again on a later activation.
    await restoreAside(asidePath, filePath);
    return 'deferred';
}

/**
 * Strips the managed block from one instruction file under a compare-and-swap.
 *
 * The file is read through a held descriptor, and immediately before the
 * rewrite the same descriptor is re-stat'd and re-read and the path is checked
 * to still resolve to that inode. Any mismatch means the user or an agent saved
 * a newer revision, and that revision always wins: we skip and retry on the
 * next activation rather than overwrite — or, in the block-only case, delete —
 * work we never saw.
 */
async function removeManagedBlockFromFile(filePath: string): Promise<InstructionCleanupResult> {
    let handle: fs.FileHandle | undefined;
    try {
        handle = await fs.open(filePath, 'r+');
    } catch (error) {
        if (errorCode(error)==='ENOENT') {
            return 'absent';
        }
        if (errorCode(error)==='EISDIR') {
            // A directory cannot hold a managed block, so there is nothing to
            // retry either.
            return 'absent';
        }
        // Permissions, a locked file, an I/O error: a stale block may well still
        // be in there, so this must not count as cleaned up.
        console.warn(`Could not open ${filePath} for Agent Review cleanup:`, error);
        return 'unreadable';
    }

    try {
        const before = identityOf(await handle.stat());
        const original = await readAllFromHandle(handle, before.size);
        const next = stripManagedBlocks(original);
        if (next===undefined) {
            return 'unchanged';
        }

        // --- compare-and-swap ---------------------------------------------
        const after = identityOf(await handle.stat());
        if (!sameIdentity(before, after)) {
            return 'deferred';
        }
        if (await readAllFromHandle(handle, after.size)!==original) {
            return 'deferred';
        }
        let current: FileIdentity;
        try {
            current = identityOf(await fs.stat(filePath));
        } catch (error) {
            console.warn(`Could not confirm ${filePath} before rewriting it:`, error);
            return 'deferred';
        }
        // An atomic replace (write-to-temp then rename) leaves our descriptor on
        // an unlinked inode while the user's new file sits at the path.
        if (!sameIdentity(before, current)) {
            return 'deferred';
        }
        // -------------------------------------------------------------------

        if (next.length===0) {
            // Nothing but our block was in the file, so the feature created it.
            // Deleting restores the pre-feature state instead of leaving an
            // empty file behind; this mirrors what the removed
            // `removeManagedBlock` did when the feature was disabled. Release
            // the descriptor first — Windows refuses to rename an open file.
            await handle.close();
            handle = undefined;
            return await deleteIfStillBlockOnly(filePath, original);
        }

        const bytes = Buffer.from(next, 'utf8');
        try {
            // Writing through the validated descriptor keeps the edit on the
            // inode we checked. Write before truncating so the file never
            // momentarily holds less than the cleaned content.
            await handle.write(bytes, 0, bytes.length, 0);
            await handle.truncate(bytes.length);
            // Make the cleaned bytes durable before this root can be recorded as
            // done, so a crash can never leave the marker without the fix.
            await handle.sync().catch(() => undefined);
        } catch (error) {
            console.warn(`Could not remove the stale Agent Review block from ${filePath}:`, error);
            return 'failed';
        }

        try {
            if (!sameInode(before, identityOf(await fs.stat(filePath)))) {
                // Replaced between the check and the write: our bytes went to an
                // inode nobody can reach any more and the user's file is intact.
                return 'deferred';
            }
        } catch {
            return 'deferred';
        }
        return 'cleaned';
    } catch (error) {
        // Never fail activation for one file.
        console.warn(`Agent Review cleanup could not process ${filePath}:`, error);
        return 'failed';
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/** True when every instruction file under this root reached a settled state. */
async function cleanInstructionFilesForRoot(root: vscode.Uri): Promise<boolean> {
    let complete = true;
    for (const name of INSTRUCTION_FILE_NAMES) {
        const result = await removeManagedBlockFromFile(path.join(root.fsPath, name));
        if (result==='unreadable' || result==='deferred' || result==='failed') {
            complete = false;
        }
    }
    return complete;
}

/**
 * Replacement for the installed helper: refuses every command, deletes nothing.
 *
 * The original helper's `submit` removed the draft directory whenever the
 * registry no longer listed the replica root, so a plain "unregister" would
 * destroy exactly the work we are trying to preserve. Replacing the executable
 * is the only neutralization that both stops submissions and keeps the drafts
 * intact.
 */
function neutralizedHelperScript(draftsRoot: string): string {
    return `#!/usr/bin/env node
// Agent Review was removed from Semantic Researcher Overleaf. This stub replaced
// the helper that handed out draft copies and accepted submissions: nothing in
// the extension imports drafts any more, so a "successful" submit would silently
// strand real work. It refuses every command and never touches a draft.
console.error([
  'Agent Review has been removed from Semantic Researcher Overleaf.',
  'The draft workflow no longer exists: edit the file in the Local Replica directly.',
  'Existing drafts are kept, unread, at ' + ${JSON.stringify(draftsRoot)} + '.',
].join('\\n'));
process.exit(1);
`;
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await fs.stat(target);
        return true;
    } catch {
        return false;
    }
}

async function directoryHasEntries(target: string): Promise<boolean> {
    try {
        return (await fs.readdir(target)).length>0;
    } catch {
        return false;
    }
}

// Proposals are stored one directory deep (`proposals/<replica-hash>/*.json`),
// so an empty hash directory must not be reported as recoverable work.
async function hasProposalFiles(proposalsRoot: string): Promise<boolean> {
    let entries: string[];
    try {
        entries = await fs.readdir(proposalsRoot);
    } catch {
        return false;
    }

    for (const entry of entries) {
        const fullPath = path.join(proposalsRoot, entry);
        try {
            const stat = await fs.stat(fullPath);
            if (!stat.isDirectory()) {
                return true;
            }
            if (await directoryHasEntries(fullPath)) {
                return true;
            }
        } catch {
            // Vanished between readdir and stat; nothing to report for it.
        }
    }
    return false;
}

/** Installs the stub over the old helper atomically, so it is never half-written. */
async function replaceHelper(metaRoot: string, helperPath: string): Promise<boolean> {
    const stagedPath = path.join(path.dirname(helperPath), `${ASIDE_PREFIX}${crypto.randomUUID()}`);
    try {
        await fs.writeFile(stagedPath, neutralizedHelperScript(path.join(metaRoot, DRAFTS_DIR)));
        await fs.chmod(stagedPath, 0o755);
        await fs.rename(stagedPath, helperPath);
        return true;
    } catch (error) {
        console.warn(`Could not neutralize the stale Agent Review helper at ${helperPath}:`, error);
        await fs.unlink(stagedPath).catch(() => undefined);
        return false;
    }
}

/**
 * Neutralizes one Agent Review storage root in place, and reports whether it
 * still holds drafts or proposals so the caller can point the user at it.
 *
 * Never removes drafts or proposals: they can contain real manuscript work that
 * an agent produced but the user never accepted.
 */
async function neutralizeStorageRoot(metaRoot: string): Promise<{preserved: boolean, complete: boolean}> {
    if (!await pathExists(metaRoot)) {
        // The feature was never used here. Do nothing, say nothing.
        return {preserved: false, complete: true};
    }

    let complete = true;
    const helperPath = path.join(metaRoot, 'bin', HELPER_NAME);
    if (await pathExists(helperPath)) {
        complete = await replaceHelper(metaRoot, helperPath);
    }

    // `registry.json` is deliberately left exactly as it is, even though an
    // emptied registry would read like extra safety. Emptying it is precisely
    // the trigger for the removed helper's own destructive path: its `submit`
    // deletes the entire draft directory when the registry no longer lists that
    // draft's replica root. So any old helper that outlives this cleanup — one
    // whose replacement failed above, or one already mid-`submit` when we ran —
    // would answer an emptied registry by destroying the manuscript work this
    // migration exists to preserve. And it protects nothing in exchange: the
    // helper resolves its registry from its own install location
    // (`dirname(dirname(__filename))`), so a copy elsewhere never reads this
    // file. Replacing the executable is the neutralization; the registry is
    // inert once the executable is a stub, and leaving it untouched means the
    // draft-deleting branch is never reachable at all.

    const preserved = await directoryHasEntries(path.join(metaRoot, DRAFTS_DIR))
        || await hasProposalFiles(path.join(metaRoot, PROPOSALS_DIR));
    return {preserved, complete};
}

function readStringSet(memento: vscode.Memento, key: string): Set<string> {
    const stored = memento.get<unknown>(key);
    return new Set(
        Array.isArray(stored)
            ? stored.filter((entry): entry is string => typeof entry==='string')
            : [],
    );
}

function notifyPreservedWork(locations: string[]) {
    const showFolder = vscode.l10n.t('Show Folder');
    // Fire and forget: activation must not wait on a notification the user may
    // never dismiss.
    void vscode.window.showInformationMessage(
        vscode.l10n.t(
            'Agent Review was removed from Semantic Researcher Overleaf. Draft copies and pending proposals it had created were left untouched at {location}. Nothing there is read by the extension or synced to Overleaf, so copy anything you still need before deleting it.',
            {location: locations.join(', ')},
        ),
        showFolder,
    ).then(choice => {
        if (choice===showFolder) {
            void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(locations[0]));
        }
    }, () => undefined);
}

async function announcePreservedWork(context: vscode.ExtensionContext, locations: string[]) {
    if (locations.length===0) {
        return;
    }
    const announced = readStringSet(context.globalState, PRESERVED_NOTICE_KEY);
    const fresh = locations.filter(location => !announced.has(location));
    if (fresh.length===0) {
        return;
    }
    // Recorded before the notification is shown, so a retry after a partial
    // cleanup — or a second window — can never announce the same folder twice.
    await context.globalState.update(PRESERVED_NOTICE_KEY, [...announced, ...fresh]);
    notifyPreservedWork(fresh);
}

/**
 * Runs the upgrade cleanup. Safe to call on every activation: a folder that has
 * been cleaned is never scanned again, and when the user never had Agent Review
 * it does nothing and says nothing.
 *
 * Never throws — every failure path degrades to a logged warning.
 */
export async function cleanupRemovedAgentReview(
    context: vscode.ExtensionContext,
    workspaceRoots: readonly vscode.Uri[] =
        (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri),
): Promise<void> {
    try {
        // The removed code only ever resolved instruction targets and legacy
        // metadata to a workspace folder root, so those are the only roots worth
        // scanning.
        const fileRoots = workspaceRoots.filter(root => root.scheme==='file');
        const completedRoots = readStringSet(context.workspaceState, INSTRUCTION_CLEANUP_ROOTS_KEY);
        const pendingRoots = fileRoots.filter(root => !completedRoots.has(root.toString()));
        const storageDone = (context.globalState.get<number>(STORAGE_CLEANUP_KEY, 0))>=CLEANUP_VERSION;
        if (pendingRoots.length===0 && storageDone) {
            return;
        }

        const preserved: string[] = [];
        const newlyCompleted: string[] = [];

        for (const root of pendingRoots) {
            let complete = await cleanInstructionFilesForRoot(root);
            // Builds before the move to global storage kept the helper, registry
            // and drafts inside each workspace folder instead. This is per root
            // and not gated on the global marker, so a folder added later still
            // gets its own legacy helper neutralized.
            const legacyRoot = path.join(root.fsPath, REPLICA_SETTINGS_DIR, AGENT_REVIEW_DIR);
            const legacy = await neutralizeStorageRoot(legacyRoot);
            complete = complete && legacy.complete;
            if (legacy.preserved) {
                preserved.push(legacyRoot);
            }
            // Only a root that fully settled is recorded, so a file that was
            // unreadable or concurrently edited is retried later instead of
            // being abandoned with its misleading block still in place.
            if (complete) {
                newlyCompleted.push(root.toString());
            }
        }

        let storageComplete = true;
        if (!storageDone) {
            const globalRoot = path.join(context.globalStorageUri.fsPath, AGENT_REVIEW_DIR);
            const result = await neutralizeStorageRoot(globalRoot);
            storageComplete = result.complete;
            if (result.preserved) {
                preserved.push(globalRoot);
            }
        }

        await announcePreservedWork(context, preserved);

        if (newlyCompleted.length>0) {
            await context.workspaceState.update(
                INSTRUCTION_CLEANUP_ROOTS_KEY,
                [...completedRoots, ...newlyCompleted],
            );
        }
        if (!storageDone && storageComplete) {
            await context.globalState.update(STORAGE_CLEANUP_KEY, CLEANUP_VERSION);
        }
    } catch (error) {
        console.warn('Agent Review removal cleanup failed:', error);
    }
}
