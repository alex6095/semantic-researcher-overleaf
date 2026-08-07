import { createHash, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { parseUri, vfsProjectKey } from './remoteFileSystemProvider';

const CACHE_DIRECTORY = 'pdf-cache-v1';
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 16;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

export interface PdfCacheStore {
    read(uri: vscode.Uri): Promise<Uint8Array | undefined>;
    write(uri: vscode.Uri, content: Uint8Array): Promise<void>;
}

export interface PdfCacheFileSystem {
    stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
    readFile(uri: vscode.Uri): Thenable<Uint8Array>;
    writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]>;
    createDirectory(uri: vscode.Uri): Thenable<void>;
    rename(source: vscode.Uri, target: vscode.Uri, options?: {overwrite?: boolean}): Thenable<void>;
    delete(uri: vscode.Uri): Thenable<void>;
}

export function pdfCacheKey(uri: vscode.Uri): string {
    const logicalPath = parseUri(uri).pathParts.join('/');
    return createHash('sha256')
        .update(`${vfsProjectKey(uri)}\0${logicalPath}`)
        .digest('hex');
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof vscode.FileSystemError
        && (error.code==='FileNotFound' || error.code==='EntryNotFound');
}

export class PersistentPdfCache implements PdfCacheStore {
    private readonly root: vscode.Uri;
    private readonly writeTails = new Map<string, Promise<void>>();

    constructor(
        globalStorageUri: vscode.Uri,
        private readonly fileSystem: PdfCacheFileSystem = vscode.workspace.fs,
    ) {
        this.root = vscode.Uri.joinPath(globalStorageUri, CACHE_DIRECTORY);
    }

    private cacheUri(uri: vscode.Uri): vscode.Uri {
        return vscode.Uri.joinPath(this.root, `${pdfCacheKey(uri)}.pdf`);
    }

    async read(uri: vscode.Uri): Promise<Uint8Array | undefined> {
        const target = this.cacheUri(uri);
        try {
            const stat = await this.fileSystem.stat(target);
            if (Date.now() - stat.mtime > MAX_CACHE_AGE_MS) {
                await this.fileSystem.delete(target);
                return undefined;
            }
            const content = await this.fileSystem.readFile(target);
            return content.byteLength===0 ? undefined : content;
        } catch (error) {
            if (isMissingFileError(error)) { return undefined; }
            throw error;
        }
    }

    async write(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        if (content.byteLength===0) { return; }
        const key = pdfCacheKey(uri);
        const previous = this.writeTails.get(key) ?? Promise.resolve();
        const operation = previous
            .catch(() => undefined)
            .then(() => this.writeNow(uri, content));
        this.writeTails.set(key, operation);
        try {
            await operation;
        } finally {
            if (this.writeTails.get(key)===operation) {
                this.writeTails.delete(key);
            }
        }
    }

    private async writeNow(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        await this.fileSystem.createDirectory(this.root);
        const target = this.cacheUri(uri);
        const temporary = target.with({path: `${target.path}.${randomUUID()}.tmp`});
        try {
            await this.fileSystem.writeFile(temporary, content);
            await this.fileSystem.rename(temporary, target, {overwrite: true});
        } finally {
            try {
                await this.fileSystem.delete(temporary);
            } catch {
                // rename normally consumed the temporary path; cleanup is only
                // for an interrupted or failed replacement.
            }
        }
        await this.prune();
    }

    private async prune(): Promise<void> {
        let entries: [string, vscode.FileType][];
        try {
            entries = await this.fileSystem.readDirectory(this.root);
        } catch (error) {
            if (isMissingFileError(error)) { return; }
            throw error;
        }
        const candidates = (await Promise.all(entries
            .filter(([name, type]) => type===vscode.FileType.File && name.endsWith('.pdf'))
            .map(async ([name]) => {
                const uri = vscode.Uri.joinPath(this.root, name);
                try {
                    return {uri, stat: await this.fileSystem.stat(uri)};
                } catch {
                    return undefined;
                }
            })))
            .filter((entry): entry is {uri: vscode.Uri, stat: vscode.FileStat} => entry!==undefined)
            .sort((left, right) => right.stat.mtime - left.stat.mtime);

        let retainedEntries = 0;
        let retainedBytes = 0;
        const now = Date.now();
        for (const candidate of candidates) {
            const expired = now - candidate.stat.mtime > MAX_CACHE_AGE_MS;
            const exceedsCount = retainedEntries >= MAX_CACHE_ENTRIES;
            const exceedsBytes = retainedBytes + candidate.stat.size > MAX_CACHE_BYTES;
            if (expired || exceedsCount || exceedsBytes) {
                try {
                    await this.fileSystem.delete(candidate.uri);
                } catch {
                    // Cache eviction is best effort and must not fail a compile.
                }
                continue;
            }
            retainedEntries += 1;
            retainedBytes += candidate.stat.size;
        }
    }
}
