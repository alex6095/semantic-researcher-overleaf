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

// A stand-in for the installed helper: enough of the original that the
// assertions below are about behaviour that actually changed.
const ORIGINAL_HELPER = `#!/usr/bin/env node
const fs = require('fs');
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

suite('Agent Review removal cleanup', () => {
    const tempRoots: string[] = [];
    const notifications: string[] = [];
    let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
    let originalWorkspaceFoldersDescriptor: PropertyDescriptor | undefined;

    setup(() => {
        notifications.length = 0;
        originalShowInformationMessage = vscode.window.showInformationMessage;
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
        await fs.writeFile(filePath, content);
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

    /** Installs the pre-removal global storage layout, including one draft and one proposal. */
    async function installAgentReviewStorage(globalStoragePath: string, replicaRoot: string) {
        const metaRoot = path.join(globalStoragePath, 'agent-review');
        await writeFile(path.join(metaRoot, 'bin', 'overleaf-agent-review'), ORIGINAL_HELPER);
        await writeFile(
            path.join(metaRoot, 'bin', 'overleaf-agent-review.cmd'),
            '@echo off\nnode "%~dp0overleaf-agent-review" %*\n',
        );
        await writeFile(
            path.join(metaRoot, 'registry.json'),
            JSON.stringify({replicaRoots: [replicaRoot]}, null, 2),
        );
        const draftId = '20260803120000-1234-abcdef';
        const draftDir = path.join(metaRoot, 'drafts', draftId);
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
        await writeFile(
            path.join(draftDir, 'project', 'main.tex'),
            '\\section{Results}\nThe estimator converges at the predicted rate.\n',
        );
        const proposalPath = path.join(metaRoot, 'proposals', 'abc123def456', 'proposal-1.json');
        await writeFile(proposalPath, JSON.stringify({id: 'proposal-1', files: []}, null, 2));
        return {metaRoot, draftId, draftDir, proposalPath};
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
        assert.strictEqual(workspaceState.get('semantic-researcher-overleaf.agentReviewInstructionCleanup'), 1);
        // Nothing to preserve, so the user is not interrupted.
        assert.deepStrictEqual(notifications, []);
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

    test('neutralizes the stale helper without deleting drafts or proposals', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-helper-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const installed = await installAgentReviewStorage(globalStoragePath, workspaceRoot);
        const draftContent = await readFile(path.join(installed.draftDir, 'project', 'main.tex'));
        const proposalContent = await readFile(installed.proposalPath);
        const {context} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        // The user's unaccepted work survives, byte for byte.
        assert.strictEqual(
            await readFile(path.join(installed.draftDir, 'project', 'main.tex')),
            draftContent,
        );
        assert.strictEqual(await readFile(installed.proposalPath), proposalContent);
        assert.strictEqual(await exists(path.join(installed.draftDir, 'draft.json')), true);
        assert.strictEqual(await exists(path.join(installed.draftDir, 'baseline', 'main.tex')), true);

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

        // No replica root is registered any more.
        assert.deepStrictEqual(JSON.parse(await readFile(path.join(installed.metaRoot, 'registry.json'))), {
            replicaRoots: [],
        });

        // Running the stub must fail and must not destroy the draft the way the
        // original helper did when the registry no longer listed the root.
        let exitStatus: number | undefined;
        let spawnFailure: string | undefined;
        try {
            childProcess.execFileSync(process.execPath, [helperPath, 'submit', '--draft', installed.draftId], {
                // The extension host runs under Electron; this asks it to behave
                // as plain node so the stub is executed rather than a window.
                // eslint-disable-next-line @typescript-eslint/naming-convention
                env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
                stdio: 'pipe',
            });
            exitStatus = 0;
        } catch (error) {
            exitStatus = (error as {status?: number}).status ?? undefined;
            spawnFailure = (error as {code?: string}).code;
        }
        if (exitStatus!==undefined) {
            assert.strictEqual(exitStatus, 1, 'the stub helper accepted a submission');
        } else {
            // Only reached if this environment cannot spawn a child process at
            // all; the compile check above still covers the stub's validity.
            assert.ok(spawnFailure, 'child process neither ran nor reported a spawn failure');
        }
        assert.strictEqual(
            await readFile(path.join(installed.draftDir, 'project', 'main.tex')),
            draftContent,
            'submitting against the stub destroyed the draft',
        );

        assert.strictEqual(notifications.length, 1, 'the preserved-work notice was not shown exactly once');
        assert.ok(
            notifications[0].includes(installed.metaRoot),
            `the notice does not name ${installed.metaRoot}: ${notifications[0]}`,
        );
    });

    test('runs once: a second activation neither rescans nor re-notifies', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-idempotent-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        await installAgentReviewStorage(globalStoragePath, workspaceRoot);
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        const {context, globalState, workspaceState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);
        assert.strictEqual(await readFile(agentsPath), USER_PROSE);
        assert.strictEqual(notifications.length, 1);
        assert.strictEqual(globalState.get('semantic-researcher-overleaf.agentReviewStorageCleanup'), 1);
        assert.strictEqual(globalState.get('semantic-researcher-overleaf.agentReviewPreservedNotice'), true);
        assert.strictEqual(workspaceState.get('semantic-researcher-overleaf.agentReviewInstructionCleanup'), 1);

        // A block that reappears after the migration recorded itself proves the
        // second activation short-circuits instead of scanning again.
        const reintroduced = blockAbove(USER_PROSE);
        await writeFile(agentsPath, reintroduced);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.strictEqual(await readFile(agentsPath), reintroduced);
        assert.strictEqual(notifications.length, 1, 'the preserved-work notice was shown twice');
    });

    test('does nothing and says nothing when Agent Review was never installed', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-absent-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const readmePath = path.join(workspaceRoot, 'README.md');
        await writeFile(readmePath, USER_PROSE);
        const {context, globalState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.deepStrictEqual(await fs.readdir(workspaceRoot), ['README.md']);
        assert.strictEqual(await readFile(readmePath), USER_PROSE);
        assert.strictEqual(await exists(globalStoragePath), false, 'global storage was created unnecessarily');
        assert.deepStrictEqual(notifications, []);
        assert.strictEqual(globalState.get('semantic-researcher-overleaf.agentReviewPreservedNotice'), undefined);
    });

    test('never throws when roots or instruction files are missing or unreadable', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-unreadable-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        // A directory where an instruction file is expected: every read of it
        // fails, exactly like a permission-denied file.
        await fs.mkdir(path.join(workspaceRoot, 'AGENTS.md'), {recursive: true});
        const claudePath = path.join(workspaceRoot, 'CLAUDE.md');
        await writeFile(claudePath, blockAbove(USER_PROSE));
        const missingRoot = path.join(workspaceRoot, 'does-not-exist');
        const {context} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [
            vscode.Uri.file(missingRoot),
            vscode.Uri.file(workspaceRoot),
            // A non-file root (an unopened remote folder) must simply be skipped.
            vscode.Uri.parse('semantic-researcher-overleaf://www.overleaf.com/Project'),
        ]);

        assert.strictEqual((await fs.stat(path.join(workspaceRoot, 'AGENTS.md'))).isDirectory(), true);
        // The unreadable neighbour must not stop the readable file being fixed.
        assert.strictEqual(await readFile(claudePath), USER_PROSE);
    });

    test('neutralizes a legacy workspace-local helper without touching its drafts', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-legacy-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const legacyRoot = path.join(workspaceRoot, REPLICA_SETTINGS_DIR, 'agent-review');
        const legacyHelper = path.join(legacyRoot, 'bin', 'overleaf-agent-review');
        const legacyDraft = path.join(legacyRoot, 'drafts', 'legacy-draft', 'project', 'main.tex');
        await writeFile(legacyHelper, ORIGINAL_HELPER);
        await writeFile(path.join(legacyRoot, 'registry.json'), JSON.stringify({replicaRoots: [workspaceRoot]}));
        await writeFile(legacyDraft, '\\section{Legacy}\n');
        const {context} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.ok(!(await readFile(legacyHelper)).includes('Submitted successfully'));
        assert.strictEqual(await readFile(legacyDraft), '\\section{Legacy}\n');
        assert.strictEqual(notifications.length, 1);
        assert.ok(notifications[0].includes(legacyRoot));
    });
});
