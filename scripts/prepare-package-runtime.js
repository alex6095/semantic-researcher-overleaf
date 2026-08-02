const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const repositoryRoot = path.resolve(__dirname, '..');
const isRemotePack = process.argv.includes('--remote-pack');
const projectRoot = isRemotePack
    ? path.join(repositoryRoot, 'remote-pack')
    : repositoryRoot;
const outputRoot = path.join(projectRoot, 'dist');

const playwrightSourceRoot = path.join(projectRoot, 'node_modules', 'playwright-core');
const playwrightTargetRoot = path.join(outputRoot, 'runtime', 'playwright-core');
const playwrightExcludedPaths = [
    'lib/server/trace/test',
    'lib/vite',
    'index.d.ts',
    'types',
];

const nodeRuntimeTargetRoot = path.join(outputRoot, 'node_modules');
const nodeRuntimeRoots = [
    'prettier',
    '@unified-latex/unified-latex-prettier',
    '@unified-latex/unified-latex-util-parse',
    'socket.io-client',
];

// Vendor trees are produced by `postinstall` (download-vendor.js) and are not
// checked in. `vscode:prepublish` does not re-run them, so `npm ci
// --ignore-scripts` or a restored node_modules cache would otherwise package a
// vsix with a broken PDF preview and language configurations that point at
// files which do not exist.
const vendorAssetRoots = [
    path.join(repositoryRoot, 'views', 'pdf-viewer', 'vendor'),
    path.join(repositoryRoot, 'data', 'vendor'),
];
const vendorAssetFiles = [
    // Read by pdfViewEditorProvider and rewritten into the webview html.
    path.join(repositoryRoot, 'views', 'pdf-viewer', 'vendor', 'web', 'viewer.html'),
    path.join(repositoryRoot, 'views', 'pdf-viewer', 'vendor', 'web', 'viewer.css'),
    path.join(repositoryRoot, 'views', 'pdf-viewer', 'vendor', 'web', 'viewer.js'),
    path.join(repositoryRoot, 'views', 'pdf-viewer', 'vendor', 'build', 'pdf.js'),
    path.join(repositoryRoot, 'views', 'pdf-viewer', 'vendor', 'build', 'pdf.worker.js'),
];

// Every hunk of patches/socket.io-client+0.9.17-overleaf-5.patch that matters
// for authentication. Without the xhr.js hunks a WebSocket-blocking proxy
// silently falls back to xhr-polling with no Cookie header.
const socketRuntimeMarkers = [
    {
        file: ['lib', 'socket.js'],
        markers: [
            'function applyExtraHeaders (xhr, headers)',
            'applyExtraHeaders(xhr, this.options',
            'function mergeSetCookieHeader (cookieHeader, setCookieHeader)',
            "self.transport.open(self.options['extraHeaders'])",
        ],
    },
    {
        file: ['lib', 'transports', 'websocket.js'],
        markers: [
            'WS.prototype.open = function (extraHeaders)',
            'headers: extraHeaders || {}',
        ],
    },
    {
        file: ['lib', 'transports', 'xhr.js'],
        markers: [
            'function applyExtraHeaders (req, headers)',
            'applyExtraHeaders(req, this.socket.options.extraHeaders)',
        ],
    },
];

function isWithin(relativePath, excludedPath) {
    return relativePath===excludedPath
        || relativePath.startsWith(`${excludedPath}${path.sep}`);
}

function directoryStats(root) {
    let files = 0;
    let bytes = 0;
    const pending = [root];

    while (pending.length>0) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(entryPath);
            } else if (entry.isFile()) {
                files += 1;
                bytes += fs.statSync(entryPath).size;
            }
        }
    }

    return { files, bytes };
}

function installedPackageRoot(packageName) {
    return path.join(projectRoot, 'node_modules', ...packageName.split('/'));
}

function collectNodeRuntimePackages() {
    const pending = [...nodeRuntimeRoots];
    const packages = new Set();

    while (pending.length>0) {
        const packageName = pending.pop();
        if (packages.has(packageName)) {
            continue;
        }
        const packageRoot = installedPackageRoot(packageName);
        const packageJsonPath = path.join(packageRoot, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            throw new Error(`Missing packaged Node runtime dependency: ${packageName}`);
        }
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        packages.add(packageName);
        for (const dependency of Object.keys({
            ...packageJson.dependencies,
            ...packageJson.optionalDependencies,
        })) {
            pending.push(dependency);
        }
    }

    return [...packages].sort();
}

function shouldCopyNodeRuntimePath(packageName, sourceRoot, sourcePath) {
    const relativePath = path.relative(sourceRoot, sourcePath);
    if (relativePath.length===0) {
        return true;
    }
    const parts = relativePath.split(path.sep);
    if (parts.some(part => [
        '.github',
        'docs',
        'examples',
        'test',
        'tests',
    ].includes(part))) {
        return false;
    }
    if (
        relativePath.endsWith('.map')
        || relativePath.endsWith('.d.ts')
        || /^readme(?:\..+)?$/i.test(path.basename(relativePath))
    ) {
        return false;
    }
    if (packageName==='prettier') {
        const firstPart = parts[0];
        if (['bin', 'internal', 'plugins'].includes(firstPart)) {
            return false;
        }
        if (/^standalone(?:\.|$)/.test(parts.at(-1))) {
            return false;
        }
    }
    return true;
}

function contributedLanguageConfigurations() {
    const packageJson = JSON.parse(
        fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    );
    const languages = packageJson.contributes?.languages ?? [];
    return [...new Set(
        languages
            .map(language => language.configuration)
            .filter(Boolean),
    )].map(relativePath => path.join(repositoryRoot, relativePath));
}

function verifyVendorAssets(options = {}) {
    const roots = options.roots ?? vendorAssetRoots;
    const files = options.files
        ?? [...vendorAssetFiles, ...contributedLanguageConfigurations()];
    const missing = [];

    for (const root of roots) {
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
            missing.push(path.relative(repositoryRoot, root));
            continue;
        }
        const stats = directoryStats(root);
        if (stats.files===0 || stats.bytes===0) {
            missing.push(`${path.relative(repositoryRoot, root)} (empty)`);
        }
    }

    for (const filePath of files) {
        if (!fs.existsSync(filePath) || fs.statSync(filePath).size===0) {
            missing.push(path.relative(repositoryRoot, filePath));
        }
    }

    if (missing.length>0) {
        throw new Error(
            'Missing vendor assets required by the packaged extension:\n' +
            missing.map(entry => `  - ${entry}`).join('\n') +
            '\nRun `npm run download-pdfjs` and `npm run download-latex-basics` ' +
            '(or reinstall without --ignore-scripts) before packaging.',
        );
    }

    return roots.reduce(
        (totals, root) => {
            const stats = directoryStats(root);
            return {files: totals.files+stats.files, bytes: totals.bytes+stats.bytes};
        },
        {files: 0, bytes: 0},
    );
}

// `createRequire` walks up to <repoRoot>/node_modules, so an assertion could
// otherwise be satisfied by the UNSTAGED copy of a package that never made it
// into dist/node_modules.
function resolveStagedRuntime(runtimeRequire, request) {
    const resolvedPath = runtimeRequire.resolve(request);
    const relativePath = path.relative(nodeRuntimeTargetRoot, resolvedPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(
            `Runtime assertion for "${request}" resolved outside the staged runtime: ` +
            `${resolvedPath}`,
        );
    }
    return resolvedPath;
}

function requireStagedRuntime(runtimeRequire, request) {
    resolveStagedRuntime(runtimeRequire, request);
    return runtimeRequire(request);
}

function verifyStagedSocketRuntime(socketRuntimeRoot) {
    const missing = [];
    for (const {file, markers} of socketRuntimeMarkers) {
        const filePath = path.join(socketRuntimeRoot, ...file);
        if (!fs.existsSync(filePath)) {
            missing.push(`${file.join('/')} (missing)`);
            continue;
        }
        const source = fs.readFileSync(filePath, 'utf8');
        for (const marker of markers) {
            if (!source.includes(marker)) {
                missing.push(`${file.join('/')}: ${marker}`);
            }
        }
    }

    if (missing.length>0) {
        throw new Error(
            'Staged socket.io-client runtime is missing authenticated handshake hunks:\n' +
            missing.map(entry => `  - ${entry}`).join('\n'),
        );
    }
}

function stagePlaywrightRuntime() {
    if (!fs.existsSync(playwrightSourceRoot)) {
        throw new Error(
            `Missing playwright-core runtime at ${playwrightSourceRoot}. Run npm install first.`,
        );
    }

    fs.rmSync(playwrightTargetRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(playwrightTargetRoot), { recursive: true });
    fs.cpSync(playwrightSourceRoot, playwrightTargetRoot, {
        recursive: true,
        filter(source) {
            const relativePath = path.relative(playwrightSourceRoot, source);
            return relativePath.length===0
                || !playwrightExcludedPaths.some(excludedPath =>
                    isWithin(relativePath, excludedPath),
                );
        },
    });

    for (const excludedPath of playwrightExcludedPaths) {
        if (fs.existsSync(path.join(playwrightTargetRoot, excludedPath))) {
            throw new Error(`Excluded Playwright path was staged: ${excludedPath}`);
        }
    }

    const playwright = require(playwrightTargetRoot);
    if (typeof playwright.chromium?.launchPersistentContext!=='function') {
        throw new Error(
            'Staged playwright-core runtime does not expose chromium.launchPersistentContext.',
        );
    }
    return directoryStats(playwrightTargetRoot);
}

async function stageNodeRuntime() {
    fs.rmSync(nodeRuntimeTargetRoot, { recursive: true, force: true });
    const packages = collectNodeRuntimePackages();

    for (const packageName of packages) {
        const sourceRoot = installedPackageRoot(packageName);
        const targetRoot = path.join(nodeRuntimeTargetRoot, ...packageName.split('/'));
        fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
        fs.cpSync(sourceRoot, targetRoot, {
            recursive: true,
            filter(source) {
                return shouldCopyNodeRuntimePath(packageName, sourceRoot, source);
            },
        });
    }

    const runtimeRequire = createRequire(path.join(outputRoot, 'runtime-smoke.cjs'));
    const prettier = requireStagedRuntime(runtimeRequire, 'prettier');
    const { prettierPluginLatex } = requireStagedRuntime(
        runtimeRequire,
        '@unified-latex/unified-latex-prettier',
    );
    const formatted = await prettier.format('\\section{Runtime}Text', {
        parser: 'latex-parser',
        plugins: [prettierPluginLatex],
        printWidth: 80,
    });
    if (!formatted.includes('\\section{Runtime}')) {
        throw new Error('Staged formatter runtime produced unexpected LaTeX output.');
    }
    const socketClient = requireStagedRuntime(runtimeRequire, 'socket.io-client');
    if (typeof socketClient.connect!=='function') {
        throw new Error('Staged socket.io-client runtime does not expose connect().');
    }
    const socketRuntimeRoot = path.dirname(
        resolveStagedRuntime(runtimeRequire, 'socket.io-client/package.json'),
    );
    verifyStagedSocketRuntime(socketRuntimeRoot);

    return {
        packages: packages.length,
        ...directoryStats(nodeRuntimeTargetRoot),
    };
}

async function main() {
    const playwrightStats = stagePlaywrightRuntime();
    console.log(
        `Staged playwright-core runtime in ` +
        `${path.relative(repositoryRoot, playwrightTargetRoot)} ` +
        `(${playwrightStats.files} files, ${playwrightStats.bytes} bytes).`,
    );

    if (!isRemotePack) {
        const vendorStats = verifyVendorAssets();
        console.log(
            `Verified vendor assets ` +
            `(${vendorStats.files} files, ${vendorStats.bytes} bytes).`,
        );

        const nodeRuntimeStats = await stageNodeRuntime();
        console.log(
            `Staged Node runtime in ` +
            `${path.relative(repositoryRoot, nodeRuntimeTargetRoot)} ` +
            `(${nodeRuntimeStats.packages} packages, ${nodeRuntimeStats.files} files, ` +
            `${nodeRuntimeStats.bytes} bytes).`,
        );
    }
}

if (require.main===module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

// Exported so the packaging assertions themselves can be regression-tested.
module.exports = {
    contributedLanguageConfigurations,
    resolveStagedRuntime,
    verifyStagedSocketRuntime,
    verifyVendorAssets,
};
