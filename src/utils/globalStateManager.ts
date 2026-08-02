import * as vscode from 'vscode';
import { Identity, BaseAPI, ProjectPersist } from '../api/base';
import { SocketIOAPI } from '../api/socketio';
import { ExtendedBaseAPI } from '../api/extendedBase';
import {
    STATE_PDF_VIEWERS_KEY,
    STATE_PROJECT_SCMS_PREFIX,
    STATE_SERVERS_KEY,
} from '../consts';

const keyServerPersists: string = STATE_SERVERS_KEY;
const keyPdfViewPersists: string = STATE_PDF_VIEWERS_KEY;

export interface ServerPersist {
    name: string;
    url: string;
    login?: {
        userId: string;
        username: string;
        identity: Identity;
        projects?: ProjectPersist[]
    };
}
type ServerPersistMap = {[name: string]: ServerPersist};

export interface ProjectSCMPersist {
    enabled: boolean;
    label: string;
    baseUri: string;
    settings: JSON;
}
type ProjectSCMPersistMap = {[name: string]: ProjectSCMPersist};

type PdfViewPersist = {
    frequency: number,
    state: any,
};
type PdfViewPersistMap = {[uri: string]: PdfViewPersist};

export class StaleAuthenticatedSessionError extends Error {
    constructor(serverName: string) {
        super(`No matching authenticated account is available for '${serverName}'.`);
        this.name = 'StaleAuthenticatedSessionError';
    }
}

export class ServerSessionExpiredError extends Error {
    constructor(serverName: string) {
        super(`The authenticated session for '${serverName}' has expired.`);
        this.name = 'ServerSessionExpiredError';
    }
}

const loginAttempts = new WeakMap<vscode.ExtensionContext, Map<string, symbol>>();

function beginLoginAttempt(context: vscode.ExtensionContext, serverName: string): symbol {
    let attempts = loginAttempts.get(context);
    if (!attempts) {
        attempts = new Map();
        loginAttempts.set(context, attempts);
    }
    const attempt = Symbol(serverName);
    attempts.set(serverName, attempt);
    return attempt;
}

function isCurrentLoginAttempt(
    context: vscode.ExtensionContext,
    serverName: string,
    attempt: symbol,
): boolean {
    return loginAttempts.get(context)?.get(serverName)===attempt;
}

function finishLoginAttempt(
    context: vscode.ExtensionContext,
    serverName: string,
    attempt: symbol,
) {
    const attempts = loginAttempts.get(context);
    if (attempts?.get(serverName)===attempt) {
        attempts.delete(serverName);
    }
}

function projectSCMStateKey(serverName: string, userId: string, projectId: string): string {
    return [
        STATE_PROJECT_SCMS_PREFIX,
        encodeURIComponent(serverName),
        encodeURIComponent(userId),
        encodeURIComponent(projectId),
    ].join('.');
}

function getLegacyProjectSCMPersists(
    context: vscode.ExtensionContext,
    serverName: string,
    userId: string,
    projectId: string,
): ProjectSCMPersistMap {
    const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
    const server = persists[serverName];
    if (server?.login?.userId!==userId) {
        return {};
    }
    const project = server?.login?.projects?.find(project => project.id===projectId);
    return project?.scm ? project.scm as ProjectSCMPersistMap : {};
}

export class GlobalStateManager {

    static getServers(context:vscode.ExtensionContext): {server:ServerPersist, api:BaseAPI}[] {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const servers = Object.values(persists).map(persist => {
            return {
                server: persist,
                api: new BaseAPI(persist.url),
            };
        });

        if (servers.length===0) {
            const url = new URL('https://www.overleaf.com');
            this.addServer(context, url.host, url.href);
            return this.getServers(context);
        } else {
            return servers;
        }
    }

    static addServer(context:vscode.ExtensionContext, name:string, url:string): boolean {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        if ( persists[name]===undefined ) {
            loginAttempts.get(context)?.delete(name);
            context.globalState.update(keyServerPersists, {
                ...persists,
                [name]: { name, url },
            });
            return true;
        } else {
            return false;
        }
    }

    static removeServer(context:vscode.ExtensionContext, name:string): boolean {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        if ( persists[name]!==undefined ) {
            loginAttempts.get(context)?.delete(name);
            const nextPersists = {...persists};
            delete nextPersists[name];
            context.globalState.update(keyServerPersists, nextPersists);
            return true;
        } else {
            return false;
        }
    }

    static async loginServer(context:vscode.ExtensionContext, api:BaseAPI, name:string, auth:{[key:string]:string}): Promise<boolean> {
        const attempt = beginLoginAttempt(context, name);
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server = persists[name];

        if (!server || server.login!==undefined) {
            finishLoginAttempt(context, name, attempt);
            return false;
        }
        const expectedUrl = server.url;
        try {
            const res = auth.cookies ? await api.cookiesLogin(auth.cookies) : await api.passportLogin(auth.email, auth.password);
            if (!isCurrentLoginAttempt(context, name, attempt)) {
                return false;
            }
            const currentPersists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
            const currentServer = currentPersists[name];
            if (
                !currentServer
                || currentServer.login!==undefined
                || currentServer.url!==expectedUrl
            ) {
                return false;
            }
            if (res.type==='success' && res.identity!==undefined && res.userInfo!==undefined) {
                const nextPersists = {
                    ...currentPersists,
                    [name]: {
                        ...currentServer,
                        login: {
                            userId: res.userInfo.userId,
                            username: auth.email || res.userInfo.userEmail,
                            identity: res.identity,
                        },
                    },
                };
                await context.globalState.update(keyServerPersists, nextPersists);
                return true;
            }
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return false;
        } finally {
            finishLoginAttempt(context, name, attempt);
        }
    }

    static async logoutServer(
        context:vscode.ExtensionContext,
        api:BaseAPI,
        name:string,
        expectedUserId?:string,
        expectedIdentity?:Identity,
    ): Promise<boolean> {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const login = persists[name]?.login;

        if (
            !login
            || (expectedUserId!==undefined && login.userId!==expectedUserId)
            || (
                expectedIdentity!==undefined
                && (
                    login.identity.csrfToken!==expectedIdentity.csrfToken
                    || login.identity.cookies!==expectedIdentity.cookies
                )
            )
        ) {
            return false;
        }
        const capturedUserId = login.userId;
        const capturedIdentity = login.identity;
        await api.logout(capturedIdentity);
        try {
            this.requireAuthenticatedIdentity(
                context,
                name,
                capturedUserId,
                capturedIdentity,
            );
        } catch {
            return false;
        }
        const currentPersists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const currentServer = currentPersists[name];
        if (!currentServer?.login) {
            return false;
        }
        const {login: _removedLogin, ...loggedOutServer} = currentServer;
        await context.globalState.update(keyServerPersists, {
            ...currentPersists,
            [name]: loggedOutServer,
        });
        return true;
    }

    static async fetchServerProjects(context:vscode.ExtensionContext, api:BaseAPI, name:string): Promise<ProjectPersist[]> {
        let session: {userId: string, identity: Identity};
        try {
            session = this.requireAuthenticatedSession(context, name);
        } catch {
            return [];
        }
        let res = await api.getProjectsJson(session.identity);
        this.requireAuthenticatedIdentity(context, name, session.userId, session.identity);
        if (res.type!=='success') {
            // fallback to `userProjectsJson`
            res = await api.userProjectsJson(session.identity);
            this.requireAuthenticatedIdentity(context, name, session.userId, session.identity);
        }
        if (res.type==='success' && res.projects!==undefined) {
            const currentPersists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
            const currentServer = currentPersists[name];
            const currentLogin = currentServer?.login;
            this.requireAuthenticatedIdentity(context, name, session.userId, session.identity);
            if (!currentServer || !currentLogin) {
                throw new StaleAuthenticatedSessionError(name);
            }
            const projects = res.projects.map(project => {
                const existProject = currentLogin.projects?.find(p => p.id===project.id);
                return {
                    ...project,
                    userId: session.userId,
                    ...(existProject?.scm ? {scm: existProject.scm} : {}),
                };
            });
            await context.globalState.update(keyServerPersists, {
                ...currentPersists,
                [name]: {
                    ...currentServer,
                    login: {
                        ...currentLogin,
                        projects,
                    },
                },
            });
            return projects;
        }
        const cookieExpireRegex = /^302/;
        // The HTTP layer now flags a login redirect / rotated CSRF token
        // centrally; the legacy prefix match stays as a fallback for responses
        // that never reach that detection.
        if (res.sessionExpired || (res.message && cookieExpireRegex.test(res.message))) {
            vscode.window.showErrorMessage(vscode.l10n.t('Cookie Expired. Please Re-Login'));
            throw new ServerSessionExpiredError(name);
        }
        if (res.message!==undefined) {
            vscode.window.showErrorMessage(res.message);
        }
        return [];
    }

    static requireAuthenticatedSession(
        context:vscode.ExtensionContext,
        name:string,
    ): {userId: string, identity: Identity} {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const login = persists[name]?.login;
        if (!login) {
            throw new StaleAuthenticatedSessionError(name);
        }
        return {
            userId: login.userId,
            identity: login.identity,
        };
    }

    static requireAuthenticatedIdentity(
        context:vscode.ExtensionContext,
        name:string,
        userId?:string,
        expectedIdentity?:Identity,
    ): Identity {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const login = persists[name]?.login;
        const sessionChanged = expectedIdentity!==undefined && (
            login?.identity.csrfToken!==expectedIdentity.csrfToken
            || login?.identity.cookies!==expectedIdentity.cookies
        );
        if (
            !login
            || (userId!==undefined && login.userId!==userId)
            || sessionChanged
        ) {
            throw new StaleAuthenticatedSessionError(name);
        }
        return login.identity;
    }

    static authenticate(
        context:vscode.ExtensionContext,
        name:string,
        userId?:string,
        expectedIdentity?:Identity,
    ) {
        try {
            return Promise.resolve(this.requireAuthenticatedIdentity(
                context,
                name,
                userId,
                expectedIdentity,
            ));
        } catch (error) {
            return Promise.reject(error);
        }
    }

    static initSocketIOAPI(
        context:vscode.ExtensionContext,
        name:string,
        projectId:string,
        userId?:string,
    ) {
        const persists = context.globalState.get<ServerPersistMap>(keyServerPersists, {});
        const server   = persists[name];
        const login = server?.login;

        if (login && (userId===undefined || login.userId===userId)) {
            const api = new ExtendedBaseAPI(server.url);
            const socket = new SocketIOAPI(server.url, api, login.identity, projectId);
            return {api, socket, identity: login.identity};
        }
    }

    static getServerProjectSCMPersists(
        context:vscode.ExtensionContext,
        serverName:string,
        userId:string,
        projectId:string,
    ) {
        const stateKey = projectSCMStateKey(serverName, userId, projectId);
        const dedicatedPersists = context.globalState.get<ProjectSCMPersistMap | undefined>(stateKey);
        if (dedicatedPersists!==undefined) {
            return dedicatedPersists;
        }

        const legacyPersists = getLegacyProjectSCMPersists(context, serverName, userId, projectId);
        if (Object.keys(legacyPersists).length>0) {
            void context.globalState.update(stateKey, {...legacyPersists});
        }
        return legacyPersists;
    }

    static updateServerProjectSCMPersist(
        context:vscode.ExtensionContext,
        serverName:string,
        userId:string,
        projectId:string,
        scmKey:string,
        scmPersist?:ProjectSCMPersist,
    ) {
        const stateKey = projectSCMStateKey(serverName, userId, projectId);
        const dedicatedPersists = context.globalState.get<ProjectSCMPersistMap | undefined>(stateKey);
        const scmPersists = {
            ...(dedicatedPersists ?? getLegacyProjectSCMPersists(context, serverName, userId, projectId)),
        };
        if (scmPersist===undefined) {
            delete scmPersists[scmKey];
        } else {
            scmPersists[scmKey] = scmPersist;
        }
        // Keep an empty map as a tombstone so removed legacy entries are not migrated again.
        return context.globalState.update(stateKey, scmPersists);
    }

    static getPdfViewPersist(context:vscode.ExtensionContext, uri:string): any {
        return context.globalState.get<PdfViewPersistMap>(keyPdfViewPersists, {})[uri]?.state;
    }

    static updatePdfViewPersist(context:vscode.ExtensionContext, uri:string, state:any) {
        const persists = context.globalState.get<PdfViewPersistMap>(keyPdfViewPersists, {});

        // update record
        if (persists[uri]!==undefined) {
            persists[uri].frequency++;
            persists[uri].state = state;
        } else {
            persists[uri] = {frequency: 1, state};
        }

        // when length>=100, remove first least used record
        if (Object.keys(persists).length>=100) {
            let minFrequency = Number.MAX_SAFE_INTEGER;
            let minUri = '';
            Object.entries(persists).forEach(([uri, persist]) => {
                if (persist.frequency<minFrequency) {
                    minFrequency = persist.frequency;
                    minUri = uri;
                }
            });
            delete persists[minUri];
        }

        context.globalState.update(keyPdfViewPersists, persists);
    }

}
