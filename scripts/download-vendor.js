#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const extract = require('extract-zip');

const repoRoot = path.resolve(__dirname, '..');

const tasks = {
    pdfjs: {
        url: 'https://github.com/mozilla/pdf.js/releases/download/v3.10.111/pdfjs-3.10.111-dist.zip',
        sha256: '95cf3d37f7614b420c19890cd460fdadb2d6cb2b788e5156a17a732d393c6417',
        outputDir: path.join(repoRoot, 'views/pdf-viewer/vendor'),
        stripComponents: 0,
        patchFile: path.join(repoRoot, 'views/pdf-viewer/vendor/pdfjs-3.10.111-dist.patch'),
    },
    'latex-basics': {
        url: 'https://github.com/jlelong/vscode-latex-basics/archive/refs/tags/v1.5.4.zip',
        sha256: '3c21ef4be37008e32d1aab78722e63621a6b1c25972df22cbb02c1e505d300ce',
        outputDir: path.join(repoRoot, 'data/vendor'),
        stripComponents: 1,
    },
};

function clientFor(url) {
    return url.startsWith('https:') ? https : http;
}

function download(url, destination, redirects = 0) {
    if (redirects>5) {
        return Promise.reject(new Error(`Too many redirects while downloading ${url}`));
    }

    return new Promise((resolve, reject) => {
        const request = clientFor(url).get(url, response => {
            if (
                response.statusCode
                && response.statusCode>=300
                && response.statusCode<400
                && response.headers.location
            ) {
                response.resume();
                const nextUrl = new URL(response.headers.location, url).toString();
                download(nextUrl, destination, redirects + 1).then(resolve, reject);
                return;
            }

            if (response.statusCode!==200) {
                response.resume();
                reject(new Error(`Download failed for ${url}: HTTP ${response.statusCode}`));
                return;
            }

            pipeline(response, fs.createWriteStream(destination)).then(resolve, reject);
        });
        request.on('error', reject);
    });
}

async function sha256(filePath) {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex');
}

async function copyExtractedContent(extractedDir, outputDir, stripComponents) {
    let sourceDir = extractedDir;
    for (let i = 0; i<stripComponents; i++) {
        const entries = await fsp.readdir(sourceDir, {withFileTypes: true});
        const directories = entries.filter(entry => entry.isDirectory());
        if (directories.length!==1) {
            throw new Error(`Cannot strip ${stripComponents} path components from archive`);
        }
        sourceDir = path.join(sourceDir, directories[0].name);
    }

    await fsp.mkdir(outputDir, {recursive: true});
    const entries = await fsp.readdir(sourceDir);
    for (const entry of entries) {
        await fsp.cp(path.join(sourceDir, entry), path.join(outputDir, entry), {
            recursive: true,
            force: true,
        });
    }
}

function applyPatch(task) {
    if (!task.patchFile) { return; }
    if (!fs.existsSync(task.patchFile)) {
        throw new Error(`Patch file not found: ${task.patchFile}`);
    }
    const result = spawnSync('patch', ['-p1', '-i', task.patchFile], {
        cwd: task.outputDir,
        encoding: 'utf8',
    });
    if (result.status!==0) {
        throw new Error([
            `Patch failed in ${task.outputDir}`,
            result.stdout,
            result.stderr,
        ].filter(Boolean).join('\n'));
    }
}

async function runTask(name) {
    const task = tasks[name];
    if (!task) {
        throw new Error(`Unknown vendor download task: ${name}`);
    }

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `sr-overleaf-${name}-`));
    const archivePath = path.join(tempDir, `${name}.zip`);
    const extractDir = path.join(tempDir, 'extract');
    try {
        await fsp.mkdir(extractDir);
        await download(task.url, archivePath);
        const actualHash = await sha256(archivePath);
        if (actualHash!==task.sha256) {
            throw new Error(`Checksum mismatch for ${name}: expected ${task.sha256}, got ${actualHash}`);
        }
        await extract(archivePath, {dir: extractDir});
        await copyExtractedContent(extractDir, task.outputDir, task.stripComponents);
        applyPatch(task);
    } finally {
        await fsp.rm(tempDir, {recursive: true, force: true});
    }
}

async function main() {
    const names = process.argv.slice(2);
    const selected = names.length===0 ? Object.keys(tasks) : names;
    for (const name of selected) {
        await runTask(name);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
