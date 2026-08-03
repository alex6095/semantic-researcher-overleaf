import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as nodeFs from 'fs';
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

// Workspace folders whose instruction files have been read, as URI strings. Per
// folder, not one bit for the whole window: a folder added to a multi-root
// workspace later carries its own leftovers, and a single flag would skip it
// forever. This records only that we have *read* those files — the helper's
// state is never trusted to a marker, see `inspectStorageRoot`.
const INSPECTED_ROOTS_KEY = `${ROOT_NAME}.agentReviewInspectedRoots`;
// Everything already named in a notification, so nothing is reported twice.
const REPORTED_KEY = `${ROOT_NAME}.agentReviewReported`;

// Identifies our stub. Cheap to check and impossible to produce by accident, so
// "is the installed helper ours?" is a substring test rather than a stored flag.
const HELPER_STUB_MARKER = `${ROOT_NAME}:agent-review-helper-disabled:v1`;
// The stub is well under a kilobyte. Anything larger cannot be ours, so the
// per-activation identity check stays bounded whatever is at that path.
const MAX_HELPER_BYTES = 64 * 1024;

// Coalesces the burst a single replacement produces (staged write, chmod,
// rename) into one reaction.
const HELPER_WATCH_DEBOUNCE_MS = 250;
// After an attempted replacement, hold off for this long. A replacement that
// keeps failing also produces events, and without this those events would
// re-trigger the attempt that produced them.
const HELPER_WATCH_COOLDOWN_MS = 5000;
// While the helper cannot be made ours, re-try on a backoff. A failed
// replacement can fail *before* touching the directory — a staging write into a
// bin/ that refuses new files never lands — so there is no event to retry on and
// the check has to schedule its own. The rate is bounded, the number of attempts
// deliberately is not: giving up would leave an accepting helper live for the
// rest of the session, which is the failure this whole migration exists to stop.
const HELPER_RETRY_BASE_MS = 5000;
const HELPER_RETRY_MAX_MS = 5*60*1000;

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
    /** Whether the location still holds drafts or proposals worth reporting. */
    preserved: Presence;
    /** The helper is definitively ours, or definitively not there. */
    complete: boolean;
}

export interface AgentReviewHelperWatch {
    dispose(): void;
    /**
     * Resolves once the watcher is armed, or has decided there is nothing to
     * arm. Nothing in production waits on this; it exists so a test can drive
     * the watcher instead of sleeping and hoping.
     */
    readonly armed: Promise<void>;
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
// ${HELPER_STUB_MARKER}
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
// so an empty hash directory must not be reported as recoverable work. An
// unreadable one must not be reported as empty either: that would turn real
// preserved work into silence.
async function probeProposalFiles(proposalsRoot: string): Promise<Presence> {
    let entries: string[];
    try {
        entries = await fs.readdir(proposalsRoot);
    } catch (error) {
        return presenceFromError(error);
    }

    let uncertain = false;
    for (const entry of entries) {
        const fullPath = path.join(proposalsRoot, entry);
        let isDirectory: boolean;
        try {
            isDirectory = (await fs.stat(fullPath)).isDirectory();
        } catch (error) {
            if (presenceFromError(error)==='unknown') {
                uncertain = true;
            }
            // Otherwise it vanished between readdir and stat; nothing to report.
            continue;
        }
        if (!isDirectory) {
            return 'present';
        }
        const nested = await probeDirectoryHasEntries(fullPath);
        if (nested==='present') {
            return 'present';
        }
        if (nested==='unknown') {
            uncertain = true;
        }
    }
    return uncertain ? 'unknown' : 'absent';
}

/**
 * Is the installed helper the stub we wrote?
 *
 * This is deliberately a property of the file rather than a stored flag. A
 * pre-upgrade window that is still running re-runs the removed
 * `ensureHelperInstalled()` on every Local Replica activation, which overwrites
 * our stub with the accepting script again; a "we already did this" marker would
 * make every window trust a helper that is live once more.
 */
async function inspectHelper(helperPath: string): Promise<'ours' | 'foreign' | 'absent' | 'unknown'> {
    let stat: {isFile(): boolean, size: number};
    try {
        stat = await fs.stat(helperPath);
    } catch (error) {
        return presenceFromError(error)==='absent' ? 'absent' : 'unknown';
    }
    if (!stat.isFile() || stat.size>MAX_HELPER_BYTES) {
        return 'foreign';
    }
    try {
        return (await fs.readFile(helperPath, 'utf8')).includes(HELPER_STUB_MARKER) ? 'ours' : 'foreign';
    } catch (error) {
        return presenceFromError(error)==='absent' ? 'absent' : 'unknown';
    }
}

/**
 * Makes the helper at one storage root ours, if it is not already.
 *
 * `attempted` reports whether a replacement was actually tried, which is what
 * the watcher uses to keep the events its own write produces from re-triggering
 * it.
 */
async function ensureHelperNeutralized(metaRoot: string): Promise<{complete: boolean, attempted: boolean}> {
    const helperPath = path.join(metaRoot, 'bin', HELPER_NAME);
    const helper = await inspectHelper(helperPath);
    if (helper==='ours' || helper==='absent') {
        // Already neutralized, or nothing installed that could accept a
        // submission. This is the steady state: one stat plus one small read,
        // and — importantly for the watcher — no write.
        return {complete: true, attempted: false};
    }
    if (helper==='foreign') {
        // Either the first run after the upgrade, or a still-running pre-upgrade
        // window has re-installed the accepting helper behind us.
        console.warn(`Disabling an active Agent Review helper at ${helperPath}.`);
        return {complete: await replaceHelper(metaRoot, helperPath), attempted: true};
    }
    console.warn(`Could not determine the state of the Agent Review helper at ${helperPath}; will retry.`);
    return {complete: false, attempted: false};
}

/**
 * Verifies — and if necessary restores — the neutralized helper at one storage
 * root, and reports whether that root still holds drafts or proposals.
 *
 * This runs on every activation rather than once, and asks the filesystem rather
 * than a stored marker. "We disabled it once" is not a safe thing to remember:
 * an extension host from before the upgrade re-installs the accepting helper
 * whenever it activates a Local Replica, and a one-shot marker would leave every
 * window trusting a helper that is live again.
 *
 * Never removes drafts or proposals: they can hold real manuscript work an agent
 * produced but the user never accepted. `complete` is true only when the helper
 * is definitively ours or definitively absent — a probe that merely failed
 * leaves it false rather than passing a live helper off as handled.
 */
async function inspectStorageRoot(metaRoot: string): Promise<StorageOutcome> {
    const metaPresence = await probe(metaRoot);
    if (metaPresence==='absent') {
        // The feature was never used here. Do nothing, say nothing. For almost
        // every user this single `stat` is the whole cost of the check.
        return {preserved: 'absent', complete: true};
    }
    if (metaPresence==='unknown') {
        console.warn(`Could not determine whether stale Agent Review storage exists at ${metaRoot}; will retry.`);
        return {preserved: 'unknown', complete: false};
    }

    const {complete} = await ensureHelperNeutralized(metaRoot);

    // `registry.json` is deliberately never written. Emptying it looks like
    // extra safety but is the precondition for the removed helper's own
    // destructive path: its `submit` deletes the entire draft directory when the
    // registry no longer lists that draft's replica root. Any old helper that
    // outlives this cleanup — one whose replacement failed above, or one already
    // mid-`submit` — would answer an emptied registry by destroying the work
    // this migration exists to preserve. It buys nothing in exchange: the helper
    // resolves its registry from its own install location
    // (`dirname(dirname(__filename))`), so a copy elsewhere never reads ours.

    const drafts = await probeDirectoryHasEntries(path.join(metaRoot, DRAFTS_DIR));
    if (drafts==='present') {
        return {preserved: 'present', complete};
    }
    const proposals = await probeProposalFiles(path.join(metaRoot, PROPOSALS_DIR));
    if (proposals==='present') {
        return {preserved: 'present', complete};
    }
    // Unreadable is not empty. What actually keeps briefly unreadable work from
    // being buried is that storage is re-probed on every activation and nothing
    // records "there was nothing here" — so it is reported as soon as it can be
    // read. This tri-state is kept so that stays true: anything that ever gates
    // on "no preserved work" must not be able to mistake "could not tell" for
    // "there is none", which is exactly how the old completion marker buried it.
    const preserved: Presence = drafts==='unknown' || proposals==='unknown' ? 'unknown' : 'absent';
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
 * Keeps the neutralized helper neutralized for the lifetime of the window.
 *
 * Checking on activation closes every interval except the one that matters
 * most: the one after the last check. A pre-upgrade extension host that is still
 * running re-installs the accepting helper whenever it activates a Local
 * Replica, and until something looks again an agent can follow the leftover
 * instructions, get a successful `submit`, and strand real work.
 *
 * Only global storage is watched. That is where the removed
 * `ensureHelperInstalled()` writes — `metaRootPath` is
 * `globalStorageUri/agent-review` — and the same build's
 * `migrateLegacyWorkspaceMeta()` deletes the per-workspace copies, so no live
 * writer targets those. They stay covered by the activation-time check.
 *
 * Nothing is armed unless `bin/` already exists, so a user who never had Agent
 * Review pays one `stat` and no watcher. If `bin/` is absent there is no helper
 * to resurrect; should it appear later, the next activation catches it.
 */
export function watchAgentReviewHelper(context: vscode.ExtensionContext): AgentReviewHelperWatch {
    let watcher: nodeFs.FSWatcher | undefined;
    let timer: NodeJS.Timeout | undefined;
    let disposed = false;
    let cooldownUntil = 0;
    // A check is in flight. Coalesced, never dropped: see `react`.
    let running = false;
    // Something changed that no check has looked at yet.
    let pending = false;
    // Consecutive checks that could not leave the helper ours; drives the retry
    // backoff and is reset the moment one succeeds.
    let failures = 0;

    const retryDelay = () => Math.min(HELPER_RETRY_BASE_MS*(2**(failures-1)), HELPER_RETRY_MAX_MS);

    const stop = () => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        try {
            watcher?.close();
        } catch {
            // Already closed, or the handle died with the directory.
        }
        watcher = undefined;
    };

    const scheduleIn = (metaRoot: string, delayMs: number) => {
        if (disposed) {
            return;
        }
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = undefined;
            void react(metaRoot);
        }, delayMs);
        timer.unref?.();
    };

    /**
     * Re-checks the helper, deferring rather than dropping.
     *
     * The cooldown and the in-flight flag both rate-limit the *work*; neither
     * may discard the *knowledge* that something changed. A second pre-upgrade
     * window reinstalling the helper while we are cooling down is exactly the
     * case that matters, and silently returning here would leave that accepting
     * helper live indefinitely.
     */
    const react = async (metaRoot: string) => {
        // Disposal is re-checked here as well as at scheduling time: the debounce
        // may have elapsed after the extension shut down. An attempt already in
        // flight is allowed to finish — its only effect is making the helper
        // ours, which is harmless at any time.
        if (disposed) {
            return;
        }
        if (running) {
            pending = true;
            return;
        }
        const cooldownRemaining = cooldownUntil-Date.now();
        if (cooldownRemaining>0) {
            pending = true;
            scheduleIn(metaRoot, cooldownRemaining);
            return;
        }

        running = true;
        pending = false;
        try {
            const {complete, attempted} = await ensureHelperNeutralized(metaRoot);
            if (attempted) {
                // Our own staged write, chmod and rename are about to fire this
                // very watcher. Holding off briefly keeps a replacement — including
                // one that fails and retries — from feeding itself.
                cooldownUntil = Date.now()+HELPER_WATCH_COOLDOWN_MS;
            }
            if (complete) {
                failures = 0;
            } else {
                // "We could not do it" must not become silence. A live helper is
                // the one state in which the leftover instruction blocks are not
                // inert, so it is the one worth interrupting the user for. The
                // shared record keeps that to once per location.
                failures += 1;
                await report(context, {
                    staleInstructionFiles: [],
                    preservedWorkLocations: [],
                    liveHelperLocations: [metaRoot],
                });
            }
        } catch (error) {
            console.warn('Agent Review helper watch could not re-check the helper:', error);
        } finally {
            running = false;
            if (!disposed) {
                const cooldownRemaining = cooldownUntil-Date.now();
                if (failures>0) {
                    // Nothing else will wake us: schedule our own retry.
                    scheduleIn(metaRoot, Math.max(retryDelay(), cooldownRemaining));
                } else if (pending) {
                    // Something changed while that check was running.
                    scheduleIn(metaRoot, Math.max(HELPER_WATCH_DEBOUNCE_MS, cooldownRemaining));
                }
            }
        }
    };

    const armed = (async () => {
        try {
            const metaRoot = path.join(context.globalStorageUri.fsPath, AGENT_REVIEW_DIR);
            const binRoot = path.join(metaRoot, 'bin');
            if (await probe(binRoot)!=='present' || disposed) {
                return;
            }
            // `persistent: false` so this can never hold the host process open.
            watcher = nodeFs.watch(binRoot, {persistent: false}, () => {
                scheduleIn(metaRoot, HELPER_WATCH_DEBOUNCE_MS);
            });
            watcher.on('error', error => {
                // Watch limits, an unmounted path, a deleted directory: give up
                // quietly. The activation-time check still covers this window.
                console.warn(`Agent Review helper watch stopped for ${binRoot}:`, error);
                stop();
            });
            if (disposed) {
                stop();
                return;
            }
            // Production arms this *after* the activation-time cleanup, and a
            // watcher only reports what happens once it exists. A pre-upgrade
            // window that reinstalled the helper in between produced no event for
            // anyone, so the gap is closed by looking rather than by assuming it
            // was empty.
            await react(metaRoot);
        } catch (error) {
            console.warn('Could not watch the Agent Review helper directory:', error);
        }
    })();

    return {
        armed,
        dispose: () => {
            disposed = true;
            stop();
        },
    };
}

/**
 * Runs the upgrade cleanup. Cheap enough to call on every activation and
 * whenever the workspace gains a folder.
 *
 * Two different jobs with two different lifetimes:
 *
 * - The helper must be ours *now*, so every storage root is re-verified on every
 *   call and nothing about it is remembered. For a user who never had Agent
 *   Review that costs one `stat` per root; for one who did, a `stat` plus a
 *   sub-kilobyte read.
 * - The instruction files are only read, and the leftover text is inert once the
 *   helper refuses, so each folder is read once and then remembered.
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
        const findings: Findings = {
            staleInstructionFiles: [],
            preservedWorkLocations: [],
            liveHelperLocations: [],
        };

        // Builds before the move to global storage kept the helper, registry and
        // drafts inside each workspace folder, so both locations are checked —
        // and both are checked every time, never gated on a stored marker.
        const storageRoots = [
            path.join(context.globalStorageUri.fsPath, AGENT_REVIEW_DIR),
            ...fileRoots.map(root => path.join(root.fsPath, REPLICA_SETTINGS_DIR, AGENT_REVIEW_DIR)),
        ];
        for (const metaRoot of storageRoots) {
            const outcome = await inspectStorageRoot(metaRoot);
            if (outcome.preserved==='present') {
                findings.preservedWorkLocations.push(metaRoot);
            }
            if (!outcome.complete) {
                findings.liveHelperLocations.push(metaRoot);
            }
        }

        const inspectedRoots = new Set(readStringList(context.workspaceState, INSPECTED_ROOTS_KEY));
        const newlyInspected: string[] = [];
        for (const root of fileRoots.filter(candidate => !inspectedRoots.has(candidate.toString()))) {
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

            if (complete) {
                newlyInspected.push(root.toString());
            }
        }

        // Reported before anything is recorded, for the same reason the report
        // record itself is written last: a crash or a rejected write must cost a
        // repeat, never a finding the user is never shown.
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
