import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as nodeFs from 'fs/promises';
import * as nodePath from 'path';
import {
    LEGACY_EXTENSION_NAMESPACE,
    LEGACY_REPLICA_SETTINGS_BACKUP_FILE,
    LEGACY_REPLICA_SETTINGS_DIR,
    LEGACY_REPLICA_SETTINGS_FILE,
    REPLICA_SETTINGS_DIR,
    REPLICA_SETTINGS_FILE,
    REPLICA_REMOVAL_TOMBSTONE_FILE,
    ROOT_NAME,
} from '../consts';
import { canonicalizeOverleafUri, stringifyOverleafUri } from './overleafUri';

export interface LocalReplicaSettings {
    uri: string,
    serverName: string,
    enableCompileNPreview: boolean,
    /** Legacy; stripped on normalization. Use agentReview.enabled instead. */
    enableAgentReview?: boolean,
    projectName: string,
}

export type ReplicaSettingsSnapshotResult =
    | {status: 'ok', settings: LocalReplicaSettings}
    | {status: 'missing'}
    | {status: 'unavailable', error: unknown};

interface ReplicaRemovalTombstone {
    version: 1;
    projectIdentity: string;
    rootUri: string;
    token: string;
    removedAt: string;
}

type ReplicaRemovalTombstoneRead =
    | {status: 'missing'}
    | {status: 'invalid'}
    | {status: 'valid', tombstone: ReplicaRemovalTombstone};

const ACTIVE_REPLICA_ROOT_KEY = `${ROOT_NAME}.activeReplicaRoot`;
const LEGACY_ACTIVE_REPLICA_ROOT_KEY = `${LEGACY_EXTENSION_NAMESPACE}.activeReplicaRoot`;
const SUPPRESSED_AUTO_RESTORE_ROOT_KEY = `${ROOT_NAME}.suppressedActiveReplicaRoot`;
const SUPPRESSED_AUTO_RESTORE_ROOTS_KEY = `${ROOT_NAME}.suppressedActiveReplicaRoots`;

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

function normalizeSettings(settings: LocalReplicaSettings): LocalReplicaSettings {
    const {enableAgentReview: _legacyEnableAgentReview, ...rest} = settings;
    return {
        ...rest,
        uri: stringifyOverleafUri(canonicalizeOverleafUri(vscode.Uri.parse(settings.uri))),
        enableCompileNPreview: true,
    };
}

async function readSettingsFile(settingsUri: vscode.Uri): Promise<LocalReplicaSettings | undefined> {
    try {
        const content = await vscode.workspace.fs.readFile(settingsUri);
        const settings = JSON.parse(new TextDecoder().decode(content)) as LocalReplicaSettings;
        const normalizedSettings = normalizeSettings(settings);
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

async function readSettingsFileSnapshot(settingsUri: vscode.Uri): Promise<LocalReplicaSettings | undefined> {
    try {
        const content = await vscode.workspace.fs.readFile(settingsUri);
        const settings = JSON.parse(new TextDecoder().decode(content)) as LocalReplicaSettings;
        return normalizeSettings(settings);
    } catch {
        return undefined;
    }
}

function isFileNotFoundError(error: unknown): boolean {
    const code = typeof error==='object' && error!==null && 'code' in error
        ? String((error as {code?: unknown}).code)
        : '';
    return code==='FileNotFound' || code==='ENOENT';
}

async function inspectSettingsFileSnapshot(settingsUri: vscode.Uri): Promise<ReplicaSettingsSnapshotResult> {
    try {
        const content = await vscode.workspace.fs.readFile(settingsUri);
        const settings = JSON.parse(new TextDecoder().decode(content)) as LocalReplicaSettings;
        return {status: 'ok', settings: normalizeSettings(settings)};
    } catch (error) {
        return isFileNotFoundError(error)
            ? {status: 'missing'}
            : {status: 'unavailable', error};
    }
}

async function backupLegacySettings(rootUri: vscode.Uri) {
    const legacySettingsUri = vscode.Uri.joinPath(rootUri, LEGACY_REPLICA_SETTINGS_FILE);
    const backupUri = vscode.Uri.joinPath(rootUri, LEGACY_REPLICA_SETTINGS_BACKUP_FILE);
    try {
        await vscode.workspace.fs.rename(legacySettingsUri, backupUri, {overwrite: false});
    } catch {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fallbackBackupUri = vscode.Uri.joinPath(
            rootUri,
            LEGACY_REPLICA_SETTINGS_DIR,
            `settings.${timestamp}.overleaf-workshop.json`,
        );
        try {
            await vscode.workspace.fs.rename(legacySettingsUri, fallbackBackupUri, {overwrite: false});
        } catch (error) {
            console.warn(`Could not back up legacy local replica settings under ${rootUri.toString()}:`, error);
        }
    }
}

async function readSettingsFromRoot(rootUri: vscode.Uri): Promise<LocalReplicaSettings | undefined> {
    const settingsUri = vscode.Uri.joinPath(rootUri, REPLICA_SETTINGS_FILE);
    const settings = await readSettingsFile(settingsUri);
    if (settings) {
        return settings;
    }

    const legacySettingsUri = vscode.Uri.joinPath(rootUri, LEGACY_REPLICA_SETTINGS_FILE);
    const legacySettings = await readSettingsFile(legacySettingsUri);
    if (!legacySettings) {
        return undefined;
    }

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(rootUri, REPLICA_SETTINGS_DIR));
    await vscode.workspace.fs.writeFile(
        settingsUri,
        Buffer.from(JSON.stringify(legacySettings, null, 4)),
    );
    await backupLegacySettings(rootUri);
    return legacySettings;
}

async function readSettingsSnapshotFromRoot(rootUri: vscode.Uri): Promise<LocalReplicaSettings | undefined> {
    const settingsUri = vscode.Uri.joinPath(rootUri, REPLICA_SETTINGS_FILE);
    const settings = await readSettingsFileSnapshot(settingsUri);
    if (settings) {
        return settings;
    }

    const legacySettingsUri = vscode.Uri.joinPath(rootUri, LEGACY_REPLICA_SETTINGS_FILE);
    return readSettingsFileSnapshot(legacySettingsUri);
}

async function inspectSettingsSnapshotFromRoot(rootUri: vscode.Uri): Promise<ReplicaSettingsSnapshotResult> {
    const current = await inspectSettingsFileSnapshot(vscode.Uri.joinPath(rootUri, REPLICA_SETTINGS_FILE));
    if (current.status==='ok') {
        return current;
    }

    const legacy = await inspectSettingsFileSnapshot(vscode.Uri.joinPath(rootUri, LEGACY_REPLICA_SETTINGS_FILE));
    if (legacy.status==='ok') {
        return legacy;
    }
    if (current.status==='unavailable') {
        return current;
    }
    if (legacy.status==='unavailable') {
        return legacy;
    }
    return {status: 'missing'};
}

export function normalizeLocalReplicaRelPath(relPath: string): string | undefined {
    if (relPath.includes('\0') || relPath.includes('\\')) {
        return undefined;
    }

    const relativePath = relPath.replace(/^\/+/, '');
    if (relativePath==='') {
        return undefined;
    }

    const parts = relativePath.split('/');
    if (parts.some(part => part==='' || part==='.' || part==='..')) {
        return undefined;
    }

    return `/${parts.join('/')}`;
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

function getSuppressedAutoRestoreRoots(): Set<string> {
    const roots = new Set(
        extensionContext?.workspaceState.get<string[]>(
            SUPPRESSED_AUTO_RESTORE_ROOTS_KEY,
            [],
        ) ?? [],
    );
    const legacyRoot = extensionContext?.workspaceState.get<string>(
        SUPPRESSED_AUTO_RESTORE_ROOT_KEY,
    );
    if (legacyRoot) {
        roots.add(parsePersistedLocalRoot(legacyRoot).toString());
    }
    return roots;
}

function replicaProjectIdentity(projectUri: vscode.Uri): string {
    const canonical = canonicalizeOverleafUri(projectUri);
    const query = new URLSearchParams(canonical.query);
    return [
        canonical.scheme,
        canonical.authority,
        query.get('user') ?? '',
        query.get('project') ?? '',
    ].join('\0');
}

function isReplicaRemovalTombstone(value: unknown): value is ReplicaRemovalTombstone {
    if (!value || typeof value!=='object' || Array.isArray(value)) {
        return false;
    }
    const record = value as Partial<ReplicaRemovalTombstone>;
    return record.version===1
        && typeof record.projectIdentity==='string'
        && record.projectIdentity.length>0
        && typeof record.rootUri==='string'
        && record.rootUri.length>0
        && typeof record.token==='string'
        && /^[a-f0-9-]{16,128}$/.test(record.token)
        && typeof record.removedAt==='string'
        && Number.isFinite(Date.parse(record.removedAt));
}

async function readReplicaRemovalTombstone(
    rootUri: vscode.Uri,
): Promise<ReplicaRemovalTombstoneRead> {
    try {
        const content = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(rootUri, REPLICA_REMOVAL_TOMBSTONE_FILE),
        );
        let parsed: unknown;
        try {
            parsed = JSON.parse(new TextDecoder().decode(content));
        } catch (error) {
            if (error instanceof SyntaxError) {
                return {status: 'invalid'};
            }
            throw error;
        }
        return isReplicaRemovalTombstone(parsed)
            ? {status: 'valid', tombstone: parsed}
            : {status: 'invalid'};
    } catch (error) {
        if (isFileNotFoundError(error)) {
            return {status: 'missing'};
        }
        throw error;
    }
}

async function persistSuppressedAutoRestoreRoot(
    rootUri: vscode.Uri,
    suppressed: boolean,
) {
    if (!extensionContext) { return; }
    const roots = getSuppressedAutoRestoreRoots();
    if (suppressed) {
        roots.add(rootUri.toString());
    } else {
        roots.delete(rootUri.toString());
    }
    await extensionContext.workspaceState.update(
        SUPPRESSED_AUTO_RESTORE_ROOTS_KEY,
        [...roots],
    );
    await extensionContext.workspaceState.update(
        SUPPRESSED_AUTO_RESTORE_ROOT_KEY,
        undefined,
    );
}

async function discoverDirectReplicaRoots() {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const matches: vscode.Uri[] = [];
    for (const folder of workspaceFolders) {
        const settingsUri = vscode.Uri.joinPath(folder.uri, REPLICA_SETTINGS_FILE);
        const legacySettingsUri = vscode.Uri.joinPath(folder.uri, LEGACY_REPLICA_SETTINGS_FILE);
        if (await pathExists(settingsUri) || await pathExists(legacySettingsUri)) {
            const settings = await readSettingsSnapshotFromRoot(folder.uri);
            if (!settings?.uri) {
                continue;
            }
            try {
                if (
                    await hasReplicaRemovalTombstone(
                        folder.uri,
                        vscode.Uri.parse(settings.uri),
                    )
                ) {
                    continue;
                }
            } catch {
                // Fail closed while removal state is temporarily unreadable.
                continue;
            }
            matches.push(folder.uri);
        }
    }
    return matches;
}

async function isReplicaRootRemoved(rootUri: vscode.Uri): Promise<boolean> {
    const settings = await readSettingsSnapshotFromRoot(rootUri);
    if (!settings?.uri) {
        return false;
    }
    try {
        return await hasReplicaRemovalTombstone(
            rootUri,
            vscode.Uri.parse(settings.uri),
        );
    } catch {
        // A temporarily unreadable removal marker must never reactivate sync.
        return true;
    }
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
    const suppressedRoots = getSuppressedAutoRestoreRoots();
    const savedRoot = extensionContext?.workspaceState.get<string>(ACTIVE_REPLICA_ROOT_KEY);
    const legacySavedRoot = extensionContext?.workspaceState.get<string>(LEGACY_ACTIVE_REPLICA_ROOT_KEY);
    if (savedRoot || legacySavedRoot) {
        const persistedRoot = savedRoot ?? legacySavedRoot!;
        const parsed = parsePersistedLocalRoot(persistedRoot);
        if (suppressedRoots.has(parsed.toString())) {
            await persistActiveRoot(undefined);
        } else if (
            await pathExists(vscode.Uri.joinPath(parsed, REPLICA_SETTINGS_FILE))
            || await pathExists(vscode.Uri.joinPath(parsed, LEGACY_REPLICA_SETTINGS_FILE))
        ) {
            if (await isReplicaRootRemoved(parsed)) {
                await persistActiveRoot(undefined);
                await persistSuppressedAutoRestoreRoot(parsed, true);
            } else {
                rootUri = parsed;
            }
        }
    }

    if (!rootUri) {
        const discovered = await discoverDirectReplicaRoots();
        const restoreCandidates = discovered.filter(
            uri => !suppressedRoots.has(uri.toString())
        );
        if (restoreCandidates.length===1) {
            rootUri = restoreCandidates[0];
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
    options?: { ensureWorkspaceFolder?: boolean, suppressAutoRestoreRoot?: vscode.Uri },
) {
    if (!rootUri) {
        activeReplicaRoot = undefined;
        activeReplicaSettings = undefined;
        await persistActiveRoot(undefined);
        if (options?.suppressAutoRestoreRoot) {
            await persistSuppressedAutoRestoreRoot(
                options.suppressAutoRestoreRoot,
                true,
            );
        }
        await syncContexts(undefined);
        onDidChangeActiveReplicaEmitter.fire({rootUri: undefined, settings: undefined});
        return undefined;
    }

    const settings = await readSettingsFromRoot(rootUri);
    if (!settings) {
        throw new Error(`No .overleaf/settings.json found under ${rootUri.toString()}`);
    }
    if (
        await hasReplicaRemovalTombstone(
            rootUri,
            vscode.Uri.parse(settings.uri),
        )
    ) {
        activeReplicaRoot = undefined;
        activeReplicaSettings = undefined;
        await persistActiveRoot(undefined);
        await persistSuppressedAutoRestoreRoot(rootUri, true);
        await syncContexts(undefined);
        onDidChangeActiveReplicaEmitter.fire({rootUri: undefined, settings: undefined});
        return undefined;
    }

    activeReplicaRoot = rootUri;
    activeReplicaSettings = settings;
    await persistActiveRoot(rootUri);
    await persistSuppressedAutoRestoreRoot(rootUri, false);
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

export async function suppressReplicaAutoRestoreRoot(rootUri: vscode.Uri) {
    await persistSuppressedAutoRestoreRoot(rootUri, true);
}

export async function restoreReplicaAutoRestoreRoot(rootUri: vscode.Uri) {
    await persistSuppressedAutoRestoreRoot(rootUri, false);
}

export async function hasReplicaRemovalTombstone(
    rootUri: vscode.Uri,
    projectUri: vscode.Uri,
): Promise<boolean> {
    const result = await readReplicaRemovalTombstone(rootUri);
    if (result.status==='missing') {
        return false;
    }
    if (result.status==='invalid') {
        return true;
    }
    return result.tombstone.projectIdentity===replicaProjectIdentity(projectUri);
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
    let handle: nodeFs.FileHandle | undefined;
    try {
        handle = await nodeFs.open(directoryPath, 'r');
        await handle.sync();
    } catch {
        // Directory fsync is unavailable on some Windows/network filesystems.
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

export async function writeReplicaRemovalTombstone(
    rootUri: vscode.Uri,
    projectUri: vscode.Uri,
): Promise<void> {
    if (rootUri.scheme!=='file') {
        throw new Error(
            `Local Replica removal tombstones require a file-system folder: ${rootUri.toString()}`,
        );
    }
    const metadataUri = vscode.Uri.joinPath(rootUri, REPLICA_SETTINGS_DIR);
    const tombstoneUri = vscode.Uri.joinPath(rootUri, REPLICA_REMOVAL_TOMBSTONE_FILE);
    const metadataPath = metadataUri.fsPath;
    const tombstonePath = tombstoneUri.fsPath;
    const temporaryPath = nodePath.join(
        metadataPath,
        `removed.json.claim-${crypto.randomUUID()}`,
    );
    const tombstone: ReplicaRemovalTombstone = {
        version: 1,
        projectIdentity: replicaProjectIdentity(projectUri),
        rootUri: rootUri.toString(),
        token: crypto.randomUUID(),
        removedAt: new Date().toISOString(),
    };
    await nodeFs.mkdir(metadataPath, {recursive: true});
    let handle: nodeFs.FileHandle | undefined;
    try {
        handle = await nodeFs.open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(Buffer.from(JSON.stringify(tombstone, null, 2)));
        await handle.sync();
        await handle.close();
        handle = undefined;
        await nodeFs.rename(temporaryPath, tombstonePath);
        await syncDirectoryBestEffort(metadataPath);
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await nodeFs.unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

export async function clearReplicaRemovalTombstone(rootUri: vscode.Uri): Promise<void> {
    if (rootUri.scheme==='file') {
        const tombstonePath = vscode.Uri.joinPath(
            rootUri,
            REPLICA_REMOVAL_TOMBSTONE_FILE,
        ).fsPath;
        try {
            await nodeFs.unlink(tombstonePath);
            await syncDirectoryBestEffort(nodePath.dirname(tombstonePath));
        } catch (error) {
            if (!isFileNotFoundError(error)) {
                throw error;
            }
        }
        return;
    }
    try {
        await vscode.workspace.fs.delete(
            vscode.Uri.joinPath(rootUri, REPLICA_REMOVAL_TOMBSTONE_FILE),
            {recursive: false},
        );
    } catch (error) {
        if (!isFileNotFoundError(error)) {
            throw error;
        }
    }
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
    if (
        relativePath==='AGENTS.md'
        || relativePath==='CLAUDE.md'
        || relativePath==='.cursor'
        || relativePath.startsWith('.cursor/')
        || relativePath==='.codex'
        || relativePath.startsWith('.codex/')
        || relativePath==='.claude'
        || relativePath.startsWith('.claude/')
    ) {
        return true;
    }
    return relativePath===REPLICA_SETTINGS_DIR
        || relativePath.startsWith(`${REPLICA_SETTINGS_DIR}/`)
        || relativePath===LEGACY_REPLICA_SETTINGS_DIR
        || relativePath.startsWith(`${LEGACY_REPLICA_SETTINGS_DIR}/`);
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

export async function readReplicaSettingsSnapshot(rootUri?: vscode.Uri) {
    if (rootUri) {
        return readSettingsSnapshotFromRoot(rootUri);
    }
    if (!activeReplicaRoot) {
        return undefined;
    }
    return readSettingsSnapshotFromRoot(activeReplicaRoot);
}

export async function inspectReplicaSettingsSnapshot(
    rootUri?: vscode.Uri,
): Promise<ReplicaSettingsSnapshotResult> {
    const resolvedRoot = rootUri ?? activeReplicaRoot;
    if (!resolvedRoot) {
        return {status: 'missing'};
    }
    return inspectSettingsSnapshotFromRoot(resolvedRoot);
}

export async function pathToLocalUri(path: string, rootUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const resolvedRoot = rootUri ?? activeReplicaRoot;
    if (!resolvedRoot) { return undefined; }
    const normalizedPath = normalizeLocalReplicaRelPath(path);
    if (!normalizedPath) { return undefined; }
    return vscode.Uri.joinPath(resolvedRoot, ...normalizedPath.replace(/^\/+/, '').split('/'));
}

export async function localUriToPath(uri: vscode.Uri, rootUri?: vscode.Uri): Promise<string | undefined> {
    const resolvedRoot = rootUri ?? activeReplicaRoot;
    if (!resolvedRoot || uri.scheme!=='file' || !isDirectoryAncestor(resolvedRoot, uri)) {
        return undefined;
    }

    const relativePath = uri.path.slice(resolvedRoot.path.length);
    return normalizeLocalReplicaRelPath(relativePath);
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

    return vscode.Uri.joinPath(canonicalizeOverleafUri(vscode.Uri.parse(activeReplicaSettings.uri)), relativePath.replace(/^\/+/, ''));
}

export function getActiveReplicaOriginUri() {
    return activeReplicaSettings?.uri ? canonicalizeOverleafUri(vscode.Uri.parse(activeReplicaSettings.uri)) : undefined;
}

export const onDidChangeActiveReplicaRoot = onDidChangeActiveReplicaEmitter.event;
