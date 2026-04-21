import * as vscode from 'vscode';
import { isWithinActiveReplica } from '../utils/localReplicaWorkspace';

export type SaveIntentKind = 'editor' | 'agentReviewAccept';

export type SaveIntent = {
    kind: SaveIntentKind,
    time: number,
    hash: number,
    proposalId?: string,
    filePath?: string,
    hunkId?: string,
};

function hashText(text: string): number {
    let hash = 0;
    for (let i=0; i<text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return hash;
}

function hashBytes(content?: Uint8Array): number | undefined {
    if (content===undefined) {
        return undefined;
    }
    return hashText(new TextDecoder().decode(content));
}

export class SaveClassifier {
    private readonly intents = new Map<string, SaveIntent>();
    private readonly onDidEditorSaveEmitter = new vscode.EventEmitter<vscode.Uri>();

    readonly onDidEditorSave = this.onDidEditorSaveEmitter.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    beginAgentReviewAcceptSave(
        uri: vscode.Uri,
        content: string,
        proposalId: string,
        filePath: string,
        hunkId: string,
    ) {
        this.intents.set(uri.toString(), {
            kind: 'agentReviewAccept',
            time: Date.now(),
            hash: hashText(content),
            proposalId,
            filePath,
            hunkId,
        });
    }

    getRecentSaveIntent(uri: vscode.Uri, content?: Uint8Array, maxAgeMs = 10000): SaveIntent | undefined {
        const intent = this.intents.get(uri.toString());
        if (!intent || Date.now()-intent.time>maxAgeMs) {
            return undefined;
        }
        const contentHash = hashBytes(content);
        if (contentHash!==undefined && contentHash!==intent.hash) {
            return undefined;
        }
        return intent;
    }

    clearSaveIntent(uri: vscode.Uri) {
        this.intents.delete(uri.toString());
    }

    get triggers(): vscode.Disposable[] {
        return [
            this.onDidEditorSaveEmitter,
            vscode.workspace.onWillSaveTextDocument(event => {
                if (!isWithinActiveReplica(event.document.uri)) {
                    return;
                }
                const existing = this.intents.get(event.document.uri.toString());
                if (existing?.kind==='agentReviewAccept' && Date.now()-existing.time<10000) {
                    existing.hash = hashText(event.document.getText());
                    existing.time = Date.now();
                    return;
                }
                this.intents.set(event.document.uri.toString(), {
                    kind: 'editor',
                    time: Date.now(),
                    hash: hashText(event.document.getText()),
                });
            }),
            vscode.workspace.onDidSaveTextDocument(document => {
                const intent = this.intents.get(document.uri.toString());
                if (!intent || intent.kind!=='editor') {
                    return;
                }
                intent.time = Date.now();
                intent.hash = hashText(document.getText());
                this.onDidEditorSaveEmitter.fire(document.uri);
            }),
        ];
    }

    dispose() {
        this.context.subscriptions.filter(() => false);
        this.onDidEditorSaveEmitter.dispose();
    }
}
