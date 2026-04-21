import * as vscode from 'vscode';
import { CONFIG_SECTION, REPLICA_SETTINGS_DIR } from '../consts';

export const AGENT_REVIEW_DIFF_SCHEME = `${CONFIG_SECTION}-agent-review`;
export const AGENT_REVIEW_BASE_DIFF_SCHEME = `${CONFIG_SECTION}-agent-review-base`;

export const PROTECTED_LOCAL_REPLICA_IGNORE_PATTERNS = [
    '**/AGENTS.md',
    '**/CLAUDE.md',
    '**/.cursor/**',
    '**/.codex/**',
    '**/.claude/**',
    `**/${REPLICA_SETTINGS_DIR}`,
    `**/${REPLICA_SETTINGS_DIR}/**`,
    '**/.overleaf',
    '**/.overleaf/**',
];

export const AGENT_REVIEW_SUPPORTED_EXTENSIONS = [
    '.tex',
    '.ltx',
    '.ctx',
    '.bib',
    '.sty',
    '.cls',
    '.bbx',
    '.cbx',
];

export type AgentTool = 'codex' | 'claude';
export type HunkStatus = 'pending' | 'saving' | 'accepted' | 'saved' | 'declined' | 'conflict';

export interface AgentReviewConfig {
    enabled: boolean,
}

export interface AgentReviewReplicaSettings {
    /**
     * Legacy per-replica opt-out. New builds use the VS Code setting
     * `semantic-researcher-overleaf.agentReview.enabled` as the single source
     * of truth; this field is stripped from replica settings on the next write.
     */
    enableAgentReview?: boolean,
}

export interface AgentReviewHunk {
    id: string,
    startLine: number,
    endLine: number,
    beforeContext?: string[],
    originalLines: string[],
    proposedLines: string[],
    afterContext?: string[],
    baselineHash?: string,
    status: HunkStatus,
}

export interface AgentReviewFileProposal {
    path: string,
    originalText: string,
    proposedText: string,
    hunks: AgentReviewHunk[],
}

export interface AgentReviewProposal {
    id: string,
    rootPath: string,
    createdAt: string,
    source: 'helper-draft' | 'direct-write',
    sourceDraftId?: string,
    tool?: AgentTool,
    files: AgentReviewFileProposal[],
}

export interface AgentReviewDraftRecord {
    id: string,
    rootPath: string,
    workspaceRoot: string,
    baselineRoot: string,
    draftRoot: string,
    createdAt: string,
    updatedAt: string,
    state: 'running' | 'submitted' | 'imported' | 'aborted',
    importedAt?: string,
}

export interface LocalReplicaPushChange {
    rootUri: vscode.Uri,
    localUri: vscode.Uri,
    relPath: string,
    type: 'update' | 'delete',
    content?: Uint8Array,
}

export interface LocalReplicaPushDecision {
    kind: 'allow' | 'block',
    reason?: string,
}

export function getAgentReviewConfig(_replicaSettings?: AgentReviewReplicaSettings): AgentReviewConfig {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    // Single source of truth. Older per-replica `enableAgentReview` values are
    // treated as legacy metadata and migrated away by the settings readers.
    return {
        enabled: config.get<boolean>('agentReview.enabled', false),
    };
}

export function normalizeReplicaPath(relPath: string): string {
    const normalized = relPath.replace(/\\/g, '/');
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function isAgentReviewSupportedPath(relPath: string): boolean {
    const lower = relPath.toLowerCase();
    return AGENT_REVIEW_SUPPORTED_EXTENSIONS.some(ext => lower.endsWith(ext));
}
