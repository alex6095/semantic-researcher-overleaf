const path = require('node:path');
const {spawn} = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const commands = [
    {
        label: 'TypeScript',
        args: [
            require.resolve('typescript/bin/tsc'),
            '--watch',
            '--project',
            repositoryRoot,
        ],
    },
    {
        label: 'Webpack',
        args: [
            path.join(__dirname, 'bundle-extension.js'),
            '--watch',
        ],
    },
];

let stopping = false;
let running = commands.length;
const children = commands.map(command => {
    const child = spawn(process.execPath, command.args, {
        cwd: repositoryRoot,
        stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
        running -= 1;
        if (!stopping) {
            stopping = true;
            process.exitCode = code && code!==0 ? code : 1;
            console.error(
                `${command.label} watcher exited unexpectedly ` +
                `(code ${code ?? 'none'}, signal ${signal ?? 'none'}).`,
            );
            for (const sibling of children) {
                if (sibling!==child && sibling.exitCode===null) {
                    sibling.kill('SIGTERM');
                }
            }
        }
        if (running===0) {
            process.exit();
        }
    });
    return child;
});

function stop(signal) {
    stopping = true;
    for (const child of children) {
        if (child.exitCode===null) {
            child.kill(signal);
        }
    }
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
