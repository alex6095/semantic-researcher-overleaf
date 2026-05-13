import * as vscode from 'vscode';
import {EventEmitter} from 'events';
import { PdfDocument } from '../core/pdfViewEditorProvider';
import { StatusInfo } from '../scm';

export type Events = {
    'fileWillOpenEvent': {uri: vscode.Uri},
    'pdfWillOpenEvent': {uri: vscode.Uri, doc:PdfDocument, webviewPanel:vscode.WebviewPanel},
    'spellCheckLanguageUpdateEvent': {language:string},
    'compilerUpdateEvent': {compiler:string},
    'rootDocUpdateEvent': {rootDocId:string},
    'scmStatusChangeEvent': {status:StatusInfo},
    'socketioConnectedEvent': {publicId:string},
    // Fires once per applySync terminal — success, failure, or guard-block —
    // for either sync direction. Replaces the prior pattern of awaiting
    // flushPendingPush() + polling status; subscribers can wait for the
    // specific (relPath, direction) without races. `outcome` distinguishes:
    //   'success' — work landed on the destination
    //   'error'   — the inner write/upload threw (see `error` for message)
    //   'blocked' — a Layer 3/4/4b guard rejected the operation
    //   'suppressed' — bypassSync / noop / cache match short-circuited it
    'scmSyncCompleteEvent': {
        rootUri: vscode.Uri,
        relPath: string,
        direction: 'push' | 'pull',
        type: 'update' | 'delete',
        outcome: 'success' | 'error' | 'blocked' | 'suppressed',
        error?: string,
    },
};

export class EventBus {
    private static _eventEmitter = new EventEmitter();

    static fire<T extends keyof Events>(eventName: T, arg: Events[T]): void {
        EventBus._eventEmitter.emit(eventName, arg);
    }

    static on<T extends keyof Events>(eventName: T, cb: (arg: Events[T]) => void): vscode.Disposable {
        EventBus._eventEmitter.on(eventName, cb);
        const disposable = {
            dispose: () => { EventBus._eventEmitter.removeListener(eventName, cb); }
        };
        return disposable;
    }
}
