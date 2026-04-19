import * as vscode from 'vscode';
import { ROOT_NAME } from './consts';
import { RemoteFileSystemProvider } from './core/remoteFileSystemProvider';
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
    const projectManagerProvider = new ProjectManagerProvider(context);
    context.subscriptions.push( ...projectManagerProvider.triggers );

    // Register: [core] PdfViewEditorProvider
    const pdfViewEditorProvider = new PdfViewEditorProvider(context);
    context.subscriptions.push( ...pdfViewEditorProvider.triggers );

    // Register: [compile] CompileManager on Statusbar
    const compileManager = new CompileManager(remoteFileSystemProvider);
    context.subscriptions.push( ...compileManager.triggers );

    // Register: [intellisense] LangIntellisenseProvider
    const langIntellisenseProvider = new LangIntellisenseProvider(context, remoteFileSystemProvider);
    context.subscriptions.push( ...langIntellisenseProvider.triggers );

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
            void syncActiveReplicaProject();
        }),
    );

    void initializeLocalReplicaWorkspace().then(async () => {
        await syncActiveReplicaProject();
    });
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activeReplicaEditor`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activeReplicaCompileEditor`, false);
}
