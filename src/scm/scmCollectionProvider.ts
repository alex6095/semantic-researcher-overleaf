import * as vscode from 'vscode';
import * as os from 'os';
import * as nodePath from 'path';
import { VirtualFileSystem, parseUri, vfsProjectKey } from '../core/remoteFileSystemProvider';

import { BaseSCM, CommitItem, SettingItem } from ".";
import {
    LocalReplicaOwnershipUnavailableError,
    LocalReplicaSCMProvider,
} from './localReplicaSCM';
import { LocalGitBridgeSCMProvider } from './localGitBridgeSCM'; 
import { HistoryViewProvider } from './historyViewProvider';
import { GlobalStateManager } from '../utils/globalStateManager';
import { EventBus } from '../utils/eventBus';
import { ROOT_NAME } from '../consts';
import { formatUnknownError } from '../utils/errorMessage';
import { stringifyOverleafUri } from '../utils/overleafUri';
import {
    clearReplicaRemovalTombstone,
    getActiveReplicaRoot,
    hasReplicaRemovalTombstone,
    inspectReplicaSettingsSnapshot,
    readReplicaSettingsSnapshot,
    restoreReplicaAutoRestoreRoot,
    setActiveReplicaRoot,
    suppressReplicaAutoRestoreRoot,
    writeReplicaRemovalTombstone,
} from '../utils/localReplicaWorkspace';

const supportedSCMs = [
    LocalReplicaSCMProvider,
    // LocalGitBridgeSCMProvider,
];
type SupportedSCM = typeof supportedSCMs[number];

class CoreSCMProvider extends BaseSCM {
    constructor(protected readonly vfs: VirtualFileSystem) {
        super(vfs, vfs.origin);
    }

    validateBaseUri() { return Promise.resolve(true); }
    async syncFromSCM() {}
    async apply(commitItem: CommitItem) {};
    get triggers() { return Promise.resolve([]); }
    get settingItems() { return[]; }

    writeFile(path: string, content: Uint8Array): Thenable<void> {
        const uri = this.vfs.pathToUri(path);
        return vscode.workspace.fs.writeFile(uri, content);
    }

    readFile(path: string): Thenable<Uint8Array> {
        const uri = this.vfs.pathToUri(path);
        return vscode.workspace.fs.readFile(uri);
    }

    list(): Iterable<CommitItem> {
        return [];
    }
}

interface SCMRecord {
    scm: BaseSCM;
    enabled: boolean;
    triggers: vscode.Disposable[];
}

interface SuspendedSCMRecord {
    item: SCMRecord;
    wasEnabled: boolean;
}

interface CreateSCMOptions {
    exactBaseUri?: boolean;
    replaceExistingLabel?: string;
    preserveExistingLocalFiles?: boolean;
    resetLocalFilesToRemote?: boolean;
    beforeActivation?: () => Promise<void>;
}

interface PromptBaseUriOptions {
    title?: string;
    placeholder?: string;
    value?: string;
    createFolderName?: string;
}

interface SCMCollectionOptions {
    restorePersistedSCMs?: boolean;
}

function parsePersistedBaseUri(baseUri: string): vscode.Uri {
    const uri = vscode.Uri.parse(baseUri);
    return uri.scheme==='' ? vscode.Uri.file(baseUri) : uri;
}

export async function removeDetachedLocalReplicaSCM(
    context: vscode.ExtensionContext,
    projectUri: vscode.Uri,
    scmKey: string,
    baseUri: vscode.Uri,
): Promise<void> {
    const {serverName, userId, projectId, projectName} = parseUri(projectUri);
    if (!serverName || !userId || !projectId) {
        throw new Error('Cannot identify the Overleaf project for Local Replica removal.');
    }
    const persistenceVFS = {
        origin: projectUri,
        serverName,
        projectName,
        projectId,
        getProjectSCMPersist: (key: string) =>
            GlobalStateManager.getServerProjectSCMPersists(
                context,
                serverName,
                userId,
                projectId,
            )[key],
        setProjectSCMPersist: (key: string, persist: any) =>
            GlobalStateManager.updateServerProjectSCMPersist(
                context,
                serverName,
                userId,
                projectId,
                key,
                persist,
            ),
    } as unknown as VirtualFileSystem;
    const detached = new LocalReplicaSCMProvider(persistenceVFS, baseUri);
    await detached.prepareRemovalAndHoldOwnership();
    try {
        await writeReplicaRemovalTombstone(baseUri, projectUri);
        await suppressReplicaAutoRestoreRoot(baseUri);
        try {
            await persistenceVFS.setProjectSCMPersist(scmKey, undefined);
        } catch (error) {
            await clearReplicaRemovalTombstone(baseUri);
            await restoreReplicaAutoRestoreRoot(baseUri);
            throw error;
        }
        await detached.confirmRemovalPersistenceDeleted();
    } catch (error) {
        throw error;
    } finally {
        await detached.finishRemoval();
    }
}

export class SCMCollectionProvider extends vscode.Disposable {
    private readonly core: CoreSCMProvider;
    private readonly scms: SCMRecord[] = [];
    private readonly pendingSCMs = new Map<string, Promise<BaseSCM | undefined>>();
    private readonly pendingSCMInstances = new Set<BaseSCM>();
    private readonly ownershipRetryTimers = new Map<
        LocalReplicaSCMProvider,
        ReturnType<typeof setTimeout>
    >();
    private readonly statusBarItem: vscode.StatusBarItem;
    private readonly statusListener: vscode.Disposable;
    private initSCMsPromise: Promise<void>;
    private disposed = false;
    private historyDataProvider: HistoryViewProvider;

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly context: vscode.ExtensionContext,
        options: SCMCollectionOptions = {},
    ) {
        // define the dispose behavior
        super(() => {
            this.disposed = true;
            this.scms.forEach(item => {
                if (item.scm instanceof LocalReplicaSCMProvider) {
                    item.scm.deactivate();
                }
                item.triggers.forEach(trigger => trigger.dispose());
            });
            this.pendingSCMInstances.forEach(scm => {
                if (scm instanceof LocalReplicaSCMProvider) {
                    scm.deactivate();
                }
            });
            this.pendingSCMInstances.clear();
            this.pendingSCMs.clear();
            for (const timer of this.ownershipRetryTimers.values()) {
                clearTimeout(timer);
            }
            this.ownershipRetryTimers.clear();
            this.statusListener?.dispose();
            this.statusBarItem?.dispose();
            this.historyDataProvider?.dispose();
        });

        this.core = new CoreSCMProvider( vfs );
        this.historyDataProvider = new HistoryViewProvider( vfs );
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.statusBarItem.command = `${ROOT_NAME}.projectSCM.configSCM`;
        this.statusListener = EventBus.on('scmStatusChangeEvent', () => {this.updateStatus();});
        this.initSCMsPromise = options.restorePersistedSCMs===false
            ? Promise.resolve()
            : this.initSCMs();
    }

    private updateStatus() {
        if (!this.statusBarItem) { return; }

        let numPush = 0, numPull = 0;
        let tooltip = new vscode.MarkdownString(`**${vscode.l10n.t('Project Source Control')}**\n\n`);
        tooltip.supportHtml = true;
        tooltip.supportThemeIcons = true;

        // update status bar item tooltip
        if (this.scms.length===0) {
            tooltip.appendMarkdown(`*${vscode.l10n.t('Click to configure.')}*\n\n`);
        } else {
            for (const {scm,enabled} of this.scms) {
                const icon = scm.iconPath.id;
                const label = (scm.constructor as any).label;
                const uri = scm.baseUri.toString();
                const slideUri = uri.length<=30? uri : uri.replace(/^(.{15}).*(.{15})$/, '$1...$2');
                tooltip.appendMarkdown(`----\n\n$(${icon}) **${label}**: [${slideUri}](${uri})\n\n`);
                //
                if (!enabled) {
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;*${vscode.l10n.t('Disabled')}.*\n\n`);
                } else if (scm.status.status==='idle') {
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;*${vscode.l10n.t('Synced')}.*\n\n`);
                } else {
                    // show status message
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;***${scm.status.message}***\n\n`);
                    // update counters
                    switch (scm.status.status) {
                        case 'push': numPush++; break;
                        case 'pull': numPull++; break;
                    }
                }
            }   
        }
        this.statusBarItem.tooltip = tooltip;

        // update status bar item text
        if (numPush!==0) {
            this.statusBarItem.text = `$(cloud-upload)`;
        } else if (numPull!==0) {
            this.statusBarItem.text = `$(cloud-download)`;
        } else {
            this.statusBarItem.text = `$(cloud)`;
        }

        this.statusBarItem.show();
    }

    private cancelOwnershipRetry(scm: LocalReplicaSCMProvider) {
        const timers = this.ownershipRetryTimers;
        if (!timers) { return; }
        const timer = timers.get(scm);
        if (timer) {
            clearTimeout(timer);
            timers.delete(scm);
        }
    }

    private scheduleOwnershipRetry(item: SCMRecord) {
        if (
            this.disposed
            || !item.enabled
            || !this.scms.includes(item)
            || !(item.scm instanceof LocalReplicaSCMProvider)
            || this.ownershipRetryTimers.has(item.scm)
        ) {
            return;
        }
        const scm = item.scm;
        const timer = setTimeout(() => {
            if (this.ownershipRetryTimers.get(scm)!==timer) { return; }
            this.ownershipRetryTimers.delete(scm);
            void (async () => {
                if (
                    this.disposed
                    || !item.enabled
                    || !this.scms.includes(item)
                    || item.triggers.length!==0
                ) {
                    return;
                }
                let removed: boolean;
                try {
                    removed = await hasReplicaRemovalTombstone(
                        scm.baseUri,
                        this.vfs.origin,
                    );
                } catch (error) {
                    scm.markWaitingForOwnership(
                        `removal state unavailable: ${formatUnknownError(error)}`,
                    );
                    this.scheduleOwnershipRetry(item);
                    return;
                }
                const persist = this.vfs.getProjectSCMPersist(scm.scmKey);
                if (
                    removed
                    || !persist
                    || persist.label!==LocalReplicaSCMProvider.label
                    || persist.baseUri!==scm.baseUri.toString()
                ) {
                    await scm.deactivate();
                    const index = this.scms.indexOf(item);
                    if (index!==-1) {
                        this.scms.splice(index, 1);
                    }
                    this.updateStatus();
                    return;
                }
                try {
                    const triggers = await scm.triggers;
                    if (
                        this.disposed
                        || !item.enabled
                        || !this.scms.includes(item)
                    ) {
                        triggers.forEach(trigger => trigger.dispose());
                        await scm.deactivate();
                        return;
                    }
                    item.triggers = triggers;
                    this.updateStatus();
                } catch (error) {
                    if (error instanceof LocalReplicaOwnershipUnavailableError) {
                        scm.markWaitingForOwnership(error.message);
                        this.scheduleOwnershipRetry(item);
                        return;
                    }
                    scm.markWaitingForOwnership(formatUnknownError(error));
                    console.error(
                        `Local Replica ownership retry failed for ${scm.baseUri.toString()}:`,
                        error,
                    );
                }
            })();
        }, 1_000);
        timer.unref?.();
        this.ownershipRetryTimers.set(scm, timer);
    }

    // Flush any pending Local Replica push for a local URI so compile-on-save
    // sees the just-saved content. No-op for SCMs that don't cover the URI
    // or aren't currently enabled.
    public async flushPendingLocalPush(localUri: vscode.Uri): Promise<void> {
        await this.initSCMsPromise;
        if (this.disposed) { return; }
        for (const {scm, enabled} of this.scms) {
            if (!enabled) { continue; }
            if (scm instanceof LocalReplicaSCMProvider) {
                await scm.flushPendingPush(localUri);
            }
        }
    }

    public async flushLocalReplicaBeforeCompile(
        localUris: vscode.Uri[] = [],
        requiredBaseUri?: vscode.Uri,
    ): Promise<void> {
        await this.initSCMsPromise;
        if (this.disposed) {
            throw new Error('Local Replica manager was disposed before the compile barrier.');
        }

        if (
            requiredBaseUri
            && !this.scms.some(item =>
                item.scm instanceof LocalReplicaSCMProvider
                && item.scm.baseUri.toString()===requiredBaseUri.toString()
            )
        ) {
            await this.ensureLocalReplicaSCM(requiredBaseUri);
        }

        const replicas = this.scms.filter(item =>
            item.scm instanceof LocalReplicaSCMProvider
            && (
                requiredBaseUri===undefined
                || item.scm.baseUri.toString()===requiredBaseUri.toString()
            )
        );
        if (replicas.length===0) {
            throw new Error('Active Local Replica sync manager could not be initialized.');
        }
        const disabledReplica = replicas.find(item => !item.enabled);
        if (disabledReplica) {
            throw new Error(`Local Replica sync is disabled for ${disabledReplica.scm.baseUri.fsPath}.`);
        }
        for (const {scm} of replicas) {
            await (scm as LocalReplicaSCMProvider).flushBeforeCompile(localUris);
        }
    }

    private async initSCMs(): Promise<void> {
        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(
            this.context,
            this.vfs.serverName,
            this.vfs._userId,
            this.vfs.projectId,
        );
        const regularPersists: Array<{
            scmProto: SupportedSCM;
            baseUri: vscode.Uri;
            enabled: boolean;
        }> = [];
        const localReplicaPersists = new Map<string, {
            scmKey: string;
            baseUri: vscode.Uri;
            enabled: boolean;
        }>();
        const expectedProjectUri = stringifyOverleafUri(this.vfs.origin);
        const expectedProjectKey = vfsProjectKey(this.vfs.origin);

        for (const [scmKey, scmPersist] of Object.entries({...scmPersists})) {
            if (this.disposed) { return; }
            const scmProto = supportedSCMs.find(scm => scm.label===scmPersist.label);
            if (scmProto===undefined) { continue; }

            const enabled = scmPersist.enabled ?? true;
            const baseUri = parsePersistedBaseUri(scmPersist.baseUri);
            const canonicalScmKey = baseUri.toString();
            if (scmKey!==canonicalScmKey || scmPersist.baseUri!==canonicalScmKey) {
                this.vfs.setProjectSCMPersist(scmKey, undefined);
                this.vfs.setProjectSCMPersist(canonicalScmKey, {
                    ...scmPersist,
                    enabled,
                    baseUri: canonicalScmKey,
                });
            }

            if (scmProto!==LocalReplicaSCMProvider) {
                regularPersists.push({scmProto, baseUri, enabled});
                continue;
            }

            const settingsSnapshot = await inspectReplicaSettingsSnapshot(baseUri);
            if (this.disposed) { return; }
            if (settingsSnapshot.status==='unavailable') {
                console.warn(
                    `Retained unavailable Local Replica mapping ${canonicalScmKey}:`,
                    settingsSnapshot.error,
                );
                vscode.window.showWarningMessage(vscode.l10n.t(
                    'Local Replica mapping for {path} is temporarily unavailable and was retained. Reload after the folder is accessible.',
                    {path: baseUri.fsPath || canonicalScmKey},
                ));
                continue;
            }
            const settings = settingsSnapshot.status==='ok'
                ? settingsSnapshot.settings
                : undefined;
            let settingsProjectKey: string | undefined;
            try {
                settingsProjectKey = settings?.uri
                    ? vfsProjectKey(vscode.Uri.parse(settings.uri))
                    : undefined;
            } catch {
                settingsProjectKey = undefined;
            }
            if (settingsSnapshot.status==='missing' || settingsProjectKey!==expectedProjectKey) {
                this.vfs.setProjectSCMPersist(canonicalScmKey, undefined);
                console.warn(
                    `Skipped stale Local Replica mapping ${canonicalScmKey}: ` +
                    `folder marker does not match ${expectedProjectUri}.`,
                );
                vscode.window.showWarningMessage(vscode.l10n.t(
                    'Skipped stale Local Replica mapping for {path}; its folder marker belongs to another project or is missing.',
                    {path: baseUri.fsPath || canonicalScmKey},
                ));
                continue;
            }
            const existing = localReplicaPersists.get(canonicalScmKey);
            if (!existing || (!existing.enabled && enabled)) {
                localReplicaPersists.set(canonicalScmKey, {
                    scmKey: canonicalScmKey,
                    baseUri,
                    enabled,
                });
            }
        }

        for (const persist of regularPersists) {
            if (this.disposed) { return; }
            await this.createSCM(persist.scmProto, persist.baseUri, false, persist.enabled);
        }

        const localReplicaCandidates = [...localReplicaPersists.values()]
            .sort((left, right) => left.baseUri.toString().localeCompare(right.baseUri.toString()));
        const activeRoot = getActiveReplicaRoot()?.toString();
        const selectedLocalReplica = localReplicaCandidates.find(candidate =>
            candidate.baseUri.toString()===activeRoot
        ) ?? localReplicaCandidates.find(candidate => candidate.enabled)
            ?? localReplicaCandidates[0];

        for (const candidate of localReplicaCandidates) {
            if (candidate===selectedLocalReplica) { continue; }
            await this.removeDetachedPersistedSCM(
                candidate.scmKey,
                candidate.baseUri,
                LocalReplicaSCMProvider.label,
            );
            console.warn(
                `Removed duplicate Local Replica mapping ${candidate.baseUri.toString()} ` +
                `for ${expectedProjectUri}.`,
            );
        }

        if (selectedLocalReplica && !this.disposed) {
            await this.createSCM(
                LocalReplicaSCMProvider,
                selectedLocalReplica.baseUri,
                false,
                selectedLocalReplica.enabled,
                {
                    preserveExistingLocalFiles: true,
                    resetLocalFilesToRemote: false,
                },
            );
        }
    }

    private async createSCM(
        scmProto: SupportedSCM,
        baseUri: vscode.Uri,
        newSCM=false,
        enabled=true,
        options?: CreateSCMOptions,
        preparedSCM?: BaseSCM,
    ) {
        if (this.disposed) { return undefined; }
        const scmRecordKey = `${scmProto.label}:${baseUri.toString()}`;
        const existing = this.scms.find(item =>
            item.scm.baseUri.toString()===baseUri.toString()
            && (item.scm.constructor as any).label===scmProto.label
        );
        if (existing) {
            if (preparedSCM && preparedSCM!==existing.scm) {
                throw new Error(
                    `Prepared SCM does not match the existing mapping for ${baseUri.toString()}.`,
                );
            }
            if (newSCM) {
                await this.vfs.setProjectSCMPersist(existing.scm.scmKey, {
                    enabled,
                    label: scmProto.label,
                    baseUri: existing.scm.baseUri.toString(),
                    settings: {} as JSON,
                });
            }
            await options?.beforeActivation?.();
            if (existing.scm instanceof LocalReplicaSCMProvider) {
                existing.scm.setInitializationOptions({
                    preserveExistingLocalFiles: options?.preserveExistingLocalFiles,
                    resetLocalFilesToRemote: options?.resetLocalFilesToRemote,
                });
            }
            if (enabled && (!existing.enabled || existing.triggers.length===0)) {
                const persist = this.vfs.getProjectSCMPersist(existing.scm.scmKey);
                if (!persist || persist.label!==scmProto.label) {
                    await this.removeSCM(existing);
                    return undefined;
                }
                persist.enabled = true;
                await this.vfs.setProjectSCMPersist(existing.scm.scmKey, persist);
                existing.enabled = true;
                const triggers = await existing.scm.triggers;
                if (this.disposed) {
                    triggers.forEach(trigger => trigger.dispose());
                    return undefined;
                }
                existing.triggers = triggers;
                this.updateStatus();
            }
            return existing.scm;
        }

        const pendingSCM = this.pendingSCMs.get(scmRecordKey);
        if (pendingSCM) {
            return pendingSCM;
        }

        const creation = this.createSCMRecord(
            scmProto,
            baseUri,
            newSCM,
            enabled,
            options,
            preparedSCM,
        );
        this.pendingSCMs.set(scmRecordKey, creation);
        try {
            return await creation;
        } finally {
            if (this.pendingSCMs.get(scmRecordKey)===creation) {
                this.pendingSCMs.delete(scmRecordKey);
            }
        }
    }

    private async createSCMRecord(
        scmProto: SupportedSCM,
        baseUri: vscode.Uri,
        newSCM=false,
        enabled=true,
        options?: CreateSCMOptions,
        preparedSCM?: BaseSCM,
    ) {
        if (this.disposed) { return undefined; }
        const scm = preparedSCM ?? new scmProto(this.vfs, baseUri);
        if (
            scm.baseUri.toString()!==baseUri.toString()
            || (scm.constructor as any).label!==scmProto.label
        ) {
            throw new Error(`Prepared SCM does not match ${scmProto.label}:${baseUri.toString()}.`);
        }
        this.pendingSCMInstances.add(scm);
        if (scm instanceof LocalReplicaSCMProvider) {
            scm.setInitializationOptions({
                preserveExistingLocalFiles: options?.preserveExistingLocalFiles,
                resetLocalFilesToRemote: options?.resetLocalFilesToRemote,
            });
        }
        try {
            if (newSCM) {
                await this.vfs.setProjectSCMPersist(scm.scmKey, {
                    enabled: enabled,
                    label: scmProto.label,
                    baseUri: scm.baseUri.toString(),
                    settings: {} as JSON,
                });
            }
            await options?.beforeActivation?.();
            const triggers = enabled ? await scm.triggers : [];
            if (this.disposed) {
                triggers.forEach(trigger => trigger.dispose());
                return undefined;
            }
            const persist = this.vfs.getProjectSCMPersist(scm.scmKey);
            if (!persist || persist.label!==scmProto.label || persist.baseUri!==scm.baseUri.toString()) {
                triggers.forEach(trigger => trigger.dispose());
                return undefined;
            }
            this.scms.push({scm,enabled,triggers});
            this.updateStatus();
            return scm;
        } catch (error) {
            // Keep persisted configuration on failure. Reload/login can fail transiently,
            // and losing the selected Local Replica path is worse than surfacing the error.
            if (scm instanceof LocalReplicaSCMProvider) {
                scm.deactivate();
                if (
                    error instanceof LocalReplicaOwnershipUnavailableError
                    && enabled
                    && !this.disposed
                ) {
                    const persist = this.vfs.getProjectSCMPersist(scm.scmKey);
                    if (
                        persist
                        && persist.label===scmProto.label
                        && persist.baseUri===scm.baseUri.toString()
                    ) {
                        const item: SCMRecord = {scm, enabled, triggers: []};
                        this.scms.push(item);
                        scm.markWaitingForOwnership(error.message);
                        this.scheduleOwnershipRetry(item);
                        this.updateStatus();
                        return scm;
                    }
                }
            }
            const message = formatUnknownError(error);
            console.error(`"${scmProto.label}" creation failed for ${baseUri.toString()}:`, error);
            vscode.window.showErrorMessage( vscode.l10n.t('"{scm}" creation failed: {message}', {scm:scmProto.label, message}) );
            return undefined;
        } finally {
            this.pendingSCMInstances.delete(scm);
        }
    }

    private async removePersistedSCM(
        scmKey: string,
        baseUri: vscode.Uri,
        label: string,
    ): Promise<void> {
        const localReplica = label===LocalReplicaSCMProvider.label;
        if (localReplica) {
            await writeReplicaRemovalTombstone(baseUri, this.vfs.origin);
            await suppressReplicaAutoRestoreRoot(baseUri);
        }
        try {
            await this.vfs.setProjectSCMPersist(scmKey, undefined);
        } catch (error) {
            if (localReplica) {
                await clearReplicaRemovalTombstone(baseUri);
                await restoreReplicaAutoRestoreRoot(baseUri);
            }
            throw error;
        }
    }

    private async removeDetachedPersistedSCM(
        scmKey: string,
        baseUri: vscode.Uri,
        label: string,
    ): Promise<void> {
        if (label!==LocalReplicaSCMProvider.label) {
            await this.removePersistedSCM(scmKey, baseUri, label);
            return;
        }
        const detached = new LocalReplicaSCMProvider(this.vfs, baseUri);
        await detached.prepareRemovalAndHoldOwnership();
        try {
            await this.removePersistedSCM(scmKey, baseUri, label);
            await detached.confirmRemovalPersistenceDeleted();
        } finally {
            await detached.finishRemoval();
        }
    }

    private async restoreSCMAfterFailedStop(item: SCMRecord): Promise<void> {
        item.triggers.forEach(trigger => trigger.dispose());
        item.triggers = [];
        if (!item.enabled || !this.scms.includes(item) || this.disposed) {
            return;
        }
        try {
            item.triggers = await item.scm.triggers;
        } catch (error) {
            console.error(
                `Could not restore "${(item.scm.constructor as any).label}" after a failed stop ` +
                `for ${item.scm.baseUri.toString()}:`,
                error,
            );
        }
    }

    private async removeSCM(item: SCMRecord): Promise<boolean> {
        const index = this.scms.indexOf(item);
        if (index===-1) { return false; }
        if (item.scm instanceof LocalReplicaSCMProvider) {
            this.cancelOwnershipRetry(item.scm);
        }
        try {
            if (item.scm instanceof LocalReplicaSCMProvider) {
                await item.scm.prepareRemovalAndHoldOwnership();
            }
            try {
                await this.removePersistedSCM(
                    item.scm.scmKey,
                    item.scm.baseUri,
                    (item.scm.constructor as any).label,
                );
                if (item.scm instanceof LocalReplicaSCMProvider) {
                    await item.scm.confirmRemovalPersistenceDeleted();
                }
                item.triggers.forEach(trigger => trigger.dispose());
                this.scms.splice(index, 1);
                this.updateStatus();
                return true;
            } finally {
                if (item.scm instanceof LocalReplicaSCMProvider) {
                    await item.scm.finishRemoval();
                }
            }
        } catch (error) {
            if (item.scm instanceof LocalReplicaSCMProvider) {
                await this.restoreSCMAfterFailedStop(item);
                if (item.enabled && item.triggers.length===0) {
                    this.scheduleOwnershipRetry(item);
                }
            }
            throw error;
        }
    }

    public async removeLocalReplicaSCM(
        scmKey: string,
        baseUri: vscode.Uri,
    ): Promise<void> {
        const pendingDrains: Promise<void>[] = [];
        for (const pending of this.pendingSCMInstances) {
            if (
                pending instanceof LocalReplicaSCMProvider
                && (
                    pending.scmKey===scmKey
                    || pending.baseUri.toString()===baseUri.toString()
                )
            ) {
                pendingDrains.push(pending.deactivateAndDrain());
            }
        }
        await Promise.all(pendingDrains);
        const pendingCreation = this.pendingSCMs.get(
            `${LocalReplicaSCMProvider.label}:${baseUri.toString()}`,
        );
        if (pendingCreation) {
            await pendingCreation;
        }
        await this.initSCMsPromise;
        const item = this.scms.find(candidate =>
            candidate.scm instanceof LocalReplicaSCMProvider
            && (
                candidate.scm.scmKey===scmKey
                || candidate.scm.baseUri.toString()===baseUri.toString()
            )
        );
        if (item) {
            await this.removeSCM(item);
        } else {
            const detached = new LocalReplicaSCMProvider(this.vfs, baseUri);
            await detached.prepareRemovalAndHoldOwnership();
            try {
                await this.removePersistedSCM(
                    scmKey,
                    baseUri,
                    LocalReplicaSCMProvider.label,
                );
                await detached.confirmRemovalPersistenceDeleted();
            } finally {
                await detached.finishRemoval();
            }
        }
    }

    private async suspendSCMsByLabel(
        label: string,
        keepBaseUri?: vscode.Uri,
    ): Promise<SuspendedSCMRecord[]> {
        const suspended: SuspendedSCMRecord[] = [];
        const candidates = this.scms
            .filter(item => (item.scm.constructor as any).label===label)
            .filter(item => keepBaseUri===undefined || item.scm.baseUri.toString()!==keepBaseUri.toString())
            .filter(item =>
                item.triggers.length!==0
                || (
                    item.scm instanceof LocalReplicaSCMProvider
                    && this.ownershipRetryTimers.has(item.scm)
                )
            );
        for (const item of candidates) {
            suspended.push({item, wasEnabled: item.enabled});
            try {
                if (item.scm instanceof LocalReplicaSCMProvider) {
                    this.cancelOwnershipRetry(item.scm);
                    await item.scm.deactivateAndDrain();
                }
                item.triggers.forEach(trigger => trigger.dispose());
                item.triggers = [];
            } catch (error) {
                item.triggers.forEach(trigger => trigger.dispose());
                item.triggers = [];
                await this.restoreSuspendedSCMs(suspended);
                throw error;
            }
        }
        this.updateStatus();
        return suspended;
    }

    private async restoreSuspendedSCMs(suspended: SuspendedSCMRecord[]) {
        for (const {item, wasEnabled} of suspended) {
            if (!wasEnabled || !item.enabled || !this.scms.includes(item) || item.triggers.length!==0) {
                continue;
            }
            try {
                item.triggers = await item.scm.triggers;
            } catch (error) {
                if (
                    item.scm instanceof LocalReplicaSCMProvider
                    && error instanceof LocalReplicaOwnershipUnavailableError
                ) {
                    item.scm.markWaitingForOwnership(error.message);
                    this.scheduleOwnershipRetry(item);
                    continue;
                }
                console.error(`Could not restore "${(item.scm.constructor as any).label}" watcher for ${item.scm.baseUri.toString()}:`, error);
            }
        }
        this.updateStatus();
    }

    private async removeSCMsByLabel(label: string, keepBaseUri?: vscode.Uri) {
        const activeItems = [...this.scms]
            .filter(item => (item.scm.constructor as any).label===label)
            .filter(item => keepBaseUri===undefined || item.scm.baseUri.toString()!==keepBaseUri.toString());
        for (const item of activeItems) {
            await this.removeSCM(item);
        }

        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(
            this.context,
            this.vfs.serverName,
            this.vfs._userId,
            this.vfs.projectId,
        );
        const inactivePersists = Object.entries(scmPersists)
            .filter(([_scmKey, scmPersist]) => scmPersist.label===label)
            .filter(([_scmKey, scmPersist]) => keepBaseUri===undefined || scmPersist.baseUri!==keepBaseUri.toString());
        for (const [scmKey, scmPersist] of inactivePersists) {
            await this.removeDetachedPersistedSCM(
                scmKey,
                parsePersistedBaseUri(scmPersist.baseUri),
                label,
            );
        }

        this.updateStatus();
    }

    private promptBaseUri(scmProto: SupportedSCM, options?: PromptBaseUriOptions): Promise<string | undefined> {
        return new Promise(resolve => {
            const inputBox = scmProto.baseUriInputBox;
            const selectButton: vscode.QuickInputButton = {
                iconPath: new vscode.ThemeIcon('check'),
                tooltip: vscode.l10n.t('Select Folder'),
            };
            const createFolderButton: vscode.QuickInputButton = {
                iconPath: new vscode.ThemeIcon('new-folder'),
                tooltip: vscode.l10n.t('Create typed folder and select it'),
            };
            let settled = false;
            const finish = (value?: string) => {
                if (settled) { return; }
                settled = true;
                inputBox.dispose();
                resolve(value);
            };
            const createTypedFolder = async () => {
                let folderPath = inputBox.value.trim();
                if (folderPath==='') {
                    vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
                    return;
                }
                if (options?.createFolderName && /[\\/]$/.test(folderPath)) {
                    folderPath = nodePath.join(folderPath, options.createFolderName);
                }
                const folderUri = vscode.Uri.file(folderPath);
                try {
                    await vscode.workspace.fs.createDirectory(folderUri);
                    const stat = await vscode.workspace.fs.stat(folderUri);
                    if (stat.type!==vscode.FileType.Directory) {
                        throw new Error('Not a folder');
                    }
                    finish(folderUri.fsPath);
                } catch (error) {
                    console.error(`Could not create Local Replica folder ${folderUri.toString()}:`, error);
                    vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
                }
            };
            inputBox.ignoreFocusOut = true;
            inputBox.title = options?.title ?? vscode.l10n.t('Create Source Control: {scm}', {scm:scmProto.label});
            if (options?.placeholder!==undefined) {
                inputBox.placeholder = options.placeholder;
            }
            if (options?.value!==undefined) {
                inputBox.value = options.value;
            }
            inputBox.buttons = options?.createFolderName
                ? [createFolderButton, selectButton]
                : [selectButton];
            inputBox.show();
            //
            inputBox.onDidTriggerButton((button) => {
                if (button===createFolderButton) {
                    void createTypedFolder();
                    return;
                }
                finish(inputBox.value);
            });
            inputBox.onDidAccept(() => {
                if (inputBox.activeItems.length===0) {
                    finish(inputBox.value);
                }
            });
            inputBox.onDidHide(() => {
                finish(undefined);
            });
        });
    }

    private async isSameProjectLocalReplica(baseUri: vscode.Uri): Promise<boolean> {
        const settings = await readReplicaSettingsSnapshot(baseUri);
        if (!settings?.uri) {
            return false;
        }
        try {
            return vfsProjectKey(vscode.Uri.parse(settings.uri))===vfsProjectKey(this.vfs.origin);
        } catch {
            return false;
        }
    }

    private createNewSCM(scmProto: SupportedSCM, options?: CreateSCMOptions) {
        if (options?.exactBaseUri && scmProto===LocalReplicaSCMProvider) {
            return this.createNewExactLocalReplicaSCM();
        }

        return this.promptBaseUri(scmProto)
        .then((uri) => {
            return scmProto.validateBaseUri(uri || '', this.vfs.projectName);
        })
        .then(async (baseUri) => {
            if (baseUri) {
                if (options?.replaceExistingLabel) {
                    await this.removeSCMsByLabel(options.replaceExistingLabel);
                }
                const scm = await this.createSCM(scmProto, baseUri, true, true, options);
                if (scm) {
                    vscode.window.showInformationMessage( vscode.l10n.t('"{scm}" created: {uri}.', {scm:scmProto.label, uri: decodeURI(scm.baseUri.toString()) }) );
                    return scm;
                }
            }
            return undefined;
        });
    }

    private async createNewExactLocalReplicaSCM() {
        const suggestedProjectFolderName = LocalReplicaSCMProvider.sanitizeProjectFolderName(this.vfs.projectName);
        const suggestedProjectFolder = await this.suggestExactLocalReplicaPath(suggestedProjectFolderName);
        const selectedPath = await this.promptBaseUri(LocalReplicaSCMProvider, {
            title: vscode.l10n.t('Select Project Folder Locally'),
            placeholder: vscode.l10n.t('e.g., dedicated local project folder'),
            value: suggestedProjectFolder,
            createFolderName: suggestedProjectFolderName,
        });
        if (selectedPath===undefined) {
            return undefined;
        }

        let suspended: SuspendedSCMRecord[] = [];
        let baseUri: vscode.Uri | undefined;
        let createdSCM: LocalReplicaSCMProvider | undefined;
        let preparedSelectionSCM: LocalReplicaSCMProvider | undefined;
        try {
            baseUri = await LocalReplicaSCMProvider.validateExactBaseUri(selectedPath || '', {
                projectUri: this.vfs.origin,
                beforeEmpty: async () => {
                    suspended = await this.suspendSCMsByLabel(
                        LocalReplicaSCMProvider.label,
                    );
                },
            });
            const sameProjectReplica = await this.isSameProjectLocalReplica(baseUri);
            suspended = [
                ...suspended,
                ...await this.suspendSCMsByLabel(
                    LocalReplicaSCMProvider.label,
                    baseUri,
                ),
            ];
            const existingSelection = this.scms.find(item =>
                item.scm instanceof LocalReplicaSCMProvider
                && item.scm.baseUri.toString()===baseUri!.toString()
            )?.scm;
            preparedSelectionSCM = existingSelection instanceof LocalReplicaSCMProvider
                ? existingSelection
                : new LocalReplicaSCMProvider(this.vfs, baseUri);
            preparedSelectionSCM.setInitializationOptions({
                preserveExistingLocalFiles: sameProjectReplica,
                resetLocalFilesToRemote: !sameProjectReplica,
            });
            await preparedSelectionSCM.prepareExplicitSelectionAndHoldOwnership();
            const scm = await this.createSCM(LocalReplicaSCMProvider, baseUri, true, true, {
                preserveExistingLocalFiles: sameProjectReplica,
                resetLocalFilesToRemote: !sameProjectReplica,
                beforeActivation: () => clearReplicaRemovalTombstone(baseUri!),
            }, preparedSelectionSCM);
            if (!scm) {
                await preparedSelectionSCM.deactivate();
                await this.removeLocalReplicaSCM(baseUri.toString(), baseUri);
                await this.restoreSuspendedSCMs(suspended);
                return undefined;
            }
            if (!(scm instanceof LocalReplicaSCMProvider)) {
                throw new Error('Exact Local Replica selection created an unexpected SCM type.');
            }
            createdSCM = scm;
            await this.removeSCMsByLabel(LocalReplicaSCMProvider.label, baseUri);
            vscode.window.showInformationMessage( vscode.l10n.t('"{scm}" created: {uri}.', {scm:LocalReplicaSCMProvider.label, uri: decodeURI(scm.baseUri.toString()) }) );
            return scm;
        } catch (error) {
            if (createdSCM) {
                const createdItem = this.scms.find(item => item.scm===createdSCM);
                if (createdItem) {
                    try {
                        await this.removeSCM(createdItem);
                    } catch (cleanupError) {
                        try {
                            await createdSCM.deactivateAndDrain();
                        } catch (stopError) {
                            console.error(
                                `Could not stop failed replacement Local Replica ` +
                                `${createdSCM.baseUri.toString()}:`,
                                stopError,
                            );
                        }
                        createdItem.triggers.forEach(trigger => trigger.dispose());
                        createdItem.triggers = [];
                        console.error(
                            `Could not remove failed replacement Local Replica ` +
                            `${createdSCM.baseUri.toString()}:`,
                            cleanupError,
                        );
                    }
                }
            }
            if (preparedSelectionSCM && preparedSelectionSCM!==createdSCM) {
                await preparedSelectionSCM.deactivate().catch(stopError => {
                    console.error(
                        `Could not release prepared Local Replica selection ` +
                        `${preparedSelectionSCM!.baseUri.toString()}:`,
                        stopError,
                    );
                });
            }
            await this.restoreSuspendedSCMs(suspended);
            console.error(`Exact Local Replica creation failed${baseUri ? ` for ${baseUri.toString()}` : ''}:`, error);
            return undefined;
        }
    }

    private async suggestExactLocalReplicaPath(projectFolderName: string) {
        const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
        const activeWorkspaceFolder = activeDocumentUri
            ? vscode.workspace.getWorkspaceFolder(activeDocumentUri)
            : undefined;
        const fileWorkspaceFolder = activeWorkspaceFolder?.uri.scheme==='file'
            ? activeWorkspaceFolder
            : (vscode.workspace.workspaceFolders ?? []).find(folder => folder.uri.scheme==='file');
        let parentPath = fileWorkspaceFolder?.uri.fsPath ?? nodePath.join(os.homedir(), 'Overleaf');

        if (fileWorkspaceFolder && await readReplicaSettingsSnapshot(fileWorkspaceFolder.uri)) {
            parentPath = nodePath.dirname(fileWorkspaceFolder.uri.fsPath);
        }

        return nodePath.join(parentPath, projectFolderName);
    }

    private configSCM(scmItem: SCMRecord) {
        const baseUri = scmItem.scm.baseUri.toString();
        const settingItems = scmItem.scm.settingItems as SettingItem[];
        const status = scmItem.enabled? scmItem.scm.status.status : 'disabled';
        const quickPickItems = [
            {label:scmItem.enabled?'Disable':'Enable', description:`Status: ${status}`},
            {label:'Remove', description:`${baseUri}`},
            {label:'', kind:vscode.QuickPickItemKind.Separator},
            ...settingItems,
        ];

        return vscode.window.showQuickPick(quickPickItems, {
            ignoreFocusOut: true,
            title: vscode.l10n.t('Project Source Control Management'),
        }).then(async (select) => {
            if (select===undefined) { return; }
            switch (select.label) {
                case 'Enable':
                case 'Disable':
                    const persist = this.vfs.getProjectSCMPersist(scmItem.scm.scmKey);
                    persist.enabled = !(persist.enabled ?? true);
                    this.vfs.setProjectSCMPersist(scmItem.scm.scmKey, persist);
                    //
                    const scmIndex = this.scms.indexOf(scmItem);
                    this.scms[scmIndex].enabled = persist.enabled;
                    if (persist.enabled) {
                        try {
                            scmItem.triggers = await scmItem.scm.triggers;
                        } catch (error) {
                            if (
                                scmItem.scm instanceof LocalReplicaSCMProvider
                                && error instanceof LocalReplicaOwnershipUnavailableError
                            ) {
                                scmItem.scm.markWaitingForOwnership(error.message);
                                this.scheduleOwnershipRetry(scmItem);
                            } else {
                                throw error;
                            }
                        }
                    } else {
                        if (scmItem.scm instanceof LocalReplicaSCMProvider) {
                            this.cancelOwnershipRetry(scmItem.scm);
                            scmItem.scm.deactivate();
                        }
                        scmItem.triggers.forEach(trigger => trigger.dispose());
                        scmItem.triggers = [];
                    }
                    this.updateStatus();
                    vscode.window.showWarningMessage(`"${(scmItem.scm.constructor as any).label}" ${persist.enabled?'enabled':'disabled'}: ${baseUri}.`);
                    break;
                case 'Remove':
                    if (
                        await vscode.window.showWarningMessage(
                            `${vscode.l10n.t('Remove')} ${baseUri}?`,
                            'Yes',
                            'No',
                        )==='Yes'
                    ) {
                        try {
                            await this.removeSCM(scmItem);
                        } catch (error) {
                            vscode.window.showErrorMessage(vscode.l10n.t(
                                'Local Replica removal was stopped: {message}',
                                {message: formatUnknownError(error)},
                            ));
                            return;
                        }
                        if (
                            scmItem.scm instanceof LocalReplicaSCMProvider
                            && getActiveReplicaRoot()?.toString()===scmItem.scm.baseUri.toString()
                        ) {
                            await setActiveReplicaRoot(undefined, {
                                suppressAutoRestoreRoot: scmItem.scm.baseUri,
                            });
                            await vscode.commands.executeCommand(
                                `${ROOT_NAME}.remoteFileSystem.deactivateProject`,
                                this.vfs.origin,
                            );
                        }
                    }
                    break;
                default:
                    const settingItem = settingItems.find(item => item.label===select.label);
                    settingItem?.callback();
                    break;
            }
        });
    }

    private async ensureLocalReplicaSCM(baseUri: vscode.Uri) {
        if (await hasReplicaRemovalTombstone(baseUri, this.vfs.origin)) {
            return undefined;
        }
        const persist = this.vfs.getProjectSCMPersist(baseUri.toString());
        const enabled = persist?.enabled ?? true;
        return this.createSCM(LocalReplicaSCMProvider, baseUri, persist===undefined, enabled, {
            preserveExistingLocalFiles: true,
            resetLocalFilesToRemote: false,
        });
    }

    showSCMConfiguration() {
        // group 1: show existing scms
        const scmItems: vscode.QuickPickItem[] = this.scms.map((item) => {
            const { scm } = item;
            return {
                label: (scm.constructor as any).label,
                iconPath: scm.iconPath,
                description: scm.baseUri.toString(),
                item,
            };
        });
        if (scmItems.length!==0) {
            scmItems.push({kind:vscode.QuickPickItemKind.Separator, label:''});
        }
        // group 2: create new scm
        const createItems: vscode.QuickPickItem[] = supportedSCMs.map((scmProto) => {
            return {
                label: vscode.l10n.t('Create Source Control: {scm}', {scm:scmProto.label}),
                scmProto,
            };
        });

        // show quick pick
        vscode.window.showQuickPick([...scmItems, ...createItems], {
            ignoreFocusOut: true,
            title: vscode.l10n.t('Project Source Control Management'),
        }).then((select) => {
            if (select) {
                const _select = select as any;
                // configure existing scm
                if (_select.item) {
                    this.configSCM( _select.item as SCMRecord );
                }
                // create new scm
                if ( _select.scmProto ) {
                    this.createNewSCM(_select.scmProto as SupportedSCM );
                }
            }
        });
    }

    get triggers() {
        return [
            // Register: HistoryViewProvider
            ...this.historyDataProvider.triggers,
            // register status bar item
            this.statusBarItem,
            this.statusListener,
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectSCM.configSCM`, () => {
                return this.showSCMConfiguration();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectSCM.newSCM`, (scmProto) => {
                return this.createNewSCM(scmProto);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectSCM.newSCMWithOptions`, (scmProto, options?: CreateSCMOptions) => {
                return this.createNewSCM(scmProto, options);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectSCM.newExactLocalReplicaSCM`, () => {
                return this.createNewExactLocalReplicaSCM();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectSCM.ensureLocalReplicaSCM`, (baseUri: vscode.Uri) => {
                return this.ensureLocalReplicaSCM(baseUri);
            }),
            this as vscode.Disposable,
        ];
    }
    
}
