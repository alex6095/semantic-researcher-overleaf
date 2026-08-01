import * as vscode from 'vscode';
import {
    RemoteFileSystemProvider,
    parseUri,
    vfsProjectKey,
} from '../core/remoteFileSystemProvider';
import { ROOT_NAME, ELEGANT_NAME, OUTPUT_FOLDER_NAME, PDF_VIEW_TYPE, getConfiguredValue } from '../consts';
import { PdfDocument } from '../core/pdfViewEditorProvider';
import { LatexParser, ErrorSchema } from './compileLogParser';
import { EventBus } from '../utils/eventBus';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { getActiveReplicaOriginUri, isWithinActiveReplica } from '../utils/localReplicaWorkspace';
import { formatUnknownError } from '../utils/errorMessage';
import { getOutputChannel } from '../utils/outputChannel';

// map string level to severity
const severityMap: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
};

// Match the document class in the tex file
const documentClassRegex = new RegExp(/\\documentclass(?:\[[^\[\]\{\}]*\])?\{([^\[\]\{\}]+)\}/);
const compileOnSaveExtensionRegex = /\.(tex|ltx|ctx|bib|sty|cls|bbx|cbx|bst|def|cfg|clo|fd)$/i;

const pdfViewRecord: {
    [key: string]: {
        [key: string]: { doc: PdfDocument, webviewPanel: vscode.WebviewPanel }
    }
} = {};

class CompileDiagnosticProvider {
    private diagnosticCollection = vscode.languages.createDiagnosticCollection(`${ROOT_NAME}.compile`);
    constructor(private readonly vfsm: RemoteFileSystemProvider) {};

    private async getRange(log: ErrorSchema, path: string, vfs: any) {
        let textDoc: vscode.TextDocument;
        try {
            textDoc = (await vscode.workspace.openTextDocument(vfs.pathToUri(path)));
        }
        catch (error) {
            return null;
        }
        if (log.line !== null) {
            const _range = new vscode.Range(
                new vscode.Position(log.line - 1, 0),
                new vscode.Position(log.line, 0),
            );
            const lineContent = textDoc.getText(_range);
            const lineMatch = lineContent.match(/^\s*(.*?)\s*$/)?.[1] || '';
            const lineStart = lineContent.indexOf(lineMatch);
            const lineEnd = lineStart + lineMatch.length;
            return new vscode.Range(
                new vscode.Position(log.line - 1, lineStart),
                new vscode.Position(log.line - 1, lineEnd),
            );
        }
        else {
            return new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(1, 0),
            );
        }
    }
    private validatePath(path: string) {
        const outputRegex = new RegExp(/\.\/(output.(aux|bbl|toc|lof|lot|bbl|bst|ttt|fff))\b/);
        const match = outputRegex.exec(path);
        if (match) {
            return path.replace(match[0], `${OUTPUT_FOLDER_NAME}/${match[1]}`);
        }
        return path;
    }

    private async updateDiagnostics(uri: vscode.Uri) {
        this.diagnosticCollection.clear();
        const vfs = await this.vfsm.prefetch(uri);
        const logPath = `${OUTPUT_FOLDER_NAME}/output.log`;
        const _uri = vfs.pathToUri(logPath);
        let content ='';
        content = new TextDecoder().decode(await vfs.openFile(_uri));
        if (content === '') {
            // A transient empty download must not fail a compile the server
            // reported as successful. Retry once before deciding.
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [compile log empty] retrying output.log download`,
            );
            content = new TextDecoder().decode(await vfs.openFile(_uri));
        }
        const logs = new LatexParser(content).parse();
        if (logs === undefined) {
            if (content === '') {
                // The compile response already reported success; an empty log
                // after a retry is a download problem, not a LaTeX error.
                // Surface it in the output channel instead of a false 'failed'.
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [compile log empty] output.log still empty after retry; ` +
                    'treating compile as successful (server reported success)',
                );
            }
            return false;
        }
        let hasError = false;
        const diagnosticsRecorder: { [key: string]: vscode.Diagnostic[] } = {};
        for (const log of logs.all) {
            if (!log.file.startsWith('./')) { continue; }
            // Count the error even when the source file cannot be opened for a
            // diagnostic range below — a LaTeX error must fail the compile
            // regardless of whether we can attach an editor squiggle to it.
            if (log.level === 'error') {
                hasError = true;
            }
            const path = this.validatePath(log.file);
            const range = await this.getRange(log, path, vfs);
            if (range === null) {
                continue;
            }
            if (!diagnosticsRecorder[path]) {
                diagnosticsRecorder[path] = [];
            }
            const diagnostic = new vscode.Diagnostic(range, log.message, severityMap[log.level]);
            diagnostic.source = vscode.l10n.t('Compile Checker');
            diagnosticsRecorder[path].push(diagnostic);
        }
        for (const file in diagnosticsRecorder) {
            const diagnostics = diagnosticsRecorder[file];
            const _uri = vfs.pathToUri(file);
            this.diagnosticCollection.set(_uri, diagnostics);
        }
        return hasError;
    }

    get triggers() {
        return [
            this.diagnosticCollection,
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compileErrorCheck`, async (uri) => {
                return await this.updateDiagnostics(uri);
            }),
        ];
    }
}

export class CompileManager {
    readonly status: vscode.StatusBarItem;
    public inCompiling: boolean = false;
    private diagnosticProvider: CompileDiagnosticProvider;
    private compileAsDraft: boolean = false;
    private compileStopOnFirstError: boolean = false;
    private pendingSavedCompiles = new Map<string, {
        projectUri: vscode.Uri;
        localUris: Map<string, vscode.Uri>;
    }>();
    private drainingPendingSavedCompiles = false;

    constructor(
        private vfsm: RemoteFileSystemProvider,
    ) {
        this.vfsm = vfsm;
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
        this.status.command = `${ROOT_NAME}.compilerManager.settings`;
        this.diagnosticProvider = new CompileDiagnosticProvider(vfsm);
        // listen pdf open event
        EventBus.on('pdfWillOpenEvent', ({uri, doc, webviewPanel}) => {
            const {identifier,pathParts} = parseUri(uri);
            const filePath = pathParts.join('/');
            if (pdfViewRecord[identifier]) {
                pdfViewRecord[identifier][filePath] = {doc, webviewPanel};
            } else {
                pdfViewRecord[identifier] = {[filePath]:{doc, webviewPanel}};
            }
        });
    }

    static async check(uri?: vscode.Uri) {
        const hasExplicitUri = uri!==undefined;
        const candidate = uri ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0].uri;
        if (candidate?.scheme === ROOT_NAME) {
            return candidate;
        }
        if (candidate?.scheme==='file' && isWithinActiveReplica(candidate)) {
            return getActiveReplicaOriginUri();
        }
        if (hasExplicitUri) {
            return undefined;
        }
        // check if supported local replica
        const localSetting = await LocalReplicaSCMProvider.readSettings();
        if (localSetting?.uri) {
            return vscode.Uri.parse(localSetting.uri);
        }
        // otherwise return undefined
        return undefined;
    }

    async update(
        status: 'success'|'compiling'|'failed'|'alert',
        projectUri?: vscode.Uri,
    ) {
        const uri = projectUri ?? await CompileManager.check();
        if (uri) {
            this.inCompiling = status === 'compiling';
            // Broadcast compile state to any open PDF webviews for this project
            // so they can show an in-viewer badge alongside the status bar.
            try {
                const { identifier } = parseUri(uri);
                const records = pdfViewRecord[identifier];
                if (records) {
                    Object.values(records).forEach((record) => {
                        record.webviewPanel.webview.postMessage({type: 'compileStatus', status});
                    });
                }
            } catch { /* parseUri may throw for non-overleaf URIs; ignore */ }
            this.vfsm.prefetch(uri).then((vfs) => {
                const rootDocName = vfs.getRootDocName().slice(1);
                const compilerName = vfs.getCompiler()?.name || '';
                this.status.tooltip = new vscode.MarkdownString();
                switch (status) {
                    case 'success':
                        this.status.text = `${compilerName}`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compile Success')}**`);
                        this.status.backgroundColor = undefined;
                        break;
                    case 'compiling':
                        this.status.text = `${compilerName} $(sync~spin)`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compiling')}**`);
                        this.status.backgroundColor = undefined;
                        break;
                    case 'failed':
                        this.status.text = `${compilerName} $(x)`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compile Failed')}**`);
                        this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                        break;
                    case 'alert':
                        this.status.text = `$(alert)`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Not Connected')}**`);
                        this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                        break;
                }
                this.status.tooltip.appendMarkdown(`\n\n*${vscode.l10n.t('Click to manage compile settings.')}*`);
                this.status.show();
            });
        } else {
            this.status.hide();
        }
        return uri;
    }

    private warnLocalReplicaPrecompileFlushFailed(error: unknown) {
        vscode.window.showWarningMessage(
            vscode.l10n.t(
                'Compile canceled: Local Replica sync did not finish. {message}',
                {message: formatUnknownError(error)},
            ),
        );
    }

    private resolveProjectUri(uri?: vscode.Uri) {
        return CompileManager.check(uri);
    }

    private queueSavedCompile(projectUri: vscode.Uri, localUris: readonly vscode.Uri[]) {
        const projectKey = vfsProjectKey(projectUri);
        let pending = this.pendingSavedCompiles.get(projectKey);
        if (!pending) {
            pending = {
                projectUri,
                localUris: new Map(),
            };
            this.pendingSavedCompiles.set(projectKey, pending);
        }
        for (const uri of localUris) {
            pending.localUris.set(uri.toString(), uri);
        }
    }

    private async flushSavedDocumentsWhileCompiling(
        projectUri: vscode.Uri,
        localUris: readonly vscode.Uri[],
    ) {
        this.queueSavedCompile(projectUri, localUris);
        try {
            const vfs = await this.vfsm.prefetch(projectUri);
            await vfs.flushLocalReplicaBeforeCompile([...localUris]);
        } catch (error) {
            this.warnLocalReplicaPrecompileFlushFailed(error);
        }
    }

    private async drainPendingSavedCompiles() {
        if (this.drainingPendingSavedCompiles) { return; }
        this.drainingPendingSavedCompiles = true;
        try {
            while (this.pendingSavedCompiles.size>0) {
                const next = this.pendingSavedCompiles.entries().next().value as
                    | [string, {
                        projectUri: vscode.Uri;
                        localUris: Map<string, vscode.Uri>;
                    }]
                    | undefined;
                if (!next) { break; }
                const [projectKey, pending] = next;
                this.pendingSavedCompiles.delete(projectKey);
                await this.compile(
                    true,
                    [...pending.localUris.values()],
                    pending.projectUri,
                );
            }
        } finally {
            this.drainingPendingSavedCompiles = false;
        }
    }

    async compile(
        force:boolean=false,
        savedLocalReplicaUris: readonly vscode.Uri[] = [],
        projectUri?: vscode.Uri,
        queueIfBusy=false,
    ) {
        const uri = projectUri ?? await CompileManager.check();
        if (!uri) { return; }
        if (this.inCompiling) {
            if (savedLocalReplicaUris.length>0) {
                // Ctrl+S is a delivery barrier even while another compile is
                // running. Flush the saved disk state now and queue one
                // follow-up compile so the latest save is not dropped.
                await this.flushSavedDocumentsWhileCompiling(uri, savedLocalReplicaUris);
            } else if (queueIfBusy) {
                this.queueSavedCompile(uri, []);
            }
            return;
        }
        await this.update('compiling', uri);
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [compile start] force=${force} ` +
            `saved=${savedLocalReplicaUris.length} project=${uri.toString()}`,
        );

        const work = this.vfsm.prefetch(uri)
            .then(async (vfs) => {
                try {
                    await vfs.flushLocalReplicaBeforeCompile([...savedLocalReplicaUris]);
                } catch (error) {
                    this.warnLocalReplicaPrecompileFlushFailed(error);
                    throw error;
                }
                // Root-document detection: when the compile was triggered from
                // a specific .tex document, prefer it as the compile root. In
                // the Local Replica flow `uri` is the project ROOT (a folder),
                // which must not be read as a file — doing so downloads the
                // root folder id via the file API and dies with a 404 before
                // the compile request is ever sent. Detection is best-effort:
                // on any failure fall back to the project's stored root doc.
                let rootDocId: string | undefined;
                try {
                    const {fileType, fileId} = await vfs._resolveUri(uri);
                    if (fileType==='doc' && fileId) {
                        const content = new TextDecoder().decode( await vfs.openFile(uri) );
                        if (RegExp(documentClassRegex).exec(content)) {
                            rootDocId = fileId;
                        }
                    }
                } catch (error) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [compile root detect] skipped: ${formatUnknownError(error)}`,
                    );
                }
                return await vfs.compile(force, this.compileAsDraft, this.compileStopOnFirstError, rootDocId);
            })
            .then(async (res) => {
                switch (res) {
                    case undefined:
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [compile skipped] no pending changes; keeping last status`,
                        );
                        await this.update('success', uri);
                        break;
                    case false:
                        // vfs.compile already logged the rejected response details.
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [compile result] failed: server rejected the compile request`,
                        );
                        await this.update('failed', uri);
                        break;
                    case true:
                        return true;
                    default:
                        getOutputChannel().appendLine(
                            `${new Date().toISOString()} [compile result] alert: not connected`,
                        );
                        await this.update('alert', uri);
                        break;
                }
            })
            .then(status =>
                status ?
                    vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compileErrorCheck`, uri)
                    : Promise.reject()
            )
            .then(async (hasError) => {
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [compile result] ${hasError ? 'failed: LaTeX errors in output.log' : 'success'}`,
                );
                if (hasError) {
                    await this.update('failed', uri);
                } else {
                    await this.update('success', uri);
                }
                // refresh pdf
                const { identifier } = parseUri(uri);
                pdfViewRecord[identifier] && Object.values(pdfViewRecord[identifier]).forEach(
                    (record) => record.doc.refresh()
                );
            })
            .catch(async (error) => {
                // Either the intentional Promise.reject() flow-break (terminal
                // update() already fired) or an actual exception mid-chain.
                // If inCompiling is still set the chain failed before any
                // terminal update(); surface as failed so the next compile()
                // isn't permanently locked out by the inCompiling guard.
                if (error!==undefined) {
                    console.error('Compile workflow failed.', formatUnknownError(error));
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [compile error] ${formatUnknownError(error)}`,
                    );
                }
                if (this.inCompiling) {
                    await this.update('failed', uri);
                }
            });

        await vscode.window.withProgress(
            {location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Compiling LaTeX')},
            () => work,
        );
        await this.drainPendingSavedCompiles();
    }

    async stopCompile() {
        const uri = await CompileManager.check();
        if (uri && this.inCompiling) {
            const vfs = await this.vfsm.prefetch(uri);
            await vfs.stopCompile();
            await this.update('failed', uri);
        }
    }

    async openPdf() {
        const uri = await CompileManager.check();
        if (uri) {
            const rootPath = uri.path.split('/', 2)[1];
            const pdfUri = uri.with({
                path: `/${rootPath}/${OUTPUT_FOLDER_NAME}/output.pdf`,
            });
            const openLocation = getConfiguredValue<'current' | 'beside'>('pdfViewer.openLocation', 'current');
            const openOptions: vscode.TextDocumentShowOptions = {
                preview: false,
                viewColumn: openLocation==='beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
            };
            vscode.commands.executeCommand('vscode.openWith', pdfUri,
                PDF_VIEW_TYPE,
                openOptions
            );
        }
    }

    async syncCode() {
        const uri = await CompileManager.check();
        if (uri && vscode.window.activeTextEditor) {
            const { identifier, pathParts } = parseUri(uri);
            const startPoint = vscode.window.activeTextEditor.selection.start;
            const filePath = pathParts.join('/');
            const line = startPoint.line;
            const column = startPoint.character;
            this.vfsm.prefetch(uri)
                .then((vfs) => vfs.syncCode(filePath, line, column))
                .then((res) => {
                    if (res) {
                        const pdfPath = `${OUTPUT_FOLDER_NAME}/output.pdf`;
                        const webview = pdfViewRecord[identifier][pdfPath].webviewPanel.webview;
                        // get page
                        webview.postMessage({
                            type: 'syncCode',
                            content: res
                        });
                    }
                });
        }
    }

    private _revealSelectionInEditor(editor: vscode.TextEditor, targetLine: number, identifier: string) {
        const _identifier = identifier.replace(/\s+/g, '\\s+');
        // targetLine is 1-based from the syncTeX result
        const lineIndex = targetLine - 1;

        if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
            console.warn(`${ELEGANT_NAME}: Invalid line number ${targetLine} for revealing in editor. Document has ${editor.document.lineCount} lines.`);
            // Optionally, just focus the editor if the line is invalid
            vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
            return;
        }

        const lineText = editor.document.lineAt(lineIndex).text;
        const match = lineText.match(_identifier);
        const matchIndex = match?.index ?? 0;

        let newSelections: vscode.Selection[];
        const newSelection = new vscode.Selection(lineIndex, matchIndex, lineIndex, matchIndex);
        if (editor.selections.length > 0) {
            newSelections = editor.selections.map((sel, index) =>
                index === 0 ? newSelection : sel
            );
        } else {
            newSelections = [newSelection];
        }
        editor.selections = newSelections;

        editor.revealRange(new vscode.Range(lineIndex, matchIndex, lineIndex, matchIndex), vscode.TextEditorRevealType.InCenter);
    }

    async syncPdf(r: { page: number, h: number, v: number, identifier: string }) {
        const uri = await CompileManager.check();
        if (uri) {
            this.vfsm.prefetch(uri)
                .then((vfs) => vfs.syncPdf(r.page, r.h, r.v))
                .then((res) => {
                    if (res) {
                        const { projectName } = parseUri(uri);
                        const { file, line, column } = res;
                        const _file = file.match(/output\.[^\.]+$/) ? `${OUTPUT_FOLDER_NAME}/${file}` : file;
                        const fileUri = uri.with({ path: `/${projectName}/${_file}` });

                        let viewColumnToUse: vscode.ViewColumn | undefined;
                        const existingEditor = vscode.window.visibleTextEditors.find(
                            e => e.document.uri.toString() === fileUri.toString()
                        );

                        if (existingEditor) {
                            viewColumnToUse = existingEditor.viewColumn;
                        } else {
                            viewColumnToUse = vscode.window.visibleTextEditors.at(-1)?.viewColumn || vscode.ViewColumn.Beside;
                        }

                        vscode.window.showTextDocument(fileUri, { viewColumn: viewColumnToUse, preserveFocus: false })
                            .then(
                                (openedEditor) => {
                                    if (openedEditor) {
                                        this._revealSelectionInEditor(openedEditor, line, r.identifier);
                                    }
                                },
                                (error) => {
                                    console.error(`${ELEGANT_NAME}: Failed to open document ${fileUri.fsPath} for syncPdf:`, error);
                                }
                            );
                    }
                })
                .catch(error => {
                    console.error(`${ELEGANT_NAME}: Error in syncPdf promise chain:`, error);
                });
        }
    }

    async setCompiler() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const compilers = vfs?.getAllCompilers();
        compilers && vscode.window.showQuickPick(compilers.map((item) => {
            return {
                label: item.name,
                description: item.code,
                picked: item.code === currentCompiler?.code,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Compiler'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ compiler: option.description }) && this.compile(true);
        });
    }

    async setRootDoc() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentRootDoc = vfs?.getRootDocName();
        const rootDocs = vfs?.getValidMainDocs();
        rootDocs && vscode.window.showQuickPick(rootDocs.map((item) => {
            return {
                id: item.entity._id,
                label: item.path,
                picked: item.path === currentRootDoc,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Main Document'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ rootDocId: option.id }) && this.compile(true);
        });
    }

    async compileSettings() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const currentRootDoc = vfs?.getRootDocName();

        const currentDraftMode = this.compileAsDraft ? vscode.l10n.t('Draft Mode') : vscode.l10n.t('Normal Mode');
        const currentStopOnError = this.compileStopOnFirstError ? vscode.l10n.t('Stop on first error') : vscode.l10n.t('Try to compile despite errors');
        const settingItems = [
            {label: vscode.l10n.t('Compile Mode'), description: currentDraftMode},
            {label: vscode.l10n.t('Compile Error Handling'), description: currentStopOnError},
            {label: '', kind: vscode.QuickPickItemKind.Separator},
            {label: vscode.l10n.t('Setting: Compiler'), description: currentCompiler?.name, },
            {label: vscode.l10n.t('Setting: Main Document'), description: currentRootDoc, },
        ];
        if (this.inCompiling) {
            settingItems.unshift({label: vscode.l10n.t('Stop compilation'), description: undefined});
        }

        const setting = await vscode.window.showQuickPick(settingItems);
        switch (setting?.label) {
            case vscode.l10n.t('Setting: Compiler'):
                this.setCompiler();
                break;
            case vscode.l10n.t('Setting: Main Document'):
                this.setRootDoc();
                break;
            case vscode.l10n.t('Stop compilation'):
                this.stopCompile();
                break;
            case vscode.l10n.t('Compile Mode'):
                this.compileAsDraft = !this.compileAsDraft;
                this.compileSettings();
                break;
            case vscode.l10n.t('Compile Error Handling'):
                this.compileStopOnFirstError = !this.compileStopOnFirstError;
                this.compileSettings();
                break;
            default:
                break;
        }
    }

    private async compileSavedDocument(document: vscode.TextDocument) {
        const uri = await this.resolveProjectUri(document.uri);
        const vfs = uri && await this.vfsm.prefetch(uri);
        const compileCondition = vscode.workspace.getConfiguration(`${ROOT_NAME}.compileOnSave`).get('enabled', true);
        const postfixCondition = compileOnSaveExtensionRegex.test(document.fileName);
        if (!compileCondition || !postfixCondition || vfs?.isInvisibleMode!==false) {
            return;
        }

        // Saving is the only editor action that contributes an in-memory
        // buffer to a compile. Manual/PDF-viewer Compile works from the last
        // saved disk/VFS state.
        const savedLocalReplicaUris = document.uri.scheme==='file'
            ? [document.uri]
            : [];
        await this.compile(true, savedLocalReplicaUris, uri, true);
    }

    get triggers() {
        return [
            // register status bar
            this.status,
            // register compile commands
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compile`, () => this.compile(true)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.viewPdf`, () =>  this.openPdf()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncCode`, () => this.syncCode()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncPdf`, (r) => this.syncPdf(r)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compilerManager.settings`, ()=> this.compileSettings()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setCompiler`, () => this.setCompiler()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setRootDoc`, () => this.setRootDoc()),
            // register compile conditions
            vscode.workspace.onDidSaveTextDocument(e => this.compileSavedDocument(e)),
            EventBus.on('compilerUpdateEvent', () => {
                this.compile(true);
            }),
            EventBus.on('rootDocUpdateEvent', () => {
                this.compile(true);
            }),
            // register diagnostics triggers
            ...this.diagnosticProvider.triggers,
        ];
    }
}
