import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { ROOT_NAME } from '../../consts';
import { PdfCacheStore } from '../../core/pdfCacheStore';
import { PdfViewEditorProvider } from '../../core/pdfViewEditorProvider';
import { ProjectManagerProvider } from '../../core/projectManagerProvider';

const SELECT_FOLDER_COMMAND = `${ROOT_NAME}.projectManager.selectProjectFolderLocalReplica`;
const ACTIVATE_PROJECT_COMMAND = `${ROOT_NAME}.remoteFileSystem.activateProject`;
const DEACTIVATE_PROJECT_COMMAND = `${ROOT_NAME}.remoteFileSystem.deactivateProject`;
const NEW_EXACT_REPLICA_COMMAND = `${ROOT_NAME}.projectSCM.newExactLocalReplicaSCM`;
const TEST_SELECT_FOLDER_COMMAND = `${SELECT_FOLDER_COMMAND}.registration-e2e`;

const validPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);

function createContextStub(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    return {
        // Compiled tests live in out/test/suite; the viewer assets remain at
        // the extension root, exactly as they do for an activated extension.
        extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')),
        globalStorageUri: vscode.Uri.file(__dirname),
        globalState: {
            get<T>(key: string, defaultValue?: T): T | undefined {
                return state.has(key) ? state.get(key) as T : defaultValue;
            },
            async update(key: string, value: unknown) {
                if (value===undefined) {
                    state.delete(key);
                } else {
                    state.set(key, value);
                }
            },
            keys: () => [...state.keys()],
            setKeysForSync: () => undefined,
        },
    } as unknown as vscode.ExtensionContext;
}

suite('Extension registration integration', () => {
    const registrations: vscode.Disposable[] = [];

    teardown(() => {
        while (registrations.length>0) {
            registrations.pop()!.dispose();
        }
    });

    test('executes the registered Select Folder command and rolls back an exact-folder cancellation', async () => {
        const projectUri = vscode.Uri.parse(
            `${ROOT_NAME}://test-server/Registered%20Select?user=test-user&project=test-project`,
        );
        const activatedVfs = {origin: projectUri};
        const calls: string[] = [];

        // The production command is already registered by extension activation.
        // Run the exact same registration factory under an isolated test id so
        // its downstream command boundary can be deterministic without replacing
        // live extension commands in the shared extension host.
        const executeCommand = async (command: string, ...args: unknown[]) => {
            if (command===ACTIVATE_PROJECT_COMMAND) {
                const [receivedUri, options] = args as [vscode.Uri, unknown];
                calls.push('activate');
                assert.strictEqual(receivedUri.toString(), projectUri.toString());
                assert.deepStrictEqual(options, {restorePersistedSCMs: false});
                return activatedVfs;
            }
            if (command===NEW_EXACT_REPLICA_COMMAND) {
                calls.push('picker-cancelled');
                return undefined;
            }
            if (command===DEACTIVATE_PROJECT_COMMAND) {
                const [receivedUri] = args as [vscode.Uri];
                calls.push('deactivate');
                assert.strictEqual(receivedUri.toString(), projectUri.toString());
                return undefined;
            }
            throw new Error(`Unexpected command: ${command}`);
        };

        const provider = new ProjectManagerProvider(
            createContextStub(),
            {getActiveVFS: () => undefined} as any,
            executeCommand as any,
        );
        // The command test owns registration and the rollback boundary. The
        // workspace-conflict policy has its own filesystem integration suite.
        (provider as any).prepareForLocalReplicaSelection = async () => true;
        (provider as any).hasConflictingLocalReplicaWorkspace = async () => false;
        registrations.push(
            provider.registerSelectProjectFolderLocalReplicaCommand(TEST_SELECT_FOLDER_COMMAND),
        );

        const registered = await vscode.commands.getCommands(true);
        assert.ok(registered.includes(SELECT_FOLDER_COMMAND), 'Select Folder must be registered in the VS Code host');
        assert.ok(registered.includes(TEST_SELECT_FOLDER_COMMAND));

        await vscode.commands.executeCommand(TEST_SELECT_FOLDER_COMMAND, {
            uri: projectUri.toString(),
            label: 'Registered Select',
        });

        assert.deepStrictEqual(calls, ['activate', 'picker-cancelled', 'deactivate']);
    });

    test('routes missing-output recovery through the registered custom-editor webview protocol and persists only after render ACK', async () => {
        const uri = vscode.Uri.parse(
            `${ROOT_NAME}://test-server/Registered%20PDF/.output/output.pdf?user=test-user&project=test-project`,
        );
        let outputAvailable = false;
        let recoveryCalls = 0;
        let cached: Uint8Array | undefined;
        const cache: PdfCacheStore = {
            read: async () => undefined,
            write: async (_uri, content) => { cached = new Uint8Array(content); },
        };
        const provider = new PdfViewEditorProvider(createContextStub(), {
            persistentCache: cache,
            readLive: async () => {
                if (!outputAvailable) {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
                return validPdf;
            },
            recoverMissingOutput: async receivedUri => {
                assert.strictEqual(receivedUri.toString(), uri.toString());
                recoveryCalls += 1;
                outputAvailable = true;
            },
        });

        let registeredProvider: vscode.CustomEditorProvider | undefined;
        const originalRegister = vscode.window.registerCustomEditorProvider;
        (vscode.window as any).registerCustomEditorProvider = (
            viewType: string,
            captured: vscode.CustomEditorProvider,
            options: Parameters<typeof vscode.window.registerCustomEditorProvider>[2],
        ) => {
            assert.strictEqual(viewType, `${ROOT_NAME}.pdfViewer`);
            assert.strictEqual(options?.supportsMultipleEditorsPerDocument, false);
            registeredProvider = captured;
            return new vscode.Disposable(() => {});
        };
        try {
            registrations.push(...provider.triggers);
        } finally {
            (vscode.window as any).registerCustomEditorProvider = originalRegister;
        }
        assert.strictEqual(registeredProvider, provider, 'the registered editor must be the recovery-capable provider');

        const document = await provider.openCustomDocument(uri);
        assert.strictEqual(recoveryCalls, 1, 'a restored output.pdf without a VFS entity must demand-compile once');
        assert.strictEqual(document.lastError, undefined);
        assert.strictEqual(cached, undefined, 'unrendered bytes are not cacheable');

        const posted: any[] = [];
        let receiveMessage: ((message: any) => void) | undefined;
        const fakePanel = {
            webview: {
                options: undefined,
                html: '',
                postMessage: async (message: any) => {
                    posted.push(message);
                    return true;
                },
                onDidReceiveMessage: (listener: (message: any) => void) => {
                    receiveMessage = listener;
                    return new vscode.Disposable(() => { receiveMessage = undefined; });
                },
                asWebviewUri: (resource: vscode.Uri) => resource,
            },
            onDidDispose: () => new vscode.Disposable(() => {}),
            onDidChangeViewState: () => new vscode.Disposable(() => {}),
        } as unknown as vscode.WebviewPanel;

        await provider.resolveCustomEditor(document, fakePanel);
        assert.ok(receiveMessage, 'the custom editor must accept messages from its webview');
        receiveMessage!({type: 'ready'});
        await new Promise(resolve => setImmediate(resolve));

        const update = posted.find(message => message.type==='update');
        assert.ok(update, 'the ready webview must receive recovered PDF bytes');
        assert.strictEqual(update.cached, false);
        assert.strictEqual(cached, undefined, 'the PDF is not persisted before pdf.js confirms rendering');

        receiveMessage!({type: 'pdfLoadSuccess', content: update.version});
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(Buffer.from(cached!), validPdf);
    });
});
