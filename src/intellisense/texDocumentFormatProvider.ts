
import * as vscode from 'vscode';
import * as Prettier from "prettier";
import { prettierPluginLatex } from "@unified-latex/unified-latex-prettier";
import { IntellisenseProvider } from '.';
import { isSupportedReplicaDocument } from '../utils/localReplicaWorkspace';
import { CONFIG_SECTION, ROOT_NAME } from '../consts';

// https://github.com/siefkenj/latex-parser-playground/blob/master/src/async-worker/parsing-worker.ts#L35-L43
async function prettierFormat(text: string, options: vscode.FormattingOptions ) {

    const lineBreakEnabled = vscode.workspace.getConfiguration(`${CONFIG_SECTION}.formatWithLineBreak`).get<boolean>('enabled', true);
    const printWidth = lineBreakEnabled ? 80 : 10000;
    return Prettier.format(text, {
        parser: "latex-parser",
        tabWidth: options.tabSize,
        useTabs: !(options.insertSpaces),
        plugins: [prettierPluginLatex],
        printWidth: printWidth,
    });
}

export class TexDocumentFormatProvider extends IntellisenseProvider implements vscode.DocumentFormattingEditProvider {
    protected readonly contextPrefix = [];

    provideDocumentFormattingEdits(document: vscode.TextDocument, options: vscode.FormattingOptions, token: vscode.CancellationToken): vscode.ProviderResult<vscode.TextEdit[]> {
        if (!isSupportedReplicaDocument(document.uri)) { return []; }
        const text = document.getText();
        return prettierFormat(text, options).then(formattedText => {
            // Create a TextEdit to replace the entire document text with the formatted text
            const edit = new vscode.TextEdit(new vscode.Range(0, 0, document.lineCount, 0), formattedText);
            return [edit];
        });
    }

    provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range, options: vscode.FormattingOptions, token: vscode.CancellationToken): vscode.ProviderResult<vscode.TextEdit[]> {
        if (!isSupportedReplicaDocument(document.uri)) { return []; }
        const text = document.getText(range);
        return prettierFormat(text, options).then(formattedText => {
            // Create a TextEdit to replace the selected text with the formatted text
            const edit = new vscode.TextEdit(range, formattedText);
            return [edit];
        });
    }

    get triggers() {
        const latexSelector = ['latex', 'latex-expl3', 'pweave', 'jlweave', 'rsweave']
            .flatMap((id) => {
                return [{scheme: ROOT_NAME, language:id}, {scheme:'file', language:id}];
            });

        return[
            vscode.languages.registerDocumentFormattingEditProvider(latexSelector, this),
            vscode.languages.registerDocumentRangeFormattingEditProvider(latexSelector, this),
        ];
    }
}
