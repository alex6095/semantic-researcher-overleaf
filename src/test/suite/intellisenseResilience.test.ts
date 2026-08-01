import * as assert from 'assert';
import * as vscode from 'vscode';
import { ROOT_NAME } from '../../consts';
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
});
