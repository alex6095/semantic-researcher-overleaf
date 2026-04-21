import * as vscode from 'vscode';

const MARKER_START = '<!-- semantic-researcher-overleaf-agent-review:start -->';
const MARKER_END = '<!-- semantic-researcher-overleaf-agent-review:end -->';

export interface AgentReviewInstructionRegistration {
    workspaceRoot: vscode.Uri,
    helperPath: string,
    replicaRoots: string[],
}

function instructionBlock(registration: AgentReviewInstructionRegistration) {
    const roots = registration.replicaRoots
    .map(root => `- ${root}`)
    .join('\n');

    return `${MARKER_START}

# Semantic Researcher Overleaf Agent Review

This workspace has Overleaf Local Replica roots registered for review:

${roots}

When asked to modify supported LaTeX project files under one of these roots
(.tex, .ltx, .ctx, .bib, .sty, .cls, .bbx, .cbx), do not edit the source file
directly. Create a review draft instead:

1. Start a draft with:
   \`"${registration.helperPath}" begin --root "<LOCAL_REPLICA_ROOT>"\`
2. Edit only files under the printed \`DRAFT_ROOT\`.
3. Submit the draft with:
   \`"${registration.helperPath}" submit --draft "<DRAFT_ID>"\`
4. After submit succeeds, reply naturally with a brief summary of what changed,
   just as you would after an ordinary edit. Treat the draft workflow as
   internal plumbing: do not mention Agent Review, draft IDs, helper paths,
   DRAFT_ROOT, or submission mechanics unless the user explicitly asks for
   debugging details.

For files outside the registered Local Replica roots, work normally.

${MARKER_END}
`;
}

async function readTextIfReadable(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch (error) {
        try {
            await vscode.workspace.fs.stat(uri);
            console.warn(`Agent Review could not read existing instruction file ${uri.fsPath}; leaving it unchanged.`, error);
            return undefined;
        } catch {
            return '';
        }
    }
}

function stripManagedBlock(existing: string) {
    const start = existing.indexOf(MARKER_START);
    const end = existing.indexOf(MARKER_END);
    if (start<0 || end<start) {
        return existing;
    }

    const afterEnd = end + MARKER_END.length;
    let preserved = `${existing.slice(0, start)}${existing.slice(afterEnd)}`;
    if (preserved.startsWith('\r\n\r\n')) {
        preserved = preserved.slice(4);
    } else if (preserved.startsWith('\n\n')) {
        preserved = preserved.slice(2);
    } else if (preserved.startsWith('\r\n')) {
        preserved = preserved.slice(2);
    } else if (preserved.startsWith('\n')) {
        preserved = preserved.slice(1);
    }
    return preserved;
}

function prependManagedBlock(block: string, preserved: string) {
    if (preserved.length===0) {
        return block;
    }
    const separator = block.endsWith('\n') ? '\n' : '\n\n';
    return `${block}${separator}${preserved}`;
}

async function writeManagedBlock(uri: vscode.Uri, block: string) {
    const existing = await readTextIfReadable(uri);
    if (existing===undefined) {
        vscode.window.showWarningMessage(`Agent Review could not read ${uri.fsPath}; existing instructions were left unchanged.`);
        return;
    }

    const preserved = stripManagedBlock(existing);
    const next = prependManagedBlock(block, preserved);

    if (next!==existing) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(next));
    }
}

async function writeManagedBlockToExistingOrCreate(uri: vscode.Uri, block: string) {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type!==vscode.FileType.File) {
            console.warn(`Agent Review instruction target is not a regular file: ${uri.fsPath}`);
            return;
        }
    } catch {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(block));
        return;
    }
    await writeManagedBlock(uri, block);
}

async function removeManagedBlock(uri: vscode.Uri) {
    const existing = await readTextIfReadable(uri);
    if (existing===undefined) {
        vscode.window.showWarningMessage(`Agent Review could not read ${uri.fsPath}; existing instructions were left unchanged.`);
        return;
    }

    const next = stripManagedBlock(existing);
    if (next===existing) {
        return;
    }
    if (next.length===0) {
        try {
            await vscode.workspace.fs.delete(uri);
        } catch {
            // If another actor removed the file first, the desired state is already true.
        }
        return;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(next));
}

export class AgentReviewInstructionFiles {
    async ensureWorkspace(registration: AgentReviewInstructionRegistration) {
        const block = instructionBlock(registration);
        await writeManagedBlockToExistingOrCreate(vscode.Uri.joinPath(registration.workspaceRoot, 'AGENTS.md'), block);
        await writeManagedBlockToExistingOrCreate(vscode.Uri.joinPath(registration.workspaceRoot, 'CLAUDE.md'), block);
    }

    async removeWorkspace(workspaceRoot: vscode.Uri) {
        await removeManagedBlock(vscode.Uri.joinPath(workspaceRoot, 'AGENTS.md'));
        await removeManagedBlock(vscode.Uri.joinPath(workspaceRoot, 'CLAUDE.md'));
    }
}
