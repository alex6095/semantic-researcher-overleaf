import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CONFIG_SECTION, REPLICA_SETTINGS_FILE, ROOT_NAME } from '../consts';
import { getActiveReplicaRoot, isWithinActiveReplica, readReplicaSettings } from '../utils/localReplicaWorkspace';
import { AgentReviewEditorProvider } from './editorReviewProvider';
import { AgentReviewProposalStore } from './proposalStore';
import { SaveClassifier } from './saveClassifier';
import { AgentReviewWorkspaceInstructionManager } from './workspaceInstructionManager';
import {
    AgentReviewConfig,
    LocalReplicaPushChange,
    LocalReplicaPushDecision,
    getAgentReviewConfig,
    isAgentReviewSupportedPath,
    normalizeReplicaPath,
} from './types';

let singleton: AgentReviewManager | undefined;

async function pathExists(filePath: string) {
    try {
        await fs.stat(filePath);
        return true;
    } catch {
        return false;
    }
}

function relPathToFs(relPath: string) {
    return relPath.replace(/^\/+/, '').split('/').join(path.sep);
}

export function initializeAgentReviewManager(context: vscode.ExtensionContext) {
    singleton = new AgentReviewManager(context);
    context.subscriptions.push(...singleton.triggers);
    void singleton.activate(getActiveReplicaRoot());
    return singleton;
}

export function getAgentReviewManager() {
    return singleton;
}

export class AgentReviewManager {
    private readonly saveClassifier: SaveClassifier;
    private readonly workspaceInstructionManager: AgentReviewWorkspaceInstructionManager;
    private readonly proposalStore: AgentReviewProposalStore;
    private readonly editorProvider: AgentReviewEditorProvider;
    private readonly internalRestoreUntil = new Map<string, number>();
    private activeRoot?: vscode.Uri;
    private importTimer?: NodeJS.Timeout;
    private config: AgentReviewConfig = getAgentReviewConfig();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.saveClassifier = new SaveClassifier(context);
        this.workspaceInstructionManager = new AgentReviewWorkspaceInstructionManager(context);
        this.proposalStore = new AgentReviewProposalStore(context);
        this.proposalStore.setCallbacks({
            onProposalResolved: async proposal => {
                if (proposal.sourceDraftId) {
                    await this.workspaceInstructionManager.removeDraft(proposal.sourceDraftId);
                }
            },
        });
        this.editorProvider = new AgentReviewEditorProvider(this.proposalStore, this.saveClassifier);
    }

    async activate(rootUri: vscode.Uri | undefined) {
        this.activeRoot = rootUri;
        this.config = await this.resolveConfig(rootUri);
        await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.agentReviewActive`, !!rootUri && this.config.enabled);
        if (!rootUri || !this.config.enabled) {
            this.stopImportTimer();
            if (rootUri) {
                await this.workspaceInstructionManager.disable(rootUri);
                // Aggressively abort in-flight drafts so any agent session still
                // running post-toggle fails fast instead of wasting tokens.
                await this.workspaceInstructionManager.abortOwnedDrafts(rootUri);
            }
            this.editorProvider.setActiveRoot(undefined);
            await this.editorProvider.deactivateEditors();
            return;
        }

        await this.proposalStore.ensureStorage(rootUri);
        await this.proposalStore.migrateLegacy(rootUri);
        await this.proposalStore.load(rootUri);
        await this.workspaceInstructionManager.ensure(rootUri);
        void this.workspaceInstructionManager.cleanupOldDrafts();
        this.editorProvider.setActiveRoot(rootUri);
        await this.importAgentReviewDrafts();
        this.startImportTimer();
    }

    async beforeLocalReplicaPush(change: LocalReplicaPushChange): Promise<LocalReplicaPushDecision> {
        this.config = await this.resolveConfig(change.rootUri);
        if (!this.config.enabled) {
            return {kind: 'allow'};
        }

        const restoreExpiry = this.internalRestoreUntil.get(change.localUri.toString());
        if (restoreExpiry && restoreExpiry>Date.now()) {
            return {kind: 'block', reason: 'Internal agent review restore'};
        }

        const saveIntent = this.saveClassifier.getRecentSaveIntent(change.localUri, change.content);
        if (saveIntent) {
            return {kind: 'allow'};
        }

        const relPath = normalizeReplicaPath(change.relPath);
        if (!isAgentReviewSupportedPath(relPath)) {
            return {kind: 'allow'};
        }

        const openDraft = await this.workspaceInstructionManager.latestOpenDraft(change.rootUri);
        if (!openDraft) {
            return {kind: 'allow'};
        }

        const baselinePath = path.join(openDraft.baselineRoot, relPathToFs(relPath));
        if (!await pathExists(baselinePath)) {
            vscode.window.showWarningMessage(`Blocked agent-originated source write without baseline: ${relPath}`);
            return {kind: 'block', reason: 'Agent source write blocked without baseline'};
        }

        const baseline = await fs.readFile(baselinePath);
        await this.proposalStore.createDirectWriteProposal(
            change.rootUri,
            relPath,
            baseline,
            change.type==='delete' ? undefined : change.content,
        );
        await this.restoreSourceFile(change.localUri, baseline);
        vscode.window.showWarningMessage(`Converted direct agent write into a review proposal: ${relPath}`);
        return {kind: 'block', reason: 'Agent source write quarantined'};
    }

    async afterLocalReplicaPush(change: LocalReplicaPushChange): Promise<void> {
        const saveIntent = this.saveClassifier.getRecentSaveIntent(change.localUri, change.content, 60000);
        if (saveIntent?.kind==='agentReviewAccept') {
            const acceptedHunks = saveIntent.acceptedHunks
                ?? (saveIntent.proposalId && saveIntent.filePath && saveIntent.hunkId
                    ? [{proposalId: saveIntent.proposalId, filePath: saveIntent.filePath, hunkId: saveIntent.hunkId}]
                    : []);
            if (acceptedHunks.length===0) {
                await this.proposalStore.markAcceptedHunksSaved(change.localUri);
            } else {
                for (const hunk of acceptedHunks) {
                    await this.proposalStore.markHunkSaved(hunk.proposalId, hunk.filePath, hunk.hunkId);
                }
            }
            this.saveClassifier.clearSaveIntent(change.localUri);
        }
    }

    async afterLocalReplicaPushFailed(change: LocalReplicaPushChange): Promise<void> {
        const saveIntent = this.saveClassifier.getRecentSaveIntent(change.localUri, change.content, 60000);
        if (saveIntent?.kind==='agentReviewAccept') {
            const acceptedHunks = saveIntent.acceptedHunks
                ?? (saveIntent.proposalId && saveIntent.filePath && saveIntent.hunkId
                    ? [{proposalId: saveIntent.proposalId, filePath: saveIntent.filePath, hunkId: saveIntent.hunkId}]
                    : []);
            if (acceptedHunks.length===0) {
                await this.proposalStore.markAcceptedHunksConflict(change.localUri);
            } else {
                for (const hunk of acceptedHunks) {
                    await this.proposalStore.markHunkConflict(hunk.proposalId, hunk.filePath, hunk.hunkId);
                }
            }
            this.saveClassifier.clearSaveIntent(change.localUri);
        }
    }

    async importAgentReviewDrafts() {
        this.config = await this.resolveConfig(this.activeRoot);
        if (!this.activeRoot || !this.config.enabled) {
            return;
        }
        const submittedDrafts = await this.workspaceInstructionManager.submittedDrafts(this.activeRoot);
        const imported = await this.proposalStore.importSubmittedDrafts(
            this.activeRoot,
            submittedDrafts,
            draft => this.workspaceInstructionManager.markDraftImported(draft),
        );
        if (imported.length>0) {
            vscode.window.showInformationMessage(`Imported ${imported.length} agent review proposal${imported.length===1 ? '' : 's'}.`);
        }
    }

    async repairWorkspaceInstructions() {
        if (!this.activeRoot) {
            vscode.window.showWarningMessage('No active Local Replica is available for Agent Review.');
            return;
        }
        const config = await this.resolveConfig(this.activeRoot);
        if (!config.enabled) {
            vscode.window.showInformationMessage('Agent Review is disabled for the active Local Replica.');
            return;
        }
        await this.workspaceInstructionManager.ensure(this.activeRoot);
        vscode.window.showInformationMessage('Agent Review workspace instructions repaired.');
    }

    async showStatus() {
        this.config = await this.resolveConfig(this.activeRoot);
        if (!this.activeRoot || !this.config.enabled) {
            vscode.window.showInformationMessage('Agent Review is disabled or no Local Replica is active.');
            return;
        }
        const proposals = this.proposalStore.all().length;
        vscode.window.showInformationMessage(`Agent Review active. Helper: ${this.workspaceInstructionManager.helperPath}. Pending proposals: ${proposals}.`);
    }

    async setEnabledForActiveReplica(enabled: boolean) {
        const rootUri = this.activeRoot ?? getActiveReplicaRoot();
        await vscode.workspace.getConfiguration(CONFIG_SECTION).update('agentReview.enabled', enabled, vscode.ConfigurationTarget.Global);
        if (!rootUri) {
            await this.activate(undefined);
            vscode.window.showInformationMessage(`Agent Review ${enabled ? 'enabled' : 'disabled'}. No active Local Replica is available.`);
            return;
        }

        const settings = await readReplicaSettings(rootUri);
        if (settings && 'enableAgentReview' in settings) {
            const {enableAgentReview: _legacyEnableAgentReview, ...nextSettings} = settings;
            await vscode.workspace.fs.writeFile(
                vscode.Uri.joinPath(rootUri, REPLICA_SETTINGS_FILE),
                Buffer.from(JSON.stringify(nextSettings, null, 4)),
            );
        }
        await this.activate(rootUri);
        vscode.window.showInformationMessage(`Agent Review ${enabled ? 'enabled' : 'disabled'}.`);
    }

    private async restoreSourceFile(uri: vscode.Uri, content: Uint8Array) {
        this.internalRestoreUntil.set(uri.toString(), Date.now()+10000);
        await vscode.workspace.fs.writeFile(uri, content);
    }

    private async resolveConfig(rootUri: vscode.Uri | undefined) {
        const settings = rootUri ? await readReplicaSettings(rootUri) : undefined;
        return getAgentReviewConfig(settings);
    }

    private isActiveReplicaSettingsUri(uri: vscode.Uri) {
        if (!this.activeRoot || uri.scheme!=='file') {
            return false;
        }
        return path.normalize(uri.fsPath)===path.join(this.activeRoot.fsPath, REPLICA_SETTINGS_FILE);
    }

    private onReplicaSettingsChanged(uri: vscode.Uri) {
        if (this.isActiveReplicaSettingsUri(uri)) {
            void this.activate(getActiveReplicaRoot());
        }
    }

    private startImportTimer() {
        this.stopImportTimer();
        this.importTimer = setInterval(() => {
            void this.importAgentReviewDrafts();
        }, 2000);
    }

    private stopImportTimer() {
        if (this.importTimer) {
            clearInterval(this.importTimer);
            this.importTimer = undefined;
        }
    }

    get triggers(): vscode.Disposable[] {
        const replicaSettingsWatcher = vscode.workspace.createFileSystemWatcher(`**/${REPLICA_SETTINGS_FILE}`);
        return [
            replicaSettingsWatcher,
            replicaSettingsWatcher.onDidChange(uri => this.onReplicaSettingsChanged(uri)),
            replicaSettingsWatcher.onDidCreate(uri => this.onReplicaSettingsChanged(uri)),
            replicaSettingsWatcher.onDidDelete(uri => this.onReplicaSettingsChanged(uri)),
            ...this.saveClassifier.triggers,
            ...this.proposalStore.triggers,
            ...this.editorProvider.triggers,
            this.saveClassifier.onDidEditorSave(uri => {
                if (isWithinActiveReplica(uri) && this.proposalStore.hasAcceptedDraft(uri)) {
                    void this.proposalStore.markAcceptedHunksSaved(uri);
                }
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(`${CONFIG_SECTION}.agentReview`)) {
                    void this.activate(getActiveReplicaRoot());
                }
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.acceptHunk`, (proposalId: string, filePath: string, hunkId: string) =>
                this.editorProvider.acceptHunk(proposalId, filePath, hunkId)),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.declineHunk`, (proposalId: string, filePath: string, hunkId: string) =>
                this.editorProvider.declineHunk(proposalId, filePath, hunkId)),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.openDiff`, (proposalId: string, filePath: string, hunkId?: string) =>
                this.editorProvider.openDiff(proposalId, filePath, hunkId)),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.nextChange`, () =>
                this.editorProvider.revealAdjacentChange('next')),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.previousChange`, () =>
                this.editorProvider.revealAdjacentChange('previous')),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.acceptAllChangesInFile`, (proposalId?: string, filePath?: string) =>
                this.editorProvider.acceptAllInActiveFile(proposalId, filePath)),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.declineAllChangesInFile`, (proposalId?: string, filePath?: string) =>
                this.editorProvider.declineAllInActiveFile(proposalId, filePath)),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.acceptAllChanges`, () =>
                this.editorProvider.acceptAllChangesInWorkspace()),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.declineAllChanges`, () =>
                this.editorProvider.declineAllChangesInWorkspace()),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.importProposalDrafts`, () => this.importAgentReviewDrafts()),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.repairInstructions`, () => this.repairWorkspaceInstructions()),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.showStatus`, () => this.showStatus()),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.enable`, () =>
                this.setEnabledForActiveReplica(true)),
            vscode.commands.registerCommand(`${ROOT_NAME}.agentReview.disable`, () =>
                this.setEnabledForActiveReplica(false)),
        ];
    }
}
