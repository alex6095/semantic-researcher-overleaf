import * as vscode from 'vscode';
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
 * The cleanup therefore removes exactly what misleads — our own delimited block
 * and the helper that keeps "accepting" submissions — and preserves everything
 * that may hold real work (draft copies, pending proposals), telling the user
 * once where it is.
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
const REGISTRY_FILE = 'registry.json';
const DRAFTS_DIR = 'drafts';
const PROPOSALS_DIR = 'proposals';

const CLEANUP_VERSION = 1;
// Instruction blocks live in the workspace, so their "already done" marker has
// to be workspace-scoped: a global-only marker would let the first upgraded
// window mark the job finished and leave every other workspace's AGENTS.md
// advertising the dead draft workflow forever.
const INSTRUCTION_CLEANUP_KEY = `${ROOT_NAME}.agentReviewInstructionCleanup`;
// Global storage is shared by every window, so its marker is global.
const STORAGE_CLEANUP_KEY = `${ROOT_NAME}.agentReviewStorageCleanup`;
// Separate from the cleanup markers so a retried cleanup can never re-notify.
const PRESERVED_NOTICE_KEY = `${ROOT_NAME}.agentReviewPreservedNotice`;

type InstructionCleanupResult = 'unchanged' | 'cleaned' | 'failed';

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

async function removeManagedBlockFromFile(uri: vscode.Uri): Promise<InstructionCleanupResult> {
    let existing: string;
    try {
        existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
        // Absent or unreadable. Both mean the same thing here: there is no
        // content we can safely rewrite, and we never recreate the file.
        return 'unchanged';
    }

    const next = stripManagedBlocks(existing);
    if (next===undefined) {
        return 'unchanged';
    }

    try {
        if (next.length===0) {
            // Nothing but our block was in the file, so the feature created it.
            // Deleting restores the pre-feature state instead of leaving an
            // empty file behind; this mirrors what the removed
            // `removeManagedBlock` did when the feature was disabled.
            await vscode.workspace.fs.delete(uri, {recursive: false, useTrash: false});
        } else {
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
        }
        return 'cleaned';
    } catch (error) {
        // Read-only file, permission loss, racing delete… Never fail activation;
        // report 'failed' so the caller retries on the next activation instead
        // of marking a still-misleading file as cleaned up.
        console.warn(`Could not remove the stale Agent Review block from ${uri.fsPath}:`, error);
        return 'failed';
    }
}

async function removeWorkspaceInstructionBlocks(roots: readonly vscode.Uri[]): Promise<boolean> {
    let complete = true;
    for (const root of roots) {
        for (const name of INSTRUCTION_FILE_NAMES) {
            const result = await removeManagedBlockFromFile(vscode.Uri.joinPath(root, name));
            if (result==='failed') {
                complete = false;
            }
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
 * itself is the only neutralization that both stops submissions and keeps the
 * drafts intact.
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

/**
 * Neutralizes one Agent Review storage root in place. Returns the root when it
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
        try {
            await fs.writeFile(helperPath, neutralizedHelperScript(path.join(metaRoot, DRAFTS_DIR)));
            await fs.chmod(helperPath, 0o755);
        } catch (error) {
            console.warn(`Could not neutralize the stale Agent Review helper at ${helperPath}:`, error);
            complete = false;
        }
    }

    // The registry was the helper's own record of which replica roots were
    // enabled. Emptying it means "no root is registered"; the stub above is the
    // real guard, this only matters for a helper copy still reading this file.
    const registryPath = path.join(metaRoot, REGISTRY_FILE);
    if (await pathExists(registryPath)) {
        try {
            await fs.writeFile(registryPath, JSON.stringify({replicaRoots: []}, null, 2));
        } catch (error) {
            console.warn(`Could not clear the stale Agent Review registry at ${registryPath}:`, error);
            complete = false;
        }
    }

    const preserved = await directoryHasEntries(path.join(metaRoot, DRAFTS_DIR))
        || await hasProposalFiles(path.join(metaRoot, PROPOSALS_DIR));
    return {preserved, complete};
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

/**
 * Runs the upgrade cleanup once. Safe to call on every activation: when the
 * markers are recorded it costs two `Memento.get` calls, and when the user never
 * had Agent Review it does nothing and says nothing.
 *
 * Never throws — every failure path degrades to a logged warning.
 */
export async function cleanupRemovedAgentReview(
    context: vscode.ExtensionContext,
    workspaceRoots: readonly vscode.Uri[] =
        (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri),
): Promise<void> {
    try {
        const instructionsDone = (context.workspaceState.get<number>(INSTRUCTION_CLEANUP_KEY, 0))>=CLEANUP_VERSION;
        const storageDone = (context.globalState.get<number>(STORAGE_CLEANUP_KEY, 0))>=CLEANUP_VERSION;
        if (instructionsDone && storageDone) {
            return;
        }

        // The removed code only ever resolved instruction targets and legacy
        // metadata to a workspace folder root, so those are the only roots worth
        // scanning.
        const fileRoots = workspaceRoots.filter(root => root.scheme==='file');
        const preserved: string[] = [];
        let instructionsComplete = true;
        let storageComplete = true;

        if (!instructionsDone) {
            instructionsComplete = await removeWorkspaceInstructionBlocks(fileRoots);
            // Builds before the move to global storage kept the helper, registry
            // and drafts inside each workspace folder instead.
            for (const root of fileRoots) {
                const legacyRoot = path.join(root.fsPath, REPLICA_SETTINGS_DIR, AGENT_REVIEW_DIR);
                const result = await neutralizeStorageRoot(legacyRoot);
                // Workspace-scoped work is gated by the workspace marker, so a
                // legacy failure has to hold back that marker, not the global one.
                instructionsComplete = instructionsComplete && result.complete;
                if (result.preserved) {
                    preserved.push(legacyRoot);
                }
            }
        }

        if (!storageDone) {
            const globalRoot = path.join(context.globalStorageUri.fsPath, AGENT_REVIEW_DIR);
            const result = await neutralizeStorageRoot(globalRoot);
            storageComplete = storageComplete && result.complete;
            if (result.preserved) {
                preserved.push(globalRoot);
            }
        }

        if (preserved.length>0 && !context.globalState.get<boolean>(PRESERVED_NOTICE_KEY, false)) {
            // One notification, ever — not one per file and not once per window.
            // Recorded before it is shown so a concurrent window cannot repeat it.
            await context.globalState.update(PRESERVED_NOTICE_KEY, true);
            notifyPreservedWork(preserved);
        }

        // Only record a step that fully succeeded, so a file that was read-only
        // during this activation is retried later instead of being abandoned
        // with its misleading block still in place.
        if (!instructionsDone && instructionsComplete) {
            await context.workspaceState.update(INSTRUCTION_CLEANUP_KEY, CLEANUP_VERSION);
        }
        if (!storageDone && storageComplete) {
            await context.globalState.update(STORAGE_CLEANUP_KEY, CLEANUP_VERSION);
        }
    } catch (error) {
        console.warn('Agent Review removal cleanup failed:', error);
    }
}
