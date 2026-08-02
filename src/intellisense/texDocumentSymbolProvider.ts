import * as vscode from 'vscode';
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { IntellisenseProvider } from '.';
import { TeXElement, TeXElementType, genTexElements } from './texDocumentParseUtility';
import { ROOT_NAME } from '../consts';
import { getActiveReplicaOriginUri, localUriToPath, isSupportedReplicaDocument, toVirtualUri } from '../utils/localReplicaWorkspace';

type TexFileStruct = {
    texElements: TeXElement[],
    childrenPaths: string[],
    bibFilePaths: string[],
};

function normalizeProjectPath(path: string): string {
    const segments = path.split('/');
    const stack: string[] = [];
    for (const segment of segments) {
        if (segment==='' || segment==='.') {
            continue;
        }
        if (segment==='..') {
            stack.pop();
            continue;
        }
        stack.push(segment);
    }
    return stack.join('/');
}

function resolvePathFromFile(sourcePath: string, targetPath: string, ext?: string): string {
    const cleaned = targetPath.trim().replace(/^['\"]|['\"]$/g, '');
    if (cleaned==='') {
        return '';
    }

    const withExt = ext && !cleaned.endsWith(ext) ? `${cleaned}${ext}` : cleaned;
    if (withExt.startsWith('/')) {
        return normalizeProjectPath(withExt);
    }

    const parentPath = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
    return normalizeProjectPath(`${parentPath}/${withExt}`);
}

function elementsTypeCast(section: TeXElement): vscode.SymbolKind {
    switch (section.type) {
        case TeXElementType.Section:
        case TeXElementType.SectionAst:
            return vscode.SymbolKind.Struct;
        case TeXElementType.Environment:
            return vscode.SymbolKind.Package;
        case TeXElementType.Command:
            return vscode.SymbolKind.Number;
        case TeXElementType.SubFile:
            return vscode.SymbolKind.File;
        case TeXElementType.BibItem:
            return vscode.SymbolKind.Class;
        case TeXElementType.BibField:
            return vscode.SymbolKind.Constant;
        default:
            return vscode.SymbolKind.String;
    }
}

function elementsToSymbols(sections: TeXElement[]): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = [];
    sections.forEach(section => {
        const range = new vscode.Range(section.lineFr, 0, section.lineTo, 65535);
        const symbol = new vscode.DocumentSymbol(
            section.label || 'empty',
            '',
            elementsTypeCast(section),
            range, range);
        symbols.push(symbol);
        if (section.children.length > 0) {
            symbol.children = elementsToSymbols(section.children);
        }
    });
    return symbols;
}

function elementsToFoldingRanges(sections: TeXElement[]): vscode.FoldingRange[] {
    const foldingRanges: vscode.FoldingRange[] = [];
    sections.forEach(section => {
        foldingRanges.push(new vscode.FoldingRange(section.lineFr, section.lineTo - 1)); // without the last line, e.g \end{document}
        if (section.children.length > 0) {
            foldingRanges.push(...elementsToFoldingRanges(section.children));
        }
    });
    return foldingRanges;
}

// Reference: https://github.com/James-Yu/LaTeX-Workshop/commit/d1a078d9b63a34c9cda9ff5d1042c8999030e6e1
function getEnvironmentFoldingRange(document: vscode.TextDocument){
    const ranges: vscode.FoldingRange[] = [];
    const opStack: { keyword: string, index: number }[] = [];
    const text: string =  document.getText();
    const envRegex: RegExp = /(\\(begin){(.*?)})|(\\(end){(.*?)})/g; //to match one 'begin' OR 'end'

    let match = envRegex.exec(text); // init regex search
    while (match) {
        //for 'begin': match[2] contains 'begin', match[3] contains keyword
        //fro 'end':   match[5] contains 'end',   match[6] contains keyword
        const item = {
            keyword: match[2] ? match[3] : match[6],
            index: match.index
        };
        const lastItem = opStack[opStack.length - 1];

        if (match[5] && lastItem && lastItem.keyword === item.keyword) { // match 'end' with its 'begin'
            opStack.pop();
            ranges.push(new vscode.FoldingRange(
                document.positionAt(lastItem.index).line,
                document.positionAt(item.index).line - 1
            ));
        } else {
            opStack.push(item);
        }

        match = envRegex.exec(text); //iterate regex search
    }
    //TODO: if opStack still not empty
    return ranges;
}

/*
    * Convert the file into the struct by:
    * 1. Construct child, named as Uri.path, from TeXElementType.SubFile
    * 2. Construct bibFile from TeXElementType.BibFile
    * 
    * @param fileContent: file content 
*/
async function parseTexFileStruct(fileContent:string): Promise<TexFileStruct>{ 
    const childrenPaths = [];
    const bibFilePaths = [];
    const texSymbols = await genTexElements(fileContent);

    // BFS: Traverse the texElements and build fileSymbol
    const queue: TeXElement[] = [...texSymbols];
    while (queue.length > 0) {
        const symbol = queue.shift();
        switch (symbol?.type) {
            case TeXElementType.BibFile:
                bibFilePaths.push(symbol.label);
                break;
            case TeXElementType.SubFile:
                const subFilePath = symbol.label?.endsWith('.tex') ? symbol.label : `${symbol.label}.tex`;
                childrenPaths.push(subFilePath);
                break;
            default:
                break;
        }
        // append children to queue
        symbol?.children.forEach( child => {
            queue.push(child);
        });
    }

    return {
        texElements: texSymbols,
        childrenPaths: childrenPaths,
        bibFilePaths: bibFilePaths,
    };
}

class ProjectStructRecord {
    private fileRecordMap: Map<string, TexFileStruct> = new Map<string, TexFileStruct>();

    constructor (private readonly vfs: VirtualFileSystem) {}

    get rootPath(): string {
        return normalizeProjectPath(this.vfs.getRootDocName());
    }

    private documentPath(document: vscode.TextDocument): string {
        const relativePath = document.uri.scheme===ROOT_NAME
            ? parseUri(document.uri).pathParts.join('/')
            : '';
        return normalizeProjectPath(relativePath);
    }

    async init(seedDocument?: vscode.TextDocument) {
        let rootFileStruct: TexFileStruct;
        try {
            const seededRoot = seedDocument
                && this.documentPath(seedDocument)===this.rootPath
                ? this.fileRecordMap.get(this.rootPath)
                    ?? await this.refreshRecord(seedDocument)
                : undefined;
            rootFileStruct = seededRoot ?? await this.refreshRecord(this.rootPath);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(
                `TexDocumentSymbolProvider: project index unavailable for ${this.rootPath}: ${message}`,
            );
            return;
        }
        const fileQueue: TexFileStruct[] = [ rootFileStruct ];
        // `\input` cycles are legal LaTeX (two files including each other, or a
        // shared preamble pulled in twice). Without a visited set this walk
        // re-downloads the same files forever and never returns.
        const visitedPaths = new Set<string>([ this.rootPath ]);

        // iteratively traverse file node tree
        while (fileQueue.length > 0) {
            const fileNode = fileQueue.shift()!;
            const subFiles = fileNode.childrenPaths;
            for (const subFile of subFiles) {
                if (visitedPaths.has(subFile)) { continue; }
                visitedPaths.add(subFile);
                // Get fileStruct can be failed due to file not exist
                try {
                    const fileStruct = await this.refreshRecord(subFile);
                    fileQueue.push( fileStruct );
                } catch { continue; }
            };
        }
    }

    getTexFileStruct(document: vscode.TextDocument): TexFileStruct | undefined {
        if (document.uri.scheme!==ROOT_NAME) {
            return undefined;
        }
        const filePath = this.documentPath(document);
        return this.fileRecordMap.get(filePath);
    }

    async refreshRecord(source: vscode.TextDocument | string): Promise<TexFileStruct> {
        let filePath:string, content: string;
        // get file path and content
        if (typeof source === 'string') {
            filePath = normalizeProjectPath(source);
            const uri = this.vfs.pathToUri(filePath);
            content = new TextDecoder().decode( await this.vfs.openFile(uri) );
        } else {
            const relativePath = source.uri.scheme===ROOT_NAME
                ? parseUri(source.uri).pathParts.join('/')
                : (await localUriToPath(source.uri))?.slice(1) || '';
            filePath = normalizeProjectPath(relativePath);
            content = source.getText();
        }

        // Normalize references against the source document path so nested main files resolve correctly.
        const rawFileStruct = await parseTexFileStruct(content);
        const fileStruct: TexFileStruct = {
            texElements: rawFileStruct.texElements,
            childrenPaths: rawFileStruct.childrenPaths
                .map((childPath) => resolvePathFromFile(filePath, childPath, '.tex'))
                .filter((childPath) => childPath!==''),
            bibFilePaths: rawFileStruct.bibFilePaths
                .flatMap((name) => name.split(','))
                .map((name) => resolvePathFromFile(filePath, name, '.bib'))
                .filter((bibPath) => bibPath!==''),
        };

        // update file record
        this.fileRecordMap.set(filePath, fileStruct);
        return fileStruct;
    }

    getAllBibFilePaths(): string[] {
        const rootStruct = this.fileRecordMap.get( this.rootPath );
        if (rootStruct === undefined) { return []; }

        const queue = [rootStruct];
        const bibFilePaths = new Set<string>();
        // This runs synchronously from `\cite{` completion: an `\input` cycle
        // without a visited set is an infinite loop that freezes the extension
        // host, not just a slow completion.
        const visitedPaths = new Set<string>([ this.rootPath ]);
        // iteratively traverse file node tree
        while (queue.length > 0) {
            const item = queue.shift()!;
            item.bibFilePaths.forEach((path) => {
                bibFilePaths.add(path);
            });
            // append children to queue
            item.childrenPaths.forEach( child => {
                if (visitedPaths.has(child)) { return; }
                visitedPaths.add(child);
                const childItem = this.fileRecordMap.get(child);
                childItem && queue.push(childItem);
            });
        }
        return [...bibFilePaths];
    }
}

export class TexDocumentSymbolProvider extends IntellisenseProvider implements vscode.DocumentSymbolProvider, vscode.FoldingRangeProvider {
    protected readonly contextPrefix = [];

    private projectRecordMap = new Map<string, ProjectStructRecord>();

    async provideFoldingRanges(document: vscode.TextDocument, context: vscode.FoldingContext, token: vscode.CancellationToken): Promise<vscode.FoldingRange[]> {
        if (!isSupportedReplicaDocument(document.uri)) { return []; }
        const environmentRange = getEnvironmentFoldingRange(document);

        // Try get fileStruct
        const vfsUri = await toVirtualUri(document.uri);
        if (!vfsUri) { return environmentRange; }
        const {projectName} = parseUri(vfsUri);
        let projectRecord = this.projectRecordMap.get(projectName);
        let initializeProjectRecord = false;
        if (projectRecord===undefined) {
            const vfs = await this.vfsm.prefetch(vfsUri);
            projectRecord = new ProjectStructRecord(vfs);
            this.projectRecordMap.set(projectName, projectRecord);
            initializeProjectRecord = true;
        }
        const fileStruct = projectRecord.getTexFileStruct(document) ?? await projectRecord.refreshRecord(document);
        if (initializeProjectRecord) {
            void projectRecord.init(document);
        }

        return environmentRange.concat( fileStruct ? elementsToFoldingRanges(fileStruct.texElements) : [] );
    }

    async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
        if (!isSupportedReplicaDocument(document.uri)) { return []; }
        const vfsUri = await toVirtualUri(document.uri);
        if (!vfsUri) { return []; }
        const vfs = await this.vfsm.prefetch(vfsUri);
        const {projectName} = parseUri(vfsUri);

        // init project record if not exist
        let projectRecord = this.projectRecordMap.get(projectName);
        let initializeProjectRecord = false;
        if (projectRecord === undefined) {
            projectRecord = new ProjectStructRecord(vfs);
            this.projectRecordMap.set(projectName, projectRecord);
            initializeProjectRecord = true;
        }

        // return symbols
        const fileStruct = projectRecord.getTexFileStruct(document) ?? await projectRecord.refreshRecord(document);
        if (initializeProjectRecord) {
            void projectRecord.init(document);
        }
        return elementsToSymbols( fileStruct.texElements );
    }

    get currentBibPathArray(): string[] {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri || !isSupportedReplicaDocument(uri)) { return []; }
        const vfsUri = uri.scheme===ROOT_NAME ? uri : getActiveReplicaOriginUri();
        if (!vfsUri) { return []; }
        // get bib file paths
        const {projectName} = parseUri(vfsUri);
        const projectRecord = this.projectRecordMap.get(projectName);
        return projectRecord?.getAllBibFilePaths() ?? [];
    }

    get triggers(): vscode.Disposable[] {
        const latexSelector = ['latex', 'latex-expl3', 'pweave', 'jlweave', 'rsweave']
            .flatMap((id) => [{scheme: ROOT_NAME, language: id}, {scheme: 'file', language: id}]);
        return [
            // register symbol provider
            vscode.languages.registerDocumentSymbolProvider(latexSelector, this),
            // register folding range provider
            vscode.languages.registerFoldingRangeProvider(latexSelector, this),
            // register file change listener
            vscode.workspace.onDidChangeTextDocument(async (e) => {
                const vfsUri = await toVirtualUri(e.document.uri);
                if (!vfsUri) { return; }
                const {projectName} = parseUri(vfsUri);
                const projectRecord = this.projectRecordMap.get(projectName);
                // Fire-and-forget, but never unhandled: this runs on every
                // keystroke, so a rejected refresh would raise one unhandled
                // rejection per character typed.
                void projectRecord?.refreshRecord(e.document).catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(
                        `TexDocumentSymbolProvider: could not refresh ${e.document.uri.toString()}: ${message}`,
                    );
                });
            }),
        ];
    }
}
