import * as vscode from 'vscode';
import { BrowserLogin, BrowserLoginRequest, BrowserLoginResponse } from './browserLogin';

const remotePackLoginCommand = 'semantic-researcher-overleaf-remote-pack.login';

function assertBrowserLoginRequest(value:unknown): BrowserLoginRequest {
    if (typeof value!=='object' || value===null) {
        throw new Error('Remote Pack login request is missing.');
    }

    const request = value as Partial<BrowserLoginRequest>;
    if (typeof request.serverName!=='string' || request.serverName.length===0) {
        throw new Error('Remote Pack login request is missing serverName.');
    }
    if (typeof request.serverUrl!=='string' || request.serverUrl.length===0) {
        throw new Error('Remote Pack login request is missing serverUrl.');
    }

    // The command is callable by any locally installed extension, so the URL
    // the session cookies end up bound to must at least be a real web origin.
    let serverUrl:URL;
    try {
        serverUrl = new URL(request.serverUrl);
    } catch {
        throw new Error('Remote Pack login request has an invalid serverUrl.');
    }
    if (serverUrl.protocol!=='https:' && serverUrl.protocol!=='http:') {
        throw new Error('Remote Pack login request serverUrl must be an http(s) URL.');
    }

    return {
        serverName: request.serverName,
        serverUrl: request.serverUrl,
        timeoutSeconds: typeof request.timeoutSeconds==='number' ? request.timeoutSeconds : undefined,
        browserPath: typeof request.browserPath==='string' ? request.browserPath : undefined,
    };
}

// Any extension in this window can execute the login command and receive the
// full Overleaf session cookie header for a server URL it chooses. Nothing but
// the user can authorise that, so ask before a browser is even launched.
async function confirmBrowserLogin(request:BrowserLoginRequest) {
    const signIn = 'Sign In and Share Session';
    const choice = await vscode.window.showWarningMessage(
        `Sign in to Overleaf at ${request.serverUrl}?`,
        {
            modal: true,
            detail: `The extension that requested this login will receive the Overleaf session cookies for "${request.serverName}" (${request.serverUrl}). Only continue if you just started an Overleaf login for that server.`,
        },
        signIn,
    );
    return choice===signIn;
}

export function activate(context:vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(remotePackLoginCommand, async (value:unknown): Promise<BrowserLoginResponse> => {
            const request = assertBrowserLoginRequest(value);
            if (!await confirmBrowserLogin(request)) {
                throw new Error('Overleaf browser login was cancelled.');
            }
            return BrowserLogin.login(context, request);
        }),
    );
}

export function deactivate() {}
