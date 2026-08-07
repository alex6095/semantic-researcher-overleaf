import * as assert from 'assert';
import * as vscode from 'vscode';
import { ROOT_NAME } from '../../consts';
import { vfsProjectKey } from '../../core/remoteFileSystemProvider';
import { TexDocumentSymbolProvider } from '../../intellisense/texDocumentSymbolProvider';

suite('Intellisense resilience', () => {
    test('returns current document symbols when the remote root index is unavailable', async () => {
        const documentUri = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project/sections/current.tex`+
            '?user=user-1&project=project-1',
        );
        const rootUri = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Project/missing-root.tex`+
            '?user=user-1&project=project-1',
        );
        let remoteReads = 0;
        const vfs = {
            getRootDocName: () => 'missing-root.tex',
            pathToUri: () => rootUri,
            openFile: async () => {
                remoteReads += 1;
                throw new Error('Overleaf download failed (404)');
            },
        };
        const vfsm = {
            prefetch: async () => vfs,
        };
        const document = {
            uri: documentUri,
            getText: () => '\\section{Local replica content}',
        } as vscode.TextDocument;
        const provider = new TexDocumentSymbolProvider(vfsm as any);

        const symbols = await provider.provideDocumentSymbols(document);
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.strictEqual(symbols.length, 1);
        assert.strictEqual(symbols[0].name, 'Local replica content');
        assert.strictEqual(remoteReads, 1);
    });

    test('isolates symbol records for same-name projects by stable VFS identity', async () => {
        const firstUri = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Same%20Name/main.tex`+
            '?user=user-1&project=project-1',
        );
        const secondUri = vscode.Uri.parse(
            `${ROOT_NAME}://www.overleaf.com/Same%20Name/main.tex`+
            '?user=user-1&project=project-2',
        );
        const vfsByProject = new Map([
            ['project-1', {
                getRootDocName: () => 'main.tex',
                pathToUri: () => firstUri,
                openFile: async () => Buffer.from('\\section{First remote root}'),
            }],
            ['project-2', {
                getRootDocName: () => 'main.tex',
                pathToUri: () => secondUri,
                openFile: async () => Buffer.from('\\section{Second remote root}'),
            }],
        ]);
        const provider = new TexDocumentSymbolProvider({
            prefetch: async (uri: vscode.Uri) => vfsByProject.get(
                new URLSearchParams(uri.query).get('project') ?? '',
            ),
        } as any);
        const firstDocument = {
            uri: firstUri,
            getText: () => '\\section{First local document}',
        } as vscode.TextDocument;
        const secondDocument = {
            uri: secondUri,
            getText: () => '\\section{Second local document}',
        } as vscode.TextDocument;

        await provider.provideDocumentSymbols(firstDocument);
        await provider.provideDocumentSymbols(secondDocument);

        const records = (provider as any).projectRecordMap as Map<string, unknown>;
        assert.strictEqual(records.size, 2);
        assert.ok(records.has(vfsProjectKey(firstUri)));
        assert.ok(records.has(vfsProjectKey(secondUri)));
        assert.notStrictEqual(vfsProjectKey(firstUri), vfsProjectKey(secondUri));
    });
});
