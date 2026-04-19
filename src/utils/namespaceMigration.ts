import * as vscode from 'vscode';
import {
    CONFIG_SECTION,
    getExplicitConfiguredValue,
    hasConfiguredValue,
    LEGACY_CONFIG_SECTION,
    LEGACY_EXTENSION_NAMESPACE,
    LEGACY_STATE_PDF_VIEWERS_KEY,
    LEGACY_STATE_SERVERS_KEY,
    ROOT_NAME,
    STATE_PDF_VIEWERS_KEY,
    STATE_SERVERS_KEY,
} from '../consts';
import { canonicalizeOverleafUriString } from './overleafUri';

const CONFIG_KEYS = [
    'compileOnSave.enabled',
    'compileOutputFolderName',
    'pdfViewer.themes',
    'pdfViewer.defaultScrollMode',
    'pdfViewer.defaultSpreadMode',
    'invisibleMode.historyRefreshInterval',
    'invisibleMode.chatMessageRefreshInterval',
    'invisibleMode.inactiveTimeout',
    'formatWithLineBreak.enabled',
    'auth.browserPath',
    'auth.browserLogin.timeoutSeconds',
];

type PdfViewPersist = {
    frequency: number,
    state: any,
};

type PdfViewPersistMap = {[uri: string]: PdfViewPersist};

async function migrateConfiguration() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const legacyConfig = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION);

    for (const key of CONFIG_KEYS) {
        if (hasConfiguredValue(config, key)) {
            continue;
        }
        const legacyValue = getExplicitConfiguredValue<any>(legacyConfig, key);
        if (legacyValue!==undefined) {
            await config.update(key, legacyValue, vscode.ConfigurationTarget.Global);
        }
    }
}

async function migrateServerState(context: vscode.ExtensionContext) {
    const current = context.globalState.get<any>(STATE_SERVERS_KEY);
    const legacy = context.globalState.get<any>(LEGACY_STATE_SERVERS_KEY);
    if (current===undefined && legacy!==undefined) {
        await context.globalState.update(STATE_SERVERS_KEY, legacy);
    }
}

function migratePdfViewState(current: PdfViewPersistMap, legacy: PdfViewPersistMap): PdfViewPersistMap {
    const migrated = {...current};
    for (const [uri, persist] of Object.entries(legacy)) {
        let canonicalUri = uri;
        try {
            canonicalUri = canonicalizeOverleafUriString(uri);
        } catch {
            // Keep opaque/invalid keys as-is rather than dropping saved viewer state.
        }

        const existing = migrated[canonicalUri];
        if (!existing || persist.frequency > existing.frequency) {
            migrated[canonicalUri] = persist;
        }
    }
    return migrated;
}

async function migratePdfState(context: vscode.ExtensionContext) {
    const current = context.globalState.get<PdfViewPersistMap>(STATE_PDF_VIEWERS_KEY, {});
    const legacy = context.globalState.get<PdfViewPersistMap>(LEGACY_STATE_PDF_VIEWERS_KEY, {});
    if (Object.keys(legacy).length===0) {
        return;
    }
    await context.globalState.update(STATE_PDF_VIEWERS_KEY, migratePdfViewState(current, legacy));
}

async function migrateWorkspaceState(context: vscode.ExtensionContext) {
    const activeReplicaRootKey = `${ROOT_NAME}.activeReplicaRoot`;
    const legacyActiveReplicaRootKey = `${LEGACY_EXTENSION_NAMESPACE}.activeReplicaRoot`;
    const current = context.workspaceState.get<string>(activeReplicaRootKey);
    const legacy = context.workspaceState.get<string>(legacyActiveReplicaRootKey);
    if (current===undefined && legacy!==undefined) {
        await context.workspaceState.update(activeReplicaRootKey, legacy);
    }
}

export async function migrateLegacyNamespace(context: vscode.ExtensionContext) {
    await migrateConfiguration();
    await migrateServerState(context);
    await migratePdfState(context);
    await migrateWorkspaceState(context);
}
