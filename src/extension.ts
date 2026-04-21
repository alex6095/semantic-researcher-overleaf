import * as vscode from 'vscode';
import { ROOT_NAME } from './consts';
import { RemoteFileSystemProvider, VFSConnectionState, parseUri } from './core/remoteFileSystemProvider';
import { ProjectManagerProvider } from './core/projectManagerProvider';
import { PdfViewEditorProvider } from './core/pdfViewEditorProvider';
import { CompileManager } from './compile/compileManager';
import { LangIntellisenseProvider } from './intellisense';
import {
    configureLocalReplicaWorkspace,
    getActiveReplicaOriginUri,
    getActiveReplicaRoot,
    initializeLocalReplicaWorkspace,
    onDidChangeActiveReplicaRoot,
} from './utils/localReplicaWorkspace';
import { migrateLegacyNamespace } from './utils/namespaceMigration';
import { initializeAgentReviewManager } from './agentReview';

type ActiveReplicaSyncTarget = {
    key: string,
    uri: vscode.Uri,
    rootUri: vscode.Uri,
};

export async function activate(context: vscode.ExtensionContext) {
    await migrateLegacyNamespace(context);

    // Register: [core] RemoteFileSystemProvider
    const remoteFileSystemProvider = new RemoteFileSystemProvider(context);
    context.subscriptions.push( ...remoteFileSystemProvider.triggers );
    configureLocalReplicaWorkspace(context);

    // Register: [core] ProjectManagerProvider on Activitybar
    const projectManagerProvider = new ProjectManagerProvider(context, remoteFileSystemProvider);
    context.subscriptions.push( ...projectManagerProvider.triggers );

    // Register: global Overleaf connection status bar so the user is never left
    // with "selected" as a false proxy for "live". Event-driven, no polling.
    const overleafStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    overleafStatusItem.command = 'workbench.action.output.toggleOutput';
    context.subscriptions.push(overleafStatusItem);

    const applyConnectionState = (state: VFSConnectionState, projectName?: string) => {
        const label = projectName ?? 'Overleaf';
        switch (state) {
            case 'connected':
                overleafStatusItem.text = `$(cloud) ${label}`;
                overleafStatusItem.tooltip = 'Overleaf connected (changes sync live)';
                overleafStatusItem.color = undefined;
                overleafStatusItem.backgroundColor = undefined;
                overleafStatusItem.show();
                projectManagerProvider.updateActiveConnectionState('connected');
                break;
            case 'reconnecting':
                overleafStatusItem.text = `$(sync~spin) ${label}`;
                overleafStatusItem.tooltip = 'Reconnecting to Overleaf';
                overleafStatusItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
                overleafStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                overleafStatusItem.show();
                projectManagerProvider.updateActiveConnectionState('reconnecting');
                break;
            case 'initial':
                overleafStatusItem.text = `$(sync~spin) ${label}`;
                overleafStatusItem.tooltip = 'Connecting to Overleaf';
                overleafStatusItem.color = undefined;
                overleafStatusItem.backgroundColor = undefined;
                overleafStatusItem.show();
                projectManagerProvider.updateActiveConnectionState('initial');
                break;
            case 'disconnected':
                overleafStatusItem.text = `$(cloud-offline) ${label}`;
                overleafStatusItem.tooltip = 'Overleaf disconnected — edits will not reach the server until reconnected';
                overleafStatusItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
                overleafStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                overleafStatusItem.show();
                projectManagerProvider.updateActiveConnectionState('disconnected');
                break;
        }
    };

    const projectIdOfUri = (uri: vscode.Uri | undefined) => {
        if (!uri) { return undefined; }
        try {
            return parseUri(uri);
        } catch {
            return undefined;
        }
    };

    context.subscriptions.push(
        remoteFileSystemProvider.onDidChangeActiveConnection(({vfs, state}) => {
            if (vfs) {
                projectManagerProvider.setActiveProject(vfs.serverName, vfs.projectId, state);
                applyConnectionState(state, vfs.projectName);
            } else {
                projectManagerProvider.setActiveProject('', undefined, 'inactive');
                overleafStatusItem.hide();
            }
        }),
    );

    // Register: [core] PdfViewEditorProvider
    const pdfViewEditorProvider = new PdfViewEditorProvider(context);
    context.subscriptions.push( ...pdfViewEditorProvider.triggers );

    // Register: [compile] CompileManager on Statusbar
    const compileManager = new CompileManager(remoteFileSystemProvider);
    context.subscriptions.push( ...compileManager.triggers );

    // Register: [intellisense] LangIntellisenseProvider
    const langIntellisenseProvider = new LangIntellisenseProvider(context, remoteFileSystemProvider);
    context.subscriptions.push( ...langIntellisenseProvider.triggers );

    // Register: [agent review] Local Replica agent proposal workflow
    const agentReviewManager = initializeAgentReviewManager(context);

    let activeReplicaSyncPromise: Promise<void> | undefined;
    let activeReplicaSyncKey: string | undefined;
    let queuedActiveReplicaSyncKey: string | undefined;

    const getActiveReplicaSyncTarget = (): ActiveReplicaSyncTarget | undefined => {
        const uri = getActiveReplicaOriginUri();
        const rootUri = getActiveReplicaRoot();
        if (uri?.scheme!==ROOT_NAME || !rootUri) {
            return undefined;
        }
        return {
            key: `${uri.toString()}::${rootUri.toString()}`,
            uri,
            rootUri,
        };
    };

    const runActiveReplicaSync = async (initialTarget: ActiveReplicaSyncTarget) => {
        let target: ActiveReplicaSyncTarget | undefined = initialTarget;
        while (target) {
            activeReplicaSyncKey = target.key;
            queuedActiveReplicaSyncKey = undefined;
            await remoteFileSystemProvider.activateProject(target.uri);

            const latestTarget = getActiveReplicaSyncTarget();
            if (latestTarget?.key===target.key) {
                await vscode.commands.executeCommand(`${ROOT_NAME}.projectSCM.ensureLocalReplicaSCM`, target.rootUri);
            }

            const queuedKey = queuedActiveReplicaSyncKey;
            const currentTarget = getActiveReplicaSyncTarget();
            target = queuedKey && currentTarget?.key===queuedKey && currentTarget.key!==activeReplicaSyncKey
                ? currentTarget
                : undefined;
        }
    };

    const syncActiveReplicaProject = () => {
        const target = getActiveReplicaSyncTarget();
        if (!target) {
            return Promise.resolve();
        }
        if (activeReplicaSyncPromise) {
            if (target.key!==activeReplicaSyncKey) {
                queuedActiveReplicaSyncKey = target.key;
            }
            return activeReplicaSyncPromise;
        }

        activeReplicaSyncPromise = runActiveReplicaSync(target)
        .catch(error => {
            console.error('Active Local Replica sync failed:', error);
        })
        .finally(() => {
            activeReplicaSyncPromise = undefined;
            activeReplicaSyncKey = undefined;
            queuedActiveReplicaSyncKey = undefined;
        });
        return activeReplicaSyncPromise;
    };

    context.subscriptions.push(
        onDidChangeActiveReplicaRoot(() => {
            void agentReviewManager.activate(getActiveReplicaRoot());
            void syncActiveReplicaProject();
        }),
    );

    void initializeLocalReplicaWorkspace().then(async () => {
        await agentReviewManager.activate(getActiveReplicaRoot());
        await syncActiveReplicaProject();
    });
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activeReplicaEditor`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activeReplicaCompileEditor`, false);
}
