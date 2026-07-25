import * as vscode from 'vscode';
import * as os from 'os';
import * as nodePath from 'path';
import { VirtualFileSystem, vfsProjectKey } from '../core/remoteFileSystemProvider';

import { BaseSCM, CommitItem, SettingItem } from ".";
import { LocalReplicaSCMProvider } from './localReplicaSCM';
import { LocalGitBridgeSCMProvider } from './localGitBridgeSCM'; 
import { HistoryViewProvider } from './historyViewProvider';
import { GlobalStateManager } from '../utils/globalStateManager';
import { EventBus } from '../utils/eventBus';
import { ROOT_NAME } from '../consts';
import { formatUnknownError } from '../utils/errorMessage';
import { stringifyOverleafUri } from '../utils/overleafUri';
import {
    getActiveReplicaRoot,
    inspectReplicaSettingsSnapshot,
    readReplicaSettingsSnapshot,
    setActiveReplicaRoot,
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
}

interface PromptBaseUriOptions {
    title?: string;
    placeholder?: string;
    value?: string;
    createFolderName?: string;
}

function parsePersistedBaseUri(baseUri: string): vscode.Uri {
    const uri = vscode.Uri.parse(baseUri);
    return uri.scheme==='' ? vscode.Uri.file(baseUri) : uri;
}

export class SCMCollectionProvider extends vscode.Disposable {
    private readonly core: CoreSCMProvider;
    private readonly scms: SCMRecord[] = [];
    private readonly pendingSCMs = new Map<string, Promise<BaseSCM | undefined>>();
    private readonly pendingSCMInstances = new Set<BaseSCM>();
    private readonly statusBarItem: vscode.StatusBarItem;
    private readonly statusListener: vscode.Disposable;
    private initSCMsPromise: Promise<void>;
    private disposed = false;
    private historyDataProvider: HistoryViewProvider;

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly context: vscode.ExtensionContext,
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
        });

        this.core = new CoreSCMProvider( vfs );
        this.historyDataProvider = new HistoryViewProvider( vfs );
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.statusBarItem.command = `${ROOT_NAME}.projectSCM.configSCM`;
        this.statusListener = EventBus.on('scmStatusChangeEvent', () => {this.updateStatus();});
        this.initSCMsPromise = this.initSCMs();
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
        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, this.vfs.serverName, this.vfs.projectId);
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
            this.vfs.setProjectSCMPersist(candidate.scmKey, undefined);
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
    ) {
        if (this.disposed) { return undefined; }
        const scmRecordKey = `${scmProto.label}:${baseUri.toString()}`;
        const existing = this.scms.find(item =>
            item.scm.baseUri.toString()===baseUri.toString()
            && (item.scm.constructor as any).label===scmProto.label
        );
        if (existing) {
            if (existing.scm instanceof LocalReplicaSCMProvider) {
                existing.scm.setInitializationOptions({
                    preserveExistingLocalFiles: options?.preserveExistingLocalFiles,
                    resetLocalFilesToRemote: options?.resetLocalFilesToRemote,
                });
            }
            if (enabled && (!existing.enabled || existing.triggers.length===0)) {
                const persist = this.vfs.getProjectSCMPersist(existing.scm.scmKey);
                if (!persist || persist.label!==scmProto.label) {
                    this.removeSCM(existing);
                    return undefined;
                }
                persist.enabled = true;
                this.vfs.setProjectSCMPersist(existing.scm.scmKey, persist);
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

        const creation = this.createSCMRecord(scmProto, baseUri, newSCM, enabled, options);
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
    ) {
        if (this.disposed) { return undefined; }
        const scm = new scmProto(this.vfs, baseUri);
        this.pendingSCMInstances.add(scm);
        if (scm instanceof LocalReplicaSCMProvider) {
            scm.setInitializationOptions({
                preserveExistingLocalFiles: options?.preserveExistingLocalFiles,
                resetLocalFilesToRemote: options?.resetLocalFilesToRemote,
            });
        }
        // insert into global state
        if (newSCM) {
            this.vfs.setProjectSCMPersist(scm.scmKey, {
                enabled: enabled,
                label: scmProto.label,
                baseUri: scm.baseUri.toString(),
                settings: {} as JSON,
            });
        }
        // insert into collection
        try {
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
            }
            const message = formatUnknownError(error);
            console.error(`"${scmProto.label}" creation failed for ${baseUri.toString()}:`, error);
            vscode.window.showErrorMessage( vscode.l10n.t('"{scm}" creation failed: {message}', {scm:scmProto.label, message}) );
            return undefined;
        } finally {
            this.pendingSCMInstances.delete(scm);
        }
    }

    private removeSCM(item: SCMRecord) {
        const index = this.scms.indexOf(item);
        if (index!==-1) {
            // remove from collection
            if (item.scm instanceof LocalReplicaSCMProvider) {
                item.scm.deactivate();
            }
            item.triggers.forEach(trigger => trigger.dispose());
            this.scms.splice(index, 1);
            // remove from global state
            this.vfs.setProjectSCMPersist(item.scm.scmKey, undefined);
            this.updateStatus();
        }
    }

    private suspendSCMsByLabel(label: string, keepBaseUri?: vscode.Uri): SuspendedSCMRecord[] {
        const suspended: SuspendedSCMRecord[] = [];
        this.scms
            .filter(item => (item.scm.constructor as any).label===label)
            .filter(item => keepBaseUri===undefined || item.scm.baseUri.toString()!==keepBaseUri.toString())
            .filter(item => item.triggers.length!==0)
            .forEach(item => {
                suspended.push({item, wasEnabled: item.enabled});
                if (item.scm instanceof LocalReplicaSCMProvider) {
                    item.scm.deactivate();
                }
                item.triggers.forEach(trigger => trigger.dispose());
                item.triggers = [];
            });
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
                console.error(`Could not restore "${(item.scm.constructor as any).label}" watcher for ${item.scm.baseUri.toString()}:`, error);
            }
        }
        this.updateStatus();
    }

    private removeSCMsByLabel(label: string, keepBaseUri?: vscode.Uri) {
        [...this.scms]
            .filter(item => (item.scm.constructor as any).label===label)
            .filter(item => keepBaseUri===undefined || item.scm.baseUri.toString()!==keepBaseUri.toString())
            .forEach(item => this.removeSCM(item));

        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, this.vfs.serverName, this.vfs.projectId);
        Object.entries(scmPersists)
            .filter(([_scmKey, scmPersist]) => scmPersist.label===label)
            .filter(([_scmKey, scmPersist]) => keepBaseUri===undefined || scmPersist.baseUri!==keepBaseUri.toString())
            .forEach(([scmKey]) => this.vfs.setProjectSCMPersist(scmKey, undefined));

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
                    this.removeSCMsByLabel(options.replaceExistingLabel);
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
        try {
            baseUri = await LocalReplicaSCMProvider.validateExactBaseUri(selectedPath || '', {
                projectUri: this.vfs.origin,
                beforeEmpty: () => {
                    suspended = this.suspendSCMsByLabel(LocalReplicaSCMProvider.label);
                },
            });
            const sameProjectReplica = await this.isSameProjectLocalReplica(baseUri);
            suspended = [
                ...suspended,
                ...this.suspendSCMsByLabel(LocalReplicaSCMProvider.label, baseUri),
            ];
            const scm = await this.createSCM(LocalReplicaSCMProvider, baseUri, true, true, {
                preserveExistingLocalFiles: sameProjectReplica,
                resetLocalFilesToRemote: !sameProjectReplica,
            });
            if (!scm) {
                if (!sameProjectReplica) {
                    this.vfs.setProjectSCMPersist(baseUri.toString(), undefined);
                }
                await this.restoreSuspendedSCMs(suspended);
                return undefined;
            }
            this.removeSCMsByLabel(LocalReplicaSCMProvider.label, baseUri);
            vscode.window.showInformationMessage( vscode.l10n.t('"{scm}" created: {uri}.', {scm:LocalReplicaSCMProvider.label, uri: decodeURI(scm.baseUri.toString()) }) );
            return scm;
        } catch (error) {
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
                        scmItem.triggers = await scmItem.scm.triggers;
                    } else {
                        if (scmItem.scm instanceof LocalReplicaSCMProvider) {
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
                        this.removeSCM(scmItem);
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
