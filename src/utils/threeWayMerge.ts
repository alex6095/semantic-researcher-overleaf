import { diff3Merge } from 'node-diff3';

export const DEFAULT_MAX_MERGE_BYTES = 5 * 1024 * 1024;

export function decodeUtf8Text(
    content: Uint8Array,
    maxBytes = DEFAULT_MAX_MERGE_BYTES,
): string | undefined {
    if (content.length>maxBytes) {
        return undefined;
    }
    try {
        return new TextDecoder('utf-8', {fatal: true}).decode(content);
    } catch {
        return undefined;
    }
}

function splitTextForMerge(content: string): string[] {
    return content.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

export function mergeUtf8Text(
    baseContent: Uint8Array,
    localContent: Uint8Array,
    remoteContent: Uint8Array,
    maxBytes = DEFAULT_MAX_MERGE_BYTES,
): Uint8Array | undefined {
    const baseText = decodeUtf8Text(baseContent, maxBytes);
    const localText = decodeUtf8Text(localContent, maxBytes);
    const remoteText = decodeUtf8Text(remoteContent, maxBytes);
    if (baseText===undefined || localText===undefined || remoteText===undefined) {
        return undefined;
    }

    const regions = diff3Merge(
        splitTextForMerge(localText),
        splitTextForMerge(baseText),
        splitTextForMerge(remoteText),
        {excludeFalseConflicts: true},
    );
    if (regions.some(region => region.conflict!==undefined)) {
        return undefined;
    }
    return new TextEncoder().encode(
        regions.flatMap(region => region.ok ?? []).join(''),
    );
}
