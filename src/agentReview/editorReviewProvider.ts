import * as vscode from 'vscode';
import * as path from 'path';
import { ROOT_NAME } from '../consts';
import { AgentReviewFileProposal, AgentReviewHunk, AgentReviewProposal, AGENT_REVIEW_BASE_DIFF_SCHEME, AGENT_REVIEW_DIFF_SCHEME } from './types';
import { hunkSummary } from './diff';
import { AgentReviewProposalStore } from './proposalStore';
import { SaveClassifier } from './saveClassifier';
import { AgentReviewChangeLocator } from './changeLocator';

function commandUri(command: string, args: unknown[]) {
    return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function toFileUri(proposal: AgentReviewProposal, file: AgentReviewFileProposal) {
    return vscode.Uri.file(path.join(proposal.rootPath, file.path.replace(/^\/+/, '')));
}

const AGGREGATE_DIFF_PATH = '/__agent_review_all__.tex';
const CODE_LENS_GAP = '   ';

function isAggregateDiffUri(uri: vscode.Uri) {
    return uri.path===AGGREGATE_DIFF_PATH;
}

function isAgentReviewDiffDocument(uri: vscode.Uri) {
    return uri.scheme===AGENT_REVIEW_DIFF_SCHEME || uri.scheme===AGENT_REVIEW_BASE_DIFF_SCHEME;
}

function codeBlock(lines: string[]) {
    const body = lines.slice(0, 12).join('\n');
    return lines.length>12 ? `${body}\n...` : body;
}

function normalizeDiffPath(uriPath: string) {
    const decoded = decodeURIComponent(uriPath.replace(/^\/+/, ''));
    return decoded.startsWith('/') ? decoded : `/${decoded}`;
}

function splitLines(text: string) {
    if (text==='') {
        return [''];
    }
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function spacedCodeLensTitle(title: string) {
    return `${CODE_LENS_GAP}${title}`;
}

interface ReviewableChange {
    proposal: AgentReviewProposal,
    file: AgentReviewFileProposal,
    hunk: AgentReviewHunk,
    range: vscode.Range,
}

interface ReviewTarget {
    proposal: AgentReviewProposal,
    file: AgentReviewFileProposal,
    hunk: AgentReviewHunk,
}

interface ActiveDiffState {
    proposalId: string,
    filePath: string,
    hunkId?: string,
}

interface BatchAcceptFile {
    uri: vscode.Uri,
    document: vscode.TextDocument,
    edits: vscode.TextEdit[],
    acceptedHunks: Array<{proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk}>,
}

interface FileScope {
    proposalId: string,
    filePath: string,
}

export class AgentReviewEditorProvider implements vscode.CodeLensProvider, vscode.HoverProvider, vscode.TextDocumentContentProvider {
    private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
    private readonly onDidChangeTextDocumentEmitter = new vscode.EventEmitter<vscode.Uri>();
    private readonly changeLocator = new AgentReviewChangeLocator();
    private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    private readonly syncLocks = new Map<string, Promise<void>>();
    private activeDiffState?: ActiveDiffState;

    readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
    readonly onDidChange = this.onDidChangeTextDocumentEmitter.event;

    constructor(
        private readonly store: AgentReviewProposalStore,
        private readonly saveClassifier: SaveClassifier,
    ) {
        this.statusBar.command = `${ROOT_NAME}.agentReview.nextChange`;
    }

    setActiveRoot(rootUri: vscode.Uri | undefined) {
        if (!rootUri) {
            this.activeDiffState = undefined;
            this.statusBar.hide();
        }
    }

    // Called when the feature is disabled: drop transient review navigation state.
    async deactivateEditors() {
        this.activeDiffState = undefined;
        this.statusBar.hide();
        this.onDidChangeCodeLensesEmitter.fire();
    }

    refresh() {
        this.onDidChangeCodeLensesEmitter.fire();
        for (const proposal of this.store.all()) {
            this.onDidChangeTextDocumentEmitter.fire(this.aggregateDiffUri(proposal, 'original'));
            this.onDidChangeTextDocumentEmitter.fire(this.aggregateDiffUri(proposal, 'proposed'));
            for (const file of proposal.files) {
                const uri = vscode.Uri.from({scheme: AGENT_REVIEW_DIFF_SCHEME, authority: proposal.id, path: file.path});
                this.onDidChangeTextDocumentEmitter.fire(uri);
            }
        }
        void this.syncReviewState();
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const proposal = this.store.all().find(candidate => candidate.id===uri.authority);
        if (!proposal) {
            return '';
        }
        if (isAggregateDiffUri(uri)) {
            return uri.scheme===AGENT_REVIEW_BASE_DIFF_SCHEME
                ? this.composeAggregateContent(proposal, 'original')
                : this.composeAggregateContent(proposal, 'proposed');
        }
        if (uri.scheme===AGENT_REVIEW_BASE_DIFF_SCHEME) {
            const filePath = normalizeDiffPath(uri.path);
            const file = proposal.files.find(candidate => candidate.path===filePath);
            return file ? this.currentFileText(proposal, file) : '';
        }
        return this.store.getProposedContent(uri) ?? '';
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (document.uri.scheme!==AGENT_REVIEW_DIFF_SCHEME) {
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
            lenses.push(new vscode.CodeLens(anchor, {
                title: `$(check) Accept`,
                command: `${ROOT_NAME}.agentReview.acceptHunk`,
                arguments: [proposal.id, file.path, hunk.id],
            }));
            lenses.push(new vscode.CodeLens(anchor, {
                title: spacedCodeLensTitle('$(x) Decline'),
                command: `${ROOT_NAME}.agentReview.declineHunk`,
                arguments: [proposal.id, file.path, hunk.id],
            }));
            if (total>1) {
                lenses.push(new vscode.CodeLens(anchor, {
                    title: spacedCodeLensTitle('$(arrow-up) Previous'),
                    command: `${ROOT_NAME}.agentReview.previousChange`,
                }));
                lenses.push(new vscode.CodeLens(anchor, {
                    title: spacedCodeLensTitle('$(arrow-down) Next'),
                    command: `${ROOT_NAME}.agentReview.nextChange`,
                }));
            }
            lenses.push(new vscode.CodeLens(anchor, {
                title: spacedCodeLensTitle(`$(git-compare) Change (${index+1}/${total}) ${hunkSummary(hunk)} ${file.path}`),
                command: `${ROOT_NAME}.agentReview.nextChange`,
            }));
        });

        if (total>=2) {
            const first = changes[0];
            const firstPosition = Math.max(0, Math.min(first.range.start.line, document.lineCount-1));
            const bulkAnchor = new vscode.Range(firstPosition, 0, firstPosition, 0);
            lenses.push(new vscode.CodeLens(bulkAnchor, {
                title: `$(check-all) Accept All (${total})`,
                command: `${ROOT_NAME}.agentReview.acceptAllChangesInFile`,
            }));
            lenses.push(new vscode.CodeLens(bulkAnchor, {
                title: spacedCodeLensTitle(`$(close-all) Decline All (${total})`),
                command: `${ROOT_NAME}.agentReview.declineAllChangesInFile`,
            }));
        }
        return lenses;
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        if (document.uri.scheme!==AGENT_REVIEW_DIFF_SCHEME) {
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
            const previous = commandUri(`${ROOT_NAME}.agentReview.previousChange`, []);
            const next = commandUri(`${ROOT_NAME}.agentReview.nextChange`, []);
            const md = new vscode.MarkdownString(undefined, true);
            md.isTrusted = {
                enabledCommands: [
                    `${ROOT_NAME}.agentReview.acceptHunk`,
                    `${ROOT_NAME}.agentReview.declineHunk`,
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
            const separator = ' &nbsp;&nbsp;|&nbsp;&nbsp; ';
            md.appendMarkdown(`[Accept](${accept})${separator}[Decline](${decline})${separator}[Previous](${previous})${separator}[Next](${next})`);
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

    async openDiff(proposalId: string, filePath: string, hunkId?: string, options?: {preserveFocus?: boolean}) {
        const proposal = this.store.all().find(candidate => candidate.id===proposalId);
        const normalizedFilePath = filePath.startsWith('/') ? filePath : `/${filePath}`;
        const file = proposal?.files.find(candidate => candidate.path===normalizedFilePath);
        if (!proposal || !file) {
            return;
        }
        await this.ensureInlineDiffMode();
        const left = this.aggregateDiffUri(proposal, 'original');
        const right = this.aggregateDiffUri(proposal, 'proposed');
        this.activeDiffState = {proposalId: proposal.id, filePath: file.path, hunkId};
        await vscode.commands.executeCommand(
            'vscode.diff',
            left,
            right,
            `Agent Review: ${this.pendingTargetsForProposal(proposal).length} changes`,
            {preview: false, preserveFocus: options?.preserveFocus ?? false},
        );
        const hunk = hunkId ? file.hunks.find(candidate => candidate.id===hunkId) : this.pendingTargetsForFile(proposal, file)[0]?.hunk;
        if (hunk) {
            await this.revealDiffHunk(proposal, file, hunk);
        }
        void this.syncReviewState();
    }

    async revealAdjacentChange(direction: 'next' | 'previous') {
        const editor = vscode.window.activeTextEditor;
        if (editor && isAgentReviewDiffDocument(editor.document.uri)) {
            await this.revealAdjacentDiffChange(editor.document, direction);
            return;
        }
        if (this.activeDiffState && editor) {
            const activeTarget = this.targetFromState(this.activeDiffState);
            if (activeTarget && toFileUri(activeTarget.proposal, activeTarget.file).toString()===editor.document.uri.toString()) {
                await this.revealAdjacentDiffChange(undefined, direction);
                return;
            }
        }
        const [first] = this.allPendingTargets();
        if (first) {
            await this.openTargetDiff(first);
        }
    }

    async acceptAllInActiveFile(proposalId?: string, filePath?: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isAgentReviewDiffDocument(editor.document.uri)) {
            return;
        }
        const scope = proposalId && filePath ? this.resolveFileScope(editor.document, proposalId, filePath) : undefined;
        await this.acceptAllInDocument(editor.document, scope);
        await this.closeActiveReviewDiffIfDone(editor.document);
    }

    async declineAllInActiveFile(proposalId?: string, filePath?: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isAgentReviewDiffDocument(editor.document.uri)) {
            return;
        }
        const scope = proposalId && filePath ? this.resolveFileScope(editor.document, proposalId, filePath) : undefined;
        await this.declineAllInDocument(editor.document, scope);
        await this.closeActiveReviewDiffIfDone(editor.document);
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
        const reviewUiSelector: vscode.DocumentSelector = [{scheme: AGENT_REVIEW_DIFF_SCHEME}];
        return [
            this.onDidChangeCodeLensesEmitter,
            this.onDidChangeTextDocumentEmitter,
            this.statusBar,
            vscode.languages.registerCodeLensProvider(reviewUiSelector, this),
            vscode.languages.registerHoverProvider(reviewUiSelector, this),
            vscode.workspace.registerTextDocumentContentProvider(AGENT_REVIEW_BASE_DIFF_SCHEME, this),
            vscode.workspace.registerTextDocumentContentProvider(AGENT_REVIEW_DIFF_SCHEME, this),
            this.store.onDidChange(() => this.refresh()),
            this.store.onDidImport(proposals => this.onNewProposalsImported(proposals)),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (!editor) {
                    this.statusBar.hide();
                    return;
                }
                void this.syncReviewStateFor(editor);
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => {
                void this.syncReviewState();
            }),
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (doc.uri.scheme!=='file') {
                    return;
                }
                void this.syncReviewState();
            }),
        ];
    }

    // Internal helpers --------------------------------------------------------

    private async applyAccept(proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk) {
        const uri = toFileUri(proposal, file);
        const document = await vscode.workspace.openTextDocument(uri);

        const range = this.changeLocator.findOriginalRange(document, hunk);
        if (!range) {
            hunk.status = 'conflict';
            await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
            vscode.window.showWarningMessage('Agent change no longer matches the editor buffer.');
            this.refresh();
            return;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.set(uri, [this.changeLocator.createAcceptEdit(document, hunk, range)]);
        const accepted = await vscode.workspace.applyEdit(edit);

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
        this.refresh();

        // The local save is only half of accept. The hunk becomes "saved" after
        // Local Replica confirms the Overleaf push, but we can still advance the
        // user's editing loop once the local buffer is safely written.
        if (saved) {
            await this.openNextRemainingDiffAfter(proposal, file, hunk);
        }
    }

    private async applyDecline(proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk) {
        hunk.status = 'declined';
        await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
        this.refresh();
        await this.openNextRemainingDiffAfter(proposal, file, hunk);
    }

    private async ensureInlineDiffMode() {
        const config = vscode.workspace.getConfiguration('diffEditor');
        if (config.get<boolean>('renderSideBySide')!==false) {
            try {
                await config.update('renderSideBySide', false, vscode.ConfigurationTarget.Workspace);
            } catch (error) {
                console.warn('Could not set diffEditor.renderSideBySide=false for Agent Review:', error);
            }
        }
        if (config.get<boolean>('codeLens')!==true) {
            try {
                await config.update('codeLens', true, vscode.ConfigurationTarget.Workspace);
            } catch (error) {
                console.warn('Could not set diffEditor.codeLens=true for Agent Review:', error);
            }
        }
    }

    private async openTargetDiff(target: ReviewTarget, options?: {preserveFocus?: boolean}) {
        await this.openDiff(target.proposal.id, target.file.path, target.hunk.id, options);
    }

    private aggregateDiffUri(proposal: AgentReviewProposal, side: 'original' | 'proposed') {
        return vscode.Uri.from({
            scheme: side==='original' ? AGENT_REVIEW_BASE_DIFF_SCHEME : AGENT_REVIEW_DIFF_SCHEME,
            authority: proposal.id,
            path: AGGREGATE_DIFF_PATH,
        });
    }

    private aggregateFiles(proposal: AgentReviewProposal): AgentReviewFileProposal[] {
        const files = proposal.files.filter(file =>
            file.hunks.some(hunk => hunk.status==='pending' || hunk.status==='conflict' || hunk.status==='saving' || hunk.status==='saved'),
        );
        return files.length>0 ? files : proposal.files;
    }

    private async composeAggregateContent(proposal: AgentReviewProposal, side: 'original' | 'proposed'): Promise<string> {
        const chunks: string[] = [];
        for (const file of this.aggregateFiles(proposal)) {
            chunks.push(`% Agent Review: ${file.path}`);
            chunks.push(side==='original'
                ? await this.currentFileText(proposal, file)
                : this.store.composeVisibleProposedContent(file));
            chunks.push('');
        }
        return chunks.join('\n');
    }

    private async currentFileText(proposal: AgentReviewProposal, file: AgentReviewFileProposal): Promise<string> {
        try {
            const document = await vscode.workspace.openTextDocument(toFileUri(proposal, file));
            return document.getText();
        } catch {
            return file.originalText;
        }
    }

    private pendingTargetsForFile(proposal: AgentReviewProposal, file: AgentReviewFileProposal): ReviewTarget[] {
        return file.hunks
            .filter(hunk => hunk.status==='pending' || hunk.status==='conflict')
            .map(hunk => ({proposal, file, hunk}))
            .sort((a, b) => a.hunk.startLine-b.hunk.startLine);
    }

    private pendingTargetsForProposal(proposal: AgentReviewProposal): ReviewTarget[] {
        return this.aggregateFiles(proposal).flatMap(file => this.pendingTargetsForFile(proposal, file));
    }

    private allPendingTargets(): ReviewTarget[] {
        const targets: ReviewTarget[] = [];
        for (const proposal of this.store.all()) {
            targets.push(...this.pendingTargetsForProposal(proposal));
        }
        return targets;
    }

    private targetFromState(state: ActiveDiffState): ReviewTarget | undefined {
        const proposal = this.store.all().find(candidate => candidate.id===state.proposalId);
        const file = proposal?.files.find(candidate => candidate.path===state.filePath);
        if (!proposal || !file) {
            return undefined;
        }
        const hunk = state.hunkId
            ? file.hunks.find(candidate => candidate.id===state.hunkId)
            : this.pendingTargetsForFile(proposal, file)[0]?.hunk;
        return hunk ? {proposal, file, hunk} : undefined;
    }

    private async openNextRemainingDiffAfter(proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk) {
        const proposalTargets = this.pendingTargetsForProposal(proposal);
        if (proposalTargets.length===0) {
            this.activeDiffState = undefined;
            this.statusBar.hide();
            await this.closeActiveReviewDiffEditor(proposal.id);
            return;
        }

        const fileOrder = this.aggregateFiles(proposal).findIndex(candidate => candidate.path===file.path);
        const nextInProposal = proposalTargets.find(target => {
            const targetFileOrder = this.aggregateFiles(proposal).findIndex(candidate => candidate.path===target.file.path);
            return targetFileOrder>fileOrder || (targetFileOrder===fileOrder && target.hunk.startLine>=hunk.startLine);
        }) ?? proposalTargets[0];
        await this.openTargetDiff(nextInProposal);
    }

    private async revealAdjacentDiffChange(document: vscode.TextDocument | undefined, direction: 'next' | 'previous') {
        const state = document?.uri.scheme===AGENT_REVIEW_DIFF_SCHEME && !isAggregateDiffUri(document.uri)
            ? {
                proposalId: document.uri.authority,
                filePath: normalizeDiffPath(document.uri.path),
                hunkId: this.activeDiffState?.hunkId,
            }
            : this.activeDiffState;
        if (!state) {
            const [first] = this.allPendingTargets();
            if (first) {
                await this.openTargetDiff(first);
            }
            return;
        }
        const proposal = this.store.all().find(candidate => candidate.id===state.proposalId);
        const file = proposal?.files.find(candidate => candidate.path===state.filePath);
        if (!proposal || !file) {
            return;
        }
        const aggregateDocument = !!document && isAgentReviewDiffDocument(document.uri) && isAggregateDiffUri(document.uri);
        const targets = aggregateDocument
            ? this.pendingTargetsForProposal(proposal)
            : this.pendingTargetsForFile(proposal, file);
        if (targets.length===0) {
            const [first] = this.allPendingTargets();
            if (first) {
                await this.openTargetDiff(first);
            }
            return;
        }
        let currentIndex = state.hunkId ? targets.findIndex(target => target.hunk.id===state.hunkId) : -1;
        if (currentIndex<0 && document) {
            const activeLine = vscode.window.activeTextEditor?.selection.active.line ?? 0;
            currentIndex = targets.findIndex(target => {
                const range = aggregateDocument
                    ? this.rangeForAggregateDiffChange(document, target.proposal, target.file, target.hunk, document.uri.scheme)
                    : this.rangeForDiffChange(document, target.file, target.hunk);
                return range.start.line<=activeLine && range.end.line>=activeLine;
            });
        }
        if (currentIndex<0) {
            currentIndex = direction==='next' ? -1 : 0;
        }
        const targetIndex = direction==='next'
            ? (currentIndex+1) % targets.length
            : (currentIndex-1+targets.length) % targets.length;
        const target = targets[targetIndex];
        this.activeDiffState = {proposalId: target.proposal.id, filePath: target.file.path, hunkId: target.hunk.id};
        if (aggregateDocument) {
            await this.revealDiffHunk(target.proposal, target.file, target.hunk);
        } else {
            await this.openTargetDiff(target);
        }
        this.updateStatusBar(targetIndex+1, targets.length);
    }

    private async revealDiffHunk(proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk) {
        const lineNumber = this.aggregateLineForHunk(proposal, file, hunk) + 1;
        try {
            await vscode.commands.executeCommand('revealLine', {lineNumber, at: 'center'});
        } catch {
            // Best-effort only: some VS Code builds do not route revealLine into diff editors.
        }
    }

    // Walks a document's pending changes from bottom to top so each edit's line numbers stay
    // valid across the sequence. Accept works on the edit range via the change locator.
    private async acceptAllInDocument(document: vscode.TextDocument, scope?: FileScope) {
        const changes = this.reviewableChanges(document).filter(change =>
            (change.hunk.status==='pending' || change.hunk.status==='conflict') && this.matchesFileScope(change, scope));
        if (changes.length===0) {
            return;
        }
        await this.applyAcceptBatch(changes);
    }

    private async declineAllInDocument(document: vscode.TextDocument, scope?: FileScope) {
        const changes = this.reviewableChanges(document).filter(change =>
            (change.hunk.status==='pending' || change.hunk.status==='conflict') && this.matchesFileScope(change, scope));
        if (changes.length===0) {
            return;
        }
        await this.applyDeclineBatch(changes);
    }

    private async applyAcceptBatch(changes: ReviewableChange[]) {
        const fileBatches = new Map<string, BatchAcceptFile>();
        const proposalsToPersist = new Set<AgentReviewProposal>();
        const validChanges: Array<{proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk}> = [];

        for (const change of changes) {
            const uri = toFileUri(change.proposal, change.file);
            let batch = fileBatches.get(uri.toString());
            if (!batch) {
                let document: vscode.TextDocument;
                try {
                    document = await vscode.workspace.openTextDocument(uri);
                } catch {
                    change.hunk.status = 'conflict';
                    proposalsToPersist.add(change.proposal);
                    continue;
                }
                batch = {uri, document, edits: [], acceptedHunks: []};
                fileBatches.set(uri.toString(), batch);
            }

            const range = this.changeLocator.findOriginalRange(batch.document, change.hunk);
            if (!range) {
                change.hunk.status = 'conflict';
                proposalsToPersist.add(change.proposal);
                continue;
            }
            batch.edits.push(this.changeLocator.createAcceptEdit(batch.document, change.hunk, range));
            batch.acceptedHunks.push({proposal: change.proposal, file: change.file, hunk: change.hunk});
            validChanges.push({proposal: change.proposal, file: change.file, hunk: change.hunk});
        }

        const workspaceEdit = new vscode.WorkspaceEdit();
        for (const batch of fileBatches.values()) {
            if (batch.edits.length>0) {
                batch.edits.sort((a, b) =>
                    b.range.start.line-a.range.start.line || b.range.start.character-a.range.start.character);
                workspaceEdit.set(batch.uri, batch.edits);
            }
        }

        if (validChanges.length===0) {
            for (const proposal of proposalsToPersist) {
                await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
            }
            this.refresh();
            return;
        }

        const accepted = await vscode.workspace.applyEdit(workspaceEdit);
        if (!accepted) {
            for (const change of validChanges) {
                change.hunk.status = 'conflict';
                proposalsToPersist.add(change.proposal);
            }
            for (const proposal of proposalsToPersist) {
                await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
            }
            this.refresh();
            return;
        }

        for (const batch of fileBatches.values()) {
            for (const change of batch.acceptedHunks) {
                change.hunk.status = 'saving';
                proposalsToPersist.add(change.proposal);
            }
        }
        for (const proposal of proposalsToPersist) {
            await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
        }

        for (const batch of fileBatches.values()) {
            if (batch.acceptedHunks.length===0) {
                continue;
            }
            this.saveClassifier.beginAgentReviewAcceptBatchSave(
                batch.uri,
                batch.document.getText(),
                batch.acceptedHunks.map(change => ({
                    proposalId: change.proposal.id,
                    filePath: change.file.path,
                    hunkId: change.hunk.id,
                })),
            );
            const saved = await batch.document.save();
            if (!saved) {
                this.saveClassifier.clearSaveIntent(batch.uri);
                const failedProposals = new Set<AgentReviewProposal>();
                for (const change of batch.acceptedHunks) {
                    change.hunk.status = 'conflict';
                    failedProposals.add(change.proposal);
                }
                for (const proposal of failedProposals) {
                    await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
                }
            }
        }

        this.refresh();
    }

    private async applyDeclineBatch(changes: ReviewableChange[]) {
        const proposalsToPersist = new Set<AgentReviewProposal>();

        for (const change of changes) {
            change.hunk.status = 'declined';
            proposalsToPersist.add(change.proposal);
        }

        for (const proposal of proposalsToPersist) {
            await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
        }
        this.refresh();
    }

    private reviewableChanges(document: vscode.TextDocument): ReviewableChange[] {
        if (isAgentReviewDiffDocument(document.uri)) {
            return this.reviewableDiffChanges(document);
        }
        const changes: ReviewableChange[] = [];
        for (const {proposal, file} of this.store.pendingForUri(document.uri)) {
            for (const hunk of file.hunks) {
                if (hunk.status!=='pending' && hunk.status!=='conflict') {
                    continue;
                }
                const range = this.rangeForChange(document, hunk);
                changes.push({proposal, file, hunk, range});
            }
        }
        return changes.sort((a, b) => a.range.start.line-b.range.start.line);
    }

    private resolveFileScope(document: vscode.TextDocument, proposalId?: string, filePath?: string): FileScope | undefined {
        if (proposalId && filePath) {
            return {
                proposalId,
                filePath: filePath.startsWith('/') ? filePath : `/${filePath}`,
            };
        }
        if (!isAgentReviewDiffDocument(document.uri)) {
            return undefined;
        }
        if (!isAggregateDiffUri(document.uri)) {
            return {
                proposalId: document.uri.authority,
                filePath: normalizeDiffPath(document.uri.path),
            };
        }

        const changes = this.reviewableChanges(document);
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor?.document.uri.toString()===document.uri.toString()) {
            const activeLine = activeEditor.selection.active.line;
            const activeChange = changes.find(change =>
                change.range.start.line<=activeLine && change.range.end.line>=activeLine);
            if (activeChange) {
                return {proposalId: activeChange.proposal.id, filePath: activeChange.file.path};
            }
        }

        if (this.activeDiffState && this.activeDiffState.proposalId===document.uri.authority) {
            return {
                proposalId: this.activeDiffState.proposalId,
                filePath: this.activeDiffState.filePath,
            };
        }

        const [first] = changes;
        return first ? {proposalId: first.proposal.id, filePath: first.file.path} : undefined;
    }

    private matchesFileScope(change: ReviewableChange, scope?: FileScope) {
        return !scope || (change.proposal.id===scope.proposalId && change.file.path===scope.filePath);
    }

    private async closeActiveReviewDiffIfDone(document: vscode.TextDocument) {
        if (!isAgentReviewDiffDocument(document.uri) || this.reviewableChanges(document).length>0) {
            return;
        }
        await this.closeActiveReviewDiffEditor(document.uri.authority);
    }

    private async closeActiveReviewDiffEditor(proposalId?: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isAgentReviewDiffDocument(editor.document.uri)) {
            return;
        }
        if (proposalId && editor.document.uri.authority!==proposalId) {
            return;
        }
        this.activeDiffState = undefined;
        this.statusBar.hide();
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }

    private reviewableDiffChanges(document: vscode.TextDocument): ReviewableChange[] {
        const proposal = this.store.all().find(candidate => candidate.id===document.uri.authority);
        if (!proposal) {
            return [];
        }
        if (isAggregateDiffUri(document.uri)) {
            return this.pendingTargetsForProposal(proposal).map(target => ({
                ...target,
                range: this.rangeForAggregateDiffChange(document, target.proposal, target.file, target.hunk, document.uri.scheme),
            }));
        }
        const filePath = normalizeDiffPath(document.uri.path);
        const file = proposal?.files.find(candidate => candidate.path===filePath);
        if (!file) {
            return [];
        }
        return this.pendingTargetsForFile(proposal, file).map(target => ({
            ...target,
            range: this.rangeForDiffChange(document, file, target.hunk),
        }));
    }

    private rangeForChange(document: vscode.TextDocument, hunk: AgentReviewHunk): vscode.Range {
        const range = this.changeLocator.findOriginalRange(document, hunk);
        if (range) {
            return range;
        }
        const line = Math.max(0, Math.min(hunk.startLine, Math.max(0, document.lineCount-1)));
        return new vscode.Range(line, 0, line, 0);
    }

    private rangeForDiffChange(document: vscode.TextDocument, file: AgentReviewFileProposal, hunk: AgentReviewHunk): vscode.Range {
        const line = Math.max(0, Math.min(this.proposedLineForHunk(file, hunk), Math.max(0, document.lineCount-1)));
        if (hunk.proposedLines.length===0) {
            return new vscode.Range(line, 0, line, 0);
        }
        const endLine = Math.max(line, Math.min(line+hunk.proposedLines.length-1, Math.max(0, document.lineCount-1)));
        return new vscode.Range(document.lineAt(line).range.start, document.lineAt(endLine).range.end);
    }

    private rangeForAggregateDiffChange(
        document: vscode.TextDocument,
        proposal: AgentReviewProposal,
        file: AgentReviewFileProposal,
        hunk: AgentReviewHunk,
        scheme = document.uri.scheme,
    ): vscode.Range {
        const lineNumber = scheme===AGENT_REVIEW_BASE_DIFF_SCHEME
            ? this.aggregateOriginalLineForHunk(proposal, file, hunk)
            : this.aggregateLineForHunk(proposal, file, hunk);
        const line = Math.max(0, Math.min(lineNumber, Math.max(0, document.lineCount-1)));
        const lineCount = scheme===AGENT_REVIEW_BASE_DIFF_SCHEME ? hunk.originalLines.length : hunk.proposedLines.length;
        if (lineCount===0) {
            return new vscode.Range(line, 0, line, 0);
        }
        const endLine = Math.max(line, Math.min(line+lineCount-1, Math.max(0, document.lineCount-1)));
        return new vscode.Range(document.lineAt(line).range.start, document.lineAt(endLine).range.end);
    }

    private aggregateOriginalLineForHunk(proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk): number {
        let line = 0;
        for (const candidate of this.aggregateFiles(proposal)) {
            if (candidate.path===file.path) {
                return line + 1 + hunk.startLine;
            }
            line += 1 + splitLines(candidate.originalText).length + 1;
        }
        return hunk.startLine;
    }

    private aggregateLineForHunk(proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk): number {
        let line = 0;
        for (const candidate of this.aggregateFiles(proposal)) {
            if (candidate.path===file.path) {
                return line + 1 + this.proposedLineForHunk(file, hunk);
            }
            line += 1 + splitLines(this.store.composeVisibleProposedContent(candidate)).length + 1;
        }
        return this.proposedLineForHunk(file, hunk);
    }

    private proposedLineForHunk(file: AgentReviewFileProposal, hunk: AgentReviewHunk): number {
        let delta = 0;
        for (const candidate of file.hunks) {
            if (candidate.id===hunk.id) {
                break;
            }
            if (candidate.status!=='declined' && candidate.startLine<=hunk.startLine) {
                delta += candidate.proposedLines.length-candidate.originalLines.length;
            }
        }
        return Math.max(0, Math.min(hunk.startLine+delta, Math.max(0, this.visibleProposedLineCount(file)-1)));
    }

    private visibleProposedLineCount(file: AgentReviewFileProposal): number {
        const originalLineCount = splitLines(file.originalText).length;
        const delta = file.hunks.reduce((sum, hunk) =>
            hunk.status==='declined' ? sum : sum + hunk.proposedLines.length-hunk.originalLines.length, 0);
        return Math.max(1, originalLineCount+delta);
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

    private async syncReviewState() {
        for (const editor of vscode.window.visibleTextEditors) {
            await this.syncReviewStateFor(editor);
        }
    }

    // Per-document mutex so overlapping event handlers (onDidChangeActiveTextEditor,
    // onDidChangeVisibleTextEditors, store.onDidChange, onDidSave, ...) cannot
    // race while recalculating review anchors.
    private async syncReviewStateFor(editor: vscode.TextEditor) {
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
        if (isAgentReviewDiffDocument(editor.document.uri)) {
            this.updateStatusBarFor(editor);
            return;
        }
        if (editor.document.uri.scheme!== 'file') {
            return;
        }
        const pending = this.store.pendingForUri(editor.document.uri);
        if (pending.length===0) {
            return;
        }
        const conflicts = this.changeLocator.findConflictsForDocument(editor.document, pending);
        for (const {proposal, hunk} of conflicts) {
            if (hunk.status!=='conflict') {
                hunk.status = 'conflict';
                await this.store.updateHunk(vscode.Uri.file(proposal.rootPath), proposal);
            }
        }
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

    private async onNewProposalsImported(proposals: AgentReviewProposal[]) {
        if (proposals.length===0) {
            return;
        }
        for (const proposal of proposals) {
            for (const file of proposal.files) {
                const [target] = this.pendingTargetsForFile(proposal, file);
                if (target) {
                    await this.openTargetDiff(target);
                    return;
                }
            }
        }
        await this.syncReviewState();
    }

}
