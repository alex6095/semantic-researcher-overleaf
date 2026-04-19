import * as vscode from 'vscode';
import {
    LEGACY_REMOTE_FILE_SYSTEM_SCHEME,
    REMOTE_FILE_SYSTEM_SCHEME,
} from '../consts';

export function normalizeOverleafQuery(query: string): string {
    if (query==='' || !/%(?:3d|26)/i.test(query)) {
        return query;
    }
    const decoded = decodeURIComponent(query);
    if (!decoded.includes('user=') || !decoded.includes('project=')) {
        throw new Error(`Invalid Overleaf URI query: ${query}`);
    }
    return decoded;
}

export function normalizeOverleafUri(uri: vscode.Uri): vscode.Uri {
    if (!isOverleafUri(uri)) {
        return uri;
    }
    return uri.with({query: normalizeOverleafQuery(uri.query)});
}

export function isCurrentOverleafUri(uri: vscode.Uri): boolean {
    return uri.scheme===REMOTE_FILE_SYSTEM_SCHEME;
}

export function isLegacyOverleafUri(uri: vscode.Uri): boolean {
    return uri.scheme===LEGACY_REMOTE_FILE_SYSTEM_SCHEME;
}

export function isOverleafUri(uri: vscode.Uri): boolean {
    return isCurrentOverleafUri(uri) || isLegacyOverleafUri(uri);
}

export function canonicalizeOverleafUri(uri: vscode.Uri): vscode.Uri {
    if (!isOverleafUri(uri)) {
        return uri;
    }
    return normalizeOverleafUri(uri).with({scheme: REMOTE_FILE_SYSTEM_SCHEME});
}

export function canonicalizeOverleafUriString(uri: string): string {
    return stringifyOverleafUri(canonicalizeOverleafUri(vscode.Uri.parse(uri)));
}

export function stringifyOverleafUri(uri: vscode.Uri): string {
    const normalized = canonicalizeOverleafUri(uri);
    if (!isCurrentOverleafUri(normalized)) {
        return normalized.toString();
    }

    const baseUri = normalized.with({query: '', fragment: ''}).toString();
    const query = normalizeOverleafQuery(normalized.query);
    const fragment = normalized.fragment==='' ? '' : `#${encodeURIComponent(normalized.fragment)}`;
    return `${baseUri}${query==='' ? '' : `?${query}`}${fragment}`;
}
