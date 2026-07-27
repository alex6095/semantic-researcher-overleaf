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

const formatterTargetRoot = path.join(outputRoot, 'node_modules');
const formatterRoots = [
    'prettier',
    '@unified-latex/unified-latex-prettier',
    '@unified-latex/unified-latex-util-parse',
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

function collectFormatterPackages() {
    const pending = [...formatterRoots];
    const packages = new Set();

    while (pending.length>0) {
        const packageName = pending.pop();
        if (packages.has(packageName)) {
            continue;
        }
        const packageRoot = installedPackageRoot(packageName);
        const packageJsonPath = path.join(packageRoot, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            throw new Error(`Missing formatter runtime dependency: ${packageName}`);
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

function shouldCopyFormatterPath(packageName, sourceRoot, sourcePath) {
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

async function stageFormatterRuntime() {
    fs.rmSync(formatterTargetRoot, { recursive: true, force: true });
    const packages = collectFormatterPackages();

    for (const packageName of packages) {
        const sourceRoot = installedPackageRoot(packageName);
        const targetRoot = path.join(formatterTargetRoot, ...packageName.split('/'));
        fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
        fs.cpSync(sourceRoot, targetRoot, {
            recursive: true,
            filter(source) {
                return shouldCopyFormatterPath(packageName, sourceRoot, source);
            },
        });
    }

    const runtimeRequire = createRequire(path.join(outputRoot, 'runtime-smoke.cjs'));
    const prettier = runtimeRequire('prettier');
    const { prettierPluginLatex } = runtimeRequire(
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

    return {
        packages: packages.length,
        ...directoryStats(formatterTargetRoot),
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
        const formatterStats = await stageFormatterRuntime();
        console.log(
            `Staged formatter runtime in ` +
            `${path.relative(repositoryRoot, formatterTargetRoot)} ` +
            `(${formatterStats.packages} packages, ${formatterStats.files} files, ` +
            `${formatterStats.bytes} bytes).`,
        );
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
