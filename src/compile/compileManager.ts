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
import {
    getActiveReplicaOriginUri,
    isWithinActiveReplica,
    localUriToPath,
    pathToLocalUri,
} from '../utils/localReplicaWorkspace';
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

// The pdfWillOpenEvent handler touches only the module-level pdfViewRecord, so
// it is registered once per process. A per-instance subscription in the
// CompileManager constructor leaked one listener on the shared EventBus for
// every manager constructed (test hosts construct many) with no disposal path.
let pdfViewRecordTrackingRegistered = false;
function registerPdfViewRecordTracking() {
    if (pdfViewRecordTrackingRegistered) { return; }
    pdfViewRecordTrackingRegistered = true;
    EventBus.on('pdfWillOpenEvent', ({uri, doc, webviewPanel}) => {
        const {identifier,pathParts} = parseUri(uri);
        const filePath = pathParts.join('/');
        if (pdfViewRecord[identifier]) {
            pdfViewRecord[identifier][filePath] = {doc, webviewPanel};
        } else {
            pdfViewRecord[identifier] = {[filePath]:{doc, webviewPanel}};
        }
        // A record must not outlive its panel: `webviewPanel.webview` throws
        // once the panel is disposed, so a closed PDF tab would otherwise
        // break every later status broadcast and every Ctrl+Alt+J.
        webviewPanel.onDidDispose(() => {
            const records = pdfViewRecord[identifier];
            if (records?.[filePath]?.webviewPanel===webviewPanel) {
                delete records[filePath];
                if (Object.keys(records).length===0) {
                    delete pdfViewRecord[identifier];
                }
            }
        });
    });
}

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
            // Count the error before any filtering below — a LaTeX error must
            // fail the compile whether or not we can attach an editor squiggle
            // to it. Errors raised inside a package (an absolute TeX Live path)
            // or with no file attribution are still errors, and LaTeX can emit
            // a PDF anyway, so dropping them reports a broken build as success.
            if (log.level === 'error') {
                hasError = true;
            }
            if (!log.file.startsWith('./')) { continue; }
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
    // Ticket dispenser for compile ownership: status, diagnostics and the PDF
    // are shared state, so only the newest compile may publish an outcome.
    private compileSequence = 0;
    private activeCompileId = 0;

    constructor(
        private vfsm: RemoteFileSystemProvider,
    ) {
        this.vfsm = vfsm;
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
        this.status.command = `${ROOT_NAME}.compilerManager.settings`;
        this.diagnosticProvider = new CompileDiagnosticProvider(vfsm);
        registerPdfViewRecordTracking();
    }

    static async check(uri?: vscode.Uri) {
        const hasExplicitUri = uri!==undefined;
        // `?.` only short-circuits on undefined: an empty workspaceFolders array
        // still indexes [0] and dereferences `.uri` of undefined.
        const candidate = uri ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
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
                        // One dead panel must not swallow the broadcast for the
                        // panels that are still alive.
                        try {
                            record.webviewPanel.webview.postMessage({type: 'compileStatus', status});
                        } catch { /* panel already disposed; the record is dropped on dispose */ }
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
            }, (error) => {
                // The status bar is cosmetic; an unreachable project must not
                // produce a detached unhandled rejection.
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [compile status] could not render status bar: ${formatUnknownError(error)}`,
                );
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
                // Another compile owns the pipeline (this one was stopped and
                // the user started a new one). It drains the queue when it ends;
                // draining here would only re-queue the same entry forever.
                if (this.inCompiling) { break; }
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
        // Take ownership of the shared compile state for this run. A compile
        // that gets stopped or superseded must never publish its status, its
        // diagnostics or its PDF over the compile the user is now waiting for.
        const compileId = ++this.compileSequence;
        this.activeCompileId = compileId;
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
                if (!this.ownsCompile(compileId)) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [compile result] discarded: superseded by a newer compile`,
                    );
                    return;
                }
                if (res===undefined) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [compile skipped] no pending changes; keeping last status`,
                    );
                    await this.update('success', uri);
                    return;
                }
                if (res===false) {
                    // vfs.compile already logged the rejected response details.
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [compile result] failed: server rejected the compile request`,
                    );
                }
                await this.publishCompileResult(uri, compileId, res===false);
            })
            .catch(async (error) => {
                console.error('Compile workflow failed.', formatUnknownError(error));
                getOutputChannel().appendLine(
                    `${new Date().toISOString()} [compile error] ${formatUnknownError(error)}`,
                );
                if (!this.ownsCompile(compileId)) { return; }
                // A dropped connection is not a LaTeX failure. Reporting it as
                // 'Compile Failed' sends the user hunting through their sources
                // for an error that does not exist; `vfs.compile` never returns
                // a distinct "not connected" value, so ask the VFS directly.
                const disconnected = await this.isProjectDisconnected(uri);
                if (disconnected) {
                    getOutputChannel().appendLine(
                        `${new Date().toISOString()} [compile result] alert: not connected`,
                    );
                }
                await this.update(disconnected ? 'alert' : 'failed', uri);
            });

        await vscode.window.withProgress(
            {location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Compiling LaTeX')},
            () => work,
        );
        if (this.ownsCompile(compileId)) {
            this.activeCompileId = 0;
        }
        await this.drainPendingSavedCompiles();
    }

    private ownsCompile(compileId: number) {
        return this.activeCompileId===compileId;
    }

    /*
        * Publish the outcome of a finished compile: this build's diagnostics,
        * then the PDF, then the status badge — in that order, so a green badge
        * is never shown over an artifact that is not the one just compiled.
    */
    private async publishCompileResult(
        uri: vscode.Uri,
        compileId: number,
        serverRejected: boolean,
    ) {
        // Parse the new build's output.log even when the server rejected the
        // compile: a fatal LaTeX error (and every `stop on first error` failure)
        // comes back as a non-success compile status, and output.log is the only
        // place the user can see WHICH error it was. Skipping it left the
        // Problems panel showing the previous build's diagnostics.
        const hasError = await this.runCompileErrorCheck(uri);
        if (!this.ownsCompile(compileId)) { return; }
        if (serverRejected) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [compile result] failed: ` +
                'server rejected the compile request',
            );
            await this.update('failed', uri);
            return;
        }
        // A server-accepted compile can produce a useful PDF while output.log
        // still contains LaTeX errors. Refresh that artifact just like Overleaf
        // does, but keep the compile verdict red. Previously the early error
        // return left a newly created .output/output.pdf undiscoverable and the
        // restored viewer permanently blank.
        const refreshError = await this.refreshPdfViews(uri);
        if (!this.ownsCompile(compileId)) { return; }
        if (hasError) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [compile result] failed: LaTeX errors in output.log` +
                (refreshError===undefined
                    ? '; generated PDF preview refreshed'
                    : `; generated PDF preview unavailable: ${refreshError}`),
            );
            await this.update('failed', uri);
            return;
        }
        // Refresh the PDF *before* the success badge, and let a refresh failure
        // veto it: a green badge over a viewer still showing the previous build
        // is exactly the "stale PDF read as current" defect.
        if (refreshError!==undefined) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [compile result] compiled, but the PDF could not be loaded: ${refreshError}`,
            );
            vscode.window.showErrorMessage(vscode.l10n.t(
                'Compiled, but the PDF preview could not be updated: {message}',
                {message: refreshError},
            ));
            await this.update('alert', uri);
            return;
        }
        getOutputChannel().appendLine(
            `${new Date().toISOString()} [compile result] success`,
        );
        await this.update('success', uri);
    }

    /*
        * Fetch + parse this build's output.log and publish the diagnostics.
        * Never throws: a crash inside the log parser must not turn a compile the
        * server reported as successful into 'Compile Failed'.
    */
    private async runCompileErrorCheck(uri: vscode.Uri): Promise<boolean> {
        try {
            const hasError = await vscode.commands.executeCommand<boolean>(
                `${ROOT_NAME}.compileManager.compileErrorCheck`, uri,
            );
            return hasError===true;
        } catch (error) {
            getOutputChannel().appendLine(
                `${new Date().toISOString()} [compile log check] failed: ${formatUnknownError(error)}`,
            );
            return false;
        }
    }

    /*
        * Reload every open PDF view of this project.
        * @return: the first refresh failure message, or undefined when every
        *          view now holds the build that was just compiled.
    */
    private async refreshPdfViews(uri: vscode.Uri): Promise<string | undefined> {
        let records: { doc: PdfDocument, webviewPanel: vscode.WebviewPanel }[];
        try {
            const { identifier } = parseUri(uri);
            records = Object.values(pdfViewRecord[identifier] ?? {});
        } catch {
            // parseUri may throw for non-overleaf URIs; nothing to refresh.
            return undefined;
        }
        let failure: string | undefined;
        for (const record of records) {
            const result = await record.doc.refresh();
            if (!result.ok && failure===undefined) {
                failure = result.message;
            }
        }
        return failure;
    }

    private async isProjectDisconnected(uri: vscode.Uri) {
        try {
            const vfs = await this.vfsm.prefetch(uri);
            return vfs.connectionState==='disconnected' || vfs.connectionState==='reconnecting';
        } catch {
            // The project cannot even be resolved: definitely not connected.
            return true;
        }
    }

    async stopCompile() {
        const uri = await CompileManager.check();
        if (uri && this.inCompiling) {
            const vfs = await this.vfsm.prefetch(uri);
            const stopped = await vfs.stopCompile();
            if (!stopped) {
                // The server did not accept the stop, so the compile is still
                // running. Reporting 'failed' here would clear the inCompiling
                // guard and let a second compile start alongside the first.
                return;
            }
            // Detach the running chain from the shared state before opening the
            // guard, so its now-irrelevant outcome cannot land on top of the
            // next compile's status, diagnostics or PDF.
            this.activeCompileId = 0;
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

    /*
        * Map an open document to its project-relative path. In Local Replica
        * mode the editor holds a `file:` uri under the replica root, which
        * `parseUri` cannot describe.
    */
    private async projectRelativePath(document: vscode.TextDocument): Promise<string | undefined> {
        if (document.uri.scheme===ROOT_NAME) {
            const { pathParts } = parseUri(document.uri);
            return pathParts.length>0 ? pathParts.join('/') : undefined;
        }
        const replicaPath = await localUriToPath(document.uri);
        return replicaPath===undefined ? undefined : replicaPath.replace(/^\/+/, '');
    }

    /*
        * The on-disk uri of a project file, when this project is the active
        * Local Replica. Returns undefined for pure virtual-filesystem projects.
    */
    private async replicaUriForProjectPath(projectUri: vscode.Uri, filePath: string) {
        const replicaOrigin = getActiveReplicaOriginUri();
        if (!replicaOrigin || vfsProjectKey(replicaOrigin)!==vfsProjectKey(projectUri)) {
            return undefined;
        }
        return pathToLocalUri(filePath);
    }

    async syncCode() {
        const uri = await CompileManager.check();
        const editor = vscode.window.activeTextEditor;
        if (!uri || !editor) { return; }
        // The SyncTeX file is the document the cursor is in, never the compile
        // uri: in Local Replica mode the latter is the project ROOT, which has
        // no path parts, so the request went out as `…/sync/code?file=&line=…`
        // and forward search was broken for the whole replica mode.
        const filePath = await this.projectRelativePath(editor.document);
        if (filePath===undefined) {
            vscode.window.showWarningMessage(vscode.l10n.t(
                'Cannot locate the active file inside the Overleaf project.',
            ));
            return;
        }
        const { identifier } = parseUri(uri);
        const pdfPath = `${OUTPUT_FOLDER_NAME}/output.pdf`;
        const record = pdfViewRecord[identifier]?.[pdfPath];
        if (record===undefined) {
            // Ctrl+Alt+J is a keybinding, so this is reachable with no PDF tab
            // open (or after one was closed). The unguarded lookup threw a
            // detached TypeError and the command did nothing at all.
            vscode.window.showInformationMessage(vscode.l10n.t(
                'Open the PDF preview first to jump to its matching location.',
            ));
            return;
        }
        const startPoint = editor.selection.start;
        // SyncTeX line numbers are 1-based, as the reverse direction confirms
        // (`_revealSelectionInEditor` subtracts 1 from the returned line).
        const line = startPoint.line + 1;
        const column = startPoint.character;
        try {
            const vfs = await this.vfsm.prefetch(uri);
            const res = await vfs.syncCode(filePath, line, column);
            // The proxy hands back the SyncTeX record ARRAY (the declared
            // response type describes the wrapper). An empty array is truthy but
            // has nothing to jump to — a comment or a preamble line — and the
            // viewer would index it with -1.
            const records = Array.isArray(res) ? res : [];
            if (records.length===0) {
                vscode.window.showInformationMessage(vscode.l10n.t(
                    'No PDF location is recorded for the current line.',
                ));
                return;
            }
            // get page
            record.webviewPanel.webview.postMessage({
                type: 'syncCode',
                content: res
            });
        } catch (error) {
            // This chain had no .catch at all, so every failure became a
            // detached unhandled rejection and the command failed silently.
            vscode.window.showErrorMessage(vscode.l10n.t(
                'Could not jump to the PDF: {message}',
                {message: formatUnknownError(error)},
            ));
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
                .then(async (res) => {
                    if (res) {
                        const { projectName } = parseUri(uri);
                        const { file, line, column } = res;
                        const _file = file.match(/output\.[^\.]+$/) ? `${OUTPUT_FOLDER_NAME}/${file}` : file;
                        // In Local Replica mode the user edits the files on
                        // disk; opening the virtual overleaf:// copy would drop
                        // the cursor into a second buffer of the same document,
                        // detached from the one they are working in.
                        const fileUri = await this.replicaUriForProjectPath(uri, _file)
                            ?? uri.with({ path: `/${projectName}/${_file}` });

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
