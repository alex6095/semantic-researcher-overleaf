const fs = require('node:fs');
const path = require('node:path');
const webpack = require('webpack');

const repositoryRoot = path.resolve(__dirname, '..');
const isRemotePack = process.argv.includes('--remote-pack');
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const projectRoot = isRemotePack
    ? path.join(repositoryRoot, 'remote-pack')
    : repositoryRoot;

const entryPoint = path.join(projectRoot, 'src', 'extension.ts');
const outputDirectory = path.join(projectRoot, 'dist');
const outputFile = path.join(outputDirectory, 'extension.js');

const configuration = {
    mode: 'none',
    target: 'node16',
    entry: entryPoint,
    devtool: false,
    externals: [
        {
            'playwright-core': `commonjs ${production ? './runtime/playwright-core' : 'playwright-core'}`,
            vscode: 'commonjs vscode',
        },
        ({request}, callback) => {
            if (
                request==='socket.io-client'
                || request==='prettier'
                || request?.startsWith('@unified-latex/')
            ) {
                callback(null, `commonjs ${request}`);
                return;
            }
            callback();
        },
    ],
    module: {
        rules: [{
            test: /\.ts$/,
            exclude: /node_modules/,
            use: {
                loader: require.resolve('ts-loader'),
                options: {
                    configFile: path.join(projectRoot, 'tsconfig.json'),
                    transpileOnly: true,
                },
            },
        }],
    },
    optimization: {
        minimize: false,
    },
    plugins: [
        new webpack.optimize.LimitChunkCountPlugin({maxChunks: 1}),
        new webpack.IgnorePlugin({
            resourceRegExp: /^(bufferutil|utf-8-validate)$/,
        }),
    ],
    output: {
        path: outputDirectory,
        filename: 'extension.js',
        library: {
            type: 'commonjs2',
        },
        clean: true,
    },
    resolve: {
        extensions: ['.ts', '.js'],
    },
    stats: 'errors-warnings',
};

const compiler = webpack(configuration);

function reportBuild(error, stats) {
    if (error) {
        throw error;
    }
    if (!stats) {
        throw new Error('Webpack did not return build statistics.');
    }
    if (stats.hasErrors()) {
        throw new Error(stats.toString({all: false, errors: true, errorDetails: true}));
    }
    if (stats.hasWarnings()) {
        console.warn(stats.toString({all: false, warnings: true}));
    }
    const outputBytes = fs.statSync(outputFile).size;
    console.log(
        `Bundled ${stats.compilation.modules.size} modules into ` +
        `${path.relative(repositoryRoot, outputFile)} (${outputBytes} bytes).`,
    );
}

if (watch) {
    compiler.watch({}, (error, stats) => {
        try {
            reportBuild(error, stats);
        } catch (buildError) {
            console.error(buildError);
        }
    });
} else {
    compiler.run((error, stats) => {
        compiler.close(closeError => {
            try {
                reportBuild(error ?? closeError, stats);
            } catch (buildError) {
                console.error(buildError);
                process.exitCode = 1;
            }
        });
    });
}
