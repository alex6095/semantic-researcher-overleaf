import * as vscode from 'vscode';
import { AgentReviewFileProposal, AgentReviewHunk, AgentReviewProposal } from './types';

function documentEol(document: vscode.TextDocument) {
    return document.eol===vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

export class AgentReviewChangeLocator {
    // Locate the range that contains the hunk's original lines in the current document.
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

    findConflictsForDocument(
        document: vscode.TextDocument,
        proposals: Array<{proposal: AgentReviewProposal, file: AgentReviewFileProposal}>,
    ): Array<{proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk}> {
        const conflicts: Array<{proposal: AgentReviewProposal, file: AgentReviewFileProposal, hunk: AgentReviewHunk}> = [];
        for (const {proposal, file} of proposals) {
            for (const hunk of file.hunks) {
                if (hunk.status==='pending' && !this.findOriginalRange(document, hunk)) {
                    conflicts.push({proposal, file, hunk});
                }
            }
        }
        return conflicts;
    }

    createAcceptEdit(document: vscode.TextDocument, hunk: AgentReviewHunk, range: vscode.Range): vscode.TextEdit {
        const editRange = hunk.originalLines.length===0 ? range : this.expandRangeToEol(document, range);
        return vscode.TextEdit.replace(editRange, this.acceptText(document, hunk, editRange));
    }

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

    private acceptText(document: vscode.TextDocument, hunk: AgentReviewHunk, editRange: vscode.Range): string {
        if (hunk.proposedLines.length===0) {
            return '';
        }
        const eol = documentEol(document);
        const body = hunk.proposedLines.join(eol);
        if (hunk.originalLines.length===0) {
            return editRange.start.character>0 ? `${eol}${body}` : `${body}${eol}`;
        }
        return editRange.end.character===0 && editRange.end.line<document.lineCount ? `${body}${eol}` : body;
    }

    private originalRangeAt(document: vscode.TextDocument, hunk: AgentReviewHunk, startLine: number): vscode.Range {
        if (hunk.originalLines.length===0) {
            const position = new vscode.Position(startLine, 0);
            return new vscode.Range(position, position);
        }
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
