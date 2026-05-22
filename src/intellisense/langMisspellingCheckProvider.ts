import * as vscode from 'vscode';
import { IntellisenseProvider } from '.';
import { ROOT_NAME } from '../consts';
import { VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';
import { getActiveReplicaOriginUri, isSupportedReplicaDocument, toVirtualUri } from '../utils/localReplicaWorkspace';

function* sRange(start:number, end:number) {
    for (let i = start; i <= end; i++) {
        yield i;
    }
}

export class MisspellingCheckProvider extends IntellisenseProvider implements vscode.CodeActionProvider {
    private learnedWords?: Set<string>;
    private suggestionCache: Map<string, string[]> = new Map();
    private diagnosticCollection = vscode.languages.createDiagnosticCollection(`${ROOT_NAME}.spell`);
    private pendingDiagnostics = new Map<string, {uri: vscode.Uri, range?: vscode.Range, timer: NodeJS.Timeout}>();
    protected readonly contextPrefix = [];
    private readonly debounceMs = 500;
    private readonly spellCheckBatchSize = 200;
    private readonly spellCheckBatchDelayMs = 150;

    private splitText(text: string) {
        return text.split(/([\P{L}\p{N}]*\\[a-zA-Z]*|[\P{L}\p{N}]+)/gu);
    }

    private async check(uri:vscode.Uri, changedText: string) {
        const vfsUri = await toVirtualUri(uri);
        if (!vfsUri) { return; }
        // init learned words
        if (this.learnedWords===undefined) {
            const vfs = await this.vfsm.prefetch(vfsUri);
            const words = vfs.getDictionary();
            this.learnedWords = new Set(words);
        }

        // extract words
        const splits = this.splitText(changedText);
        const words = splits.filter((x, i) => i%2===0 && x.length>1)
                            .filter(x => !this.suggestionCache.has(x))
                            .filter(x => !this.learnedWords?.has(x));
        if (words.length === 0) { return; }
        const uniqueWordsArray = [...new Set(words)];

        // update suggestion cache and learned words
        const vfs = await this.vfsm.prefetch(vfsUri);
        for (let offset=0; offset<uniqueWordsArray.length; offset+=this.spellCheckBatchSize) {
            const batch = uniqueWordsArray.slice(offset, offset + this.spellCheckBatchSize);
            const acceptedWords = new Set(batch);
            const misspellings = await vfs.spellCheck(vfsUri, batch);
            if (misspellings) {
                misspellings.forEach(misspelling => {
                    acceptedWords.delete(batch[misspelling.index]);
                    this.suggestionCache.set(batch[misspelling.index], misspelling.suggestions);
                });
            }
            acceptedWords.forEach(x => this.learnedWords?.add(x));
            if (offset + this.spellCheckBatchSize < uniqueWordsArray.length) {
                await new Promise(resolve => setTimeout(resolve, this.spellCheckBatchDelayMs));
            }
        }

        // restrict cache size
        if (this.suggestionCache.size > 1000) {
            const keys = [...this.suggestionCache.keys()];
            keys.slice(0, 100).forEach(key => this.suggestionCache.delete(key));
        }
    }

    private async updateDiagnostics(uri:vscode.Uri, range?: vscode.Range) {
        // remove affected diagnostics
        let diagnostics = this.diagnosticCollection.get(uri) || [];
        if (range===undefined) {
            diagnostics = [];
        } else {
            diagnostics = diagnostics.filter(x => !x.range.intersection(range));
        }

        // update diagnostics
        const newDiagnostics:vscode.Diagnostic[] = [];
        const document = await vscode.workspace.openTextDocument(uri);
        const startLine = range ? range.start.line : 0;
        const endLine = range ? range.end.line : document.lineCount-1;
        for (const i of sRange(startLine, endLine)) {
            const cumsum = (sum => (value: number) => sum += value)(0);
            const splits = this.splitText( document.lineAt(i).text );
            const splitStart = splits.map(x => cumsum(x.length));
            const words = splits.filter((_, i) => i%2===0);
            const wordEnds = splitStart.filter((_, i) => i%2===0);
            //
            words.forEach((word, j) => {
                if (this.suggestionCache.has(word)) {
                    const range = new vscode.Range(
                        new vscode.Position(i, wordEnds[j] - word.length),
                        new vscode.Position(i, wordEnds[j])
                    );
                    const message = vscode.l10n.t('{word}: Unknown word.', {word});
                    const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Information);
                    diagnostic.source = vscode.l10n.t('Spell Checker');
                    diagnostic.code = word;
                    newDiagnostics.push(diagnostic);
                }
            });
        }
        // update diagnostics collection
        diagnostics = [...diagnostics, ...newDiagnostics];
        this.diagnosticCollection.set(uri, diagnostics);
    }

    private mergeRanges(a: vscode.Range | undefined, b: vscode.Range | undefined): vscode.Range | undefined {
        if (a===undefined || b===undefined) { return undefined; }
        const start = a.start.isBefore(b.start) ? a.start : b.start;
        const end = a.end.isAfter(b.end) ? a.end : b.end;
        return new vscode.Range(start, end);
    }

    private clearPendingDiagnostics() {
        this.pendingDiagnostics.forEach(({timer}) => clearTimeout(timer));
        this.pendingDiagnostics.clear();
    }

    private scheduleDiagnostics(uri: vscode.Uri, range?: vscode.Range) {
        const key = uri.toString();
        const previous = this.pendingDiagnostics.get(key);
        if (previous) {
            clearTimeout(previous.timer);
        }
        const nextRange = previous ? this.mergeRanges(previous.range, range) : range;
        const timer = setTimeout(async () => {
            this.pendingDiagnostics.delete(key);
            if (!isSupportedReplicaDocument(uri)) { return; }
            const document = await vscode.workspace.openTextDocument(uri);
            const validatedRange = nextRange && document.validateRange(nextRange);
            const changedText = validatedRange
                ? [...sRange(validatedRange.start.line, validatedRange.end.line)]
                    .map(i => document.lineAt(i).text).join(' ')
                : document.getText();
            await this.check(uri, changedText);
            await this.updateDiagnostics(uri, validatedRange);
        }, this.debounceMs);
        this.pendingDiagnostics.set(key, {uri, range: nextRange, timer});
    }

    private resetDiagnosticCollection() {
        this.clearPendingDiagnostics();
        this.diagnosticCollection.clear();
        vscode.workspace.textDocuments.forEach(async doc => {
            if (!isSupportedReplicaDocument(doc.uri)) { return; }
            const uri = doc.uri;
            this.scheduleDiagnostics(uri);
        });
    }

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeAction[]> {
        if (context.diagnostics.length === 0) {
            return [];
        }

        const diagnostic = context.diagnostics[0];
        const actions = this.suggestionCache.get(diagnostic.code as string)
                        ?.slice(0,8).map(suggestion => {
                            const action = new vscode.CodeAction(suggestion, vscode.CodeActionKind.QuickFix);
                            action.diagnostics = [diagnostic];
                            action.edit = new vscode.WorkspaceEdit();
                            action.edit.replace(document.uri, diagnostic.range, suggestion);
                            return action;
                        });
        //
        const learnAction = new vscode.CodeAction(vscode.l10n.t('Add to Dictionary'), vscode.CodeActionKind.QuickFix);
        learnAction.diagnostics = [diagnostic];
        learnAction.command = {
            title: vscode.l10n.t('Add to Dictionary'),
            command: `${ROOT_NAME}.langIntellisense.learnSpelling`,
            arguments: [document.uri, diagnostic.code as string],
        };
        actions?.push(learnAction);
        //
        return actions;
    }

    learnSpelling(uri:vscode.Uri, word: string) {
        toVirtualUri(uri).then(vfsUri => {
            vfsUri && this.vfsm.prefetch(vfsUri).then(vfs => vfs.spellLearn(word));
        });
        this.learnedWords?.add(word);
        this.suggestionCache.delete(word);
        this.updateDiagnostics(uri);
    }

    async dictionarySettings(vfs:VirtualFileSystem, dictionary?:string[]) {
        vscode.window.showQuickPick(dictionary||[], {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select a word to unlearn'),
        }).then(async (word) => {
            if (word) {
                vfs.spellUnlearn(word);
                this.learnedWords?.delete(word);
                this.suggestionCache.delete(word);
                dictionary = dictionary?.filter(x => x!==word);
                this.dictionarySettings(vfs, dictionary);
            } else {
                // reset diagnostic collection is dictionary changed
                if ( !vfs.getDictionary()?.every(x => dictionary?.includes(x)) ) {
                    this.resetDiagnosticCollection();
                }
            }
        });
    }

    async spellCheckSettings() {
        const uri = getActiveReplicaOriginUri() ?? vscode.workspace.workspaceFolders?.[0].uri;
        const vfs = uri && await this.vfsm.prefetch(uri);
        const languages = vfs?.getAllSpellCheckLanguages();
        const currentLanguage = vfs?.getSpellCheckLanguage();

        const items = [];
        items.push({
            id: "dictionary",
            label: vscode.l10n.t('Manage Dictionary'),
            iconPath: new vscode.ThemeIcon('book'),
        });
        items.push({label:'',kind:vscode.QuickPickItemKind.Separator});
        for (const item of languages||[]) {
            items.push({
                label: item.name,
                description: item.code,
                picked: item.code===currentLanguage?.code,
            });
        }

        vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t('Select spell check language'),
            canPickMany: false,
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        }).then(async (option) => {
            if (option?.id==='dictionary') {
                vfs && this.dictionarySettings(vfs, vfs.getDictionary());
            } else {
                option && vfs?.updateSettings({spellCheckLanguage:option.description});
            }
        });
    }

    get triggers () {
        return [
            // the diagnostic collection
            this.diagnosticCollection,
            // the code action provider
            vscode.languages.registerCodeActionsProvider([{scheme: ROOT_NAME}, {scheme: 'file'}], this),
            // register learn spelling command
            vscode.commands.registerCommand(`${ROOT_NAME}.langIntellisense.learnSpelling`, (uri: vscode.Uri, word: string) => {
                this.learnSpelling(uri, word);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.langIntellisense.settings`, () => {
                this.spellCheckSettings();
            }),
            // reset diagnostics when spell check languages changed
            EventBus.on('spellCheckLanguageUpdateEvent', async () => {
                this.learnedWords?.clear();
                this.suggestionCache.clear();
                this.resetDiagnosticCollection();
            }),
            // update diagnostics on document open
            vscode.workspace.onDidOpenTextDocument(async doc => {
                if (isSupportedReplicaDocument(doc.uri)) {
                    this.scheduleDiagnostics(doc.uri);
                }
            }),
            // update diagnostics on text changed
            vscode.workspace.onDidChangeTextDocument(async e => {
                if (isSupportedReplicaDocument(e.document.uri)) {
                    const uri = e.document.uri;
                    for (const event of e.contentChanges) {
                        // extract changed text
                        const startLine = Math.max(0, event.range.start.line-1);
                        const [endLine, maxLength] = (() => {
                            try {
                                const _line = event.range.end.line;
                                return [_line, e.document.lineAt(_line).text.length];
                            } catch {
                                return [event.range.end.line+1, 0];
                            }
                        })();
                        let _range = new vscode.Range(startLine, 0, endLine, maxLength);
                        _range = e.document.validateRange(_range);
                        this.scheduleDiagnostics(uri, _range);
                    };
                }
            }),
            new vscode.Disposable(() => this.clearPendingDiagnostics()),
        ];
    }
}
