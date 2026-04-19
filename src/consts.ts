import * as vscode from 'vscode';

export const EXTENSION_NAMESPACE = 'semantic-researcher-overleaf';
export const LEGACY_EXTENSION_NAMESPACE = 'overleaf-workshop';

export const ROOT_NAME = EXTENSION_NAMESPACE;
export const ELEGANT_NAME = 'Semantic Researcher Overleaf';

export const CONFIG_SECTION = EXTENSION_NAMESPACE;
export const LEGACY_CONFIG_SECTION = LEGACY_EXTENSION_NAMESPACE;

export const REMOTE_FILE_SYSTEM_SCHEME = EXTENSION_NAMESPACE;
export const LEGACY_REMOTE_FILE_SYSTEM_SCHEME = LEGACY_EXTENSION_NAMESPACE;

export const PDF_VIEW_TYPE = `${ROOT_NAME}.pdfViewer`;
export const DIFF_SCHEME = `${ROOT_NAME}-diff`;
export const PREFETCH_COMMAND = `${ROOT_NAME}.remoteFileSystem.prefetch`;

export const REPLICA_SETTINGS_DIR = '.semantic-researcher-overleaf';
export const REPLICA_SETTINGS_FILE = `${REPLICA_SETTINGS_DIR}/settings.json`;
export const LEGACY_REPLICA_SETTINGS_DIR = '.overleaf';
export const LEGACY_REPLICA_SETTINGS_FILE = `${LEGACY_REPLICA_SETTINGS_DIR}/settings.json`;
export const LEGACY_REPLICA_SETTINGS_BACKUP_FILE = `${LEGACY_REPLICA_SETTINGS_DIR}/settings.overleaf-workshop.json`;

export const STATE_SERVERS_KEY = `${ROOT_NAME}.servers`;
export const LEGACY_STATE_SERVERS_KEY = 'overleaf-servers';
export const STATE_PDF_VIEWERS_KEY = `${ROOT_NAME}.pdf-viewers`;
export const LEGACY_STATE_PDF_VIEWERS_KEY = 'overleaf-pdf-viewers';

export function getExplicitConfiguredValue<T>(config: vscode.WorkspaceConfiguration, key: string): T | undefined {
    const inspected = config.inspect<T>(key);
    return inspected?.workspaceFolderLanguageValue
        ?? inspected?.workspaceFolderValue
        ?? inspected?.workspaceLanguageValue
        ?? inspected?.workspaceValue
        ?? inspected?.globalLanguageValue
        ?? inspected?.globalValue;
}

export function hasConfiguredValue(config: vscode.WorkspaceConfiguration, key: string): boolean {
    return getExplicitConfiguredValue(config, key)!==undefined;
}

export function getConfiguredValue<T>(key: string, defaultValue: T): T {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const legacyConfig = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION);
    return getExplicitConfiguredValue<T>(config, key)
        ?? getExplicitConfiguredValue<T>(legacyConfig, key)
        ?? config.get<T>(key, defaultValue)
        ?? defaultValue;
}

export const OUTPUT_FOLDER_NAME = getConfiguredValue('compileOutputFolderName', '.output') || '.output';
