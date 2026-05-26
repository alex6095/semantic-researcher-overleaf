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
        // Browser login loads Playwright at runtime. Keep its package layout in
        // the VSIX instead of bundling it into the extension entrypoint.
        'playwright-core',
    ],
    logOverride: {
        // Dependencies may contain optional platform helpers behind dynamic
        // require.resolve() calls. They are not needed during extension startup.
        'require-resolve-not-external': 'silent',
    },
    logLevel: 'info',
}).catch(error => {
    console.error(error);
    process.exit(1);
});
