import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const packageJsonPath = resolve(repoRoot, 'package.json');
const packageNlsPath = resolve(repoRoot, 'package.nls.json');

const packageJsonRaw = await readFile(packageJsonPath, 'utf8');
const packageNlsRaw = await readFile(packageNlsPath, 'utf8');

const packageJson = JSON.parse(packageJsonRaw);
const packageNls = JSON.parse(packageNlsRaw);

packageJson.name = 'semantic-researcher-overleaf';
packageJson.publisher = 'semantic-researcher';

packageNls['extension.displayName'] = 'Semantic Researcher Overleaf';
packageNls['extension.description'] = 'Open Overleaf projects in VS Code with semantic-researcher-friendly local replica workflows.';

try {
    await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
    await writeFile(packageNlsPath, JSON.stringify(packageNls, null, 4) + '\n');

    await new Promise((resolvePromise, rejectPromise) => {
        const child = spawn('npx', ['@vscode/vsce', 'package'], {
            cwd: repoRoot,
            stdio: 'inherit',
            shell: false,
        });

        child.on('error', rejectPromise);
        child.on('exit', (code) => {
            if (code===0) {
                resolvePromise(undefined);
            } else {
                rejectPromise(new Error(`vsce package exited with code ${code}`));
            }
        });
    });
} finally {
    await writeFile(packageJsonPath, packageJsonRaw);
    await writeFile(packageNlsPath, packageNlsRaw);
}
