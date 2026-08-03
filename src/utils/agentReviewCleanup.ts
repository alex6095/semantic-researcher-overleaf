import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { REPLICA_SETTINGS_DIR, ROOT_NAME } from '../consts';

/**
 * One-time upgrade cleanup for the removed Agent Review feature.
 *
 * While Agent Review existed it installed a helper script under global storage
 * and wrote a delimited instruction block into the workspace `AGENTS.md` and
 * `CLAUDE.md`. The block tells coding agents to edit a *draft copy* rather than
 * the real file, and to treat a successful `submit` as a finished task. Nothing
 * in this build imports drafts any more, so a submission that still "succeeds"
 * would let an agent do real manuscript work, report success, and strand the
 * user's edits where neither the extension nor Overleaf will ever see them.
 *
 * The danger lives entirely in the helper, and the helper is our own file in our
 * own storage. Neutralising it removes the danger at its source: every step of
 * the block routes through the helper, step 2 needs a `DRAFT_ROOT` that only
 * `begin` can print, and step 4's "treat the edit as complete" is conditioned on
 * `submit` succeeding. Once the helper refuses, `begin` fails before any work
 * exists, so the chain cannot start and nothing can be stranded.
 *
 * That makes the leftover text inert, and this migration therefore NEVER writes
 * to, truncates, renames or deletes `AGENTS.md`/`CLAUDE.md`. Those are the
 * user's files, an agent may be saving one at this very moment, and no
 * lock-free rewrite from a background activation can be made safe against that:
 * every check/use ordering still leaves a window in which a newer revision is
 * overwritten or an unlinked inode swallows a concurrent write. Tidiness is not
 * worth that trade, so we only ever read, and tell the user where the dead text
 * is so they can remove it when it suits them.
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
// Workspace folders already inspected, as URI strings. Per folder, not one bit
// for the whole window: a folder added to a multi-root workspace later carries
// its own leftovers, and a single flag would skip it forever.
const INSPECTED_ROOTS_KEY = `${ROOT_NAME}.agentReviewInspectedRoots`;
// Global storage is shared by every window, so its marker is global.
const STORAGE_CLEANUP_KEY = `${ROOT_NAME}.agentReviewStorageCleanup`;
// Everything already named in a notification, so nothing is reported twice.
const REPORTED_KEY = `${ROOT_NAME}.agentReviewReported`;

// Name for the staged replacement helper. The `.sr-overleaf-*` prefix is in
// `PROTECTED_LOCAL_REPLICA_IGNORE_PATTERNS`, so a transient staging file can
// never be pushed to Overleaf.
const STAGING_PREFIX = '.sr-overleaf-agent-review-cleanup-';

/**
 * Three states, never two. "Could not tell" must not collapse into "absent":
 * that is how a live helper or a stale instruction file gets recorded as
 * handled and is then never looked at again.
 */
type Presence = 'present' | 'absent' | 'unknown';

type InstructionFileState = 'stale' | 'clean' | 'absent' | 'unknown';

interface StorageOutcome {
    /** The location still holds drafts or proposals worth telling the user about. */
    preserved: boolean;
    /** The helper was definitively handled: replaced, or definitively not there. */
    complete: boolean;
}

interface Findings {
    staleInstructionFiles: string[];
    preservedWorkLocations: string[];
    /**
     * Storage roots whose helper could not be disabled. This is the one state in
     * which the leftover instructions are NOT inert, so it has to be able to
     * raise the alarm on its own, without waiting for some other finding to
     * carry it.
     */
    liveHelperLocations: string[];
}

function errorCode(error: unknown): string {
    return typeof error==='object' && error!==null && 'code' in error
        ? String((error as {code?: unknown}).code)
        : '';
}

/** ENOENT/ENOTDIR prove absence; anything else means we could not tell. */
function presenceFromError(error: unknown): Presence {
    const code = errorCode(error);
    return code==='ENOENT' || code==='ENOTDIR' ? 'absent' : 'unknown';
}

async function probe(target: string): Promise<Presence> {
    try {
        await fs.stat(target);
        return 'present';
    } catch (error) {
        return presenceFromError(error);
    }
}

async function probeDirectoryHasEntries(target: string): Promise<Presence> {
    try {
        return (await fs.readdir(target)).length>0 ? 'present' : 'absent';
    } catch (error) {
        return presenceFromError(error);
    }
}

/**
 * A well-formed managed block: a start marker with its end marker after it.
 * A truncated or reordered pair is not something we can attribute to the removed
 * feature, so it is not reported as ours.
 */
function containsManagedBlock(text: string): boolean {
    const start = text.indexOf(MANAGED_BLOCK_START);
    return start>=0 && text.indexOf(MANAGED_BLOCK_END)>start;
}

/** Read-only, by construction: this only ever opens the file for reading. */
async function inspectInstructionFile(filePath: string): Promise<InstructionFileState> {
    try {
        return containsManagedBlock(await fs.readFile(filePath, 'utf8')) ? 'stale' : 'clean';
    } catch (error) {
        if (presenceFromError(error)==='absent' || errorCode(error)==='EISDIR') {
            // No file here, and a directory cannot carry a block either.
            return 'absent';
        }
        console.warn(`Could not read ${filePath} while checking for stale Agent Review instructions:`, error);
        return 'unknown';
    }
}

/**
 * Replacement for the installed helper: refuses every command, deletes nothing.
 *
 * This stub is the entire safety mechanism now, so its message has to countermand
 * the leftover instructions directly. An agent that reaches it must learn to edit
 * the real file, that the drafts folder is a dead end, and that nothing here may
 * be reported as a completed edit.
 */
function neutralizedHelperScript(draftsRoot: string): string {
    return `#!/usr/bin/env node
// Agent Review was removed from Semantic Researcher Overleaf. This stub replaced
// the helper that handed out draft copies and accepted submissions: nothing in
// the extension imports drafts any more, so a "successful" submit would silently
// strand real work. It refuses every command and never touches a draft.
console.error([
  'Agent Review has been removed from Semantic Researcher Overleaf.',
  'There is no draft workflow any more: edit the file in the Local Replica directly,',
  'exactly as you would edit any other file, and report only what you actually changed.',
  'Do not treat anything here as a completed edit, and do not work inside the drafts',
  'folder: it is kept only so the user can recover old work, and nothing reads it.',
  'Previously created drafts are at ' + ${JSON.stringify(draftsRoot)} + '.',
].join('\\n'));
process.exit(1);
`;
}

/** Installs the stub over the old helper atomically, so it is never half-written. */
async function replaceHelper(metaRoot: string, helperPath: string): Promise<boolean> {
    const stagedPath = path.join(path.dirname(helperPath), `${STAGING_PREFIX}${crypto.randomUUID()}`);
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
            if (!(await fs.stat(fullPath)).isDirectory()) {
                return true;
            }
            if (await probeDirectoryHasEntries(fullPath)==='present') {
                return true;
            }
        } catch {
            // Vanished between readdir and stat; nothing to report for it.
        }
    }
    return false;
}

/**
 * Neutralizes one Agent Review storage root, and reports whether it still holds
 * drafts or proposals so the caller can point the user at them.
 *
 * Never removes drafts or proposals: they can hold real manuscript work an agent
 * produced but the user never accepted. `complete` is true only when the helper
 * was genuinely dealt with — a probe that merely failed leaves it false, so the
 * next activation tries again instead of recording a live helper as handled.
 */
async function neutralizeStorageRoot(metaRoot: string): Promise<StorageOutcome> {
    const metaPresence = await probe(metaRoot);
    if (metaPresence==='absent') {
        // The feature was never used here. Do nothing, say nothing.
        return {preserved: false, complete: true};
    }
    if (metaPresence==='unknown') {
        console.warn(`Could not determine whether stale Agent Review storage exists at ${metaRoot}; will retry.`);
        return {preserved: false, complete: false};
    }

    const helperPath = path.join(metaRoot, 'bin', HELPER_NAME);
    const helperPresence = await probe(helperPath);
    let complete: boolean;
    if (helperPresence==='present') {
        complete = await replaceHelper(metaRoot, helperPath);
    } else if (helperPresence==='absent') {
        // Nothing installed here that could accept a submission.
        complete = true;
    } else {
        console.warn(`Could not determine the state of the stale Agent Review helper at ${helperPath}; will retry.`);
        complete = false;
    }

    // `registry.json` is deliberately never written. Emptying it looks like
    // extra safety but is the precondition for the removed helper's own
    // destructive path: its `submit` deletes the entire draft directory when the
    // registry no longer lists that draft's replica root. Any old helper that
    // outlives this cleanup — one whose replacement failed above, or one already
    // mid-`submit` — would answer an emptied registry by destroying the work
    // this migration exists to preserve. It buys nothing in exchange: the helper
    // resolves its registry from its own install location
    // (`dirname(dirname(__filename))`), so a copy elsewhere never reads ours.

    const preserved = await probeDirectoryHasEntries(path.join(metaRoot, DRAFTS_DIR))==='present'
        || await hasProposalFiles(path.join(metaRoot, PROPOSALS_DIR));
    return {preserved, complete};
}

function readStringList(memento: vscode.Memento, key: string): string[] {
    const stored = memento.get<unknown>(key);
    return Array.isArray(stored)
        ? stored.filter((entry): entry is string => typeof entry==='string')
        : [];
}

function buildReportMessage(findings: Findings): string {
    const sentences = [vscode.l10n.t(
        'Agent Review was removed from Semantic Researcher Overleaf, and its draft helper now refuses every request.',
    )];

    if (findings.preservedWorkLocations.length>0) {
        sentences.push(vscode.l10n.t(
            'Draft copies and pending proposals it had created were left untouched at {location} — nothing there is read by the extension or synced to Overleaf.',
            {location: findings.preservedWorkLocations.join(', ')},
        ));
    }
    if (findings.staleInstructionFiles.length>0) {
        sentences.push(vscode.l10n.t(
            'Its instructions are still in {files}, between {start} and {end}. They no longer do anything, and these are your files, so the extension left them exactly as they are — delete that block whenever it suits you.',
            {
                files: findings.staleInstructionFiles.join(', '),
                start: MANAGED_BLOCK_START,
                end: MANAGED_BLOCK_END,
            },
        ));
    }
    if (findings.liveHelperLocations.length>0) {
        sentences.push(vscode.l10n.t(
            'The helper at {location} could not be disabled yet, so those instructions may still be followed; that will be retried the next time this window opens.',
            {location: findings.liveHelperLocations.join(', ')},
        ));
    }
    return sentences.join(' ');
}

function showReport(findings: Findings) {
    const message = buildReportMessage(findings);
    const openFile = vscode.l10n.t('Open File');
    const showFolder = vscode.l10n.t('Show Folder');
    // At most one action, and both possibilities are read-only.
    const action = findings.staleInstructionFiles.length>0
        ? openFile
        : (findings.preservedWorkLocations.length>0 ? showFolder : undefined);
    const items = action ? [action] : [];

    // Fire and forget: activation must not wait on a notification the user may
    // never dismiss.
    const shown = findings.liveHelperLocations.length>0
        ? vscode.window.showWarningMessage(message, ...items)
        : vscode.window.showInformationMessage(message, ...items);
    void shown.then(choice => {
        if (choice===openFile) {
            void vscode.window.showTextDocument(vscode.Uri.file(findings.staleInstructionFiles[0]));
        } else if (choice===showFolder) {
            void vscode.commands.executeCommand(
                'revealFileInOS',
                vscode.Uri.file(findings.preservedWorkLocations[0]),
            );
        }
    }, () => undefined);
}

// Record entries are namespaced because one storage root can be worth reporting
// for two different reasons at once, and being told about its drafts must not
// silence the warning that its helper is still live.
const reportKeys = {
    instructions: (filePath: string) => `instructions:${filePath}`,
    drafts: (location: string) => `drafts:${location}`,
    helper: (location: string) => `helper:${location}`,
};

/**
 * Reports anything the user has not already been told about.
 *
 * WHAT THE RECORD GUARANTEES. It is a de-duplication hint, not a ledger.
 * `Memento` exposes only `get`/`update` — no compare-and-swap, no transaction,
 * no versioned write — so two windows that both read before either writes will
 * lose one window's additions. Re-reading immediately before the write narrows
 * that window; nothing available here can close it.
 *
 * The consequence is bounded and one-directional. An entry is only ever added
 * after its notification has already been dispatched by the window that found
 * it, and the notification is dispatched before the record is written, so both
 * ways this can go wrong — a lost update between windows, or a crash between the
 * two steps — cost at most a repeated notification. Neither can produce a
 * finding the user is never told about, which is the only failure that matters.
 */
async function report(context: vscode.ExtensionContext, findings: Findings) {
    const alreadyReported = new Set(readStringList(context.globalState, REPORTED_KEY));
    const fresh: Findings = {
        staleInstructionFiles: findings.staleInstructionFiles
            .filter(entry => !alreadyReported.has(reportKeys.instructions(entry))),
        preservedWorkLocations: findings.preservedWorkLocations
            .filter(entry => !alreadyReported.has(reportKeys.drafts(entry))),
        liveHelperLocations: findings.liveHelperLocations
            .filter(entry => !alreadyReported.has(reportKeys.helper(entry))),
    };
    const newEntries = [
        ...fresh.staleInstructionFiles.map(reportKeys.instructions),
        ...fresh.preservedWorkLocations.map(reportKeys.drafts),
        ...fresh.liveHelperLocations.map(reportKeys.helper),
    ];
    if (newEntries.length===0) {
        return;
    }

    // Severity and the helper sentence follow the *current* state, not just what
    // is new: a still-live helper keeps the notice a warning even when the only
    // new finding is an instruction file.
    showReport({...fresh, liveHelperLocations: findings.liveHelperLocations});
    const merged = new Set([...readStringList(context.globalState, REPORTED_KEY), ...newEntries]);
    await context.globalState.update(REPORTED_KEY, [...merged]);
}

/**
 * Runs the upgrade cleanup. Safe to call on every activation: an inspected
 * folder is never looked at again, and when the user never had Agent Review it
 * does nothing and says nothing.
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
        // looking at.
        const fileRoots = workspaceRoots.filter(root => root.scheme==='file');
        const inspectedRoots = new Set(readStringList(context.workspaceState, INSPECTED_ROOTS_KEY));
        const pendingRoots = fileRoots.filter(root => !inspectedRoots.has(root.toString()));
        const storageDone = (context.globalState.get<number>(STORAGE_CLEANUP_KEY, 0))>=CLEANUP_VERSION;
        if (pendingRoots.length===0 && storageDone) {
            return;
        }

        const findings: Findings = {
            staleInstructionFiles: [],
            preservedWorkLocations: [],
            liveHelperLocations: [],
        };
        const newlyInspected: string[] = [];

        for (const root of pendingRoots) {
            // A root that is missing or unreachable right now is not "clean": a
            // disconnected mount can come back carrying a stale AGENTS.md, so it
            // must not be recorded as inspected.
            let complete = await probe(root.fsPath)==='present';

            for (const name of INSTRUCTION_FILE_NAMES) {
                const filePath = path.join(root.fsPath, name);
                const state = complete ? await inspectInstructionFile(filePath) : 'unknown';
                if (state==='stale') {
                    findings.staleInstructionFiles.push(filePath);
                } else if (state==='unknown') {
                    complete = false;
                }
            }

            // Builds before the move to global storage kept the helper, registry
            // and drafts inside each workspace folder instead. This runs per root
            // and is not gated on the global marker, so a folder added later
            // still gets its own legacy helper neutralized.
            const legacyRoot = path.join(root.fsPath, REPLICA_SETTINGS_DIR, AGENT_REVIEW_DIR);
            const legacy = await neutralizeStorageRoot(legacyRoot);
            if (legacy.preserved) {
                findings.preservedWorkLocations.push(legacyRoot);
            }
            if (!legacy.complete) {
                findings.liveHelperLocations.push(legacyRoot);
                complete = false;
            }

            if (complete) {
                newlyInspected.push(root.toString());
            }
        }

        if (!storageDone) {
            const globalRoot = path.join(context.globalStorageUri.fsPath, AGENT_REVIEW_DIR);
            const result = await neutralizeStorageRoot(globalRoot);
            if (result.preserved) {
                findings.preservedWorkLocations.push(globalRoot);
            }
            if (result.complete) {
                await context.globalState.update(STORAGE_CLEANUP_KEY, CLEANUP_VERSION);
            } else {
                findings.liveHelperLocations.push(globalRoot);
            }
        }

        await report(context, findings);

        if (newlyInspected.length>0) {
            await context.workspaceState.update(
                INSPECTED_ROOTS_KEY,
                [...new Set([
                    ...readStringList(context.workspaceState, INSPECTED_ROOTS_KEY),
                    ...newlyInspected,
                ])],
            );
        }
    } catch (error) {
        console.warn('Agent Review removal cleanup failed:', error);
    }
}
