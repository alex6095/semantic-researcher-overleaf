#!/usr/bin/env node

const esbuild = require('esbuild');

esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: 'out/extension.js',
    sourcemap: true,
    sourcesContent: false,
    external: [
        'vscode',
    ],
    logOverride: {
        // Playwright's Electron/app-launcher helpers use require.resolve() for
        // files we do not call from browser login. The Chromium channel flow used
        // here bundles cleanly, so keep the VSIX free of node_modules.
        'require-resolve-not-external': 'silent',
    },
    logLevel: 'info',
}).catch(error => {
    console.error(error);
    process.exit(1);
});
