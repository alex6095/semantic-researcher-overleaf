import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { normalizeOverleafUri, stringifyOverleafUri } from './overleafUri';

export interface LocalReplicaSettings {
    uri: string,
    serverName: string,
    enableCompileNPreview: boolean,
    projectName: string,
}

const ACTIVE_REPLICA_ROOT_KEY = `${ROOT_NAME}.activeReplicaRoot`;

let extensionContext: vscode.ExtensionContext | undefined;
let activeReplicaRoot: vscode.Uri | undefined;
let activeReplicaSettings: LocalReplicaSettings | undefined;

const onDidChangeActiveReplicaEmitter = new vscode.EventEmitter<{
    rootUri: vscode.Uri | undefined,
    settings: LocalReplicaSettings | undefined,
}>();

function isDirectoryAncestor(parent: vscode.Uri, child: vscode.Uri) {
    const normalizedParent = parent.path.endsWith('/') ? parent.path : `${parent.path}/`;
    return child.path===parent.path || child.path.startsWith(normalizedParent);
}

function parsePersistedLocalRoot(rootUri: string): vscode.Uri {
    const uri = vscode.Uri.parse(rootUri);
    return uri.scheme==='' ? vscode.Uri.file(rootUri) : uri;
}

async function pathExists(uri: vscode.Uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function readSettingsFromRoot(rootUri: vscode.Uri): Promise<LocalReplicaSettings | undefined> {
    const settingsUri = vscode.Uri.joinPath(rootUri, '.overleaf/settings.json');
    try {
        const content = await vscode.workspace.fs.readFile(settingsUri);
        const settings = JSON.parse(new TextDecoder().decode(content)) as LocalReplicaSettings;
        const normalizedSettings = {
            ...settings,
            uri: stringifyOverleafUri(vscode.Uri.parse(settings.uri)),
            enableCompileNPreview: true,
        };
        if (JSON.stringify(settings)!==JSON.stringify(normalizedSettings)) {
            await vscode.workspace.fs.writeFile(
                settingsUri,
                Buffer.from(JSON.stringify(normalizedSettings, null, 4)),
            );
        }
        return normalizedSettings;
    } catch {
        return undefined;
    }
}

async function syncContexts(settings?: LocalReplicaSettings) {
    await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, settings!==undefined);
    await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, settings!==undefined);
    await syncActiveEditorContexts(settings);
}

async function persistActiveRoot(rootUri: vscode.Uri | undefined) {
    if (!extensionContext) { return; }
    await extensionContext.workspaceState.update(ACTIVE_REPLICA_ROOT_KEY, rootUri?.toString());
}

async function discoverDirectReplicaRoots() {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const matches: vscode.Uri[] = [];
    for (const folder of workspaceFolders) {
        const settingsUri = vscode.Uri.joinPath(folder.uri, '.overleaf/settings.json');
        if (await pathExists(settingsUri)) {
            matches.push(folder.uri);
        }
    }
    return matches;
}

export function configureLocalReplicaWorkspace(context: vscode.ExtensionContext) {
    extensionContext = context;
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            void syncActiveEditorContexts();
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void syncActiveEditorContexts();
        }),
    );
}

export async function initializeLocalReplicaWorkspace() {
    let rootUri: vscode.Uri | undefined;
    const savedRoot = extensionContext?.workspaceState.get<string>(ACTIVE_REPLICA_ROOT_KEY);
    if (savedRoot) {
        const parsed = parsePersistedLocalRoot(savedRoot);
        if (await pathExists(vscode.Uri.joinPath(parsed, '.overleaf/settings.json'))) {
            rootUri = parsed;
        }
    }

    if (!rootUri) {
        const discovered = await discoverDirectReplicaRoots();
        if (discovered.length===1) {
            rootUri = discovered[0];
        }
    }

    if (rootUri) {
        await setActiveReplicaRoot(rootUri, {ensureWorkspaceFolder: true});
    } else {
        activeReplicaRoot = undefined;
        activeReplicaSettings = undefined;
        await syncContexts(undefined);
    }
}

export async function setActiveReplicaRoot(
    rootUri: vscode.Uri | undefined,
    options?: { ensureWorkspaceFolder?: boolean },
) {
    if (!rootUri) {
        activeReplicaRoot = undefined;
        activeReplicaSettings = undefined;
        await persistActiveRoot(undefined);
        await syncContexts(undefined);
        onDidChangeActiveReplicaEmitter.fire({rootUri: undefined, settings: undefined});
        return undefined;
    }

    const settings = await readSettingsFromRoot(rootUri);
    if (!settings) {
        throw new Error(`No .overleaf/settings.json found under ${rootUri.toString()}`);
    }

    activeReplicaRoot = rootUri;
    activeReplicaSettings = settings;
    await persistActiveRoot(rootUri);
    await syncContexts(settings);

    if (options?.ensureWorkspaceFolder) {
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const covered = workspaceFolders.some(folder => folder.uri.scheme===rootUri.scheme && isDirectoryAncestor(folder.uri, rootUri));
        if (!covered) {
            vscode.workspace.updateWorkspaceFolders(
                workspaceFolders.length,
                0,
                { uri: rootUri, name: rootUri.path.split('/').filter(Boolean).at(-1) },
            );
        }
    }

    onDidChangeActiveReplicaEmitter.fire({rootUri, settings});
    return settings;
}

export function getActiveReplicaRoot() {
    return activeReplicaRoot;
}

export function getActiveReplicaSettings() {
    return activeReplicaSettings;
}

export function isActiveReplicaRoot(rootUri: vscode.Uri) {
    return activeReplicaRoot?.toString()===rootUri.toString();
}

export function isWithinActiveReplica(uri: vscode.Uri) {
    return uri.scheme==='file' && activeReplicaRoot!==undefined && isDirectoryAncestor(activeReplicaRoot, uri);
}

export function isLocalReplicaMetadataUri(uri: vscode.Uri, rootUri = activeReplicaRoot) {
    if (!rootUri || uri.scheme!=='file' || !isDirectoryAncestor(rootUri, uri)) {
        return false;
    }

    const relativePath = uri.path.slice(rootUri.path.length).replace(/^\/+/, '');
    return relativePath==='.overleaf' || relativePath.startsWith('.overleaf/');
}

export function isSupportedReplicaDocument(uri: vscode.Uri) {
    return uri.scheme===ROOT_NAME || (isWithinActiveReplica(uri) && !isLocalReplicaMetadataUri(uri));
}

export async function syncActiveEditorContexts(settings = activeReplicaSettings) {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const isReplicaEditor = activeUri ? isWithinActiveReplica(activeUri) && !isLocalReplicaMetadataUri(activeUri) : false;
    const isCompileEditor = isReplicaEditor && settings!==undefined && activeUri?.path.toLowerCase().endsWith('.tex');
    await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activeReplicaEditor`, isReplicaEditor);
    await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activeReplicaCompileEditor`, isCompileEditor);
}

export async function readActiveReplicaSettings() {
    if (!activeReplicaRoot) {
        return undefined;
    }
    activeReplicaSettings = await readSettingsFromRoot(activeReplicaRoot);
    await syncContexts(activeReplicaSettings);
    return activeReplicaSettings;
}

export async function readReplicaSettings(rootUri?: vscode.Uri) {
    if (rootUri) {
        return readSettingsFromRoot(rootUri);
    }
    return readActiveReplicaSettings();
}

export async function pathToLocalUri(path: string, rootUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const resolvedRoot = rootUri ?? activeReplicaRoot;
    if (!resolvedRoot) { return undefined; }
    return vscode.Uri.joinPath(resolvedRoot, path.replace(/^\/+/, ''));
}

export async function localUriToPath(uri: vscode.Uri, rootUri?: vscode.Uri): Promise<string | undefined> {
    const resolvedRoot = rootUri ?? activeReplicaRoot;
    if (!resolvedRoot || uri.scheme!=='file' || !isDirectoryAncestor(resolvedRoot, uri)) {
        return undefined;
    }

    const relativePath = uri.path.slice(resolvedRoot.path.length);
    return relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
}

export async function toVirtualUri(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    if (uri.scheme===ROOT_NAME) {
        return uri;
    }

    if (!isWithinActiveReplica(uri) || isLocalReplicaMetadataUri(uri) || !activeReplicaSettings) {
        return undefined;
    }

    const relativePath = await localUriToPath(uri);
    if (relativePath===undefined) {
        return undefined;
    }

    return vscode.Uri.joinPath(normalizeOverleafUri(vscode.Uri.parse(activeReplicaSettings.uri)), relativePath.replace(/^\/+/, ''));
}

export function getActiveReplicaOriginUri() {
    return activeReplicaSettings?.uri ? normalizeOverleafUri(vscode.Uri.parse(activeReplicaSettings.uri)) : undefined;
}

export const onDidChangeActiveReplicaRoot = onDidChangeActiveReplicaEmitter.event;
