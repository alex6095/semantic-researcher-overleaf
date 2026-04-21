import * as vscode from 'vscode';
import * as path from 'path';
import { ROOT_NAME } from '../consts';
import { AgentReviewFileProposal, AgentReviewHunk, AgentReviewProposal, AGENT_REVIEW_DIFF_SCHEME } from './types';
import { hunkSummary } from './diff';
import { AgentReviewProposalStore } from './proposalStore';
import { SaveClassifier } from './saveClassifier';
import { AgentReviewPhantomTracker, PhantomKey } from './phantomTracker';

function commandUri(command: string, args: unknown[]) {
    return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function toFileUri(proposal: AgentReviewProposal, file: AgentReviewFileProposal) {
    return vscode.Uri.file(path.join(proposal.rootPath, file.path.replace(/^\/+/, '')));
}

function codeBlock(lines: string[]) {
    const body = lines.slice(0, 12).join('\n');
    return lines.length>12 ? `${body}\n...` : body;
}

interface ReviewableChange {
    proposal: AgentReviewProposal,
    file: AgentReviewFileProposal,
    hunk: AgentReviewHunk,
    range: vscode.Range,
}

export class AgentReviewEditorProvider implements vscode.CodeLensProvider, vscode.HoverProvider, vscode.TextDocumentContentProvider {
    private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
    private readonly onDidChangeTextDocumentEmitter = new vscode.EventEmitter<vscode.Uri>();
    private readonly revealedFirstChanges = new Set<string>();
    private readonly phantomTracker = new AgentReviewPhantomTracker();
    private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    private readonly syncLocks = new Map<string, Promise<void>>();
    private activeRoot?: vscode.Uri;
    private suppressRefresh = false;

    // Red highlight + strike-through on the original (about-to-be-removed) lines.
    private readonly removedDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
        textDecoration: 'line-through',
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    // Green highlight on the inserted phantom lines (the proposed new content).
    private readonly addedDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    // Amber attention marker used when a change can't be aligned with the current document.
    private readonly conflictDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('editorWarning.background'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.warningForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        border: '1px dashed',
        borderColor: new vscode.ThemeColor('editorWarning.foreground'),
    });

    readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
    readonly onDidChange = this.onDidChangeTextDocumentEmitter.event;

    constructor(
        private readonly store: AgentReviewProposalStore,
        private readonly saveClassifier: SaveClassifier,
    ) {
        this.statusBar.command = `${ROOT_NAME}.agentReview.nextChange`;
    }

    setActiveRoot(rootUri: vscode.Uri | undefined) {
        this.activeRoot = rootUri;
        if (!rootUri) {
            this.statusBar.hide();
        }
    }

    // Called when the feature is disabled: strip any phantom lines out of every
    // visible editor and drop tracker state so no stale diff remains on screen.
    async deactivateEditors() {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.scheme!=='file') { continue; }
            await this.withSuppressedRefresh(() => this.phantomTracker.removeAllFromDocument(editor.document));
            editor.setDecorations(this.removedDecoration, []);
            editor.setDecorations(this.addedDecoration, []);
            editor.setDecorations(this.conflictDecoration, []);
        }
        this.revealedFirstChanges.clear();
        this.statusBar.hide();
        this.onDidChangeCodeLensesEmitter.fire();
    }

    refresh() {
        this.onDidChangeCodeLensesEmitter.fire();
        for (const proposal of this.store.all()) {
            for (const file of proposal.files) {
                const uri = vscode.Uri.from({scheme: AGENT_REVIEW_DIFF_SCHEME, authority: proposal.id, path: file.path});
                this.onDidChangeTextDocumentEmitter.fire(uri);
            }
        }
        void this.syncPhantomsAndDecorations();
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.store.getProposedContent(uri) ?? '';
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (document.uri.scheme!=='file') {
            return [];
        }
        const changes = this.reviewableChanges(document);
        if (changes.length===0) {
            return [];
        }
        const total = changes.length;
        const lenses: vscode.CodeLens[] = [];
        changes.forEach((change, index) => {
            const {proposal, file, hunk, range} = change;
            const position = Math.max(0, Math.min(range.start.line, document.lineCount-1));
            const anchor = new vscode.Range(position, 0, position, 0);
            const counter = total>1 ? ` (${index+1}/${total})` : '';

            lenses.push(new vscode.CodeLens(anchor, {
                title: `$(check) Accept Change${counter} ${hunkSummary(hunk)}`,
                command: `${ROOT_NAME}.agentReview.acceptHunk`,
                arguments: [proposal.id, file.path, hunk.id],
            }));
            lenses.push(new vscode.CodeLens(anchor, {
                title: '$(x) Decline',
                command: `${ROOT_NAME}.agentReview.declineHunk`,
                arguments: [proposal.id, file.path, hunk.id],
            }));
            lenses.push(new vscode.CodeLens(anchor, {
                title: '$(diff) Open Diff',
                command: `${ROOT_NAME}.agentReview.openDiff`,
                arguments: [proposal.id, file.path],
            }));
            if (total>1) {
                lenses.push(new vscode.CodeLens(anchor, {
                    title: `$(arrow-up) Previous (${index+1}/${total})`,
                    command: `${ROOT_NAME}.agentReview.previousChange`,
                }));
                lenses.push(new vscode.CodeLens(anchor, {
                    title: `$(arrow-down) Next (${index+1}/${total})`,
                    command: `${ROOT_NAME}.agentReview.nextChange`,
                }));
            }
        });

        if (total>=2) {
            const firstPosition = Math.max(0, Math.min(changes[0].range.start.line, document.lineCount-1));
            const bulkAnchor = new vscode.Range(firstPosition, 0, firstPosition, 0);
            lenses.push(new vscode.CodeLens(bulkAnchor, {
                title: `$(check-all) Accept All (${total})`,
                command: `${ROOT_NAME}.agentReview.acceptAllChangesInFile`,
            }));
            lenses.push(new vscode.CodeLens(bulkAnchor, {
                title: `$(close-all) Decline All (${total})`,
                command: `${ROOT_NAME}.agentReview.declineAllChangesInFile`,
            }));
        }
        return lenses;
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        if (document.uri.scheme!=='file') {
            return undefined;
        }
        const changes = this.reviewableChanges(document);
        for (let i=0; i<changes.length; i++) {
            const change = changes[i];
            if (!change.range.contains(position) && change.range.start.line!==position.line) {
                continue;
            }
            const {proposal, file, hunk} = change;
            const accept = commandUri(`${ROOT_NAME}.agentReview.acceptHunk`, [proposal.id, file.path, hunk.id]);
            const decline = commandUri(`${ROOT_NAME}.agentReview.declineHunk`, [proposal.id, file.path, hunk.id]);
            const diff = commandUri(`${ROOT_NAME}.agentReview.openDiff`, [proposal.id, file.path]);
            const previous = commandUri(`${ROOT_NAME}.agentReview.previousChange`, []);
            const next = commandUri(`${ROOT_NAME}.agentReview.nextChange`, []);
            const md = new vscode.MarkdownString(undefined, true);
            md.isTrusted = {
                enabledCommands: [
                    `${ROOT_NAME}.agentReview.acceptHunk`,
                    `${ROOT_NAME}.agentReview.declineHunk`,
                    `${ROOT_NAME}.agentReview.openDiff`,
                    `${ROOT_NAME}.agentReview.previousChange`,
                    `${ROOT_NAME}.agentReview.nextChange`,
                ],
            };
            md.appendMarkdown(`**Agent change (${i+1}/${changes.length})** ${hunkSummary(hunk)}\n\n`);
            if (hunk.proposedLines.length>0) {
                md.appendMarkdown('Proposed:\n\n');
                md.appendCodeblock(codeBlock(hunk.proposedLines), document.languageId);
                md.appendMarkdown('\n');
            }
            md.appendMarkdown(`[Accept](${accept}) | [Decline](${decline}) | [Open Diff](${diff}) | [Previous](${previous}) | [Next](${next})`);
            return new vscode.Hover(md, change.range);
        }
        return undefined;
    }

    async acceptHunk(proposalId: string, filePath: string, hunkId: string) {
        const match = this.store.findHunk(proposalId, filePath, hunkId);
        if (!match || (match.hunk.status!=='pending' && match.hunk.status!=='conflict')) {
            return;
        }
        const {proposal, file, hunk} = match;
        await this.applyAccept(proposal, file, hunk);
    }

    async declineHunk(proposalId: string, filePath: string, hunkId: string) {
        const match = this.store.findHunk(proposalId, filePath, hunkId);
        if (!match || match.hunk.status==='saved' || match.hunk.status==='saving') {
            return;
        }
        await this.applyDecline(match.proposal, match.file, match.hunk);
    }

    async openDiff(proposalId: string, filePath: string) {
        const proposal = this.store.all().find(candidate => candidate.id===proposalId);
        const file = proposal?.files.find(candidate => candidate.path===filePath);
        if (!proposal || !file) {
            return;
        }
        // Temporarily strip phantoms from the open document so the diff editor compares clean content.
        const left = toFileUri(proposal, file);
        try {
            const doc = await vscode.workspace.openTextDocument(left);
            if (this.phantomTracker.entriesForDocument(doc).length>0) {
                await this.withSuppressedRefresh(() => this.phantomTracker.removeAllFromDocument(doc));
            }
        } catch { /* document may not exist yet */ }
        const right = vscode.Uri.from({scheme: AGENT_REVIEW_DIFF_SCHEME, authority: proposal.id, path: file.path});
        await vscode.commands.executeCommand('vscode.diff', left, right, `Agent Proposal: ${file.path}`);
        // Reinstall phantoms after the diff editor opens.
        void this.syncPhantomsAndDecorations();
    }

    async revealAdjacentChange(direction: 'next' | 'previous') {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme!=='file') {
            return;
        }
        const changes = this.reviewableChanges(editor.document);
        if (changes.length===0) {
            return;
        }
        const activeLine = editor.selection.active.line;
        const targetIndex = direction==='next'
            ? this.firstIndexAfter(changes, activeLine) ?? 0
            : this.lastIndexBefore(changes, activeLine) ?? changes.length-1;
        await this.revealChange(editor, changes[targetIndex], false);
        this.updateStatusBar(targetIndex+1, changes.length);
    }

    async acceptAllInActiveFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme!=='file') {
            return;
        }
        await this.acceptAllInDocument(editor.document);
    }

    async declineAllInActiveFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme!=='file') {
            return;
        }
        await this.declineAllInDocument(editor.document);
    }

    async acceptAllChangesInWorkspace() {
        const proposals = this.store.all();
        const total = proposals.reduce((sum, proposal) =>
            sum + proposal.files.reduce((inner, file) =>
                inner + file.hunks.filter(h => h.status==='pending' || h.status==='conflict').length, 0), 0);
        if (total===0) {
            vscode.window.showInformationMessage('No pending agent changes to accept.');
            return;
        }
        const confirm = await vscode.window.showWarningMessage(`Accept ${total} pending agent change${total===1 ? '' : 's'} across all files?`, {modal: true}, 'Accept All');
        if (confirm!=='Accept All') {
            return;
        }
        for (const proposal of proposals) {
            for (const file of proposal.files) {
                const uri = toFileUri(proposal, file);
                let doc: vscode.TextDocument;
                try {
                    doc = await vscode.workspace.openTextDocument(uri);
                } catch {
                    continue;
                }
                await this.acceptAllInDocument(doc);
            }
        }
    }

    async declineAllChangesInWorkspace() {
        const proposals = this.store.all();
        const total = proposals.reduce((sum, proposal) =>
            sum + proposal.files.reduce((inner, file) =>
                inner + file.hunks.filter(h => h.status==='pending' || h.status==='conflict').length, 0), 0);
        if (total===0) {
            vscode.window.showInformationMessage('No pending agent changes to decline.');
            return;
        }
        const confirm = await vscode.window.showWarningMessage(`Decline ${total} pending agent change${total===1 ? '' : 's'} across all files?`, {modal: true}, 'Decline All');
        if (confirm!=='Decline All') {
            return;
        }
        for (const proposal of proposals) {
            for (const file of proposal.files) {
                const uri = toFileUri(proposal, file);
                let doc: vscode.TextDocument;
                try {
                    doc = await vscode.workspace.openTextDocument(uri);
                } catch {
                    continue;
                }
                await this.declineAllInDocument(doc);
            }
        }
    }

    get triggers(): vscode.Disposable[] {
        const selector: vscode.DocumentSelector = [{scheme: 'file'}];
        return [
            this.onDidChangeCodeLensesEmitter,
            this.onDidChangeTextDocumentEmitter,
            this.removedDecoration,
            this.addedDecoration,
            this.conflictDecoration,
            this.statusBar,
            vscode.languages.registerCodeLensProvider(selector, this),
            vscode.languages.registerHoverProvider(selector, this),
            vscode.workspace.registerTextDocumentContentProvider(AGENT_REVIEW_DIFF_SCHEME, this),
            this.store.onDidChange(() => this.refresh()),
            this.store.onDidImport(proposals => this.onNewProposalsImported(proposals)),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (!editor) {
                    this.statusBar.hide();
                    return;
                }
                void this.syncPhantomsAndDecorationsFor(editor);
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => {
                void this.syncPhantomsAndDecorations();
            }),
            vscode.workspace.onDidCloseTextDocument(doc => {
                // Clear tracker state for closed docs so reopen re-inserts phantoms cleanly.
                this.phantomTracker.clearDocument(doc);
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (this.suppressRefresh) {
                    return;
                }
                const editor = vscode.window.visibleTextEditors.find(candidate => candidate.document.uri.toString()===event.document.uri.toString());
                if (editor) {
                    this.updateDecorations(editor);
                }
            }),
            vscode.workspace.onWillSaveTextDocument(event => {
                const edits = this.phantomTracker.strippingEditsFor(event.document);
                if (edits.length===0) {
                    return;
                }
                event.waitUntil(Promise.resolve(edits));
                // Tracker is no longer valid after the strip — it will be rebuilt after save.
                this.phantomTracker.clearDocument(event.document);
            }),
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (doc.uri.scheme!=='file') {
                    return;
                }
                void this.syncPhantomsAndDecorations();
            }),
        ];
    }

    // Internal helpers --------------------------------------------------------

    private async applyAccept(proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk) {
        const uri = toFileUri(proposal, file);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, {preview: false, preserveFocus: true});

        const key: PhantomKey = {proposalId: proposal.id, filePath: file.path, hunkId: hunk.id};
        let accepted = false;

        // Fast path: a phantom already exists for this hunk — remove the original range so the phantom
        // becomes the file's permanent content with no intermediate diff flash.
        if (this.phantomTracker.hasEntry(document, key)) {
            accepted = await this.withSuppressedRefresh(() => this.phantomTracker.removeOriginalKeepPhantom(document, key));
        } else {
            const range = this.phantomTracker.findOriginalRange(document, hunk);
            if (!range) {
                hunk.status = 'conflict';
                await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
                vscode.window.showWarningMessage('Agent change no longer matches the editor buffer.');
                this.refresh();
                return;
            }
            const eol = document.eol===vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            const proposedText = hunk.proposedLines.length===0
                ? ''
                : hunk.proposedLines.join(eol) + (range.end.line<document.lineCount ? eol : '');
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, range, proposedText);
            accepted = await this.withSuppressedRefresh(() => Promise.resolve(vscode.workspace.applyEdit(edit)));
        }

        if (!accepted) {
            hunk.status = 'conflict';
            await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
            this.refresh();
            return;
        }

        hunk.status = 'saving';
        await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
        this.saveClassifier.beginAgentReviewAcceptSave(uri, document.getText(), proposal.id, file.path, hunk.id);
        const saved = await document.save();
        if (!saved) {
            hunk.status = 'conflict';
            this.saveClassifier.clearSaveIntent(uri);
            await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
        }
        this.invalidateRevealedKey(document, proposal.id, file.path, hunk.id);
        this.refresh();

        // The local save is only half of accept. The hunk becomes "saved" after
        // Local Replica confirms the Overleaf push, but we can still advance the
        // user's editing loop once the local buffer is safely written.
        if (saved) {
            await this.focusRemainingChange(editor);
        }
    }

    private async applyDecline(proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk) {
        const uri = toFileUri(proposal, file);
        let document: vscode.TextDocument | undefined;
        try {
            document = await vscode.workspace.openTextDocument(uri);
        } catch {
            document = undefined;
        }
        if (document) {
            const key: PhantomKey = {proposalId: proposal.id, filePath: file.path, hunkId: hunk.id};
            if (this.phantomTracker.hasEntry(document, key)) {
                await this.withSuppressedRefresh(() => this.phantomTracker.removePhantom(document!, key));
            }
        }
        hunk.status = 'declined';
        await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
        if (document) {
            this.invalidateRevealedKey(document, proposal.id, file.path, hunk.id);
            const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString()===document!.uri.toString());
            if (editor) {
                await this.focusRemainingChange(editor);
            }
        }
        this.refresh();
    }

    // Walks a document's pending changes from bottom to top so each edit's line numbers stay
    // valid across the sequence. Accept works on the edit range via the phantom tracker.
    private async acceptAllInDocument(document: vscode.TextDocument) {
        const changes = this.reviewableChanges(document).filter(change => change.hunk.status==='pending' || change.hunk.status==='conflict');
        if (changes.length===0) {
            return;
        }
        changes.sort((a, b) => b.range.start.line-a.range.start.line);
        for (const change of changes) {
            await this.applyAccept(change.proposal, change.file, change.hunk);
        }
    }

    private async declineAllInDocument(document: vscode.TextDocument) {
        const changes = this.reviewableChanges(document).filter(change => change.hunk.status==='pending' || change.hunk.status==='conflict');
        if (changes.length===0) {
            return;
        }
        changes.sort((a, b) => b.range.start.line-a.range.start.line);
        for (const change of changes) {
            await this.applyDecline(change.proposal, change.file, change.hunk);
        }
    }

    private reviewableChanges(document: vscode.TextDocument): ReviewableChange[] {
        const changes: ReviewableChange[] = [];
        for (const {proposal, file} of this.store.pendingForUri(document.uri)) {
            for (const hunk of file.hunks) {
                if (hunk.status!=='pending' && hunk.status!=='conflict') {
                    continue;
                }
                const range = this.rangeForChange(document, proposal.id, file.path, hunk);
                changes.push({proposal, file, hunk, range});
            }
        }
        return changes.sort((a, b) => a.range.start.line-b.range.start.line);
    }

    private rangeForChange(document: vscode.TextDocument, proposalId: string, filePath: string, hunk: AgentReviewHunk): vscode.Range {
        const entry = this.phantomTracker.findEntry(document, {proposalId, filePath, hunkId: hunk.id});
        if (entry) {
            // Bind the CodeLens/Hover to the phantom (green) lines so clicking Accept picks them.
            return new vscode.Range(entry.phantomRange.start, entry.phantomRange.end);
        }
        const range = this.phantomTracker.findOriginalRange(document, hunk);
        if (range) {
            return range;
        }
        const line = Math.max(0, Math.min(hunk.startLine, Math.max(0, document.lineCount-1)));
        return new vscode.Range(line, 0, line, 0);
    }

    private firstIndexAfter(changes: ReviewableChange[], line: number): number | undefined {
        for (let i=0; i<changes.length; i++) {
            if (changes[i].range.start.line>line) {
                return i;
            }
        }
        return undefined;
    }

    private lastIndexBefore(changes: ReviewableChange[], line: number): number | undefined {
        for (let i=changes.length-1; i>=0; i--) {
            if (changes[i].range.start.line<line) {
                return i;
            }
        }
        return undefined;
    }

    private updateStatusBar(current: number, total: number) {
        if (total<=0) {
            this.statusBar.hide();
            return;
        }
        this.statusBar.text = `$(git-compare) Agent ${current}/${total}`;
        this.statusBar.tooltip = total>1 ? 'Next agent change — Ctrl+click for command palette' : 'Jump to agent change';
        this.statusBar.show();
    }

    private updateDecorations(editor: vscode.TextEditor) {
        if (editor.document.uri.scheme!=='file') {
            editor.setDecorations(this.removedDecoration, []);
            editor.setDecorations(this.addedDecoration, []);
            editor.setDecorations(this.conflictDecoration, []);
            return;
        }

        const document = editor.document;
        const removed: vscode.DecorationOptions[] = [];
        const added: vscode.DecorationOptions[] = [];
        const conflict: vscode.DecorationOptions[] = [];

        const phantomEntries = new Map<string, ReturnType<AgentReviewPhantomTracker['entriesForDocument']>[number]>();
        for (const entry of this.phantomTracker.entriesForDocument(document)) {
            phantomEntries.set(`${entry.key.proposalId}::${entry.key.filePath}::${entry.key.hunkId}`, entry);
        }

        for (const {proposal, file} of this.store.pendingForUri(document.uri)) {
            for (const hunk of file.hunks) {
                const hoverMessage = new vscode.MarkdownString(`Agent change ${hunkSummary(hunk)}`);
                if (hunk.status==='conflict') {
                    const range = this.phantomTracker.findOriginalRange(document, hunk)
                        ?? new vscode.Range(hunk.startLine, 0, hunk.startLine, 0);
                    conflict.push({range, hoverMessage});
                    continue;
                }
                if (hunk.status!=='pending' && hunk.status!=='saving') {
                    continue;
                }
                const phantomKey = `${proposal.id}::${file.path}::${hunk.id}`;
                const phantom = phantomEntries.get(phantomKey);
                if (phantom) {
                    added.push({range: phantom.phantomRange, hoverMessage});
                    if (hunk.originalLines.length>0) {
                        removed.push({range: phantom.originalRange, hoverMessage});
                    }
                } else if (hunk.originalLines.length>0) {
                    const range = this.phantomTracker.findOriginalRange(document, hunk);
                    if (range) {
                        removed.push({range, hoverMessage});
                    }
                }
            }
        }

        editor.setDecorations(this.removedDecoration, removed);
        editor.setDecorations(this.addedDecoration, added);
        editor.setDecorations(this.conflictDecoration, conflict);
    }

    private async syncPhantomsAndDecorations() {
        for (const editor of vscode.window.visibleTextEditors) {
            await this.syncPhantomsAndDecorationsFor(editor);
        }
    }

    // Per-document mutex so overlapping event handlers (onDidChangeActiveTextEditor,
    // onDidChangeVisibleTextEditors, store.onDidChange, onDidSave, ...) cannot
    // race on ensurePhantomsForDocument and end up inserting duplicate phantoms.
    private async syncPhantomsAndDecorationsFor(editor: vscode.TextEditor) {
        const key = editor.document.uri.toString();
        const previous = this.syncLocks.get(key) ?? Promise.resolve();
        const next = previous
            .catch(() => {})
            .then(() => this.runSync(editor));
        this.syncLocks.set(key, next);
        try {
            await next;
        } finally {
            if (this.syncLocks.get(key)===next) {
                this.syncLocks.delete(key);
            }
        }
    }

    private async runSync(editor: vscode.TextEditor) {
        if (editor.document.uri.scheme!=='file') {
            editor.setDecorations(this.removedDecoration, []);
            editor.setDecorations(this.addedDecoration, []);
            editor.setDecorations(this.conflictDecoration, []);
            return;
        }
        const pending = this.store.pendingForUri(editor.document.uri);
        if (pending.length===0) {
            await this.withSuppressedRefresh(() => this.phantomTracker.removeAllFromDocument(editor.document));
            this.updateDecorations(editor);
            this.updateStatusBarFor(editor);
            return;
        }
        const {conflicts} = await this.withSuppressedRefresh(() => this.phantomTracker.ensurePhantomsForDocument(editor.document, pending));
        for (const {proposal, hunk} of conflicts) {
            if (hunk.status!=='conflict') {
                hunk.status = 'conflict';
                await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
            }
        }
        this.updateDecorations(editor);
        await this.maybeRevealFirstChange(editor);
        this.updateStatusBarFor(editor);
    }

    private updateStatusBarFor(editor: vscode.TextEditor) {
        const changes = this.reviewableChanges(editor.document);
        if (changes.length===0) {
            this.statusBar.hide();
            return;
        }
        const activeLine = editor.selection.active.line;
        const currentIndex = changes.findIndex(change => change.range.start.line<=activeLine && change.range.end.line>=activeLine);
        const index = currentIndex>=0 ? currentIndex+1 : 1;
        this.updateStatusBar(index, changes.length);
    }

    private async maybeRevealFirstChange(editor: vscode.TextEditor) {
        const [first] = this.reviewableChanges(editor.document);
        if (!first) {
            return;
        }
        const key = this.changeKey(editor.document, first);
        if (this.revealedFirstChanges.has(key)) {
            return;
        }
        this.revealedFirstChanges.add(key);
        await this.revealChange(editor, first, true);
    }

    // "Reveal" here means scroll the editor's viewport to the change — NEVER
    // move the caret or steal keyboard focus. The user may be typing in a
    // different editor and must not have their input redirected.
    private async revealChange(editor: vscode.TextEditor, change: ReviewableChange, ensureVisible: boolean) {
        let targetEditor = editor;
        if (ensureVisible) {
            targetEditor = await vscode.window.showTextDocument(editor.document, {
                viewColumn: editor.viewColumn ?? vscode.ViewColumn.Active,
                preview: false,
                preserveFocus: true,
            });
        }
        targetEditor.revealRange(change.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    private async focusRemainingChange(editor: vscode.TextEditor) {
        const changes = this.reviewableChanges(editor.document);
        if (changes.length===0) {
            this.statusBar.hide();
            return;
        }
        const activeLine = editor.selection.active.line;
        const nextIndex = this.firstIndexAfter(changes, activeLine) ?? 0;
        const target = changes[nextIndex];
        await this.revealChange(editor, target, false);
        this.updateStatusBar(nextIndex+1, changes.length);
    }

    private changeKey(document: vscode.TextDocument, change: ReviewableChange) {
        return `${document.uri.toString()}::${change.proposal.id}::${change.file.path}::${change.hunk.id}`;
    }

    private invalidateRevealedKey(document: vscode.TextDocument, proposalId: string, filePath: string, hunkId: string) {
        const prefix = `${document.uri.toString()}::${proposalId}::${filePath}::${hunkId}`;
        this.revealedFirstChanges.delete(prefix);
    }

    private async onNewProposalsImported(proposals: AgentReviewProposal[]) {
        if (proposals.length===0) {
            return;
        }
        // Bring at least one affected file on-screen so the user can see the diff,
        // but never steal focus: the user may be typing in a different editor.
        for (const proposal of proposals) {
            for (const file of proposal.files) {
                const uri = toFileUri(proposal, file);
                const alreadyVisible = vscode.window.visibleTextEditors.some(editor => editor.document.uri.toString()===uri.toString());
                if (alreadyVisible) {
                    continue;
                }
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc, {preview: false, preserveFocus: true});
                    await this.syncPhantomsAndDecorations();
                    return;
                } catch {
                    continue;
                }
            }
        }
        await this.syncPhantomsAndDecorations();
    }

    private async withSuppressedRefresh<T>(fn: () => Promise<T> | T): Promise<T> {
        this.suppressRefresh = true;
        try {
            return await fn();
        } finally {
            this.suppressRefresh = false;
        }
    }
}
