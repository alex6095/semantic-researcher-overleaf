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

/**
 * Produces a reviewable diff3 result for an explicitly user-resolved text
 * conflict. Unlike mergeUtf8Text, overlapping edits remain visible as
 * Base/Local/Overleaf conflict markers for the user to edit before applying.
 */
export function mergeUtf8TextWithConflictMarkers(
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
    const withLineEnding = (lines: readonly string[]) => {
        const text = lines.join('');
        return text==='' || /(?:\r\n|\r|\n)$/.test(text) ? text : text + '\n';
    };
    let result = '';
    for (const region of regions) {
        if (region.ok!==undefined) {
            result += region.ok.join('');
            continue;
        }
        const conflict = region.conflict;
        if (conflict===undefined) { continue; }
        if (result!=='' && !/(?:\r\n|\r|\n)$/.test(result)) {
            result += '\n';
        }
        result += '<<<<<<< Local\n';
        result += withLineEnding(conflict.a);
        result += '||||||| Base\n';
        result += withLineEnding(conflict.o);
        result += '=======\n';
        result += withLineEnding(conflict.b);
        result += '>>>>>>> Overleaf\n';
    }
    return new TextEncoder().encode(result);
}
