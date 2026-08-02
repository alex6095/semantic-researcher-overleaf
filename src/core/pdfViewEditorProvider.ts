import * as vscode from 'vscode';
import { CONFIG_SECTION, PDF_VIEW_TYPE, ROOT_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import { GlobalStateManager } from '../utils/globalStateManager';
import { formatUnknownError } from '../utils/errorMessage';

export type PdfRefreshResult = {ok: true} | {ok: false, message: string};

export class PdfDocument implements vscode.CustomDocument {
    cache: Uint8Array = new Uint8Array(0);
    // Message of the last failed refresh, `undefined` while `cache` holds the
    // bytes of the current build. A failed download must never be indistinguishable
    // from "nothing changed": the viewer would keep the previous build's page on
    // screen and the user would read a stale PDF as if it were the new one.
    private _lastError: string | undefined;

    private readonly _onDidChange = new vscode.EventEmitter<{}>();
    readonly onDidChange = this._onDidChange.event;

    constructor(readonly uri: vscode.Uri) {
        if (uri.scheme !== ROOT_NAME) {
            throw new Error(`Invalid uri scheme: ${uri}`);
        }
        this.uri = uri;
    }

    dispose() { }

    get lastError(): string | undefined {
        return this._lastError;
    }

    async refresh(): Promise<PdfRefreshResult> {
        try {
            this.cache = new Uint8Array(await vscode.workspace.fs.readFile(this.uri));
            this._lastError = this.cache.byteLength===0
                // An empty output.pdf is not a document; treat it like a failed
                // download so the viewer shows an error instead of nothing.
                ? vscode.l10n.t('The compiled PDF is empty.')
                : undefined;
        } catch (error) {
            this._lastError = formatUnknownError(error);
        }
        this._onDidChange.fire({content:this.cache, error:this._lastError});
        return this._lastError===undefined
            ? {ok: true}
            : {ok: false, message: this._lastError};
    }
}

export class PdfViewEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly context:vscode.ExtensionContext) {
        this.context = context;
    }

    public saveCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public saveCustomDocumentAs(document: PdfDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public revertCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public backupCustomDocument(document: PdfDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
        return Promise.resolve({id: '', delete: () => {}});
    }

    public async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
        const doc = new PdfDocument(uri);
        const result = await doc.refresh();
        if (!result.ok) {
            // The editor still opens (so the viewer can show the error and the
            // next compile can retry), but the failure has to reach the user —
            // it used to leave a permanently blank viewer with no explanation.
            vscode.window.showErrorMessage(vscode.l10n.t(
                'Could not load the compiled PDF: {message}',
                {message: result.message},
            ));
        }
        return doc;
    }

    public async resolveCustomEditor(doc: PdfDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        EventBus.fire('pdfWillOpenEvent', {uri: doc.uri, doc, webviewPanel});

        const updateWebview = () => {
            // A failed refresh must produce a visible error state instead of
            // posting nothing: silence leaves the previous build's page on
            // screen, and the user reads it as the current one.
            if (doc.lastError!==undefined) {
                webviewPanel.webview.postMessage({type:'error', content:doc.lastError});
                return;
            }
            webviewPanel.webview.postMessage({type:'update', content:doc.cache.buffer});
        };

        const docOnDidChangeListener = doc.onDidChange(() => {
            updateWebview();
        });

        webviewPanel.onDidDispose(() => {
            docOnDidChangeListener.dispose();
        });

        webviewPanel.webview.options = {enableScripts:true};
        webviewPanel.webview.html = await this.getHtmlForWebview(webviewPanel.webview);

        // register event listeners
        webviewPanel.onDidChangeViewState((e) => {
            if (e.webviewPanel.active) {
                EventBus.fire('fileWillOpenEvent', {uri: doc.uri});
            }
        });
        webviewPanel.webview.onDidReceiveMessage((e) => {
            switch (e.type) {
                case 'syncPdf':
                    vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.syncPdf`, e.content);
                    break;
                case 'saveState':
                    GlobalStateManager.updatePdfViewPersist(this.context, doc.uri.toString(), e.content);
                    break;
                case 'pdfLoadError':
                    // pdf.js rejected the bytes we handed it (truncated/corrupt
                    // build output). Only the webview can see that, so it reports
                    // back rather than leaving the previous page up silently.
                    vscode.window.showErrorMessage(vscode.l10n.t(
                        'Could not render the compiled PDF: {message}',
                        {message: String(e.content ?? '')},
                    ));
                    break;
                case 'ready':
                    const state = GlobalStateManager.getPdfViewPersist(this.context, doc.uri.toString());
                    const config = vscode.workspace.getConfiguration(`${CONFIG_SECTION}.pdfViewer`);
                    const colorThemes = config.get('themes', undefined);
                    const defaults = {
                        scrollMode: config.get('defaultScrollMode', 'vertical'),
                        spreadMode: config.get('defaultSpreadMode', 'none'),
                    };
                    const citationPreview = {
                        enabled: config.get<boolean>('citationPreview.enabled', true),
                        maxEntries: config.get<number>('citationPreview.maxEntries', 8),
                        maxLines: config.get<number>('citationPreview.maxLines', 6),
                        maxChars: config.get<number>('citationPreview.maxChars', 1200),
                    };
                    webviewPanel.webview.postMessage({type:'initState', content:state, colorThemes, defaults, citationPreview});
                    updateWebview();
                    break;
                default:
                    break;
            }
        });
    }

    public get triggers(): vscode.Disposable[] {
        return [
            vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, this, {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }),
        ];
    }

    private patchViewerHtml(webview: vscode.Webview, html: string): string {
        const patchPath = (...path:string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer', ...path)).toString();

        // adjust original path
        html = html.replace('../build/pdf.js', patchPath('vendor','build','pdf.js'));
        html = html.replace('viewer.css', patchPath('vendor','web','viewer.css'));
        html = html.replace('viewer.js',  patchPath('vendor','web','viewer.js'));

        // patch custom files
        const workerScript = `<script src="${patchPath('vendor','build','pdf.worker.js')}"></script>`;
        const customScript = `<script src="${patchPath('index.js')}"></script>`;
        const customStyle = `<link rel="stylesheet" href="${patchPath('index.css')}" />`;
        html = html.replace(/\<\/head\>/, `${workerScript}\n${customScript}\n${customStyle}\n</head>`);

        return html;
    }

    private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer/vendor/web/viewer.html');
        let html = (await vscode.workspace.fs.readFile(htmlPath)).toString();
        return this.patchViewerHtml(webview, html);
    }

}
