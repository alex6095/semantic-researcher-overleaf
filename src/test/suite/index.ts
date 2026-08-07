import * as fs from 'fs';
import * as path from 'path';
import * as Mocha from 'mocha';

function findTestFiles(root: string): string[] {
    const result: string[] = [];
    for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            result.push(...findTestFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
            result.push(fullPath);
        }
    }
    return result;
}

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true,
    });
    const grep = process.env.VSCODE_TEST_GREP;
    if (grep) {
        mocha.grep(new RegExp(grep));
    }

    for (const file of findTestFiles(__dirname).sort()) {
        mocha.addFile(file);
    }

    return new Promise((resolve, reject) => {
        mocha.run((failures: number) => {
            if (failures>0) {
                reject(new Error(`${failures} tests failed.`));
            } else {
                resolve();
            }
        });
    });
}
