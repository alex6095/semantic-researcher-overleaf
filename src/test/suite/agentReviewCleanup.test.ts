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

const INSPECTED_ROOTS_KEY = 'semantic-researcher-overleaf.agentReviewInspectedRoots';
const STORAGE_CLEANUP_KEY = 'semantic-researcher-overleaf.agentReviewStorageCleanup';
const REPORTED_KEY = 'semantic-researcher-overleaf.agentReviewReported';

// Every `fs/promises` entry point that can change or destroy a file. The
// migration must not call any of them on an instruction file under any
// interleaving — that is what makes the concurrency question moot rather than
// merely narrow.
const MUTATING_FS_CALLS = [
    'writeFile', 'appendFile', 'truncate', 'unlink', 'rm', 'rmdir',
    'rename', 'copyFile', 'link', 'symlink', 'chmod', 'chown', 'utimes', 'mkdir',
] as const;

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

// Reproduces the removed helper's destructive `submit` branch in behaviour: it
// deletes the whole draft directory when the registry no longer lists that
// draft's replica root. The cleanup must never create that precondition.
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

// The record namespaces its entries, because one storage root can be worth
// reporting for two different reasons at once.
const reportKeys = {
    instructions: (filePath: string) => `instructions:${filePath}`,
    drafts: (location: string) => `drafts:${location}`,
    helper: (location: string) => `helper:${location}`,
};

function createContextStub(
    globalStoragePath: string,
    // Shared between two stubs to model two windows of the same installation.
    sharedGlobalState = new Map<string, unknown>(),
): ContextStub {
    const globalState = sharedGlobalState;
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

function storedList(state: Map<string, unknown>, key: string): string[] {
    return ((state.get(key) as string[] | undefined) ?? []).slice().sort();
}

suite('Agent Review removal cleanup', () => {
    const tempRoots: string[] = [];
    const notifications: string[] = [];
    const warnings: string[] = [];
    let originalShowInformationMessage: typeof vscode.window.showInformationMessage;
    let originalShowWarningMessage: typeof vscode.window.showWarningMessage;
    let originalWorkspaceFoldersDescriptor: PropertyDescriptor | undefined;
    const originalFsCalls = new Map<string, unknown>();

    setup(() => {
        notifications.length = 0;
        warnings.length = 0;
        originalShowInformationMessage = vscode.window.showInformationMessage;
        originalShowWarningMessage = vscode.window.showWarningMessage;
        originalWorkspaceFoldersDescriptor = Object.getOwnPropertyDescriptor(
            vscode.workspace,
            'workspaceFolders',
        );
        for (const name of ['open', 'readFile', 'stat', 'mkdtemp', ...MUTATING_FS_CALLS]) {
            originalFsCalls.set(name, (fs as any)[name]);
        }
        (vscode.window as any).showInformationMessage = async (message: string) => {
            notifications.push(message);
            return undefined;
        };
        (vscode.window as any).showWarningMessage = async (message: string) => {
            warnings.push(message);
            return undefined;
        };
    });

    teardown(async () => {
        (vscode.window as any).showInformationMessage = originalShowInformationMessage;
        (vscode.window as any).showWarningMessage = originalShowWarningMessage;
        for (const [name, implementation] of originalFsCalls) {
            (fs as any)[name] = implementation;
        }
        while (tempRoots.length>0) {
            await fs.rm(tempRoots.pop()!, {recursive: true, force: true});
        }
        originalFsCalls.clear();
    });

    function realFs<T>(name: string): T {
        return originalFsCalls.get(name) as T;
    }

    async function tempDir(prefix: string) {
        const root = await realFs<typeof fs.mkdtemp>('mkdtemp')(path.join(os.tmpdir(), prefix));
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
        await realFs<typeof fs.mkdir>('mkdir')(path.dirname(filePath), {recursive: true});
        await realFs<typeof fs.writeFile>('writeFile')(filePath, content);
    }

    async function readFile(filePath: string): Promise<string> {
        return realFs<(p: string, e: string) => Promise<string>>('readFile')(filePath, 'utf8');
    }

    async function exists(filePath: string) {
        try {
            await realFs<typeof fs.stat>('stat')(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async function listDir(dir: string) {
        return (await fs.readdir(dir)).sort();
    }

    /** Identity + content, so any rewrite, replace or delete becomes detectable. */
    async function snapshot(filePath: string) {
        const stat = await realFs<typeof fs.stat>('stat')(filePath);
        return {
            content: await readFile(filePath),
            ino: stat.ino,
            dev: stat.dev,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
        };
    }

    /**
     * Records every mutating `fs/promises` call aimed at one of `guarded`, and
     * makes each of them fail, so a migration that tried to write would be both
     * caught and unable to do damage.
     */
    function guardAgainstMutationOf(guarded: string[]) {
        const violations: string[] = [];
        const refuse = (label: string) => {
            violations.push(label);
            const error: NodeJS.ErrnoException = new Error('EPERM: guarded by test');
            error.code = 'EPERM';
            throw error;
        };
        for (const name of MUTATING_FS_CALLS) {
            const real = realFs<(...args: unknown[]) => unknown>(name);
            (fs as any)[name] = async (...args: unknown[]) => {
                if (guarded.includes(String(args[0]))) {
                    refuse(`${name}(${String(args[0])})`);
                }
                return real(...args);
            };
        }
        // A writable descriptor is the other way to change a file.
        const realOpen = realFs<(...args: unknown[]) => Promise<unknown>>('open');
        (fs as any).open = async (...args: unknown[]) => {
            const flags = args[1]===undefined ? 'r' : String(args[1]);
            if (guarded.includes(String(args[0])) && flags!=='r') {
                refuse(`open(${String(args[0])}, ${flags})`);
            }
            return realOpen(...args);
        };
        return violations;
    }

    /**
     * Simulates the exact interleaving earlier reviews called out: a save that
     * lands *after* the migration has read the file — after any comparison it
     * could possibly have made — but before it could act on that snapshot.
     */
    function saveNewerRevisionAfterReadOf(targetPath: string, newerContent: string) {
        const realReadFile = realFs<(...args: unknown[]) => Promise<unknown>>('readFile');
        (fs as any).readFile = async (...args: unknown[]) => {
            const result = await realReadFile(...args);
            if (String(args[0])===targetPath) {
                await realFs<typeof fs.writeFile>('writeFile')(targetPath, newerContent);
            }
            return result;
        };
    }

    function failStatOf(targetPath: string, code: string) {
        const realStat = realFs<(...args: unknown[]) => unknown>('stat');
        (fs as any).stat = async (...args: unknown[]) => {
            if (String(args[0])===targetPath) {
                const error: NodeJS.ErrnoException = new Error(`${code}: simulated`);
                error.code = code;
                throw error;
            }
            return realStat(...args);
        };
    }

    function failReadOf(targetPath: string, code: string) {
        const realReadFile = realFs<(...args: unknown[]) => unknown>('readFile');
        (fs as any).readFile = async (...args: unknown[]) => {
            if (String(args[0])===targetPath) {
                const error: NodeJS.ErrnoException = new Error(`${code}: simulated`);
                error.code = code;
                throw error;
            }
            return realReadFile(...args);
        };
    }

    function failWritesUnder(directory: string) {
        const real = realFs<(...args: unknown[]) => unknown>('writeFile');
        (fs as any).writeFile = async (...args: unknown[]) => {
            if (String(args[0]).startsWith(directory)) {
                const error: NodeJS.ErrnoException = new Error('EACCES: simulated');
                error.code = 'EACCES';
                throw error;
            }
            return real(...args);
        };
    }

    /** Installs the pre-removal storage layout, optionally with a draft and a proposal. */
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

    test('never writes to or deletes an instruction file, even when one is saved mid-run', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-readonly-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        await installAgentReviewStorage(path.join(globalStoragePath, 'agent-review'), workspaceRoot);
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        const claudePath = path.join(workspaceRoot, 'CLAUDE.md');
        // The worst case for the removed rewrite: one file it would have edited,
        // one whose entire content was the block and which it would have deleted.
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        await writeFile(claudePath, managedBlock());
        const newerRevision = '# Real notes\n\nSaved after the migration read the file.\n';
        const violations = guardAgainstMutationOf([agentsPath, claudePath]);
        saveNewerRevisionAfterReadOf(claudePath, newerRevision);
        const agentsBefore = await snapshot(agentsPath);
        const {context} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.deepStrictEqual(violations, [], 'the migration attempted to mutate an instruction file');
        // Untouched: same inode, same bytes, same timestamp.
        assert.deepStrictEqual(await snapshot(agentsPath), agentsBefore);
        // And the revision saved mid-run is still there, in full.
        assert.strictEqual(await exists(claudePath), true, 'a block-only file was deleted');
        assert.strictEqual(await readFile(claudePath), newerRevision);
        assert.deepStrictEqual(await listDir(workspaceRoot), ['AGENTS.md', 'CLAUDE.md']);
    });

    test('reports the files that still carry the block, the markers and the drafts location', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-report-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const installed = await installAgentReviewStorage(
            path.join(globalStoragePath, 'agent-review'),
            workspaceRoot,
        );
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        const claudePath = path.join(workspaceRoot, 'CLAUDE.md');
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        await writeFile(claudePath, `Team notes.\n\n${blockAbove('Trailing note.\n')}`);
        // Exercise the production default, which reads vscode.workspace.workspaceFolders.
        setWorkspaceFoldersForTest(vscode.Uri.file(workspaceRoot));
        const {context, globalState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context);

        assert.strictEqual(warnings.length, 0, 'the helper was disabled, so this is not a warning');
        assert.strictEqual(notifications.length, 1, 'the user was not told exactly once');
        const notice = notifications[0];
        for (const expected of [
            agentsPath,
            claudePath,
            MANAGED_BLOCK_START,
            MANAGED_BLOCK_END,
            installed.metaRoot,
        ]) {
            assert.ok(notice.includes(expected), `the notice does not mention ${expected}: ${notice}`);
        }
        assert.deepStrictEqual(
            storedList(globalState, REPORTED_KEY),
            [
                reportKeys.instructions(agentsPath),
                reportKeys.instructions(claudePath),
                reportKeys.drafts(installed.metaRoot),
            ].sort(),
        );
    });

    test('does not report files whose markers are absent or malformed', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-malformed-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const startOnly = `${MANAGED_BLOCK_START}\n\nTruncated block, no end marker.\n\n${USER_PROSE}`;
        const reversed = `${MANAGED_BLOCK_END}\n\nEnd before start.\n\n${MANAGED_BLOCK_START}\n\n${USER_PROSE}`;
        const cases: Array<[string, string]> = [
            [path.join(workspaceRoot, 'AGENTS.md'), startOnly],
            [path.join(workspaceRoot, 'CLAUDE.md'), `${USER_PROSE}\nNothing managed here.\n`],
            [path.join(workspaceRoot, 'nested', 'AGENTS.md'), reversed],
            [path.join(workspaceRoot, 'nested', 'CLAUDE.md'), `${USER_PROSE}\n${MANAGED_BLOCK_END}\n`],
        ];
        for (const [filePath, content] of cases) {
            await writeFile(filePath, content);
        }
        const {context, workspaceState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [
            vscode.Uri.file(workspaceRoot),
            vscode.Uri.file(path.join(workspaceRoot, 'nested')),
        ]);

        for (const [filePath, content] of cases) {
            assert.strictEqual(await readFile(filePath), content, `${filePath} was modified`);
        }
        assert.strictEqual(notifications.length, 0, 'a malformed marker pair was reported as ours');
        assert.deepStrictEqual(
            storedList(workspaceState, INSPECTED_ROOTS_KEY),
            [
                vscode.Uri.file(workspaceRoot).toString(),
                vscode.Uri.file(path.join(workspaceRoot, 'nested')).toString(),
            ].sort(),
        );
    });

    test('neutralizes the stale helper without deleting drafts, proposals or the registry', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-helper-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const installed = await installAgentReviewStorage(
            path.join(globalStoragePath, 'agent-review'),
            workspaceRoot,
        );
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

        const helperPath = path.join(installed.metaRoot, 'bin', 'overleaf-agent-review');
        const helper = await readFile(helperPath);
        assert.ok(!helper.includes('Submitted successfully'), 'helper still reports submissions as accepted');
        assert.ok(helper.includes('process.exit(1)'), 'helper does not fail the caller');
        assert.ok(
            helper.includes(JSON.stringify(path.join(installed.metaRoot, 'drafts'))),
            'helper does not name the drafts location',
        );
        // The stub is now the whole safety mechanism, so it must countermand the
        // leftover instructions it replaces.
        assert.ok(helper.includes('edit the file in the Local Replica directly'));
        assert.ok(helper.includes('Do not treat anything here as a completed edit'));
        // It is executed by agents, so it has to parse as JavaScript. `Function`
        // compiles without running; the shebang is stripped the way node does.
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
        assert.strictEqual(await readFile(installed.registryPath), registryContent);
        assert.deepStrictEqual(
            await listDir(path.join(metaRoot, 'bin')),
            ['overleaf-agent-review', 'overleaf-agent-review.cmd'],
            'a failed replacement left staging litter behind',
        );
        // A live helper is a warning, not a quiet notice.
        assert.strictEqual(warnings.length, 1);
        assert.ok(warnings[0].includes('could not be disabled yet'));
        assert.strictEqual(notifications.length, 0);

        (fs as any).writeFile = realFs('writeFile');
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

    test('does not record completion when the helper state could not be determined', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-unknown-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const metaRoot = path.join(globalStoragePath, 'agent-review');
        const installed = await installAgentReviewStorage(metaRoot, workspaceRoot);
        const helperPath = path.join(metaRoot, 'bin', 'overleaf-agent-review');
        const {context, globalState} = createContextStub(globalStoragePath);
        // An EACCES probe is not evidence of absence: the live helper is still
        // there, and treating this as "nothing to do" would retire it forever.
        failStatOf(helperPath, 'EACCES');

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.strictEqual(
            globalState.get(STORAGE_CLEANUP_KEY),
            undefined,
            'an unreadable helper was recorded as handled',
        );
        assert.strictEqual(await readFile(helperPath), ORIGINAL_HELPER);
        assert.strictEqual(warnings.length, 1, 'the user was not warned that the helper is still live');

        (fs as any).stat = realFs('stat');
        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.ok(
            !(await readFile(helperPath)).includes('Submitted successfully'),
            'the retry never replaced the helper',
        );
        assert.strictEqual(globalState.get(STORAGE_CLEANUP_KEY), 1);
        assert.strictEqual(
            await readFile(installed.registryPath),
            JSON.stringify({replicaRoots: [workspaceRoot]}, null, 2),
        );
    });

    test('re-inspects a root whose instruction file could not be read', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-unreadable-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        const {context, workspaceState} = createContextStub(globalStoragePath);
        failReadOf(agentsPath, 'EACCES');

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        // Unreadable is not "no block here", so the folder stays pending.
        assert.deepStrictEqual(storedList(workspaceState, INSPECTED_ROOTS_KEY), []);
        assert.strictEqual(notifications.length, 0);

        (fs as any).readFile = realFs('readFile');
        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.strictEqual(notifications.length, 1);
        assert.ok(notifications[0].includes(agentsPath));
        assert.deepStrictEqual(
            storedList(workspaceState, INSPECTED_ROOTS_KEY),
            [vscode.Uri.file(workspaceRoot).toString()],
        );
    });

    test('does not re-inspect or re-report a folder it already handled', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-idempotent-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        await installAgentReviewStorage(path.join(globalStoragePath, 'agent-review'), workspaceRoot);
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        const {context, globalState, workspaceState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);
        assert.strictEqual(notifications.length, 1);
        assert.strictEqual(globalState.get(STORAGE_CLEANUP_KEY), 1);
        assert.deepStrictEqual(
            storedList(workspaceState, INSPECTED_ROOTS_KEY),
            [vscode.Uri.file(workspaceRoot).toString()],
        );

        // Even a block reappearing must not produce a second report: the folder
        // has been inspected and the migration has nothing left to do to it.
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.strictEqual(notifications.length, 1, 'the user was told twice');
        assert.strictEqual(warnings.length, 0);
    });

    test('reports a folder added to the workspace later, including its legacy helper', async () => {
        const firstRoot = await tempDir('sr-overleaf-agent-review-multi-a-');
        const laterRoot = await tempDir('sr-overleaf-agent-review-multi-b-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        // Global storage holds only a helper, so the only preserved work in this
        // test lives inside the folder that is added later.
        await installAgentReviewStorage(
            path.join(globalStoragePath, 'agent-review'),
            firstRoot,
            {withWork: false},
        );
        const firstAgents = path.join(firstRoot, 'AGENTS.md');
        await writeFile(firstAgents, blockAbove(USER_PROSE));
        const {context, globalState, workspaceState} = createContextStub(globalStoragePath);

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(firstRoot)]);
        assert.strictEqual(notifications.length, 1);
        assert.deepStrictEqual(
            storedList(workspaceState, INSPECTED_ROOTS_KEY),
            [vscode.Uri.file(firstRoot).toString()],
        );

        // The user adds a second folder to the same window. It carries its own
        // stale block, its own legacy helper and its own unaccepted draft.
        const laterClaude = path.join(laterRoot, 'CLAUDE.md');
        await writeFile(laterClaude, blockAbove(USER_PROSE));
        const legacyMeta = path.join(laterRoot, REPLICA_SETTINGS_DIR, 'agent-review');
        const legacy = await installAgentReviewStorage(legacyMeta, laterRoot);
        const legacyDraftContent = await readFile(legacy.draftFile);

        await cleanupRemovedAgentReview(context, [
            vscode.Uri.file(firstRoot),
            vscode.Uri.file(laterRoot),
        ]);

        assert.strictEqual(notifications.length, 2, 'the folder added later was never inspected');
        assert.ok(notifications[1].includes(laterClaude));
        assert.ok(notifications[1].includes(legacyMeta));
        assert.ok(
            !notifications[1].includes(firstAgents),
            'an already-reported file was reported again',
        );
        const legacyHelper = await readFile(path.join(legacyMeta, 'bin', 'overleaf-agent-review'));
        assert.ok(!legacyHelper.includes('Submitted successfully'), 'the later folder kept a live legacy helper');
        assert.strictEqual(await readFile(legacy.draftFile), legacyDraftContent);
        assert.strictEqual(
            await readFile(legacy.registryPath),
            JSON.stringify({replicaRoots: [laterRoot]}, null, 2),
        );
        // The record grew; the first folder's entry was not replaced.
        assert.deepStrictEqual(
            storedList(globalState, REPORTED_KEY),
            [
                reportKeys.instructions(firstAgents),
                reportKeys.instructions(laterClaude),
                reportKeys.drafts(legacyMeta),
            ].sort(),
        );

        await cleanupRemovedAgentReview(context, [
            vscode.Uri.file(firstRoot),
            vscode.Uri.file(laterRoot),
        ]);
        assert.strictEqual(notifications.length, 2, 'a settled workspace reported again');
    });

    test('keeps an entry written between its own read and write of the report record', async () => {
        // This is the interleaving the pre-write re-read covers. It is NOT proof
        // of atomicity: `Memento` has no compare-and-swap, so two windows that
        // both read before either writes still lose one side's additions. The
        // test below pins down what that costs.
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-concurrent-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        const {context, globalState} = createContextStub(globalStoragePath);
        const foreignEntry = reportKeys.instructions('/other/window/CLAUDE.md');
        let reads = 0;
        const realGet = context.globalState.get.bind(context.globalState);
        (context.globalState as any).get = (key: string, defaultValue?: unknown) => {
            const value = realGet(key, defaultValue as any);
            if (key===REPORTED_KEY) {
                reads += 1;
                if (reads===1) {
                    globalState.set(REPORTED_KEY, [foreignEntry]);
                }
            }
            return value;
        };

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.strictEqual(notifications.length, 1);
        assert.deepStrictEqual(
            storedList(globalState, REPORTED_KEY),
            [reportKeys.instructions(agentsPath), foreignEntry].sort(),
            'an entry that landed before the write was discarded',
        );
    });

    test('re-reports rather than dropping a finding when a record entry is lost', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-lost-update-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        const sharedGlobalState = new Map<string, unknown>();
        const first = createContextStub(globalStoragePath, sharedGlobalState);

        await cleanupRemovedAgentReview(first.context, [vscode.Uri.file(workspaceRoot)]);
        assert.strictEqual(notifications.length, 1);
        assert.ok(notifications[0].includes(agentsPath));

        // A concurrent window that read the record before this write, and wrote
        // after it, drops our entry. That is unpreventable with `Memento`, so
        // what matters is which way the loss falls.
        const foreignEntry = reportKeys.instructions('/other/window/AGENTS.md');
        sharedGlobalState.set(REPORTED_KEY, [foreignEntry]);

        // Another window of the same installation opens the same folder.
        const second = createContextStub(globalStoragePath, sharedGlobalState);
        await cleanupRemovedAgentReview(second.context, [vscode.Uri.file(workspaceRoot)]);

        // The cost is a repeat, never a finding the user is never told about.
        assert.strictEqual(notifications.length, 2, 'the finding was silently dropped');
        assert.ok(notifications[1].includes(agentsPath));
        assert.deepStrictEqual(
            storedList(sharedGlobalState, REPORTED_KEY),
            [reportKeys.instructions(agentsPath), foreignEntry].sort(),
        );
    });

    test('tells the user even if recording that it did so then fails', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-record-fails-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
        await writeFile(agentsPath, blockAbove(USER_PROSE));
        const {context, globalState} = createContextStub(globalStoragePath);
        // Storage that commits the write and then dies. This is the ordering
        // that decides the question: record-then-tell would have persisted
        // "already reported" for a notification the user never saw.
        const realUpdate = context.globalState.update.bind(context.globalState);
        let alreadyFailed = false;
        (context.globalState as any).update = async (key: string, value: unknown) => {
            await realUpdate(key, value);
            if (key===REPORTED_KEY && !alreadyFailed) {
                alreadyFailed = true;
                throw new Error('storage died immediately after the write');
            }
        };

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.strictEqual(notifications.length, 1, 'the finding was recorded but never shown');
        assert.ok(notifications[0].includes(agentsPath));
        assert.deepStrictEqual(
            storedList(globalState, REPORTED_KEY),
            [reportKeys.instructions(agentsPath)],
        );
    });

    test('warns about a helper it could not disable even when nothing else is new', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-live-helper-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        const metaRoot = path.join(globalStoragePath, 'agent-review');
        // No drafts, no proposals, and no instruction files anywhere: a live
        // helper has to be able to raise the alarm entirely on its own, since it
        // is the one state in which the leftover instructions are not inert.
        await installAgentReviewStorage(metaRoot, workspaceRoot, {withWork: false});
        const helperPath = path.join(metaRoot, 'bin', 'overleaf-agent-review');
        const {context, globalState} = createContextStub(globalStoragePath);
        failWritesUnder(path.join(metaRoot, 'bin'));

        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.strictEqual(notifications.length, 0);
        assert.strictEqual(warnings.length, 1, 'a live helper was never reported');
        assert.ok(warnings[0].includes(metaRoot), `the warning does not name the helper: ${warnings[0]}`);
        assert.ok(warnings[0].includes('could not be disabled yet'));
        assert.strictEqual(globalState.get(STORAGE_CLEANUP_KEY), undefined);

        // The condition persists: retried, but not announced again.
        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);
        assert.strictEqual(warnings.length, 1, 'the same live helper was announced twice');

        (fs as any).writeFile = realFs('writeFile');
        await cleanupRemovedAgentReview(context, [vscode.Uri.file(workspaceRoot)]);

        assert.ok(!(await readFile(helperPath)).includes('Submitted successfully'), 'the retry never ran');
        assert.strictEqual(globalState.get(STORAGE_CLEANUP_KEY), 1);
        assert.strictEqual(warnings.length, 1, 'a resolved condition was announced again');
        assert.strictEqual(notifications.length, 0);
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
        assert.strictEqual(notifications.length, 0);
        assert.strictEqual(warnings.length, 0);
        assert.strictEqual(globalState.get(REPORTED_KEY), undefined);
    });

    test('keeps a missing or unreachable root pending instead of settling it', async () => {
        const workspaceRoot = await tempDir('sr-overleaf-agent-review-missing-');
        const globalStoragePath = path.join(await tempDir('sr-overleaf-agent-review-storage-'), 'globalStorage');
        // A directory where an instruction file is expected: it cannot hold a
        // block, so it is settled rather than retried forever.
        await realFs<typeof fs.mkdir>('mkdir')(path.join(workspaceRoot, 'AGENTS.md'), {recursive: true});
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

        assert.strictEqual(
            (await realFs<typeof fs.stat>('stat')(path.join(workspaceRoot, 'AGENTS.md'))).isDirectory(),
            true,
        );
        assert.strictEqual(await readFile(claudePath), blockAbove(USER_PROSE));
        // A folder that is not there right now may come back carrying a stale
        // file, so it must not be recorded as inspected.
        assert.deepStrictEqual(
            storedList(workspaceState, INSPECTED_ROOTS_KEY),
            [vscode.Uri.file(workspaceRoot).toString()],
        );
        assert.strictEqual(notifications.length, 1);
        assert.ok(notifications[0].includes(claudePath));
    });
});
