import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';

type BrowserLoginResult = {
    cookies: string;
};

type BrowserCandidate = {
    label: string;
    executablePath: string;
};

type BrowserCookie = {
    name: string;
    value: string;
};

type BrowserPage = {
    goto: (url:string, options?:{waitUntil:'domcontentloaded'}) => Promise<unknown>;
    bringToFront: () => Promise<unknown>;
    isClosed: () => boolean;
    url: () => string;
    locator: (selector:string) => { count: () => Promise<number> };
};

type BrowserContext = {
    pages: () => BrowserPage[];
    newPage: () => Promise<BrowserPage>;
    cookies: (url?:string) => Promise<BrowserCookie[]>;
    close: () => Promise<unknown>;
};

const chromium = (require('playwright-core') as {
    chromium: {
        launchPersistentContext: (userDataDir:string, options:{
            executablePath: string;
            headless: boolean;
            acceptDownloads: boolean;
            args: string[];
        }) => Promise<BrowserContext>;
    };
}).chromium;

export class BrowserLogin {
    static async login(context:vscode.ExtensionContext, serverName:string, serverUrl:string, token?:vscode.CancellationToken): Promise<BrowserLoginResult> {
        this.ensureGraphicalEnvironment();

        const profileUri = vscode.Uri.joinPath(context.globalStorageUri, 'browser-login', encodeURIComponent(serverName));
        await vscode.workspace.fs.createDirectory(profileUri);

        const timeoutSeconds = vscode.workspace.getConfiguration(ROOT_NAME).get<number>('auth.browserLogin.timeoutSeconds', 600);
        const timeoutMs = timeoutSeconds * 1000;
        const candidates = this.getBrowserCandidates();

        if (candidates.length===0) {
            throw new Error(vscode.l10n.t('Could not find Chrome, Edge, or Chromium. Set semantic-researcher-overleaf.auth.browserPath and try again.'));
        }

        let browserContext: BrowserContext | undefined;
        let lastError: unknown;

        for (const candidate of candidates) {
            try {
                browserContext = await chromium.launchPersistentContext(profileUri.fsPath, {
                    executablePath: candidate.executablePath,
                    headless: false,
                    acceptDownloads: false,
                    args: [
                        '--no-first-run',
                        '--no-default-browser-check',
                        '--disable-blink-features=AutomationControlled',
                    ],
                });
                break;
            } catch (error) {
                lastError = error;
            }
        }

        if (browserContext===undefined) {
            throw new Error(vscode.l10n.t('Could not open a browser for login: {message}', { message: this.errorMessage(lastError) }));
        }

        try {
            const page = browserContext.pages()[0] ?? await browserContext.newPage();
            await this.openProjectPage(page, serverUrl);
            const cookies = await this.waitForProjectCookies(browserContext, page, serverUrl, timeoutMs, token);
            return { cookies };
        } finally {
            await browserContext.close().catch(() => undefined);
        }
    }

    private static async openProjectPage(page:BrowserPage, serverUrl:string) {
        const projectUrl = new URL('project', serverUrl).href;
        await page.goto(projectUrl, { waitUntil: 'domcontentloaded' });
        await page.bringToFront().catch(() => undefined);
    }

    private static async waitForProjectCookies(browserContext:BrowserContext, page:BrowserPage, serverUrl:string, timeoutMs:number, token?:vscode.CancellationToken) {
        const deadline = Date.now() + timeoutMs;
        const projectUrl = new URL('project', serverUrl);

        while (Date.now()<deadline) {
            if (token?.isCancellationRequested) {
                throw new Error(vscode.l10n.t('Browser login cancelled.'));
            }

            if (page.isClosed()) {
                throw new Error(vscode.l10n.t('Browser was closed before login completed.'));
            }

            try {
                const currentUrl = new URL(page.url());
                if (currentUrl.origin===projectUrl.origin && currentUrl.pathname.startsWith(projectUrl.pathname)) {
                    const hasUserMeta = await page.locator('meta[name="ol-user_id"]').count();
                    const hasCsrfMeta = await page.locator('meta[name="ol-csrfToken"]').count();
                    if (hasUserMeta>0 && hasCsrfMeta>0) {
                        const cookies = await browserContext.cookies(projectUrl.href);
                        const cookieHeader = this.toCookieHeader(cookies);
                        if (cookieHeader.length>0) {
                            return cookieHeader;
                        }
                    }
                }
            } catch {
                // OAuth/SSO redirects can leave the page between navigations. Keep polling.
            }

            await this.sleep(1000);
        }

        throw new Error(vscode.l10n.t('Timed out waiting for Overleaf browser login.'));
    }

    private static toCookieHeader(cookies:BrowserCookie[]) {
        return cookies
            .filter(cookie => cookie.name.length>0 && cookie.value.length>0)
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
    }

    private static ensureGraphicalEnvironment() {
        if (process.platform==='linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
            throw new Error(vscode.l10n.t('Browser login requires a graphical browser. This environment looks headless; use Login with Cookies or run the extension where a desktop browser is available.'));
        }
    }

    private static getBrowserCandidates(): BrowserCandidate[] {
        const configuredPath = vscode.workspace.getConfiguration(ROOT_NAME).get('auth.browserPath', '').trim();
        const candidates: BrowserCandidate[] = [];
        const seen = new Set<string>();

        const addCandidate = (label:string, executablePath?:string) => {
            if (!executablePath || seen.has(executablePath)) {
                return;
            }
            seen.add(executablePath);
            candidates.push({ label, executablePath });
        };

        if (configuredPath.length>0) {
            addCandidate(vscode.l10n.t('Configured browser'), this.resolveExecutable(configuredPath));
        }

        for (const candidate of this.platformBrowserPaths()) {
            if (fs.existsSync(candidate.executablePath)) {
                addCandidate(candidate.label, candidate.executablePath);
            }
        }

        for (const command of this.browserCommands()) {
            addCandidate(command, this.resolveExecutable(command));
        }

        return candidates;
    }

    private static platformBrowserPaths(): BrowserCandidate[] {
        switch (process.platform) {
            case 'darwin':
                return [
                    { label: 'Google Chrome', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
                    { label: 'Microsoft Edge', executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
                    { label: 'Chromium', executablePath: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
                ];
            case 'win32':
                return [
                    { label: 'Google Chrome', executablePath: path.join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe') },
                    { label: 'Google Chrome', executablePath: path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google/Chrome/Application/chrome.exe') },
                    { label: 'Microsoft Edge', executablePath: path.join(process.env.PROGRAMFILES ?? '', 'Microsoft/Edge/Application/msedge.exe') },
                    { label: 'Microsoft Edge', executablePath: path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe') },
                    { label: 'Google Chrome', executablePath: path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe') },
                ];
            default:
                return [
                    { label: 'Google Chrome', executablePath: '/usr/bin/google-chrome' },
                    { label: 'Google Chrome', executablePath: '/usr/bin/google-chrome-stable' },
                    { label: 'Chromium', executablePath: '/usr/bin/chromium' },
                    { label: 'Chromium', executablePath: '/usr/bin/chromium-browser' },
                    { label: 'Microsoft Edge', executablePath: '/usr/bin/microsoft-edge' },
                    { label: 'Microsoft Edge', executablePath: '/usr/bin/microsoft-edge-stable' },
                ];
        }
    }

    private static browserCommands() {
        switch (process.platform) {
            case 'win32':
                return ['chrome.exe', 'msedge.exe', 'chromium.exe'];
            case 'darwin':
                return [];
            default:
                return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];
        }
    }

    private static resolveExecutable(executable:string) {
        if (path.isAbsolute(executable) && fs.existsSync(executable)) {
            return executable;
        }

        if (fs.existsSync(executable)) {
            return path.resolve(executable);
        }

        const lookupCommand = process.platform==='win32' ? 'where' : 'which';
        const lookup = spawnSync(lookupCommand, [executable], { encoding: 'utf8' });
        if (lookup.status===0) {
            const firstMatch = lookup.stdout.split(/\r?\n/).find(line => line.trim().length>0);
            return firstMatch?.trim();
        }

        return undefined;
    }

    private static sleep(ms:number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private static errorMessage(error:unknown) {
        return error instanceof Error ? error.message : String(error);
    }
}
