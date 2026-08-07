import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ROOT_NAME } from '../../consts';
import {
    PdfDocument,
    PdfViewEditorProvider,
} from '../../core/pdfViewEditorProvider';
import {
    PdfCacheFileSystem,
    PdfCacheStore,
    PersistentPdfCache,
    pdfCacheKey,
} from '../../core/pdfCacheStore';

suite('PDF reload cache', () => {
    const tempRoots: string[] = [];

    teardown(async () => {
        await Promise.all(tempRoots.splice(0).map(root =>
            fs.rm(root, {recursive: true, force: true})
        ));
    });

    const pdfUri = (
        projectName: string,
        projectId = 'project-1',
        server = 'www.overleaf.com',
        user = 'user-1',
        outputPath = 'output.pdf',
    ) => vscode.Uri.parse(
        `${ROOT_NAME}://${server}/${encodeURIComponent(projectName)}/.output/${outputPath}`+
        `?user=${user}&project=${projectId}`,
    );

    test('restores the last known-good PDF when a new host has no output entity yet', async () => {
        const uri = pdfUri('Reload Cache');
        let cached: Uint8Array | undefined;
        const store: PdfCacheStore = {
            read: async () => cached,
            write: async (_uri, content) => {
                cached = new Uint8Array(content);
            },
        };
        const livePdf = Buffer.from('%PDF-1.7\nlast successful build');
        const firstSession = new PdfDocument(uri, store, async () => livePdf);

        assert.deepStrictEqual(await firstSession.refresh(), {ok: true, source: 'live'});
        assert.strictEqual(cached, undefined, 'unrendered bytes are not last known-good');
        await firstSession.confirmRendered(firstSession.version);
        assert.deepStrictEqual(Buffer.from(cached!), livePdf);

        const restoredSession = new PdfDocument(uri, store, async () => {
            throw vscode.FileSystemError.FileNotFound(uri);
        });
        const restored = await restoredSession.refresh({allowCachedFallback: true});

        assert.strictEqual(restored.ok, true);
        assert.strictEqual(restored.ok && restored.source, 'cache');
        assert.deepStrictEqual(Buffer.from(restoredSession.cache), livePdf);
        assert.strictEqual(restoredSession.lastError, undefined);
        assert.match(restoredSession.lastLiveError ?? '', /FileNotFound|EntryNotFound/);
        assert.strictEqual(restoredSession.usingCachedCopy, true);
    });

    test('does not hide authentication or network failures behind a cached build', async () => {
        const uri = pdfUri('No Broad Fallback');
        let cacheReads = 0;
        const store: PdfCacheStore = {
            read: async () => {
                cacheReads += 1;
                return Buffer.from('%PDF-1.7\nstale build');
            },
            write: async () => undefined,
        };
        const document = new PdfDocument(uri, store, async () => {
            throw new Error('HTTP 403: authentication expired');
        });

        const result = await document.refresh({allowCachedFallback: true});

        assert.strictEqual(result.ok, false);
        assert.strictEqual(cacheReads, 0);
        assert.match(document.lastError ?? '', /403/);
    });

    test('rebuilds on demand when a restored viewer has neither live output nor cache', async () => {
        const uri = pdfUri('First Upgrade Reload');
        let outputAvailable = false;
        let recoveryCalls = 0;
        const store: PdfCacheStore = {
            read: async () => undefined,
            write: async () => undefined,
        };
        const provider = new PdfViewEditorProvider({} as vscode.ExtensionContext, {
            persistentCache: store,
            readLive: async () => {
                if (!outputAvailable) { throw vscode.FileSystemError.FileNotFound(uri); }
                return Buffer.from('%PDF-1.7\nfresh rebuild');
            },
            recoverMissingOutput: async () => {
                recoveryCalls += 1;
                outputAvailable = true;
            },
        });

        const document = await provider.openCustomDocument(uri);

        assert.strictEqual(recoveryCalls, 1);
        assert.strictEqual(document.lastError, undefined);
        assert.strictEqual(document.usingCachedCopy, false);
        assert.strictEqual(Buffer.from(document.cache).toString(), '%PDF-1.7\nfresh rebuild');
    });

    test('single-flights simultaneous missing-output recovery for one project', async () => {
        const uri = pdfUri('Single Flight');
        let outputAvailable = false;
        let recoveryCalls = 0;
        let releaseRecovery!: () => void;
        const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve; });
        const store: PdfCacheStore = {
            read: async () => undefined,
            write: async () => undefined,
        };
        const provider = new PdfViewEditorProvider({} as vscode.ExtensionContext, {
            persistentCache: store,
            readLive: async () => {
                if (!outputAvailable) { throw vscode.FileSystemError.FileNotFound(uri); }
                return Buffer.from('%PDF-1.7\nshared rebuild');
            },
            recoverMissingOutput: async () => {
                recoveryCalls += 1;
                await recoveryGate;
                outputAvailable = true;
            },
        });

        const first = provider.openCustomDocument(uri);
        const second = provider.openCustomDocument(uri);
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(recoveryCalls, 1);
        releaseRecovery();

        const [firstDocument, secondDocument] = await Promise.all([first, second]);
        assert.strictEqual(firstDocument.lastError, undefined);
        assert.strictEqual(secondDocument.lastError, undefined);
    });

    test('does not cache a live PDF until the matching renderer acknowledges it', async () => {
        const uri = pdfUri('Renderer Ack');
        const writes: string[] = [];
        const store: PdfCacheStore = {
            read: async () => undefined,
            write: async (_uri, content) => {
                writes.push(Buffer.from(content).toString());
            },
        };
        let content = Buffer.from('%PDF-1.7\nfirst');
        const document = new PdfDocument(uri, store, async () => content);

        await document.refresh();
        const staleVersion = document.version;
        content = Buffer.from('%PDF-1.7\nsecond');
        await document.refresh();
        await document.confirmRendered(staleVersion);
        assert.deepStrictEqual(writes, [], 'an old render acknowledgement cannot cache stale bytes');

        await document.confirmRendered(document.version);
        assert.deepStrictEqual(writes, ['%PDF-1.7\nsecond']);
    });

    test('rejects invalid live bytes without overwriting the known-good cache', async () => {
        const uri = pdfUri('Invalid PDF');
        let writes = 0;
        const store: PdfCacheStore = {
            read: async () => Buffer.from('%PDF-1.7\nknown-good'),
            write: async () => { writes += 1; },
        };
        const document = new PdfDocument(uri, store, async () => Buffer.from('not a pdf'));

        const result = await document.refresh({allowCachedFallback: true});

        assert.strictEqual(result.ok, false);
        assert.strictEqual(writes, 0);
        assert.strictEqual(document.usingCachedCopy, false);
        assert.match(document.lastError ?? '', /not a valid PDF/);
    });

    test('never lets a cached build satisfy the strict post-compile refresh', async () => {
        const uri = pdfUri('Strict Compile');
        let cacheReads = 0;
        const store: PdfCacheStore = {
            read: async () => {
                cacheReads += 1;
                return Buffer.from('%PDF-1.7\nstale build');
            },
            write: async () => undefined,
        };
        const document = new PdfDocument(uri, store, async () => {
            throw vscode.FileSystemError.FileNotFound(uri);
        });

        const result = await document.refresh();

        assert.strictEqual(result.ok, false);
        assert.strictEqual(cacheReads, 0, 'compile refresh must not inspect the stale cache');
        assert.notStrictEqual(document.lastError, undefined);
    });

    test('persists PDF bytes atomically across cache-store instances', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-overleaf-pdf-cache-'));
        tempRoots.push(root);
        const uri = pdfUri('Persistent Cache');
        const firstStore = new PersistentPdfCache(vscode.Uri.file(root));
        assert.strictEqual(await firstStore.read(uri), undefined);
        await firstStore.write(uri, Buffer.from('%PDF-1.7\nfirst'));

        const secondStore = new PersistentPdfCache(vscode.Uri.file(root));
        assert.strictEqual(
            Buffer.from((await secondStore.read(uri))!).toString(),
            '%PDF-1.7\nfirst',
        );

        await secondStore.write(uri, Buffer.from('%PDF-1.7\nreplacement'));
        assert.strictEqual(
            Buffer.from((await firstStore.read(uri))!).toString(),
            '%PDF-1.7\nreplacement',
        );
        const cacheFiles = await fs.readdir(path.join(root, 'pdf-cache-v1'));
        assert.deepStrictEqual(cacheFiles.filter(file => file.endsWith('.tmp')), []);
        assert.strictEqual(cacheFiles.filter(file => file.endsWith('.pdf')).length, 1);
    });

    test('serializes concurrent replacements so the newest requested bytes win', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-overleaf-pdf-cache-'));
        tempRoots.push(root);
        const uri = pdfUri('Concurrent Cache');
        const realFileSystem = vscode.workspace.fs;
        const originalWriteFile = vscode.workspace.fs.writeFile;
        let releaseFirstWrite!: () => void;
        let markFirstWriteStarted!: () => void;
        const firstWriteGate = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
        const firstWriteStarted = new Promise<void>(resolve => { markFirstWriteStarted = resolve; });
        const delayedFileSystem: PdfCacheFileSystem = {
            stat: uri => realFileSystem.stat(uri),
            readFile: uri => realFileSystem.readFile(uri),
            writeFile: async (target, content) => {
                if (Buffer.from(content).toString()==='%PDF-1.7\nolder') {
                    markFirstWriteStarted();
                    await firstWriteGate;
                }
                await originalWriteFile.call(realFileSystem, target, content);
            },
            readDirectory: uri => realFileSystem.readDirectory(uri),
            createDirectory: uri => realFileSystem.createDirectory(uri),
            rename: (source, target, options) => realFileSystem.rename(source, target, options),
            delete: uri => realFileSystem.delete(uri),
        };
        const store = new PersistentPdfCache(vscode.Uri.file(root), delayedFileSystem);

        const older = store.write(uri, Buffer.from('%PDF-1.7\nolder'));
        await firstWriteStarted;
        const newer = store.write(uri, Buffer.from('%PDF-1.7\nnewer'));
        releaseFirstWrite();
        await Promise.all([older, newer]);

        assert.strictEqual(
            Buffer.from((await store.read(uri))!).toString(),
            '%PDF-1.7\nnewer',
        );
    });

    test('expires cached PDFs after the retention window', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-overleaf-pdf-cache-'));
        tempRoots.push(root);
        const uri = pdfUri('Expired Cache');
        const store = new PersistentPdfCache(vscode.Uri.file(root));
        await store.write(uri, Buffer.from('%PDF-1.7\nold'));
        const target = path.join(root, 'pdf-cache-v1', `${pdfCacheKey(uri)}.pdf`);
        const expired = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
        await fs.utimes(target, expired, expired);

        assert.strictEqual(await store.read(uri), undefined);
        await assert.rejects(() => fs.stat(target), (error: NodeJS.ErrnoException) => {
            return error.code==='ENOENT';
        });
    });

    test('bounds the persistent cache entry count', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-overleaf-pdf-cache-'));
        tempRoots.push(root);
        const store = new PersistentPdfCache(vscode.Uri.file(root));
        for (let index = 0; index < 20; index += 1) {
            await store.write(
                pdfUri(`Bounded Cache ${index}`, `project-${index}`),
                Buffer.from(`%PDF-1.7\n${index}`),
            );
        }

        const cacheFiles = await fs.readdir(path.join(root, 'pdf-cache-v1'));
        assert.strictEqual(cacheFiles.filter(file => file.endsWith('.pdf')).length, 16);
    });

    test('keys the cache by server, user, project id and logical output path', () => {
        const beforeRename = pdfUri('Old Name', 'project-1');
        const afterRename = pdfUri('New Name', 'project-1');
        const otherProject = pdfUri('Old Name', 'project-2');
        const otherServer = pdfUri('Old Name', 'project-1', 'overleaf.example.test');
        const otherUser = pdfUri('Old Name', 'project-1', 'www.overleaf.com', 'user-2');
        const otherPath = pdfUri(
            'Old Name', 'project-1', 'www.overleaf.com', 'user-1', 'other.pdf',
        );

        assert.strictEqual(pdfCacheKey(beforeRename), pdfCacheKey(afterRename));
        assert.notStrictEqual(pdfCacheKey(beforeRename), pdfCacheKey(otherProject));
        assert.notStrictEqual(pdfCacheKey(beforeRename), pdfCacheKey(otherServer));
        assert.notStrictEqual(pdfCacheKey(beforeRename), pdfCacheKey(otherUser));
        assert.notStrictEqual(pdfCacheKey(beforeRename), pdfCacheKey(otherPath));
    });
});
