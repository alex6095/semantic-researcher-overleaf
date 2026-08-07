import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CompileManager } from '../../compile/compileManager';
import { RemoteFileSystemProvider } from '../../core/remoteFileSystemProvider';
import { EventBus } from '../../utils/eventBus';

suite('Compile save UX', () => {
    test('constructing multiple compile managers does not accumulate EventBus listeners', () => {
        const emitter = (EventBus as any)._eventEmitter;
        const before = emitter.listenerCount('pdfWillOpenEvent');
        const managers = Array.from({length: 5}, () => new CompileManager({
            prefetch: async () => ({}),
        } as unknown as RemoteFileSystemProvider));
        try {
            const after = emitter.listenerCount('pdfWillOpenEvent');
            // One process-wide subscription tracks PDF panels; per-instance
            // registration leaked a listener for every constructed manager.
            assert.ok(after - before <= 1, `listener count grew from ${before} to ${after}`);
        } finally {
            managers.forEach(manager => manager.status.dispose());
        }
    });

    test('manual Compile leaves unsaved editor buffers untouched', async () => {
        const origin = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Compile%20UX?user=user-1&project=project-1',
        );
        const flushArguments: vscode.Uri[][] = [];
        const fakeVfs = {
            flushLocalReplicaBeforeCompile: async (uris: vscode.Uri[]) => {
                flushArguments.push(uris);
            },
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
            _resolveUri: async () => ({fileId: 'main-doc'}),
            compile: async () => undefined,
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        (manager as any).update = async () => origin;

        const document = await vscode.workspace.openTextDocument({
            language: 'latex',
            content: '\\documentclass{article}\n',
        });
        const editor = await vscode.window.showTextDocument(document);
        await editor.edit(builder => builder.insert(
            document.positionAt(document.getText().length),
            'unsaved edit\n',
        ));
        assert.strictEqual(document.isDirty, true);

        try {
            await manager.compile(true, [], origin);
            assert.strictEqual(document.isDirty, true);
            assert.deepStrictEqual(flushArguments, [[]]);
        } finally {
            manager.status.dispose();
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
    });

    test('compile-on-save passes only the saved Local Replica source URI', async () => {
        const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-overleaf-compile-save-'));
        const rootUri = vscode.Uri.file(rootPath);
        const origin = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Compile%20UX?user=user-1&project=project-1',
        );
        const sourceUri = vscode.Uri.joinPath(rootUri, 'main.tex');
        const imageUri = vscode.Uri.joinPath(rootUri, 'figure.png');
        await vscode.workspace.fs.writeFile(sourceUri, Buffer.from('saved source'));
        await vscode.workspace.fs.writeFile(imageUri, Buffer.from([1, 2, 3]));

        const compileCalls: Array<{
            force: boolean;
            uris: readonly vscode.Uri[];
            projectUri: vscode.Uri | undefined;
        }> = [];
        const manager = new CompileManager({
            prefetch: async () => ({isInvisibleMode: false}),
        } as unknown as RemoteFileSystemProvider);
        (manager as any).resolveProjectUri = async () => origin;
        (manager as any).compile = async (
            force: boolean,
            uris: readonly vscode.Uri[],
            projectUri?: vscode.Uri,
        ) => {
            compileCalls.push({force, uris, projectUri});
        };

        let saveSubscription: vscode.Disposable | undefined;
        try {
            const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
            const sourceEditor = await vscode.window.showTextDocument(sourceDocument);
            let resolveSaveHandled!: () => void;
            const saveHandled = new Promise<void>(resolve => {
                resolveSaveHandled = resolve;
            });
            saveSubscription = vscode.workspace.onDidSaveTextDocument(async document => {
                if (document.uri.toString()!==sourceUri.toString()) { return; }
                await (manager as any).compileSavedDocument(document);
                resolveSaveHandled();
            });
            await sourceEditor.edit(builder => builder.insert(
                sourceDocument.positionAt(sourceDocument.getText().length),
                '\nsaved edit',
            ));
            await sourceDocument.save();
            await saveHandled;

            const imageDocument = {
                uri: imageUri,
                fileName: imageUri.fsPath,
            } as vscode.TextDocument;
            await (manager as any).compileSavedDocument(imageDocument);

            assert.strictEqual(compileCalls.length, 1);
            assert.strictEqual(compileCalls[0].force, true);
            assert.deepStrictEqual(
                compileCalls[0].uris.map(uri => uri.toString()),
                [sourceUri.toString()],
            );
            assert.strictEqual(compileCalls[0].projectUri?.toString(), origin.toString());
        } finally {
            saveSubscription?.dispose();
            manager.status.dispose();
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await fs.rm(rootPath, {recursive: true, force: true});
        }
    });

    test('flushes and queues a Ctrl+S compile while another compile is running', async () => {
        const origin = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Queued?user=user-1&project=project-1',
        );
        const sourceUri = vscode.Uri.file(path.join(os.tmpdir(), 'queued-save.tex'));
        const flushArguments: vscode.Uri[][] = [];
        let compileCount = 0;
        let releaseFirstCompile!: () => void;
        const firstCompileReleased = new Promise<void>(resolve => {
            releaseFirstCompile = resolve;
        });
        let resolveFirstCompileStarted!: () => void;
        const firstCompileStarted = new Promise<void>(resolve => {
            resolveFirstCompileStarted = resolve;
        });
        const fakeVfs = {
            flushLocalReplicaBeforeCompile: async (uris: vscode.Uri[]) => {
                flushArguments.push(uris);
            },
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
            _resolveUri: async () => ({fileId: 'main-doc'}),
            compile: async () => {
                compileCount += 1;
                if (compileCount===1) {
                    resolveFirstCompileStarted();
                    await firstCompileReleased;
                }
                return undefined;
            },
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        (manager as any).update = async (
            status: 'success' | 'compiling' | 'failed' | 'alert',
        ) => {
            manager.inCompiling = status==='compiling';
            return origin;
        };

        try {
            const firstCompile = manager.compile(true, [], origin);
            await firstCompileStarted;

            await manager.compile(true, [sourceUri], origin);
            assert.deepStrictEqual(
                flushArguments.map(uris => uris.map(uri => uri.toString())),
                [[], [sourceUri.toString()]],
            );

            releaseFirstCompile();
            await firstCompile;

            assert.strictEqual(compileCount, 2);
            assert.deepStrictEqual(
                flushArguments.map(uris => uris.map(uri => uri.toString())),
                [[], [sourceUri.toString()], [sourceUri.toString()]],
            );
        } finally {
            releaseFirstCompile();
            manager.status.dispose();
        }
    });

    test('retains one queued Ctrl+S compile for every project', async () => {
        const projectA = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project%20A?user=user-1&project=project-a',
        );
        const projectB = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Project%20B?user=user-1&project=project-b',
        );
        const projectASecondDocument = projectA.with({
            path: '/Project A/chapter.tex',
        });
        const sourceA = vscode.Uri.file(path.join(os.tmpdir(), 'queued-save-a.tex'));
        const sourceB = vscode.Uri.file(path.join(os.tmpdir(), 'queued-save-b.tex'));
        const compileOrder: string[] = [];
        const flushes = new Map<string, string[][]>();
        let releaseFirstCompile!: () => void;
        const firstCompileReleased = new Promise<void>(resolve => {
            releaseFirstCompile = resolve;
        });
        let resolveFirstCompileStarted!: () => void;
        const firstCompileStarted = new Promise<void>(resolve => {
            resolveFirstCompileStarted = resolve;
        });
        let firstCompile = true;
        const projectKey = (uri: vscode.Uri) => uri.toString();
        const fakeVfs = (projectUri: vscode.Uri) => ({
            flushLocalReplicaBeforeCompile: async (uris: vscode.Uri[]) => {
                const key = projectKey(projectUri);
                const projectFlushes = flushes.get(key) ?? [];
                projectFlushes.push(uris.map(uri => uri.toString()));
                flushes.set(key, projectFlushes);
            },
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
            _resolveUri: async () => ({fileId: 'main-doc'}),
            compile: async () => {
                compileOrder.push(projectKey(projectUri));
                if (firstCompile) {
                    firstCompile = false;
                    resolveFirstCompileStarted();
                    await firstCompileReleased;
                }
                return undefined;
            },
        });
        const manager = new CompileManager({
            prefetch: async (uri: vscode.Uri) => fakeVfs(uri),
        } as unknown as RemoteFileSystemProvider);
        (manager as any).update = async (
            status: 'success' | 'compiling' | 'failed' | 'alert',
        ) => {
            manager.inCompiling = status==='compiling';
            return projectA;
        };

        try {
            const activeCompile = manager.compile(true, [], projectA);
            await firstCompileStarted;
            await manager.compile(true, [sourceA], projectA);
            await manager.compile(true, [], projectASecondDocument, true);
            await manager.compile(true, [sourceB], projectB);

            releaseFirstCompile();
            await activeCompile;

            assert.deepStrictEqual(compileOrder, [
                projectKey(projectA),
                projectKey(projectA),
                projectKey(projectB),
            ]);
            assert.deepStrictEqual(flushes.get(projectKey(projectA)), [
                [],
                [sourceA.toString()],
                [sourceA.toString()],
            ]);
            assert.deepStrictEqual(flushes.get(projectKey(projectB)), [
                [sourceB.toString()],
                [sourceB.toString()],
            ]);
            assert.strictEqual((manager as any).pendingSavedCompiles.size, 0);
        } finally {
            releaseFirstCompile();
            manager.status.dispose();
        }
    });

    test('project-root compile survives root-doc detection failure', async () => {
        const origin = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Compile%20UX?user=user-1&project=project-1',
        );
        const compileRootArgs: Array<string | undefined> = [];
        const fakeVfs = {
            flushLocalReplicaBeforeCompile: async () => {},
            // Local Replica compiles pass the project ROOT uri, which resolves
            // to a folder. Reading it as a file used to fail the whole compile
            // with `Overleaf download failed (404)` before the request was sent.
            _resolveUri: async () => ({fileType: 'folder', fileId: 'root-folder-id'}),
            openFile: async () => {
                throw new Error('Overleaf download failed (404)');
            },
            compile: async (
                _force: boolean,
                _draft: boolean,
                _stop: boolean,
                rootDocId?: string,
            ) => {
                compileRootArgs.push(rootDocId);
                return undefined;
            },
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        const statuses: string[] = [];
        (manager as any).update = async (status: string) => {
            statuses.push(status);
            return origin;
        };
        try {
            await manager.compile(true, [], origin);
            // The compile request must still be issued, deferring the root
            // document to the project's stored setting.
            assert.deepStrictEqual(compileRootArgs, [undefined]);
            assert.ok(!statuses.includes('failed'), `unexpected failed status in ${statuses}`);
        } finally {
            manager.status.dispose();
        }
    });

    test('empty output.log after a successful compile is not reported as failure', async () => {
        const origin = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Compile%20UX?user=user-1&project=project-1',
        );
        let openFileCalls = 0;
        const fakeVfs = {
            pathToUri: (...pathParts: string[]) => vscode.Uri.joinPath(origin, ...pathParts),
            openFile: async () => {
                openFileCalls += 1;
                return new Uint8Array(0);
            },
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        try {
            const hasError = await (manager as any).diagnosticProvider.updateDiagnostics(origin);
            // The compile response already reported success by the time the
            // error check runs; an empty log download must not flip the
            // result to 'failed'.
            assert.strictEqual(hasError, false);
            // The empty first download is retried once before giving up.
            assert.strictEqual(openFileCalls, 2);
        } finally {
            manager.status.dispose();
        }
    });

    test('LaTeX error raised inside a package still fails the compile', async () => {
        const origin = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Compile%20UX?user=user-1&project=project-1',
        );
        // The error is attributed to an absolute TeX Live path, so no editor
        // diagnostic can be attached — but LaTeX still emitted a PDF and the
        // document is broken, so the compile must not be reported as success.
        const packageErrorLog = [
            'This is pdfTeX, Version 3.141592653 (TeX Live 2025)',
            '(/usr/local/texlive/2025/texmf-dist/tex/latex/base/article.cls',
            '! Undefined control sequence.',
            'l.42 \\brokenmacro',
            ')',
            'Output written on output.pdf (1 page, 1234 bytes).',
        ].join('\n');
        const fakeVfs = {
            pathToUri: (...pathParts: string[]) => vscode.Uri.joinPath(origin, ...pathParts),
            openFile: async () => Buffer.from(packageErrorLog),
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        try {
            const hasError = await (manager as any).diagnosticProvider.updateDiagnostics(origin);
            assert.strictEqual(hasError, true);
        } finally {
            manager.status.dispose();
        }
    });

    test('non-empty output.log with LaTeX errors is still reported as failure', async () => {
        const origin = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Compile%20UX?user=user-1&project=project-1',
        );
        const failingLog = [
            'This is pdfTeX, Version 3.141592653 (TeX Live 2025)',
            '(./main.tex',
            '! Undefined control sequence.',
            'l.3 \\thiscommanddoesnotexist',
            ')',
        ].join('\n');
        const fakeVfs = {
            pathToUri: (...pathParts: string[]) => vscode.Uri.joinPath(origin, ...pathParts),
            openFile: async () => Buffer.from(failingLog),
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        try {
            const hasError = await (manager as any).diagnosticProvider.updateDiagnostics(origin);
            assert.strictEqual(hasError, true);
        } finally {
            manager.status.dispose();
        }
    });

    test('refreshes a generated PDF while retaining the LaTeX failure verdict', async () => {
        const origin = vscode.Uri.parse(
            'semantic-researcher-overleaf://www.overleaf.com/Compile%20UX?user=user-1&project=project-1',
        );
        const statuses: string[] = [];
        let refreshCount = 0;
        const manager = new CompileManager({
            prefetch: async () => ({}),
        } as unknown as RemoteFileSystemProvider);
        const internals = manager as any;
        internals.activeCompileId = 7;
        internals.runCompileErrorCheck = async () => true;
        internals.refreshPdfViews = async () => {
            refreshCount += 1;
            return undefined;
        };
        internals.update = async (status: string) => {
            statuses.push(status);
            return origin;
        };

        try {
            await internals.publishCompileResult(origin, 7, false);
            assert.strictEqual(refreshCount, 1);
            assert.deepStrictEqual(statuses, ['failed']);
        } finally {
            manager.status.dispose();
        }
    });
});
