import * as vscode from 'vscode';
import { AgentReviewFileProposal, AgentReviewHunk, AgentReviewProposal } from './types';

export interface PhantomKey {
    proposalId: string,
    filePath: string,
    hunkId: string,
}

export interface PhantomEntry {
    key: PhantomKey,
    originalRange: vscode.Range,
    phantomRange: vscode.Range,
    proposedText: string,
}

function keyString(key: PhantomKey) {
    return `${key.proposalId}::${key.filePath}::${key.hunkId}`;
}

function documentEol(document: vscode.TextDocument) {
    return document.eol===vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

export class AgentReviewPhantomTracker {
    private readonly byDocument = new Map<string, Map<string, PhantomEntry>>();

    entriesForDocument(document: vscode.TextDocument): PhantomEntry[] {
        const map = this.byDocument.get(document.uri.toString());
        return map ? [...map.values()] : [];
    }

    findEntry(document: vscode.TextDocument, key: PhantomKey): PhantomEntry | undefined {
        return this.byDocument.get(document.uri.toString())?.get(keyString(key));
    }

    hasEntry(document: vscode.TextDocument, key: PhantomKey): boolean {
        return this.findEntry(document, key)!==undefined;
    }

    clearDocument(document: vscode.TextDocument) {
        this.byDocument.delete(document.uri.toString());
    }

    // Locate the range that contains the hunk's originalLines in the current document.
    // Mirrors the logic used by the editor provider so phantom insertion picks the same range.
    findOriginalRange(document: vscode.TextDocument, hunk: AgentReviewHunk): vscode.Range | undefined {
        if (hunk.originalLines.length===0) {
            const insertionLine = this.findInsertionLine(document, hunk);
            if (insertionLine===undefined) {
                return undefined;
            }
            if (insertionLine>=document.lineCount) {
                const end = document.lineAt(document.lineCount-1).range.end;
                return new vscode.Range(end, end);
            }
            const position = new vscode.Position(insertionLine, 0);
            return new vscode.Range(position, position);
        }

        if (this.linesMatch(document, hunk.startLine, hunk.originalLines)) {
            return this.originalRangeAt(document, hunk, hunk.startLine);
        }

        const matches = this.findSequence(document, hunk.originalLines);
        const contextMatches = matches.filter(line => this.contextMatches(document, hunk, line));
        if (contextMatches.length===1) {
            return this.originalRangeAt(document, hunk, contextMatches[0]);
        }
        if (matches.length===1) {
            return this.originalRangeAt(document, hunk, matches[0]);
        }
        return undefined;
    }

    // Insert phantoms for all pending hunks in the given proposals that target `document`.
    // Returns the list of hunks that became `conflict` because the original range could not be located.
    async ensurePhantomsForDocument(
        document: vscode.TextDocument,
        proposals: Array<{proposal: AgentReviewProposal, file: AgentReviewFileProposal}>,
    ): Promise<{inserted: PhantomEntry[], conflicts: Array<{proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk}>}> {
        const inserted: PhantomEntry[] = [];
        const conflicts: Array<{proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk}> = [];

        // Collect pending work sorted bottom-to-top so inserts don't shift earlier ranges.
        type PendingHunk = {proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk, originalRange: vscode.Range};
        const pending: PendingHunk[] = [];
        for (const {proposal, file} of proposals) {
            for (const hunk of file.hunks) {
                if (hunk.status!=='pending') {
                    continue;
                }
                if (this.hasEntry(document, {proposalId: proposal.id, filePath: file.path, hunkId: hunk.id})) {
                    continue;
                }
                if (hunk.proposedLines.length===0) {
                    // Pure deletion: no phantom needed, but we still want to surface it.
                    continue;
                }
                const range = this.findOriginalRange(document, hunk);
                if (!range) {
                    conflicts.push({proposal, file, hunk});
                    continue;
                }
                pending.push({proposal, file, hunk, originalRange: range});
            }
        }
        pending.sort((a, b) => b.originalRange.start.line-a.originalRange.start.line);

        const eol = documentEol(document);
        const docKey = document.uri.toString();
        let docMap = this.byDocument.get(docKey);
        if (!docMap) {
            docMap = new Map<string, PhantomEntry>();
            this.byDocument.set(docKey, docMap);
        }

        for (const item of pending) {
            const proposedText = item.hunk.proposedLines.join(eol);
            const originalLineCount = item.hunk.originalLines.length;
            // Phantom goes BELOW the original lines. For pure insertion (no original),
            // the "insertion line" is the caller-supplied anchor (start of the empty range).
            const insertLineIndex = originalLineCount===0
                ? item.originalRange.start.line
                : item.originalRange.start.line + originalLineCount;
            const atEnd = insertLineIndex>=document.lineCount;
            const insertText = atEnd ? `${eol}${proposedText}` : `${proposedText}${eol}`;
            const insertPos = atEnd
                ? document.lineAt(Math.max(0, document.lineCount-1)).range.end
                : new vscode.Position(insertLineIndex, 0);

            const edit = new vscode.WorkspaceEdit();
            edit.insert(document.uri, insertPos, insertText);
            const applied = await vscode.workspace.applyEdit(edit);
            if (!applied) {
                continue;
            }

            // Phantom now occupies `proposedLines.length` lines starting at insertLineIndex
            // (or at document.lineCount when we had to append at end-of-doc).
            const phantomStartLine = atEnd ? insertPos.line+1 : insertLineIndex;
            const phantomLastLineIndex = Math.min(
                phantomStartLine + item.hunk.proposedLines.length - 1,
                Math.max(0, document.lineCount-1),
            );
            const lastLine = document.lineAt(phantomLastLineIndex);
            const phantomRange = new vscode.Range(
                new vscode.Position(phantomStartLine, 0),
                lastLine.range.end,
            );

            const entry: PhantomEntry = {
                key: {proposalId: item.proposal.id, filePath: item.file.path, hunkId: item.hunk.id},
                originalRange: item.originalRange,
                phantomRange,
                proposedText,
            };
            docMap.set(keyString(entry.key), entry);
            inserted.push(entry);
        }

        return {inserted, conflicts};
    }

    // Remove the phantom lines for a given hunk from the document (decline path).
    async removePhantom(document: vscode.TextDocument, key: PhantomKey): Promise<boolean> {
        const docMap = this.byDocument.get(document.uri.toString());
        const entry = docMap?.get(keyString(key));
        if (!docMap || !entry) {
            return false;
        }

        const range = this.expandRangeToEol(document, entry.phantomRange);
        const edit = new vscode.WorkspaceEdit();
        edit.delete(document.uri, range);
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) {
            docMap.delete(keyString(key));
            if (docMap.size===0) {
                this.byDocument.delete(document.uri.toString());
            }
        }
        return applied;
    }

    // Accept path: remove the original range, keep the phantom as permanent content.
    async removeOriginalKeepPhantom(document: vscode.TextDocument, key: PhantomKey): Promise<boolean> {
        const docMap = this.byDocument.get(document.uri.toString());
        const entry = docMap?.get(keyString(key));
        if (!docMap || !entry) {
            return false;
        }

        const range = this.expandRangeToEol(document, entry.originalRange);
        const edit = new vscode.WorkspaceEdit();
        edit.delete(document.uri, range);
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) {
            docMap.delete(keyString(key));
            if (docMap.size===0) {
                this.byDocument.delete(document.uri.toString());
            }
        }
        return applied;
    }

    // Remove every phantom from the document (used on close or on save to strip before save).
    async removeAllFromDocument(document: vscode.TextDocument): Promise<boolean> {
        const docMap = this.byDocument.get(document.uri.toString());
        if (!docMap || docMap.size===0) {
            return true;
        }
        const entries = [...docMap.values()].sort((a, b) => b.phantomRange.start.line-a.phantomRange.start.line);
        const edit = new vscode.WorkspaceEdit();
        for (const entry of entries) {
            const range = this.expandRangeToEol(document, entry.phantomRange);
            edit.delete(document.uri, range);
        }
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) {
            this.byDocument.delete(document.uri.toString());
        }
        return applied;
    }

    // Compute the TextEdits needed to strip all phantoms, for use inside
    // `onWillSaveTextDocument.waitUntil(...)` where an atomic edit is required.
    strippingEditsFor(document: vscode.TextDocument): vscode.TextEdit[] {
        const docMap = this.byDocument.get(document.uri.toString());
        if (!docMap || docMap.size===0) {
            return [];
        }
        const entries = [...docMap.values()].sort((a, b) => b.phantomRange.start.line-a.phantomRange.start.line);
        return entries.map(entry => vscode.TextEdit.delete(this.expandRangeToEol(document, entry.phantomRange)));
    }

    getPendingKeys(document: vscode.TextDocument): PhantomKey[] {
        const docMap = this.byDocument.get(document.uri.toString());
        if (!docMap) {
            return [];
        }
        return [...docMap.values()].map(entry => entry.key);
    }

    // Stored phantom ranges end at the end-of-content of the last covered line.
    // To DELETE those lines cleanly we must also swallow the trailing newline,
    // so we extend the end to the start of the following line (unless the last
    // line of the document itself is being deleted).
    private expandRangeToEol(document: vscode.TextDocument, range: vscode.Range): vscode.Range {
        if (document.lineCount===0) {
            return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
        }
        const lastContentLine = range.end.line;
        if (lastContentLine>=document.lineCount-1) {
            const lastLine = document.lineAt(document.lineCount-1);
            return new vscode.Range(range.start, lastLine.range.end);
        }
        return new vscode.Range(range.start, new vscode.Position(lastContentLine+1, 0));
    }

    private originalRangeAt(document: vscode.TextDocument, hunk: AgentReviewHunk, startLine: number): vscode.Range {
        if (hunk.originalLines.length===0) {
            const position = new vscode.Position(startLine, 0);
            return new vscode.Range(position, position);
        }
        // End at the *end of the last covered line* (not the next line's col 0).
        // `isWholeLine` decorations otherwise spill onto the following line.
        const lastLineIndex = Math.min(startLine+hunk.originalLines.length-1, Math.max(0, document.lineCount-1));
        const start = new vscode.Position(startLine, 0);
        const lastLine = document.lineAt(lastLineIndex);
        return new vscode.Range(start, lastLine.range.end);
    }

    private findInsertionLine(document: vscode.TextDocument, hunk: AgentReviewHunk): number | undefined {
        const afterContext = hunk.afterContext ?? [];
        const beforeContext = hunk.beforeContext ?? [];
        if (beforeContext.length>0) {
            const beforeMatches = this.findSequence(document, beforeContext);
            const insertionLines = beforeMatches.map(line => line+beforeContext.length);
            const contextMatches = insertionLines.filter(line =>
                afterContext.length===0 || this.linesMatch(document, line, afterContext),
            );
            if (contextMatches.length===1) {
                return contextMatches[0];
            }
        }
        if (afterContext.length>0) {
            const afterMatches = this.findSequence(document, afterContext);
            if (afterMatches.length===1) {
                return afterMatches[0];
            }
        }
        if (hunk.startLine<=document.lineCount) {
            return hunk.startLine;
        }
        return undefined;
    }

    private contextMatches(document: vscode.TextDocument, hunk: AgentReviewHunk, startLine: number): boolean {
        const beforeContext = hunk.beforeContext ?? [];
        const afterContext = hunk.afterContext ?? [];
        const beforeStart = startLine-beforeContext.length;
        const afterStart = startLine+hunk.originalLines.length;
        const beforeOk = beforeContext.length===0 || this.linesMatch(document, beforeStart, beforeContext);
        const afterOk = afterContext.length===0 || this.linesMatch(document, afterStart, afterContext);
        return beforeOk && afterOk;
    }

    private findSequence(document: vscode.TextDocument, lines: string[]): number[] {
        const matches: number[] = [];
        if (lines.length===0 || lines.length>document.lineCount) {
            return matches;
        }
        for (let line=0; line<=document.lineCount-lines.length; line++) {
            if (this.linesMatch(document, line, lines)) {
                matches.push(line);
            }
        }
        return matches;
    }

    private linesMatch(document: vscode.TextDocument, startLine: number, lines: string[]): boolean {
        if (startLine<0 || startLine+lines.length>document.lineCount) {
            return false;
        }
        for (let i=0; i<lines.length; i++) {
            if (document.lineAt(startLine+i).text!==lines[i]) {
                return false;
            }
        }
        return true;
    }
}
