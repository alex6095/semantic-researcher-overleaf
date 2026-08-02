import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CONFIG_SECTION, REPLICA_SETTINGS_FILE, ROOT_NAME } from '../consts';
import {
    getActiveReplicaRoot,
    isWithinActiveReplica,
    readReplicaSettings,
    readReplicaSettingsSnapshot,
} from '../utils/localReplicaWorkspace';
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
    context.subscriptions.push(singleton, ...singleton.triggers);
    void singleton.activate(getActiveReplicaRoot());
    return singleton;
}

export function getAgentReviewManager() {
    return singleton;
}

export class AgentReviewManager implements vscode.Disposable {
    private readonly saveClassifier: SaveClassifier;
    private readonly workspaceInstructionManager: AgentReviewWorkspaceInstructionManager;
    private readonly proposalStore: AgentReviewProposalStore;
    private readonly editorProvider: AgentReviewEditorProvider;
    private readonly internalRestoreUntil = new Map<string, number>();
    private activeRoot?: vscode.Uri;
    private importTimer?: NodeJS.Timeout;
    private config: AgentReviewConfig = getAgentReviewConfig();
    private disposed = false;
    private activationGeneration = 0;
    private activationQueue: Promise<void> = Promise.resolve();
    private importQueue: Promise<void> = Promise.resolve();

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

    activate(rootUri: vscode.Uri | undefined): Promise<void> {
        const generation = ++this.activationGeneration;
        this.stopImportTimer();
        const activation = this.activationQueue
            .catch(() => undefined)
            .then(() => this.performActivation(rootUri, generation));
        this.activationQueue = activation;
        return activation;
    }

    private isActivationCurrent(generation: number) {
        return !this.disposed && generation===this.activationGeneration;
    }

    private async performActivation(rootUri: vscode.Uri | undefined, generation: number) {
        await this.importQueue.catch(() => undefined);
        if (!this.isActivationCurrent(generation)) { return; }
        this.activeRoot = rootUri;
        const config = await this.resolveConfig(rootUri);
        if (!this.isActivationCurrent(generation)) { return; }
        this.config = config;
        await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.agentReviewActive`, !!rootUri && this.config.enabled);
        if (!this.isActivationCurrent(generation)) { return; }
        if (!rootUri || !this.config.enabled) {
            this.stopImportTimer();
            if (rootUri) {
                await this.workspaceInstructionManager.disable(rootUri);
                if (!this.isActivationCurrent(generation)) { return; }
                // Aggressively abort in-flight drafts so any agent session still
                // running post-toggle fails fast instead of wasting tokens.
                await this.workspaceInstructionManager.abortOwnedDrafts(rootUri);
                if (!this.isActivationCurrent(generation)) { return; }
            }
            this.editorProvider.setActiveRoot(undefined);
            await this.editorProvider.deactivateEditors();
            return;
        }

        await this.proposalStore.ensureStorage(rootUri);
        if (!this.isActivationCurrent(generation)) { return; }
        await this.proposalStore.migrateLegacy(rootUri);
        if (!this.isActivationCurrent(generation)) { return; }
        await this.proposalStore.load(rootUri);
        if (!this.isActivationCurrent(generation)) { return; }
        await this.workspaceInstructionManager.ensure(rootUri);
        if (!this.isActivationCurrent(generation)) { return; }
        void this.workspaceInstructionManager.cleanupOldDrafts();
        this.editorProvider.setActiveRoot(rootUri);
        await this.importAgentReviewDrafts();
        if (!this.isActivationCurrent(generation)) { return; }
        this.startImportTimer();
    }

    beforeLocalReplicaPush(change: LocalReplicaPushChange): Promise<LocalReplicaPushDecision> {
        const operation = this.activationQueue
            .catch(() => undefined)
            .then(() => this.performBeforeLocalReplicaPush(change));
        this.activationQueue = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    private async performBeforeLocalReplicaPush(
        change: LocalReplicaPushChange,
    ): Promise<LocalReplicaPushDecision> {
        if (this.disposed) {
            return {kind: 'allow'};
        }
        const generation = this.activationGeneration;
        const rootUri = this.activeRoot;
        if (!rootUri || rootUri.toString()!==change.rootUri.toString()) {
            return {kind: 'allow'};
        }
        const isCurrentRoot = () =>
            this.isActivationCurrent(generation)
            && this.activeRoot?.toString()===rootUri.toString();
        // Snapshot read: the normalizing reader rewrites settings.json, which
        // would fire this manager's own settings watcher and invalidate the
        // very push decision being made here.
        this.config = await this.resolveConfigSnapshot(change.rootUri);
        if (!isCurrentRoot()) {
            return {kind: 'block', reason: 'Agent review workspace changed'};
        }
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
        if (!isCurrentRoot()) {
            return {kind: 'block', reason: 'Agent review workspace changed'};
        }
        if (!openDraft) {
            return {kind: 'allow'};
        }

        const baselinePath = path.join(openDraft.baselineRoot, relPathToFs(relPath));
        if (!await pathExists(baselinePath)) {
            if (!isCurrentRoot()) {
                return {kind: 'block', reason: 'Agent review workspace changed'};
            }
            vscode.window.showWarningMessage(`Blocked agent-originated source write without baseline: ${relPath}`);
            return {kind: 'block', reason: 'Agent source write blocked without baseline'};
        }

        const baseline = await fs.readFile(baselinePath);
        if (!isCurrentRoot()) {
            return {kind: 'block', reason: 'Agent review workspace changed'};
        }
        await this.proposalStore.createDirectWriteProposal(
            change.rootUri,
            relPath,
            baseline,
            change.type==='delete' ? undefined : change.content,
        );
        await this.restoreSourceFile(change.localUri, baseline);
        if (!isCurrentRoot()) {
            return {kind: 'block', reason: 'Agent review workspace changed'};
        }
        vscode.window.showWarningMessage(`Converted direct agent write into a review proposal: ${relPath}`);
        return {kind: 'block', reason: 'Agent source write quarantined'};
    }

    async afterLocalReplicaPush(change: LocalReplicaPushChange): Promise<void> {
        if (this.disposed) { return; }
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
        if (this.disposed) { return; }
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

    importAgentReviewDrafts(): Promise<void> {
        const rootUri = this.activeRoot;
        const generation = this.activationGeneration;
        const importTask = this.importQueue
            .catch(() => undefined)
            .then(() => this.performDraftImport(rootUri, generation));
        this.importQueue = importTask;
        return importTask;
    }

    private async performDraftImport(
        rootUri: vscode.Uri | undefined,
        generation: number,
    ) {
        if (
            !rootUri
            || !this.isActivationCurrent(generation)
            || this.activeRoot?.toString()!==rootUri.toString()
        ) {
            return;
        }
        const config = await this.resolveConfig(rootUri);
        if (
            !config.enabled
            || !this.isActivationCurrent(generation)
            || this.activeRoot?.toString()!==rootUri.toString()
        ) {
            return;
        }
        this.config = config;
        const submittedDrafts = await this.workspaceInstructionManager.submittedDrafts(rootUri);
        if (
            !this.isActivationCurrent(generation)
            || this.activeRoot?.toString()!==rootUri.toString()
        ) {
            return;
        }
        const imported = await this.proposalStore.importSubmittedDrafts(
            rootUri,
            submittedDrafts,
            draft => this.workspaceInstructionManager.markDraftImported(draft),
        );
        if (
            !this.isActivationCurrent(generation)
            || this.activeRoot?.toString()!==rootUri.toString()
        ) {
            return;
        }
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

    /** Same result as `resolveConfig`, but never writes settings.json. */
    private async resolveConfigSnapshot(rootUri: vscode.Uri | undefined) {
        const settings = rootUri ? await readReplicaSettingsSnapshot(rootUri) : undefined;
        return getAgentReviewConfig(settings);
    }

    private isActiveReplicaSettingsUri(uri: vscode.Uri) {
        if (!this.activeRoot || uri.scheme!=='file') {
            return false;
        }
        return path.normalize(uri.fsPath)===path.join(this.activeRoot.fsPath, REPLICA_SETTINGS_FILE);
    }

    private async onReplicaSettingsChanged(uri: vscode.Uri) {
        if (this.disposed || !this.isActiveReplicaSettingsUri(uri)) { return; }
        // Reading replica settings normalizes the file in place, so this
        // watcher also fires for writes this manager caused itself. Bumping the
        // activation generation for those would report every in-flight push as
        // blocked, so re-activate only when the effective config really changed.
        const rootUri = getActiveReplicaRoot();
        const config = await this.resolveConfigSnapshot(rootUri);
        if (this.disposed || config.enabled===this.config.enabled) { return; }
        await this.activate(rootUri);
    }

    private startImportTimer() {
        if (this.disposed) { return; }
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
            replicaSettingsWatcher.onDidChange(uri => void this.onReplicaSettingsChanged(uri)),
            replicaSettingsWatcher.onDidCreate(uri => void this.onReplicaSettingsChanged(uri)),
            replicaSettingsWatcher.onDidDelete(uri => void this.onReplicaSettingsChanged(uri)),
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

    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        this.activationGeneration += 1;
        this.stopImportTimer();
        this.activeRoot = undefined;
        this.internalRestoreUntil.clear();
        if (singleton===this) {
            singleton = undefined;
        }
        void vscode.commands.executeCommand('setContext', `${ROOT_NAME}.agentReviewActive`, false);
    }
}
