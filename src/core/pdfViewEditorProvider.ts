import * as vscode from 'vscode';
import { CONFIG_SECTION, PDF_VIEW_TYPE, ROOT_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import { GlobalStateManager } from '../utils/globalStateManager';
import { formatUnknownError } from '../utils/errorMessage';
import { PdfCacheStore, PersistentPdfCache } from './pdfCacheStore';
import { vfsProjectKey } from './remoteFileSystemProvider';

export type PdfRefreshResult =
    | {ok: true, source: 'live'}
    | {ok: true, source: 'cache', message: string}
    | {ok: false, message: string};

function isMissingOutputError(error: unknown): boolean {
    if (error instanceof vscode.FileSystemError) {
        return error.code==='FileNotFound' || error.code==='EntryNotFound';
    }
    const code = (error as {code?: unknown} | undefined)?.code;
    return code==='FileNotFound' || code==='EntryNotFound';
}

function hasPdfSignature(content: Uint8Array): boolean {
    const limit = Math.min(content.byteLength, 1024);
    for (let index = 0; index + 5 <= limit; index += 1) {
        if (
            content[index]===0x25
            && content[index + 1]===0x50
            && content[index + 2]===0x44
            && content[index + 3]===0x46
            && content[index + 4]===0x2d
        ) {
            return true;
        }
    }
    return false;
}

export class PdfDocument implements vscode.CustomDocument {
    cache: Uint8Array = new Uint8Array(0);
    // Message of the last failed refresh, `undefined` while `cache` holds the
    // bytes of the current build. A failed download must never be indistinguishable
    // from "nothing changed": the viewer would keep the previous build's page on
    // screen and the user would read a stale PDF as if it were the new one.
    private _lastError: string | undefined;
    private _lastLiveError: string | undefined;
    private _lastLiveOutputMissing = false;
    private contentVersion = 0;
    private pendingRenderedCache: {version: number, content: Uint8Array} | undefined;

    private readonly _onDidChange = new vscode.EventEmitter<{}>();
    readonly onDidChange = this._onDidChange.event;

    constructor(
        readonly uri: vscode.Uri,
        private readonly persistentCache?: PdfCacheStore,
        private readonly readLive: (uri: vscode.Uri) => Thenable<Uint8Array>
            = uri => vscode.workspace.fs.readFile(uri),
    ) {
        if (uri.scheme !== ROOT_NAME) {
            throw new Error(`Invalid uri scheme: ${uri}`);
        }
        this.uri = uri;
    }

    dispose() { }

    get lastError(): string | undefined {
        return this._lastError;
    }

    get lastLiveError(): string | undefined {
        return this._lastLiveError;
    }

    get usingCachedCopy(): boolean {
        return this._lastError===undefined && this._lastLiveError!==undefined;
    }

    get lastLiveOutputMissing(): boolean {
        return this._lastLiveOutputMissing;
    }

    get version(): number {
        return this.contentVersion;
    }

    async confirmRendered(version: number): Promise<void> {
        const pending = this.pendingRenderedCache;
        if (!pending || pending.version!==version || !this.persistentCache) { return; }
        this.pendingRenderedCache = undefined;
        try {
            await this.persistentCache.write(this.uri, pending.content);
        } catch (error) {
            // A valid live build is already on screen. Cache persistence is
            // best effort and must never turn that compile into a failure.
            console.warn(
                `Could not cache compiled PDF ${this.uri.toString()}: `+
                formatUnknownError(error),
            );
        }
    }

    async refresh(options: {allowCachedFallback?: boolean} = {}): Promise<PdfRefreshResult> {
        let liveError: string | undefined;
        let liveOutputMissing = false;
        try {
            const content = new Uint8Array(await this.readLive(this.uri));
            if (content.byteLength===0) {
                // An empty output.pdf is not a document; treat it like a failed
                // download so the viewer shows an error instead of nothing.
                liveError = vscode.l10n.t('The compiled PDF is empty.');
            } else if (!hasPdfSignature(content)) {
                liveError = vscode.l10n.t('The compiled output is not a valid PDF.');
            } else {
                this.cache = content;
                this._lastError = undefined;
                this._lastLiveError = undefined;
                this._lastLiveOutputMissing = false;
                this.contentVersion += 1;
                // Only bytes that pdf.js confirms it rendered become the last
                // known-good persistent copy. A truncated build can have a PDF
                // header, so signature validation alone is not sufficient.
                this.pendingRenderedCache = {version: this.contentVersion, content};
                this._onDidChange.fire({content:this.cache, error:undefined});
                return {ok: true, source: 'live'};
            }
        } catch (error) {
            liveError = formatUnknownError(error);
            liveOutputMissing = isMissingOutputError(error);
        }

        this.pendingRenderedCache = undefined;
        this._lastLiveOutputMissing = liveOutputMissing;
        if (options.allowCachedFallback && liveOutputMissing && this.persistentCache) {
            try {
                const cached = await this.persistentCache.read(this.uri);
                if (cached?.byteLength && hasPdfSignature(cached)) {
                    this.cache = new Uint8Array(cached);
                    this._lastError = undefined;
                    this._lastLiveError = liveError;
                    this.contentVersion += 1;
                    this._onDidChange.fire({content:this.cache, error:undefined});
                    return {ok: true, source: 'cache', message: liveError!};
                }
            } catch (error) {
                liveError = `${liveError}; cached PDF could not be read: ${formatUnknownError(error)}`;
            }
        }

        this._lastError = liveError;
        this._lastLiveError = liveError;
        this._onDidChange.fire({content:this.cache, error:this._lastError});
        return {ok: false, message: liveError!};
    }
}

export class PdfViewEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private readonly persistentCache: PdfCacheStore;
    private readonly missingOutputRecoveries = new Map<string, Promise<void>>();

    constructor(
        private readonly context:vscode.ExtensionContext,
        private readonly options: {
            persistentCache?: PdfCacheStore;
            readLive?: (uri: vscode.Uri) => Thenable<Uint8Array>;
            recoverMissingOutput?: (uri: vscode.Uri) => Promise<void>;
        } = {},
    ) {
        this.context = context;
        this.persistentCache = options.persistentCache
            ?? new PersistentPdfCache(context.globalStorageUri);
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
        const doc = new PdfDocument(uri, this.persistentCache, this.options.readLive);
        // A restored editor may open before this new extension host has any
        // compile-output entity in its in-memory VFS. Only this session-restore
        // path may use the last known-good cached PDF. Compile-time refreshes
        // remain strict and must load the newly reported live output.
        let result = await doc.refresh({allowCachedFallback: true});
        if (!result.ok && doc.lastLiveOutputMissing && this.options.recoverMissingOutput) {
            const initialMessage = result.message;
            const key = vfsProjectKey(uri);
            let recovery = this.missingOutputRecoveries.get(key);
            if (!recovery) {
                recovery = this.options.recoverMissingOutput(uri);
                this.missingOutputRecoveries.set(key, recovery);
                const clearRecovery = () => {
                    if (this.missingOutputRecoveries.get(key)===recovery) {
                        this.missingOutputRecoveries.delete(key);
                    }
                };
                void recovery.then(clearRecovery, clearRecovery);
            }
            try {
                await recovery;
                result = await doc.refresh();
            } catch (error) {
                result = {
                    ok: false,
                    message: `${initialMessage}; recovery compile failed: ${formatUnknownError(error)}`,
                };
            }
        }
        if (!result.ok) {
            // The editor still opens (so the viewer can show the error and the
            // next compile can retry), but the failure has to reach the user —
            // it used to leave a permanently blank viewer with no explanation.
            vscode.window.showErrorMessage(vscode.l10n.t(
                'Could not load the compiled PDF: {message}',
                {message: result.message},
            ));
        } else if (result.source==='cache') {
            vscode.window.showWarningMessage(vscode.l10n.t(
                'Showing the last cached compiled PDF because the live output is not available yet. Compile the project to refresh it. ({message})',
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
            webviewPanel.webview.postMessage({
                type:'update',
                content:doc.cache.buffer,
                cached:doc.usingCachedCopy,
                version:doc.version,
            });
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
                case 'pdfLoadSuccess':
                    void doc.confirmRendered(Number(e.content));
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
