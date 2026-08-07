import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CompileManager } from '../../compile/compileManager';
import { LatexParser } from '../../compile/compileLogParser';
import { OUTPUT_FOLDER_NAME, REPLICA_SETTINGS_DIR, REPLICA_SETTINGS_FILE, ROOT_NAME } from '../../consts';
import { PdfDocument } from '../../core/pdfViewEditorProvider';
import { RemoteFileSystemProvider, vfsProjectKey } from '../../core/remoteFileSystemProvider';
import { TexDocumentSymbolProvider } from '../../intellisense/texDocumentSymbolProvider';
import { EventBus } from '../../utils/eventBus';
import { setActiveReplicaRoot } from '../../utils/localReplicaWorkspace';

type CapturedMessage = {kind: 'info' | 'warning' | 'error', message: string};

// Intercept the notification API so a test can assert that a silent failure is
// now reported to the user, without popping real notifications.
function captureMessages() {
    const messages: CapturedMessage[] = [];
    const original = {
        info: vscode.window.showInformationMessage,
        warning: vscode.window.showWarningMessage,
        error: vscode.window.showErrorMessage,
    };
    const record = (kind: CapturedMessage['kind']) => (message: string) => {
        messages.push({kind, message});
        return Promise.resolve(undefined);
    };
    (vscode.window as any).showInformationMessage = record('info');
    (vscode.window as any).showWarningMessage = record('warning');
    (vscode.window as any).showErrorMessage = record('error');
    return {
        messages,
        dispose: () => {
            (vscode.window as any).showInformationMessage = original.info;
            (vscode.window as any).showWarningMessage = original.warning;
            (vscode.window as any).showErrorMessage = original.error;
        },
    };
}

// A PDF view record as the compile manager sees it: the panel hands back its
// dispose callbacks so a test can close the tab deterministically.
function fakePdfView(refresh: () => Promise<{ok: true} | {ok: false, message: string}>) {
    const posted: any[] = [];
    const disposeCallbacks: Array<() => void> = [];
    const doc = {
        refresh,
        get lastError() { return undefined; },
    };
    const webviewPanel = {
        webview: {
            postMessage: (message: any) => {
                posted.push(message);
                return Promise.resolve(true);
            },
        },
        onDidDispose: (callback: () => void) => {
            disposeCallbacks.push(callback);
            return {dispose: () => {}};
        },
    };
    return {
        posted,
        doc: doc as unknown as PdfDocument,
        webviewPanel: webviewPanel as unknown as vscode.WebviewPanel,
        close: () => disposeCallbacks.splice(0).forEach(callback => callback()),
    };
}

async function createReplicaRoot(origin: vscode.Uri, projectName: string) {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-overleaf-audit-'));
    const rootUri = vscode.Uri.file(rootPath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(rootUri, REPLICA_SETTINGS_DIR));
    await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(rootUri, REPLICA_SETTINGS_FILE),
        Buffer.from(JSON.stringify({
            uri: origin.toString(),
            serverName: 'www.overleaf.com',
            enableCompileNPreview: true,
            projectName,
        }, null, 4)),
    );
    await setActiveReplicaRoot(rootUri);
    return {rootUri, rootPath};
}

suite('Compile audit fixes', () => {
    test('a compile the server rejects still parses the new build log', async () => {
        const origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Rejected?user=user-1&project=project-1`,
        );
        const fakeVfs = {
            flushLocalReplicaBeforeCompile: async () => {},
            _resolveUri: async () => ({fileType: 'folder', fileId: 'root-folder-id'}),
            openFile: async () => Buffer.from(''),
            // `stop on first error` and fatal LaTeX errors both come back as a
            // rejected compile response.
            compile: async () => false,
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        const statuses: string[] = [];
        (manager as any).update = async (status: string) => {
            statuses.push(status);
            manager.inCompiling = status==='compiling';
            return origin;
        };
        const checkedUris: string[] = [];
        (manager as any).runCompileErrorCheck = async (uri: vscode.Uri) => {
            checkedUris.push(uri.toString());
            return true;
        };

        try {
            await manager.compile(true, [], origin);
            // The rejected build still produced an output.log; skipping it left
            // the Problems panel showing the previous compile's diagnostics.
            assert.deepStrictEqual(checkedUris, [origin.toString()]);
            assert.deepStrictEqual(statuses, ['compiling', 'failed']);
        } finally {
            manager.status.dispose();
        }
    });

    test('a successful compile refreshes the PDF before it reports success', async () => {
        const origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Ordering?user=user-1&project=project-1`,
        );
        const pdfUri = origin.with({path: `/Ordering/${OUTPUT_FOLDER_NAME}/output.pdf`});
        const events: string[] = [];
        const view = fakePdfView(async () => {
            events.push('refresh');
            return {ok: true};
        });
        const fakeVfs = {
            flushLocalReplicaBeforeCompile: async () => {},
            _resolveUri: async () => ({fileType: 'folder', fileId: 'root-folder-id'}),
            openFile: async () => Buffer.from(''),
            compile: async () => true,
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        (manager as any).update = async (status: string) => {
            events.push(status);
            manager.inCompiling = status==='compiling';
            return origin;
        };
        (manager as any).runCompileErrorCheck = async () => false;
        EventBus.fire('pdfWillOpenEvent', {uri: pdfUri, doc: view.doc, webviewPanel: view.webviewPanel});

        try {
            await manager.compile(true, [], origin);
            // The success badge must never appear before the viewer holds the
            // build it is announcing.
            assert.deepStrictEqual(events, ['compiling', 'refresh', 'success']);
        } finally {
            view.close();
            manager.status.dispose();
        }
    });

    test('a PDF that fails to reload vetoes the success badge', async () => {
        const origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/StalePdf?user=user-1&project=project-1`,
        );
        const pdfUri = origin.with({path: `/StalePdf/${OUTPUT_FOLDER_NAME}/output.pdf`});
        const view = fakePdfView(async () => ({ok: false, message: 'Overleaf download failed (404)'}));
        const fakeVfs = {
            flushLocalReplicaBeforeCompile: async () => {},
            _resolveUri: async () => ({fileType: 'folder', fileId: 'root-folder-id'}),
            openFile: async () => Buffer.from(''),
            compile: async () => true,
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        const statuses: string[] = [];
        (manager as any).update = async (status: string) => {
            statuses.push(status);
            manager.inCompiling = status==='compiling';
            return origin;
        };
        (manager as any).runCompileErrorCheck = async () => false;
        EventBus.fire('pdfWillOpenEvent', {uri: pdfUri, doc: view.doc, webviewPanel: view.webviewPanel});
        const captured = captureMessages();

        try {
            await manager.compile(true, [], origin);
            // A green badge over the previous build's page is the exact defect:
            // the user reads a stale PDF believing it is current.
            assert.ok(!statuses.includes('success'), `unexpected success status in ${statuses}`);
            assert.strictEqual(statuses.at(-1), 'alert');
            assert.strictEqual(
                captured.messages.some(({kind, message}) =>
                    kind==='error' && message.includes('Overleaf download failed (404)')),
                true,
                `refresh failure was not surfaced: ${JSON.stringify(captured.messages)}`,
            );
        } finally {
            captured.dispose();
            view.close();
            manager.status.dispose();
        }
    });

    test('a stop the server rejects leaves the running compile alone', async () => {
        const origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/StopRejected?user=user-1&project=project-1`,
        );
        const fakeVfs = {
            stopCompile: async () => false,
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        const statuses: string[] = [];
        (manager as any).update = async (status: string) => {
            statuses.push(status);
            manager.inCompiling = status==='compiling';
            return origin;
        };
        const originalCheck = CompileManager.check;
        (CompileManager as any).check = async () => origin;

        try {
            await (manager as any).update('compiling', origin);
            await manager.stopCompile();
            // The compile is still running: clearing the guard here would let a
            // second compile start alongside it.
            assert.deepStrictEqual(statuses, ['compiling']);
            assert.strictEqual(manager.inCompiling, true);
        } finally {
            (CompileManager as any).check = originalCheck;
            manager.status.dispose();
        }
    });

    test('a stopped compile cannot clobber the status of the next compile', async () => {
        const origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/StopRace?user=user-1&project=project-1`,
        );
        let releaseFirstCompile!: () => void;
        const firstCompileReleased = new Promise<void>(resolve => {
            releaseFirstCompile = resolve;
        });
        let resolveFirstCompileStarted!: () => void;
        const firstCompileStarted = new Promise<void>(resolve => {
            resolveFirstCompileStarted = resolve;
        });
        let compileCount = 0;
        const fakeVfs = {
            flushLocalReplicaBeforeCompile: async () => {},
            _resolveUri: async () => ({fileType: 'folder', fileId: 'root-folder-id'}),
            openFile: async () => Buffer.from(''),
            compile: async () => {
                compileCount += 1;
                if (compileCount===1) {
                    resolveFirstCompileStarted();
                    await firstCompileReleased;
                }
                return true;
            },
            stopCompile: async () => true,
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        const statuses: string[] = [];
        (manager as any).update = async (status: string) => {
            statuses.push(status);
            manager.inCompiling = status==='compiling';
            return origin;
        };
        (manager as any).runCompileErrorCheck = async () => false;
        const originalCheck = CompileManager.check;
        (CompileManager as any).check = async () => origin;

        try {
            const stoppedCompile = manager.compile(true, [], origin);
            await firstCompileStarted;
            await manager.stopCompile();
            assert.deepStrictEqual(statuses, ['compiling', 'failed']);

            // The user starts a new compile; it must own the status from here on.
            await manager.compile(true, [], origin);
            assert.deepStrictEqual(statuses, ['compiling', 'failed', 'compiling', 'success']);

            releaseFirstCompile();
            await stoppedCompile;
            // The abandoned compile terminates last and must publish nothing.
            assert.deepStrictEqual(statuses, ['compiling', 'failed', 'compiling', 'success']);
            assert.strictEqual(compileCount, 2);
        } finally {
            releaseFirstCompile();
            (CompileManager as any).check = originalCheck;
            manager.status.dispose();
        }
    });

    test('a disconnected project reports not-connected instead of a compile failure', async () => {
        const origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Disconnected?user=user-1&project=project-1`,
        );
        const makeManager = (connectionState: string) => {
            const fakeVfs = {
                connectionState,
                flushLocalReplicaBeforeCompile: async () => {},
                _resolveUri: async () => ({fileType: 'folder', fileId: 'root-folder-id'}),
                openFile: async () => Buffer.from(''),
                compile: async () => {
                    throw new Error('socket hang up');
                },
            };
            const manager = new CompileManager({
                prefetch: async () => fakeVfs,
            } as unknown as RemoteFileSystemProvider);
            const statuses: string[] = [];
            (manager as any).update = async (status: string) => {
                statuses.push(status);
                manager.inCompiling = status==='compiling';
                return origin;
            };
            return {manager, statuses};
        };

        const disconnected = makeManager('disconnected');
        const connected = makeManager('connected');
        try {
            await disconnected.manager.compile(true, [], origin);
            // A dropped connection sent the user hunting for a LaTeX error that
            // does not exist.
            assert.deepStrictEqual(disconnected.statuses, ['compiling', 'alert']);

            await connected.manager.compile(true, [], origin);
            assert.deepStrictEqual(connected.statuses, ['compiling', 'failed']);
        } finally {
            disconnected.manager.status.dispose();
            connected.manager.status.dispose();
        }
    });

    test('syncCode uses the active document path and a live PDF panel', async () => {
        const origin = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Audit?user=user-1&project=project-1`,
        );
        const pdfUri = origin.with({path: `/Audit/${OUTPUT_FOLDER_NAME}/output.pdf`});
        const {rootUri, rootPath} = await createReplicaRoot(origin, 'Audit');
        const sourceUri = vscode.Uri.joinPath(rootUri, 'sections', 'intro.tex');
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(rootUri, 'sections'));
        await vscode.workspace.fs.writeFile(sourceUri, Buffer.from('\\section{Intro}\n'));

        const syncCodeArguments: Array<{file: string, line: number, column: number}> = [];
        let syncCodeResult: unknown = [{page: 2, h: 100, v: 200, width: 1, height: 1}];
        const fakeVfs = {
            syncCode: async (file: string, line: number, column: number) => {
                syncCodeArguments.push({file, line, column});
                return syncCodeResult;
            },
        };
        const manager = new CompileManager({
            prefetch: async () => fakeVfs,
        } as unknown as RemoteFileSystemProvider);
        const view = fakePdfView(async () => ({ok: true}));
        EventBus.fire('pdfWillOpenEvent', {uri: pdfUri, doc: view.doc, webviewPanel: view.webviewPanel});
        const captured = captureMessages();

        try {
            const document = await vscode.workspace.openTextDocument(sourceUri);
            const editor = await vscode.window.showTextDocument(document);
            editor.selection = new vscode.Selection(0, 3, 0, 3);

            await manager.syncCode();
            // In Local Replica mode the compile uri is the project ROOT, which
            // has no path parts: the request used to go out as `file=`.
            assert.deepStrictEqual(syncCodeArguments, [{
                file: 'sections/intro.tex',
                line: 1,
                column: 3,
            }]);
            assert.deepStrictEqual(view.posted, [{type: 'syncCode', content: syncCodeResult}]);

            // A line with no SyncTeX record comes back as an empty array, which
            // is truthy and made the viewer index it with -1.
            syncCodeResult = [];
            await manager.syncCode();
            assert.strictEqual(view.posted.length, 1);
            assert.strictEqual(captured.messages.at(-1)?.kind, 'info');

            // Closing the PDF tab must drop the record: reading `webview` off a
            // disposed panel throws.
            view.close();
            syncCodeResult = [{page: 2, h: 100, v: 200, width: 1, height: 1}];
            await manager.syncCode();
            assert.strictEqual(view.posted.length, 1);
            assert.strictEqual(syncCodeArguments.length, 2);
            assert.strictEqual(captured.messages.at(-1)?.kind, 'info');
        } finally {
            captured.dispose();
            view.close();
            manager.status.dispose();
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await setActiveReplicaRoot(undefined);
            await fs.rm(rootPath, {recursive: true, force: true});
        }
    });
});

suite('Compile log parser audit fixes', () => {
    test('parses the first line of output.log', () => {
        const log = [
            '! Undefined control sequence.',
            'l.1 \\thiscommanddoesnotexist',
            '',
        ].join('\n');
        const result = new LatexParser(log).parse();
        // The cursor used to start at line 0 and pre-increment, so the very
        // first line of the log was never parsed.
        assert.strictEqual(result?.errors.length, 1);
        assert.strictEqual(result?.errors[0].message, 'Undefined control sequence.');
    });

    test('does not overflow the stack on a line with thousands of parentheses', () => {
        // `LogText` joins every run of exactly-79-char lines into one line, so a
        // real package-heavy log reaches this depth easily.
        const log = `${'()'.repeat(10000)}\n`;
        assert.doesNotThrow(() => new LatexParser(log).parse());
    });
});

suite('Intellisense audit fixes', () => {
    const projectUri = vscode.Uri.parse(
        `${ROOT_NAME}://www.overleaf.com/Cycle/main.tex?user=user-1&project=project-1`,
    );
    // Two files that include each other is legal LaTeX and used to make the
    // project index walk re-download them forever.
    /* eslint-disable @typescript-eslint/naming-convention */
    const files: Record<string, string> = {
        'main.tex': '\\input{chapter.tex}\n\\bibliography{refs}\n',
        'chapter.tex': '\\input{main.tex}\n',
    };
    /* eslint-enable @typescript-eslint/naming-convention */

    async function createProvider() {
        const downloads: string[] = [];
        const vfs = {
            getRootDocName: () => '/main.tex',
            pathToUri: (filePath: string) => projectUri.with({path: `/Cycle/${filePath}`}),
            openFile: async (uri: vscode.Uri) => {
                const filePath = uri.path.replace('/Cycle/', '');
                downloads.push(filePath);
                const content = files[filePath];
                if (content===undefined) {
                    throw new Error(`Overleaf download failed (404): ${filePath}`);
                }
                return Buffer.from(content);
            },
        };
        const provider = new TexDocumentSymbolProvider({
            prefetch: async () => vfs,
        } as unknown as RemoteFileSystemProvider);
        const document = {
            uri: projectUri,
            getText: () => files['main.tex'],
        } as vscode.TextDocument;
        await provider.provideDocumentSymbols(document);
        return {
            provider,
            document,
            downloads,
            record: (provider as any).projectRecordMap.get(vfsProjectKey(projectUri)),
        };
    }

    test('the project index walk terminates on an \\input cycle', async () => {
        const {record, document, downloads} = await createProvider();
        // Without a visited set this never resolves.
        await record.init(document);
        // The cycle was entered (chapter.tex was fetched) but the root, which
        // chapter.tex includes back, was never re-fetched — that re-fetch is
        // the first step of the endless walk.
        assert.deepStrictEqual([...new Set(downloads)], ['chapter.tex']);
    });

    test('collecting bib paths terminates on an \\input cycle', async () => {
        const {record, document} = await createProvider();
        await record.init(document);
        // Reached synchronously from `\cite{` completion: a cycle here freezes
        // the whole extension host.
        assert.deepStrictEqual(record.getAllBibFilePaths(), ['refs.bib']);
    });
});
