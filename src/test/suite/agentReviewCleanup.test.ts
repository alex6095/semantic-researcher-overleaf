import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { REPLICA_SETTINGS_DIR } from '../../consts';
import { cleanupRemovedAgentReview } from '../../utils/agentReviewCleanup';

// Verbatim from the removed `src/agentReview/instructionFiles.ts`: the tests
// must exercise the literals real user files were written with, not a paraphrase.
const MANAGED_BLOCK_START = '<!-- semantic-researcher-overleaf-agent-review:start -->';
const MANAGED_BLOCK_END = '<!-- semantic-researcher-overleaf-agent-review:end -->';

const HELPER_PATH_IN_BLOCK = '/global-storage/agent-review/bin/overleaf-agent-review';

const INSTRUCTION_ROOTS_KEY = 'semantic-researcher-overleaf.agentReviewInstructionCleanupRoots';
const STORAGE_CLEANUP_KEY = 'semantic-researcher-overleaf.agentReviewStorageCleanup';
const NOTICE_KEY = 'semantic-researcher-overleaf.agentReviewPreservedNoticeLocations';

// Reproduces the shape `AgentReviewInstructionFiles` produced: the delimited
// block, and — when the file already had content — a blank-line separator in
// front of the preserved user prose.
function managedBlock() {
    return `${MANAGED_BLOCK_START}

# Semantic Researcher Overleaf Agent Review

This workspace has Overleaf Local Replica roots registered for review:

- /workspace/manuscript

When asked to make plain text edits inside existing supported LaTeX project
files under one of these roots, do not edit the source file directly. Create a
review draft instead:

1. Start a draft with:
   \`"${HELPER_PATH_IN_BLOCK}" begin --root "<LOCAL_REPLICA_ROOT>"\`
2. Edit only files under the printed \`DRAFT_ROOT\`.
3. Submit the draft with:
   \`"${HELPER_PATH_IN_BLOCK}" submit --draft "<DRAFT_ID>"\`
4. After submit succeeds, treat the requested edit as complete.

${MANAGED_BLOCK_END}
`;
}

function blockAbove(userContent: string) {
    return `${managedBlock()}\n${userContent}`;
}

// Reproduces the removed helper's destructive `submit` branch verbatim in
// behaviour: it deletes the whole draft directory when the registry no longer
// lists that draft's replica root. The cleanup must never create that
// precondition.
const ORIGINAL_HELPER = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const META_ROOT = path.dirname(path.dirname(__filename));
const REGISTRY_PATH = path.join(META_ROOT, 'registry.json');
const DRAFTS_ROOT = path.join(META_ROOT, 'drafts');
const draftDir = path.join(DRAFTS_ROOT, process.argv[4]);
const draft = JSON.parse(fs.readFileSync(path.join(draftDir, 'draft.json'), 'utf8'));
try {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const registered = (registry.replicaRoots || []).map((entry) => path.resolve(entry));
  if (!registered.includes(path.resolve(draft.rootPath || ''))) {
    fs.rmSync(draftDir, {recursive: true, force: true});
    console.error('Agent Review is disabled for ' + draft.rootPath + '; draft discarded.');
    process.exit(1);
  }
} catch (error) {
  fs.rmSync(draftDir, {recursive: true, force: true});
  console.error('Agent Review registry missing; draft discarded.');
  process.exit(1);
}
console.log('Submitted successfully. Treat the requested edit as complete.');
`;

const USER_PROSE = [
    '# Manuscript conventions',
    '',
    'Cite with \\autocite, never \\cite.',
    'Section files live under sections/.',
    '',
].join('\n');

interface ContextStub {
    context: vscode.ExtensionContext;
    globalState: Map<string, unknown>;
    workspaceState: Map<string, unknown>;
}

function createMemento(store: Map<string, unknown>) {
    return {
        get: <T>(key: string, defaultValue?: T) =>
            store.has(key) ? store.get(key) as T : defaultValue as T,
        update: async (key: string, value: unknown) => {
            if (value===undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
        },
        keys: () => [...store.keys()],
    } as unknown as vscode.Memento;
}

function createContextStub(globalStoragePath: string): ContextStub {
    const globalState = new Map<string, unknown>();
    const workspaceState = new Map<string, unknown>();
    return {
        context: {
            globalState: createMemento(globalState),
            workspaceState: createMemento(workspaceState),
            globalStorageUri: vscode.Uri.file(globalStoragePath),
        } as unknown as vscode.ExtensionContext,
        globalState,
        workspaceState,
    };
}

function completedRoots(workspaceState: Map<string, unknown>): string[] {
    return (workspaceState.get(INSTRUCTION_ROOTS_KEY) as string[] | undefined) ?? [];
}

suite('Agent Review removal cleanup', () => {
    const tempRoots: string[] = [];
    const notifications: string[] = [];
    let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
    let originalWorkspaceFoldersDescriptor: PropertyDescriptor | undefined;
    let originalOpen: typeof fs.open;
    let originalWriteFile: typeof fs.writeFile;

    setup(() => {
        notifications.length = 0;
        originalShowInformationMessage = vscode.window.showInformationMessage;
        originalOpen = fs.open;
        originalWriteFile = fs.writeFile;
        originalWorkspaceFoldersDescriptor = Object.getOwnPropertyDescriptor(
            vscode.workspace,
            'workspaceFolders',
        );
        (vscode.window as any).showInformationMessage = async (message: string) => {
            notifications.push(message);
            return undefined;
        };
    });

    teardown(async () => {
        (vscode.window as any).showInformationMessage = originalShowInformationMessage;
        (fs as any).open = originalOpen;
        (fs as any).writeFile = originalWriteFile;
        if (originalWorkspaceFoldersDescriptor) {
            Object.defineProperty(
                vscode.workspace,
                'workspaceFolders',
                originalWorkspaceFoldersDescriptor,
            );
        }
        while (tempRoots.length>0) {
            await fs.rm(tempRoots.pop()!, {recursive: true, force: true});
        }
    });

    async function tempDir(prefix: string) {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
        tempRoots.push(root);
        return root;
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

    async function writeFile(filePath: string, content: string) {
        await fs.mkdir(path.dirname(filePath), {recursive: true});
        await originalWriteFile(filePath, content);
    }

    async function readFile(filePath: string) {
        return fs.readFile(filePath, 'utf8');
    }

    async function exists(filePath: string) {
        try {
            await fs.stat(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async function listDir(dir: string) {
        return (await fs.readdir(dir)).sort();
    }

    /**
     * Simulates a save that lands between the cleanup's snapshot read and its
     * rewrite: the first read the cleanup performs through its own descriptor
     * triggers a newer revision being written to the same path behind its back.
     */
    function saveNewerRevisionDuringFirstReadOf(targetPath: string, newerContent: string) {
        (fs as any).open = async (...args: unknown[]) => {
            const handle = await (originalOpen as any)(...args);
            if (String(args[0])!==targetPath) {
                return handle;
            }
            const realRead = handle.read.bind(handle);
            let reads = 0;
            handle.read = async (...readArgs: unknown[]) => {
                const result = await realRead(...readArgs);
                reads += 1;
                if (reads===1) {
                    await originalWriteFile(targetPath, newerContent);
                }
                return result;
            };
            return handle;
        };
    }

    function failOpenOf(targetPath: string, code: string) {
        (fs as any).open = async (...args: unknown[]) => {
            if (String(args[0])===targetPath) {
                const error: NodeJS.ErrnoException = new Error(`${code}: simulated, open '${targetPath}'`);
                error.code = code;
                throw error;
            }
            return (originalOpen as any)(...args);
        };
    }

    function failWritesUnder(directory: string) {
        (fs as any).writeFile = async (...args: unknown[]) => {
            if (String(args[0]).startsWith(directory)) {
                const error: NodeJS.ErrnoException = new Error(`EACCES: simulated, write '${String(args[0])}'`);
                error.code = 'EACCES';
                throw error;
            }
            return (originalWriteFile as any)(...args);
        };
    }

    /** Installs the pre-removal global storage layout, optionally with a draft and a proposal. */
    async function installAgentReviewStorage(
        metaRoot: string,
        replicaRoot: string,
        options: {withWork?: boolean} = {},
    ) {
        await writeFile(path.join(metaRoot, 'bin', 'overleaf-agent-review'), ORIGINAL_HELPER);
        await writeFile(
            path.join(metaRoot, 'bin', 'overleaf-agent-review.cmd'),
            '@echo off\nnode "%~dp0overleaf-agent-review" %*\n',
        );
        const registryPath = path.join(metaRoot, 'registry.json');
        await writeFile(registryPath, JSON.stringify({replicaRoots: [replicaRoot]}, null, 2));
        const draftId = '20260803120000-1234-abcdef';
        const draftDir = path.join(metaRoot, 'drafts', draftId);
        const draftFile = path.join(draftDir, 'project', 'main.tex');
        const proposalPath = path.join(metaRoot, 'proposals', 'abc123def456', 'proposal-1.json');
        if (options.withWork!==false) {
            await writeFile(path.join(draftDir, 'draft.json'), JSON.stringify({
                id: draftId,
                rootPath: replicaRoot,
                workspaceRoot: metaRoot,
                baselineRoot: path.join(draftDir, 'baseline'),
                draftRoot: path.join(draftDir, 'project'),
                createdAt: '2026-08-03T12:00:00.000Z',
                updatedAt: '2026-08-03T12:00:00.000Z',
                state: 'submitted',
            }, null, 2));
            await writeFile(path.join(draftDir, 'baseline', 'main.tex'), '\\section{Results}\n');
            await writeFile(draftFile, '\\section{Results}\nThe estimator converges at the predicted rate.\n');
            await writeFile(proposalPath, JSON.stringify({id: 'proposal-1', files: []}, null, 2));
        }
        return {metaRoot, registryPath, draftId, draftDir, draftFile, proposalPath};
    }

    /**
     * Runs a helper the way an agent would. Returns the exit status, or
     * `undefined` if this environment cannot spawn a child at all.
     */
    function runHelper(helperPath: string, draftId: string) {
        try {
            childProcess.execFileSync(process.execPath, [helperPath, 'submit', '--draft', draftId], {
                // The extension host runs under Electron; this asks it to behave
                // as plain node so the helper is executed rather than a window.
                // eslint-disable-next-line @typescript-eslint/naming-convention
                env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
                stdio: 'pipe',
            });
            return 0;
        } catch (error) {
            return (error as {status?: number}).status;
        }
    }

    test('removes the managed block from AGENTS.md and CLAUDE.md with user prose intact', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-blocks-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        const claudePath = path.join(workspaceRoot, 'CLAUDE.md');
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        // A file where the user moved their own prose above the managed block.
        await writeFile(claudePath, `Team notes.\n\n${blockAbove('Trailing note.\n')}`);
        // Exercise the production default, which reads vscode.workspace.workspaceFolders.
        setWorkspaceFoldersForTest(vscode.Uri.file(workspaceRoot));
        const {context, workspaceState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context);

        assert.strictEqual(await readFile(agentsPath), USER_PROSE);
        assert.strictEqual(await readFile(claudePath), 'Team notes.\n\nTrailing note.\n');
        for (const filePath of [agentsPath, claudePath]) {
            const content = await readFile(filePath);
            assert.ok(!content.includes(MANAGED_BLOCK_START), `${filePath} still carries the start marker`);
            assert.ok(!content.includes(MANAGED_BLOCK_END), `${filePath} still carries the end marker`);
            assert.ok(!content.includes(HELPER_PATH_IN_BLOCK), `${filePath} still points at the helper`);
        }
        assert.deepStrictEqual(
            completedRoots(workspaceState),
            [vscode.Uri.file(workspaceRoot).toString()],
        );
        // Nothing to preserve, so the user is not interrupted.
        assert.strictEqual(notifications.length, 0, 'the user was interrupted with nothing to recover');
        // No stray working files left in the user's folder.
        assert.deepStrictEqual(await listDir(workspaceRoot), ['AGENTS.md', 'CLAUDE.md']);
    });

    test('deletes an instruction file that carried nothing but the managed block', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-only-block-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        await writeFile(agentsPath, managedBlock());
        const {context} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        // The feature created this file to carry the block, so removing the
        // block removes the file rather than leaving an empty one behind.
        assert.strictEqual(await exists(agentsPath), false);
        // And the aside file used to prove the delete was safe is gone too.
        assert.deepStrictEqual(await listDir(workspaceRoot), []);
    });

    test('leaves files with absent or malformed markers byte-for-byte untouched', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-malformed-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const noMarkers = `${USER_PROSE}\nNothing managed here.\n`;
        const startOnly = `${MANAGED_BLOCK_START}\n\nTruncated block, no end marker.\n\n${USER_PROSE}`;
        const reversed = `${MANAGED_BLOCK_END}\n\nEnd before start.\n\n${MANAGED_BLOCK_START}\n\n${USER_PROSE}`;
        const endOnly = `${USER_PROSE}\n${MANAGED_BLOCK_END}\n`;
        const cases: Array<[string, string]> = [
            [path.join(workspaceRoot, 'AGENTS.md'), startOnly],
            [path.join(workspaceRoot, 'CLAUDE.md'), noMarkers],
            [path.join(workspaceRoot, 'nested', 'AGENTS.md'), reversed],
            [path.join(workspaceRoot, 'nested', 'CLAUDE.md'), endOnly],
        ];
        for (const [filePath, content] of cases) {
            await writeFile(filePath, content);
        }
        const {context} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [
            vscode.Uri.file(workspaceRoot),
            vscode.Uri.file(path.join(workspaceRoot, 'nested')),
        ]);

        for (const [filePath, content] of cases) {
            assert.strictEqual(await readFile(filePath), content, `${filePath} was modified`);
        }
    });

    test('never overwrites an instruction file that was saved after the cleanup read it', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-cas-write-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        // The revision the user saves mid-cleanup. It still carries the block,
        // so the retry has something real to do.
        const newerRevision = blockAbove('# Newer revision\n\nSaved while the cleanup was deciding.\n');
        const {context, workspaceState} = createContextStub(globalStoragePath);
        saveNewerRevisionDuringFirstReadOf(agentsPath, newerRevision);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        // The concurrent save wins, byte for byte.
        assert.strictEqual(await readFile(agentsPath), newerRevision);
        // And the root is not recorded, so the stale block is retried.
        assert.deepStrictEqual(completedRoots(workspaceState), []);

        (fs as any).open = originalOpen;
        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.strictEqual(
            await readFile(agentsPath),
            '# Newer revision\n\nSaved while the cleanup was deciding.\n',
        );
        assert.deepStrictEqual(
            completedRoots(workspaceState),
            [vscode.Uri.file(workspaceRoot).toString()],
        );
    });

    test('never deletes an instruction file that stopped being block-only after the read', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-cas-delete-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        // Block-only: the snapshot the cleanup reads authorises a delete.
        await writeFile(agentsPath, managedBlock());
        const newerRevision = '# Real notes\n\nWritten while the cleanup held a block-only snapshot.\n';
        const {context, workspaceState} = createContextStub(globalStoragePath);
        saveNewerRevisionDuringFirstReadOf(agentsPath, newerRevision);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        // The worst case: deleting a file that is no longer the one we read.
        assert.strictEqual(await exists(agentsPath), true, 'a newer revision was deleted');
        assert.strictEqual(await readFile(agentsPath), newerRevision);
        assert.deepStrictEqual(completedRoots(workspaceState), []);
        // Nothing was left behind by the prove-then-delete move.
        assert.deepStrictEqual(await listDir(workspaceRoot), ['AGENTS.md']);

        (fs as any).open = originalOpen;
        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.strictEqual(await readFile(agentsPath), newerRevision);
        assert.deepStrictEqual(
            completedRoots(workspaceState),
            [vscode.Uri.file(workspaceRoot).toString()],
        );
    });

    test('neutralizes the stale helper without deleting drafts, proposals or the registry', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-helper-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const installed = await installAgentReviewStorage(path.join(globalStoragePath, 'agent-review'), workspaceRoot);
        const draftContent = await readFile(installed.draftFile);
        const proposalContent = await readFile(installed.proposalPath);
        const registryContent = await readFile(installed.registryPath);
        const {context, globalState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        // The user's unaccepted work survives, byte for byte.
        assert.strictEqual(await readFile(installed.draftFile), draftContent);
        assert.strictEqual(await readFile(installed.proposalPath), proposalContent);
        assert.strictEqual(await exists(path.join(installed.draftDir, 'draft.json')), true);
        assert.strictEqual(await exists(path.join(installed.draftDir, 'baseline', 'main.tex')), true);

        // The registry is left exactly as it was: emptying it is the removed
        // helper's own trigger for deleting a draft directory.
        assert.strictEqual(await readFile(installed.registryPath), registryContent);

        // The helper can no longer accept anything.
        const helperPath = path.join(installed.metaRoot, 'bin', 'overleaf-agent-review');
        const helper = await readFile(helperPath);
        assert.ok(!helper.includes('Submitted successfully'), 'helper still reports submissions as accepted');
        assert.ok(helper.includes('process.exit(1)'), 'helper does not fail the caller');
        assert.ok(
            helper.includes(JSON.stringify(path.join(installed.metaRoot, 'drafts'))),
            'helper does not name the drafts location',
        );
        // The stub is executed by agents, so it has to parse as JavaScript.
        // `Function` compiles without running; the shebang is stripped the way
        // node strips it.
        new Function(helper.replace(/^#![^\n]*\n/, ''));
        // No half-written staging file is left in bin/.
        assert.deepStrictEqual(
            await listDir(path.join(installed.metaRoot, 'bin')),
            ['overleaf-agent-review', 'overleaf-agent-review.cmd'],
        );

        const status = runHelper(helperPath, installed.draftId);
        if (status!==undefined) {
            assert.strictEqual(status, 1, 'the stub helper accepted a submission');
        }
        assert.strictEqual(
            await readFile(installed.draftFile),
            draftContent,
            'submitting against the stub destroyed the draft',
        );

        assert.strictEqual(globalState.get(STORAGE_CLEANUP_KEY), 1);
        assert.strictEqual(notifications.length, 1, 'the preserved-work notice was not shown exactly once');
        assert.ok(
            notifications[0].includes(installed.metaRoot),
            `the notice does not name ${installed.metaRoot}: ${notifications[0]}`,
        );
    });

    test('leaves the registry usable when the helper could not be replaced, so no draft is destroyed', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-partial-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const metaRoot = path.join(globalStoragePath, 'agent-review');
        const installed = await installAgentReviewStorage(metaRoot, workspaceRoot);
        const draftContent = await readFile(installed.draftFile);
        const registryContent = await readFile(installed.registryPath);
        const {context, globalState} = createContextStub(globalStoragePath);
        // Only the helper is unwritable — a locked or read-only executable. The
        // registry beside it stays writable, which is exactly the situation in
        // which emptying it would arm the old helper's draft-deleting branch.
        failWritesUnder(path.join(metaRoot, 'bin'));

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        const helperPath = path.join(metaRoot, 'bin', 'overleaf-agent-review');
        assert.strictEqual(await readFile(helperPath), ORIGINAL_HELPER, 'the helper was unexpectedly replaced');
        // The registry must still list the root. An emptied registry plus a
        // surviving old helper is exactly what destroys the draft.
        assert.strictEqual(await readFile(installed.registryPath), registryContent);
        assert.deepStrictEqual(
            await listDir(path.join(metaRoot, 'bin')),
            ['overleaf-agent-review', 'overleaf-agent-review.cmd'],
            'a failed replacement left staging litter behind',
        );

        (fs as any).writeFile = originalWriteFile;
        const status = runHelper(helperPath, installed.draftId);
        if (status!==undefined) {
            assert.strictEqual(status, 0, 'the surviving helper refused a root it should still know');
        }
        assert.strictEqual(await exists(installed.draftDir), true, 'the draft directory was destroyed');
        assert.strictEqual(await readFile(installed.draftFile), draftContent);

        // Nothing is marked done, so the next activation replaces the helper.
        assert.strictEqual(globalState.get(STORAGE_CLEANUP_KEY), undefined);
        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);
        assert.ok(!(await readFile(helperPath)).includes('Submitted successfully'));
        assert.strictEqual(globalState.get(STORAGE_CLEANUP_KEY), 1);
    });

    test('retries a stale instruction file it could not read instead of marking it done', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-unreadable-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        const claudePath = path.join(workspaceRoot, 'CLAUDE.md');
        const stale = blockAbove(USER_PROSE);
        await writeFile(agentsPath, stale);
        await writeFile(claudePath, stale);
        const {context, workspaceState} = createContextStub(globalStoragePath);
        failOpenOf(agentsPath, 'EACCES');

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        // Unreadable is not "no block here": the file still misleads agents.
        assert.strictEqual(await readFile(agentsPath), stale);
        assert.deepStrictEqual(completedRoots(workspaceState), [], 'an unreadable stale file was marked handled');
        // Its readable neighbour is still fixed in the same pass.
        assert.strictEqual(await readFile(claudePath), USER_PROSE);

        (fs as any).open = originalOpen;
        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.strictEqual(await readFile(agentsPath), USER_PROSE);
        assert.deepStrictEqual(
            completedRoots(workspaceState),
            [vscode.Uri.file(workspaceRoot).toString()],
        );
    });

    test('does not rescan or re-notify for a folder it already cleaned', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-idempotent-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        await installAgentReviewStorage(path.join(globalStoragePath, 'agent-review'), workspaceRoot);
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        const {context, globalState, workspaceState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);
        assert.strictEqual(await readFile(agentsPath), USER_PROSE);
        assert.strictEqual(notifications.length, 1);
        assert.strictEqual(globalState.get(STORAGE_CLEANUP_KEY), 1);
        assert.deepStrictEqual(
            completedRoots(workspaceState),
            [vscode.Uri.file(workspaceRoot).toString()],
        );

        // A block that reappears after this folder was recorded proves the
        // second activation short-circuits instead of scanning it again.
        const reintroduced = blockAbove(USER_PROSE);
        await writeFile(agentsPath, reintroduced);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.strictEqual(await readFile(agentsPath), reintroduced);
        assert.strictEqual(notifications.length, 1, 'the preserved-work notice was shown twice');
    });

    test('cleans a folder added to the workspace later, including its legacy helper', async () => {
        const firstRoot = await tempDir('sr-overleaf-agent-review-multi-a-');
        const laterRoot = await tempDir('sr-overleaf-agent-review-multi-b-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        // Global storage holds only a helper, so the only preserved work in this
        // test is the one inside the folder added later.
        await installAgentReviewStorage(
            path.join(globalStoragePath, 'agent-review'),
            firstRoot,
            {withWork: false},
        );
        await writeFile(path.join(firstRoot, 'AGENTS.md'), blockAbove(USER_PROSE));
        const {context, workspaceState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(firstRoot)]);
        assert.deepStrictEqual(
            completedRoots(workspaceState),
            [vscode.Uri.file(firstRoot).toString()],
        );
        assert.strictEqual(notifications.length, 0, 'the user was interrupted with nothing to recover');

        // The user adds a second folder to the same window. It carries its own
        // stale block, its own legacy helper and its own unaccepted draft.
        const laterAgents = path.join(laterRoot, 'CLAUDE.md');
        await writeFile(laterAgents, blockAbove(USER_PROSE));
        const legacyMeta = path.join(laterRoot, REPLICA_SETTINGS_DIR, 'agent-review');
        const legacy = await installAgentReviewStorage(legacyMeta, laterRoot);
        const legacyDraftContent = await readFile(legacy.draftFile);
        // Re-introduce a block in the finished folder: it must stay untouched.
        const reintroduced = blockAbove(USER_PROSE);
        await writeFile(path.join(firstRoot, 'AGENTS.md'), reintroduced);

        await cleanupRemovedAgentReview(context, [
            vscode.Uri.file(firstRoot),
            vscode.Uri.file(laterRoot),
        ]);

        assert.strictEqual(await readFile(laterAgents), USER_PROSE, 'the folder added later was never scanned');
        const legacyHelper = await readFile(path.join(legacyMeta, 'bin', 'overleaf-agent-review'));
        assert.ok(!legacyHelper.includes('Submitted successfully'), 'the later folder kept a live legacy helper');
        assert.strictEqual(await readFile(legacy.draftFile), legacyDraftContent);
        assert.strictEqual(await readFile(legacy.registryPath), JSON.stringify({replicaRoots: [laterRoot]}, null, 2));
        assert.strictEqual(await readFile(path.join(firstRoot, 'AGENTS.md')), reintroduced);
        assert.deepStrictEqual(
            completedRoots(workspaceState).sort(),
            [vscode.Uri.file(firstRoot).toString(), vscode.Uri.file(laterRoot).toString()].sort(),
        );
        // Exactly one notice for the newly discovered location, and none repeated.
        assert.strictEqual(notifications.length, 1);
        assert.ok(notifications[0].includes(legacyMeta));

        await cleanupRemovedAgentReview(context, [
            vscode.Uri.file(firstRoot),
            vscode.Uri.file(laterRoot),
        ]);
        assert.strictEqual(notifications.length, 1, 'a settled workspace notified again');
    });

    test('does nothing and says nothing when Agent Review was never installed', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-absent-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const readmePath = path.join(workspaceRoot, 'README.md');
        await writeFile(readmePath, USER_PROSE);
        const {context, globalState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.deepStrictEqual(await listDir(workspaceRoot), ['README.md']);
        assert.strictEqual(await readFile(readmePath), USER_PROSE);
        assert.strictEqual(await exists(globalStoragePath), false, 'global storage was created unnecessarily');
        assert.strictEqual(notifications.length, 0, 'the user was interrupted with nothing to recover');
        assert.strictEqual(globalState.get(NOTICE_KEY), undefined);
    });

    test('never throws when roots or instruction files are missing or not files', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-missing-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        // A directory where an instruction file is expected. It cannot hold a
        // managed block, so it is settled, not endlessly retried.
        await fs.mkdir(path.join(workspaceRoot, 'AGENTS.md'), {recursive: true});
        const claudePath = path.join(workspaceRoot, 'CLAUDE.md');
        await writeFile(claudePath, blockAbove(USER_PROSE));
        const missingRoot = path.join(workspaceRoot, 'does-not-exist');
        const {context, workspaceState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [
            vscode.Uri.file(missingRoot),
            vscode.Uri.file(workspaceRoot),
            // A non-file root (an unopened remote folder) must simply be skipped.
            vscode.Uri.parse('semantic-researcher-overleaf://www.overleaf.com/Project'),
        ]);

        assert.strictEqual((await fs.stat(path.join(workspaceRoot, 'AGENTS.md'))).isDirectory(), true);
        assert.strictEqual(await readFile(claudePath), USER_PROSE);
        assert.deepStrictEqual(
            completedRoots(workspaceState).sort(),
            [
                vscode.Uri.file(missingRoot).toString(),
                vscode.Uri.file(workspaceRoot).toString(),
            ].sort(),
        );
    });
});
