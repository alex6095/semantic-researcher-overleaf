import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    AGENT_REVIEW_SUPPORTED_EXTENSIONS,
    AgentReviewFileProposal,
    AgentReviewProposal,
    AgentReviewDraftRecord,
    AgentTool,
    normalizeReplicaPath,
} from './types';
import { REPLICA_SETTINGS_DIR } from '../consts';
import { createLineHunks } from './diff';

const PROPOSALS_DIR = 'proposals';
const LEGACY_PROPOSALS_SUBDIR = 'agent-proposals';

function toPosixPath(value: string): string {
    return value.replace(/\\/g, '/');
}

function isSupportedFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return AGENT_REVIEW_SUPPORTED_EXTENSIONS.some(ext => lower.endsWith(ext));
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.stat(filePath);
        return true;
    } catch {
        return false;
    }
}

async function readTextIfExists(filePath: string): Promise<string> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch {
        return '';
    }
}

async function listFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    if (!await pathExists(root)) {
        return results;
    }
    const queue = [''];
    while (queue.length>0) {
        const relDir = queue.shift()!;
        const absDir = path.join(root, relDir);
        const entries = await fs.readdir(absDir, {withFileTypes: true});
        for (const entry of entries) {
            const rel = path.join(relDir, entry.name);
            const posixRel = toPosixPath(rel);
            if (
                posixRel===REPLICA_SETTINGS_DIR
                || posixRel.startsWith(`${REPLICA_SETTINGS_DIR}/`)
                || posixRel==='.overleaf'
                || posixRel.startsWith('.overleaf/')
                || posixRel==='.git'
                || posixRel.startsWith('.git/')
            ) {
                continue;
            }
            if (entry.isDirectory()) {
                queue.push(rel);
            } else if (entry.isFile() && isSupportedFile(posixRel)) {
                results.push(posixRel);
            }
        }
    }
    return results;
}

function uniqueSorted(items: string[]) {
    return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function normalizeRootPath(rootPath: string) {
    return path.resolve(rootPath);
}

function textEol(text: string) {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(text: string): string[] {
    if (text==='') {
        return [];
    }
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function rootContainsUri(uri: vscode.Uri, rootPath: string) {
    const normalizedRoot = normalizeRootPath(rootPath);
    const normalizedUri = path.resolve(uri.fsPath);
    return normalizedUri===normalizedRoot || normalizedUri.startsWith(`${normalizedRoot}${path.sep}`);
}

function replicaRootHash(rootPath: string): string {
    return crypto.createHash('sha1').update(normalizeRootPath(rootPath)).digest('hex').slice(0, 12);
}

export interface ProposalStoreCallbacks {
    onProposalResolved?: (proposal: AgentReviewProposal) => Promise<void> | void,
}

export class AgentReviewProposalStore {
    private readonly proposals = new Map<string, AgentReviewProposal>();
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    private readonly onDidImportEmitter = new vscode.EventEmitter<AgentReviewProposal[]>();
    private callbacks: ProposalStoreCallbacks = {};

    readonly onDidChange = this.onDidChangeEmitter.event;
    readonly onDidImport = this.onDidImportEmitter.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    setCallbacks(callbacks: ProposalStoreCallbacks) {
        this.callbacks = callbacks;
    }

    private get globalRoot(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'agent-review');
    }

    private proposalsRoot(rootUri: vscode.Uri) {
        return path.join(this.globalRoot, PROPOSALS_DIR, replicaRootHash(rootUri.fsPath));
    }

    async ensureStorage(rootUri: vscode.Uri) {
        await fs.mkdir(this.proposalsRoot(rootUri), {recursive: true});
    }

    // One-shot migration of legacy per-replica proposals into globalStorage.
    async migrateLegacy(rootUri: vscode.Uri): Promise<number> {
        const legacyRoot = path.join(rootUri.fsPath, REPLICA_SETTINGS_DIR, LEGACY_PROPOSALS_SUBDIR);
        if (!await pathExists(legacyRoot)) {
            return 0;
        }
        await this.ensureStorage(rootUri);
        const target = this.proposalsRoot(rootUri);
        const entries = await fs.readdir(legacyRoot, {withFileTypes: true});
        let moved = 0;
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) {
                continue;
            }
            const src = path.join(legacyRoot, entry.name);
            const dst = path.join(target, entry.name);
            try {
                await fs.rename(src, dst);
                moved++;
            } catch {
                try {
                    await fs.copyFile(src, dst);
                    await fs.unlink(src);
                    moved++;
                } catch {
                    // ignore unreadable entries
                }
            }
        }
        try {
            await fs.rmdir(legacyRoot);
        } catch {
            // ignore if still not empty
        }
        const legacySessions = path.join(rootUri.fsPath, REPLICA_SETTINGS_DIR, 'agent-sessions');
        if (await pathExists(legacySessions)) {
            try {
                await fs.rm(legacySessions, {recursive: true, force: true});
            } catch {
                // ignore
            }
        }
        return moved;
    }

    async load(rootUri: vscode.Uri) {
        const root = this.proposalsRoot(rootUri);
        this.proposals.clear();
        if (!await pathExists(root)) {
            this.onDidChangeEmitter.fire();
            return;
        }
        const entries = await fs.readdir(root, {withFileTypes: true});
        const stale: AgentReviewProposal[] = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) {
                continue;
            }
            try {
                const proposal = JSON.parse(await fs.readFile(path.join(root, entry.name), 'utf8')) as AgentReviewProposal;
                proposal.rootPath = normalizeRootPath(proposal.rootPath);
                // Proposals that arrive already fully resolved (e.g. migrated from an older
                // version before immediate cleanup existed) are purged instead of surfaced.
                const resolved = proposal.files.every(file =>
                    file.hunks.every(hunk => hunk.status==='saved' || hunk.status==='declined'));
                if (resolved) {
                    stale.push(proposal);
                    continue;
                }
                this.proposals.set(proposal.id, proposal);
            } catch (error) {
                console.warn(`Could not load agent review proposal ${entry.name}:`, error);
            }
        }
        for (const proposal of stale) {
            await this.deleteProposalFile(rootUri, proposal);
            try {
                await this.callbacks.onProposalResolved?.(proposal);
            } catch (error) {
                console.warn('onProposalResolved callback failed during load cleanup:', error);
            }
        }
        this.onDidChangeEmitter.fire();
    }

    all(): AgentReviewProposal[] {
        return [...this.proposals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    pendingForUri(uri: vscode.Uri): Array<{proposal: AgentReviewProposal, file: AgentReviewFileProposal}> {
        const matches: Array<{proposal: AgentReviewProposal, file: AgentReviewFileProposal}> = [];
        for (const proposal of this.proposals.values()) {
            if (!rootContainsUri(uri, proposal.rootPath)) {
                continue;
            }
            const relPath = normalizeReplicaPath(toPosixPath(path.relative(normalizeRootPath(proposal.rootPath), uri.fsPath)));
            const file = proposal.files.find(candidate => candidate.path===relPath);
            if (file && file.hunks.some(hunk => hunk.status==='pending' || hunk.status==='saving' || hunk.status==='conflict')) {
                matches.push({proposal, file});
            }
        }
        return matches;
    }

    findHunk(proposalId: string, filePath: string, hunkId: string) {
        const proposal = this.proposals.get(proposalId);
        const file = proposal?.files.find(candidate => candidate.path===filePath);
        const hunk = file?.hunks.find(candidate => candidate.id===hunkId);
        return proposal && file && hunk ? {proposal, file, hunk} : undefined;
    }

    hasAcceptedDraft(uri: vscode.Uri): boolean {
        return this.pendingForUri(uri).some(({file}) => file.hunks.some(hunk => hunk.status==='saving'));
    }

    hasAnyAcceptedDraft(): boolean {
        return [...this.proposals.values()].some(proposal =>
            proposal.files.some(file => file.hunks.some(hunk => hunk.status==='saving')),
        );
    }

    async markAcceptedHunksSaved(uri: vscode.Uri) {
        const matches = this.pendingForUri(uri);
        for (const {proposal, file} of matches) {
            let changed = false;
            for (const hunk of file.hunks) {
                if (hunk.status==='saving') {
                    hunk.status = 'saved';
                    changed = true;
                }
            }
            if (changed) {
                await this.persistOrCleanup(proposal);
            }
        }
    }

    async updateHunk(_rootUri: vscode.Uri, proposal: AgentReviewProposal) {
        await this.persistOrCleanup(proposal);
    }

    async markHunkSaved(proposalId: string, filePath: string, hunkId: string) {
        const match = this.findHunk(proposalId, filePath, hunkId);
        if (!match) {
            return;
        }
        match.hunk.status = 'saved';
        await this.persistOrCleanup(match.proposal);
    }

    async markHunkConflict(proposalId: string, filePath: string, hunkId: string) {
        const match = this.findHunk(proposalId, filePath, hunkId);
        if (!match) {
            return;
        }
        match.hunk.status = 'conflict';
        await this.persistOrCleanup(match.proposal);
    }

    async markAcceptedHunksConflict(uri: vscode.Uri) {
        const matches = this.pendingForUri(uri);
        for (const {proposal, file} of matches) {
            let changed = false;
            for (const hunk of file.hunks) {
                if (hunk.status==='saving') {
                    hunk.status = 'conflict';
                    changed = true;
                }
            }
            if (changed) {
                await this.persistOrCleanup(proposal);
            }
        }
    }

    async importSubmittedDrafts(
        rootUri: vscode.Uri,
        drafts: AgentReviewDraftRecord[],
        markImported: (draft: AgentReviewDraftRecord) => Promise<void>,
    ): Promise<AgentReviewProposal[]> {
        await this.ensureStorage(rootUri);
        const importedProposals: AgentReviewProposal[] = [];
        for (const draft of drafts) {
            const proposal = await this.createProposalFromDraft(rootUri, draft);
            await markImported(draft);
            if (proposal) {
                await this.saveProposal(rootUri, proposal);
                importedProposals.push(proposal);
            } else {
                // No effective diff → remove draft dir immediately to keep storage tidy.
                void this.callbacks.onProposalResolved?.({
                    id: draft.id,
                    rootPath: normalizeRootPath(rootUri.fsPath),
                    createdAt: draft.createdAt,
                    source: 'helper-draft',
                    sourceDraftId: draft.id,
                    files: [],
                });
            }
        }
        if (importedProposals.length>0) {
            this.onDidChangeEmitter.fire();
            this.onDidImportEmitter.fire(importedProposals);
        }
        return importedProposals;
    }

    async createDirectWriteProposal(
        rootUri: vscode.Uri,
        relPath: string,
        originalContent: Uint8Array,
        proposedContent?: Uint8Array,
        tool?: AgentTool,
    ) {
        const originalText = new TextDecoder().decode(originalContent);
        const proposedText = proposedContent ? new TextDecoder().decode(proposedContent) : '';
        const fileProposal = this.createFileProposal(relPath, originalText, proposedText);
        if (!fileProposal) {
            return undefined;
        }
        const proposal: AgentReviewProposal = {
            id: `direct-${Date.now()}`,
            rootPath: normalizeRootPath(rootUri.fsPath),
            createdAt: new Date().toISOString(),
            source: 'direct-write',
            tool,
            files: [fileProposal],
        };
        await this.saveProposal(rootUri, proposal);
        this.onDidChangeEmitter.fire();
        this.onDidImportEmitter.fire([proposal]);
        return proposal;
    }

    getProposedContent(uri: vscode.Uri): string | undefined {
        const proposalId = uri.authority;
        const filePath = decodeURIComponent(uri.path.replace(/^\/+/, ''));
        const proposal = this.proposals.get(proposalId);
        const file = proposal?.files.find(candidate => candidate.path===normalizeReplicaPath(filePath));
        return file ? this.composeVisibleProposedContent(file) : undefined;
    }

    composeVisibleProposedContent(file: AgentReviewFileProposal): string {
        const lines = splitLines(file.originalText);
        const hunks = file.hunks
            .filter(hunk => hunk.status!=='declined')
            .sort((a, b) => b.startLine-a.startLine);

        for (const hunk of hunks) {
            const start = Math.max(0, Math.min(hunk.startLine, lines.length));
            lines.splice(start, hunk.originalLines.length, ...hunk.proposedLines);
        }

        return lines.join(textEol(file.proposedText || file.originalText));
    }

    private createFileProposal(relPath: string, originalText: string, proposedText: string): AgentReviewFileProposal | undefined {
        const normalizedPath = normalizeReplicaPath(relPath);
        const hunks = createLineHunks(originalText, proposedText);
        if (hunks.length===0) {
            return undefined;
        }
        return {
            path: normalizedPath,
            originalText,
            proposedText,
            hunks,
        };
    }

    private async createProposalFromDraft(rootUri: vscode.Uri, draft: AgentReviewDraftRecord): Promise<AgentReviewProposal | undefined> {
        const baselineFiles = await listFiles(draft.baselineRoot);
        const draftFiles = await listFiles(draft.draftRoot);
        const filePaths = uniqueSorted([...baselineFiles, ...draftFiles]);
        const files: AgentReviewFileProposal[] = [];
        for (const relPath of filePaths) {
            const originalText = await readTextIfExists(path.join(draft.baselineRoot, relPath));
            const proposedText = await readTextIfExists(path.join(draft.draftRoot, relPath));
            const fileProposal = this.createFileProposal(relPath, originalText, proposedText);
            if (fileProposal) {
                files.push(fileProposal);
            }
        }
        if (files.length===0) {
            return undefined;
        }
        return {
            id: draft.id,
            rootPath: normalizeRootPath(rootUri.fsPath),
            createdAt: new Date().toISOString(),
            source: 'helper-draft',
            sourceDraftId: draft.id,
            files,
        };
    }

    private async saveProposal(rootUri: vscode.Uri, proposal: AgentReviewProposal) {
        await this.ensureStorage(rootUri);
        proposal.rootPath = normalizeRootPath(proposal.rootPath);
        this.proposals.set(proposal.id, proposal);
        await fs.writeFile(
            path.join(this.proposalsRoot(rootUri), `${proposal.id}.json`),
            JSON.stringify(proposal, null, 2),
        );
        this.onDidChangeEmitter.fire();
    }

    // If every hunk is in a terminal state, delete the JSON + owning draft dir.
    // Otherwise persist the updated state.
    private async persistOrCleanup(proposal: AgentReviewProposal) {
        const allResolved = proposal.files.every(file => file.hunks.every(hunk => hunk.status==='saved' || hunk.status==='declined'));
        const rootUri = vscode.Uri.file(proposal.rootPath);
        if (!allResolved) {
            await this.saveProposal(rootUri, proposal);
            return;
        }
        await this.deleteProposalFile(rootUri, proposal);
        this.proposals.delete(proposal.id);
        try {
            await this.callbacks.onProposalResolved?.(proposal);
        } catch (error) {
            console.warn('onProposalResolved callback failed:', error);
        }
        this.onDidChangeEmitter.fire();
    }

    private async deleteProposalFile(rootUri: vscode.Uri, proposal: AgentReviewProposal) {
        const file = path.join(this.proposalsRoot(rootUri), `${proposal.id}.json`);
        try {
            await fs.unlink(file);
        } catch {
            // already gone
        }
    }

    get triggers(): vscode.Disposable[] {
        return [
            this.onDidChangeEmitter,
            this.onDidImportEmitter,
        ];
    }
}
