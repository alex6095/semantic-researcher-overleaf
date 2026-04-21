import { AgentReviewHunk } from './types';

type DiffOp = {
    kind: 'equal' | 'delete' | 'insert',
    line: string,
    oldIndex?: number,
    newIndex?: number,
};

const CONTEXT_LINES = 3;

function splitLines(text: string): string[] {
    if (text==='') {
        return [];
    }
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

export function hashText(text: string): string {
    let hash = 0;
    for (let i=0; i<text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return `${text.length}:${hash}`;
}

function trimSharedEdges(original: string[], proposed: string[]) {
    let prefix = 0;
    while (
        prefix<original.length
        && prefix<proposed.length
        && original[prefix]===proposed[prefix]
    ) {
        prefix++;
    }

    let suffix = 0;
    while (
        suffix<original.length-prefix
        && suffix<proposed.length-prefix
        && original[original.length-1-suffix]===proposed[proposed.length-1-suffix]
    ) {
        suffix++;
    }

    return {
        prefix,
        originalMiddle: original.slice(prefix, original.length-suffix),
        proposedMiddle: proposed.slice(prefix, proposed.length-suffix),
    };
}

function diffMiddle(original: string[], proposed: string[], offset: number): DiffOp[] {
    const rows = original.length + 1;
    const cols = proposed.length + 1;
    const table = new Array<number>(rows * cols).fill(0);
    const at = (i: number, j: number) => i * cols + j;

    for (let i=original.length-1; i>=0; i--) {
        for (let j=proposed.length-1; j>=0; j--) {
            table[at(i, j)] = original[i]===proposed[j]
                ? table[at(i+1, j+1)] + 1
                : Math.max(table[at(i+1, j)], table[at(i, j+1)]);
        }
    }

    const ops: DiffOp[] = [];
    let i = 0;
    let j = 0;
    while (i<original.length || j<proposed.length) {
        if (i<original.length && j<proposed.length && original[i]===proposed[j]) {
            ops.push({kind: 'equal', line: original[i], oldIndex: offset+i, newIndex: offset+j});
            i++;
            j++;
        } else if (j<proposed.length && (i===original.length || table[at(i, j+1)]>=table[at(i+1, j)])) {
            ops.push({kind: 'insert', line: proposed[j], newIndex: offset+j});
            j++;
        } else if (i<original.length) {
            ops.push({kind: 'delete', line: original[i], oldIndex: offset+i});
            i++;
        }
    }
    return ops;
}

function diffLines(original: string[], proposed: string[]): DiffOp[] {
    const {prefix, originalMiddle, proposedMiddle} = trimSharedEdges(original, proposed);
    const ops: DiffOp[] = [];
    for (let i=0; i<prefix; i++) {
        ops.push({kind: 'equal', line: original[i], oldIndex: i, newIndex: i});
    }
    ops.push(...diffMiddle(originalMiddle, proposedMiddle, prefix));
    const suffixOriginalStart = original.length - (original.length-prefix-originalMiddle.length);
    const suffixProposedStart = proposed.length - (proposed.length-prefix-proposedMiddle.length);
    for (let i=0; i<original.length-prefix-originalMiddle.length; i++) {
        ops.push({
            kind: 'equal',
            line: original[suffixOriginalStart+i],
            oldIndex: suffixOriginalStart+i,
            newIndex: suffixProposedStart+i,
        });
    }
    return ops;
}

export function createLineHunks(originalText: string, proposedText: string): AgentReviewHunk[] {
    if (originalText===proposedText) {
        return [];
    }

    const originalLines = splitLines(originalText);
    const proposedLines = splitLines(proposedText);
    const baselineHash = hashText(originalText);
    const ops = diffLines(originalLines, proposedLines);
    const hunks: AgentReviewHunk[] = [];
    let currentOriginal: string[] = [];
    let currentProposed: string[] = [];
    let startLine: number | undefined;
    let endLine = 0;
    let anchorLine = 0;

    const flush = () => {
        if (startLine===undefined) {
            return;
        }
        const id = `${startLine}:${endLine}:${hunks.length}`;
        hunks.push({
            id,
            startLine,
            endLine,
            beforeContext: originalLines.slice(Math.max(0, startLine-CONTEXT_LINES), startLine),
            originalLines: currentOriginal,
            proposedLines: currentProposed,
            afterContext: originalLines.slice(endLine, endLine+CONTEXT_LINES),
            baselineHash,
            status: 'pending',
        });
        currentOriginal = [];
        currentProposed = [];
        startLine = undefined;
    };

    for (const op of ops) {
        if (op.kind==='equal') {
            flush();
            anchorLine = (op.oldIndex ?? anchorLine) + 1;
            continue;
        }
        if (startLine===undefined) {
            startLine = op.oldIndex ?? anchorLine;
            endLine = startLine;
        }
        if (op.kind==='delete') {
            currentOriginal.push(op.line);
            endLine = (op.oldIndex ?? endLine) + 1;
            anchorLine = endLine;
        } else {
            currentProposed.push(op.line);
        }
    }
    flush();
    return hunks;
}

export function hunkSummary(hunk: AgentReviewHunk): string {
    const removed = hunk.originalLines.length;
    const added = hunk.proposedLines.length;
    return `-${removed} +${added}`;
}
