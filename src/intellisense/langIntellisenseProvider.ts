import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { RemoteFileSystemProvider } from '../core/remoteFileSystemProvider';
import { getActiveReplicaOriginUri, onDidChangeActiveReplicaRoot } from '../utils/localReplicaWorkspace';
import { EventBus } from '../utils/eventBus';

import { IntellisenseProvider } from '.';
import { TexDocumentSymbolProvider } from './texDocumentSymbolProvider';
import { TexDocumentFormatProvider } from './texDocumentFormatProvider';
import { MisspellingCheckProvider } from './langMisspellingCheckProvider';
import { CommandCompletionProvider, ConstantCompletionProvider, FilePathCompletionProvider, ReferenceCompletionProvider } from './langCompletionProvider';

export class LangIntellisenseProvider {
    private status: vscode.StatusBarItem;
    private providers: IntellisenseProvider[];

    constructor(context: vscode.ExtensionContext, private readonly vfsm: RemoteFileSystemProvider) {
        const texSymbolProvider = new TexDocumentSymbolProvider(vfsm);
        this.providers = [
            // document symbol provider
            texSymbolProvider,
            // document format provider
            new TexDocumentFormatProvider(vfsm),
            // completion provider
            new CommandCompletionProvider(vfsm, context.extensionUri),
            new ConstantCompletionProvider(vfsm, context.extensionUri),
            new FilePathCompletionProvider(vfsm),
            new ReferenceCompletionProvider(vfsm, texSymbolProvider),
            // misspelling check provider
            new MisspellingCheckProvider(vfsm),
        ];
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
        // Enable CSpell for Overleaf virtual documents only when CSpell is installed.
        if (vscode.extensions.getExtension('streetsidesoftware.code-spell-checker')) {
            const config = vscode.workspace.getConfiguration("cSpell");
            const inspected = config.inspect<Record<string, boolean>>("enabledSchemes");
            if (inspected!==undefined) {
                const enabledSchemes = config.get<Record<string, boolean>>("enabledSchemes") || {};
                if (enabledSchemes[ROOT_NAME]!==true) {
                    enabledSchemes[ROOT_NAME] = true;
                    void config.update("enabledSchemes", enabledSchemes, vscode.ConfigurationTarget.Global).then(undefined, error => {
                        console.warn('Could not enable CSpell for Overleaf virtual documents:', error);
                    });
                }
            }
        }
        
        void this.updateStatus();
    }

    async updateStatus() {
        const uri = getActiveReplicaOriginUri() ?? vscode.workspace.workspaceFolders?.[0].uri;
        if (uri?.scheme!==ROOT_NAME) {
            this.status.hide();
            return;
        }

        const vfs = uri && await this.vfsm.prefetch(uri);
        const languageItem = vfs?.getSpellCheckLanguage();
        if (languageItem) {
            const {name, code} = languageItem;
            this.status.text = code===''? '$(eye-closed)' : '$(eye) ' + code.toLocaleUpperCase();
            this.status.tooltip = new vscode.MarkdownString(`${vscode.l10n.t('Spell Check')}: **${name}**`);
            this.status.tooltip.appendMarkdown(`\n\n*${vscode.l10n.t('Click to manage spell check.')}*`);
        } else {
            this.status.text = '';
            this.status.tooltip = '';
        }
        this.status.command = `${ROOT_NAME}.langIntellisense.settings`;
        this.status.show();
    }

    get triggers() {
        return [
            // register provider triggers
            ...this.providers.map(x => x.triggers).flat(),
            this.status,
            onDidChangeActiveReplicaRoot(() => void this.updateStatus()),
            this.vfsm.onDidChangeActiveConnection(() => void this.updateStatus()),
            vscode.window.onDidChangeActiveTextEditor(() => void this.updateStatus()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => void this.updateStatus()),
            EventBus.on('spellCheckLanguageUpdateEvent', () => void this.updateStatus()),
        ];
    }
}
