import * as vscode from 'vscode';

// Single shared output channel for extension diagnostics (Local Replica sync,
// compile lifecycle, …). Lazy-created so importing this module has no side
// effects until the first log line is emitted.
let sharedOutput: vscode.OutputChannel | undefined;

export function getOutputChannel() {
    if (!sharedOutput) {
        sharedOutput = vscode.window.createOutputChannel('Semantic Researcher Overleaf');
    }
    return sharedOutput;
}
