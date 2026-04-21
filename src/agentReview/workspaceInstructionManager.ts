import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { REPLICA_SETTINGS_DIR } from '../consts';
import { AgentReviewDraftRecord } from './types';
import { AgentReviewInstructionFiles } from './instructionFiles';

const AGENT_REVIEW_DIR = 'agent-review';
const REGISTRY_FILE = 'registry.json';
const HELPER_NAME = 'overleaf-agent-review';

// Drafts older than these thresholds get cleaned up on activation.
const IMPORTED_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ABORTED_DRAFT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const RUNNING_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type Registry = {
    replicaRoots: string[],
};

function normalizePath(value: string) {
    return path.resolve(value);
}

function quoteJsString(value: string) {
    return JSON.stringify(value);
}

function helperScript() {
    return `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const META_ROOT = path.dirname(path.dirname(__filename));
const REGISTRY_PATH = path.join(META_ROOT, ${quoteJsString(REGISTRY_FILE)});
const DRAFTS_ROOT = path.join(META_ROOT, 'drafts');
const SKIP_NAMES = new Set(['.git', '.overleaf', ${quoteJsString(REPLICA_SETTINGS_DIR)}, 'node_modules']);
const SKIP_EXTENSIONS = new Set([
  '.aux', '.blg', '.fdb_latexmk', '.fls', '.log', '.out', '.pdf',
  '.synctex', '.xdv', '.toc', '.lof', '.lot'
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function ensureRegisteredRoot(root) {
  let registry;
  try {
    registry = readJson(REGISTRY_PATH);
  } catch (error) {
    throw new Error('Agent Review is disabled globally. Edit the file directly without the draft helper.');
  }
  const normalized = path.resolve(root);
  if (!registry.replicaRoots.map((entry) => path.resolve(entry)).includes(normalized)) {
    throw new Error('Agent Review is disabled for ' + normalized + '. Edit the file directly without the draft helper.');
  }
  return normalized;
}

function shouldSkip(name) {
  return SKIP_NAMES.has(name) || SKIP_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function copyProject(source, dest) {
  fs.mkdirSync(dest, {recursive: true});
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    if (shouldSkip(entry.name)) {
      continue;
    }
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyProject(from, to);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), {recursive: true});
      fs.copyFileSync(from, to);
    }
  }
}

function createId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return stamp + '-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
}

function begin(args) {
  const rootArg = argValue(args, '--root');
  if (!rootArg) {
    throw new Error('Usage: overleaf-agent-review begin --root <local-replica-root>');
  }
  const rootPath = ensureRegisteredRoot(rootArg);
  const id = createId();
  const draftBase = path.join(DRAFTS_ROOT, id);
  const baselineRoot = path.join(draftBase, 'baseline');
  const draftRoot = path.join(draftBase, 'project');
  copyProject(rootPath, baselineRoot);
  copyProject(rootPath, draftRoot);
  const now = new Date().toISOString();
  writeJson(path.join(draftBase, 'draft.json'), {
    id,
    rootPath,
    workspaceRoot: META_ROOT,
    baselineRoot,
    draftRoot,
    createdAt: now,
    updatedAt: now,
    state: 'running'
  });
  console.log('DRAFT_ID=' + id);
  console.log('SOURCE_ROOT=' + rootPath);
  console.log('DRAFT_ROOT=' + draftRoot);
  console.log('Edit only files under DRAFT_ROOT, then run:');
  console.log(process.argv[1] + ' submit --draft ' + id);
}

function submit(args) {
  const id = argValue(args, '--draft');
  if (!id) {
    throw new Error('Usage: overleaf-agent-review submit --draft <draft-id>');
  }
  const draftDir = path.join(DRAFTS_ROOT, id);
  const draftPath = path.join(draftDir, 'draft.json');
  const draft = readJson(draftPath);
  // Re-check registration at submit time: if the replica root was unregistered
  // (user toggled Agent Review off mid-session), discard the draft instead of
  // letting it pile up on disk. The helper fails fast so the agent can fall
  // back to direct writes without burning tokens on a dead workflow.
  try {
    const registry = readJson(REGISTRY_PATH);
    const normalized = path.resolve(draft.rootPath || '');
    const registered = (registry.replicaRoots || []).map((entry) => path.resolve(entry));
    if (!registered.includes(normalized)) {
      fs.rmSync(draftDir, {recursive: true, force: true});
      console.error('Agent Review is disabled for ' + draft.rootPath + '; draft discarded. Edit the file directly instead.');
      process.exit(1);
    }
  } catch (error) {
    // If the registry is missing the feature is effectively off globally.
    fs.rmSync(draftDir, {recursive: true, force: true});
    console.error('Agent Review registry missing; draft discarded. Edit the file directly instead.');
    process.exit(1);
  }
  draft.state = 'submitted';
  draft.updatedAt = new Date().toISOString();
  writeJson(draftPath, draft);
  console.log('Submitted successfully. Treat the requested edit as complete; do not apply it again to the Local Replica source file. Reply naturally with a concise summary of the edit; do not mention draft IDs or helper internals unless the user asks.');
}

function abort(args) {
  const id = argValue(args, '--draft');
  if (!id) {
    throw new Error('Usage: overleaf-agent-review abort --draft <draft-id>');
  }
  const draftPath = path.join(DRAFTS_ROOT, id, 'draft.json');
  const draft = readJson(draftPath);
  draft.state = 'aborted';
  draft.updatedAt = new Date().toISOString();
  writeJson(draftPath, draft);
  console.log('Aborted Agent Review draft: ' + id);
}

function status() {
  const registry = fs.existsSync(REGISTRY_PATH) ? readJson(REGISTRY_PATH) : {replicaRoots: []};
  console.log('Registered Local Replica roots:');
  for (const root of registry.replicaRoots) {
    console.log('- ' + root);
  }
  if (!fs.existsSync(DRAFTS_ROOT)) {
    return;
  }
  console.log('Drafts:');
  for (const id of fs.readdirSync(DRAFTS_ROOT)) {
    const draftPath = path.join(DRAFTS_ROOT, id, 'draft.json');
    if (fs.existsSync(draftPath)) {
      const draft = readJson(draftPath);
      console.log('- ' + draft.id + ' ' + draft.state + ' ' + draft.rootPath);
    }
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'begin':
      begin(args);
      break;
    case 'submit':
      submit(args);
      break;
    case 'abort':
      abort(args);
      break;
    case 'status':
      status();
      break;
    default:
      throw new Error('Usage: overleaf-agent-review <begin|submit|abort|status>');
  }
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
`;
}

function cmdHelperScript() {
    return `@echo off
node "%~dp0${HELPER_NAME}" %*
`;
}

async function pathExists(filePath: string) {
    try {
        await fs.stat(filePath);
        return true;
    } catch {
        return false;
    }
}

export class AgentReviewWorkspaceInstructionManager {
    private readonly instructionFiles = new AgentReviewInstructionFiles();
    private metaRootPath: string;
    private readonly writtenInstructionRoots = new Set<string>();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.metaRootPath = path.join(context.globalStorageUri.fsPath, AGENT_REVIEW_DIR);
    }

    get helperPath() {
        return path.join(this.metaRootPath, 'bin', HELPER_NAME);
    }

    get draftsRoot() {
        return path.join(this.metaRootPath, 'drafts');
    }

    async ensureHelperInstalled() {
        const binRoot = path.join(this.metaRootPath, 'bin');
        await fs.mkdir(binRoot, {recursive: true});
        await fs.writeFile(path.join(binRoot, HELPER_NAME), helperScript());
        await fs.chmod(path.join(binRoot, HELPER_NAME), 0o755);
        await fs.writeFile(path.join(binRoot, `${HELPER_NAME}.cmd`), cmdHelperScript());
    }

    async ensure(rootUri: vscode.Uri) {
        await this.migrateLegacyWorkspaceMeta();
        await this.ensureHelperInstalled();

        const registry = await this.readRegistry();
        const normalizedRoot = normalizePath(rootUri.fsPath);
        if (!registry.replicaRoots.includes(normalizedRoot)) {
            registry.replicaRoots.push(normalizedRoot);
            registry.replicaRoots.sort((a, b) => a.localeCompare(b));
        }
        await this.writeRegistry(registry);

        const workspaceRoot = this.resolveWorkspaceRoot(rootUri);
        if (workspaceRoot) {
            await this.instructionFiles.ensureWorkspace({
                workspaceRoot,
                helperPath: this.helperPath,
                replicaRoots: registry.replicaRoots,
            });
            this.writtenInstructionRoots.add(workspaceRoot.fsPath);
        }
    }

    async disable(rootUri: vscode.Uri) {
        const registry = await this.readRegistry();
        const normalizedRoot = normalizePath(rootUri.fsPath);
        const replicaRoots = registry.replicaRoots.filter(root => root!==normalizedRoot);
        if (replicaRoots.length!==registry.replicaRoots.length) {
            await this.writeRegistry({replicaRoots});
        }

        const workspaceRoot = this.resolveWorkspaceRoot(rootUri);
        if (workspaceRoot) {
            if (replicaRoots.length>0) {
                await this.instructionFiles.ensureWorkspace({
                    workspaceRoot,
                    helperPath: this.helperPath,
                    replicaRoots,
                });
            } else {
                await this.instructionFiles.removeWorkspace(workspaceRoot);
                this.writtenInstructionRoots.delete(workspaceRoot.fsPath);
            }
        }
    }

    // When the feature is toggled off, any in-flight (running/submitted) draft
    // for this root becomes garbage — the user explicitly disabled the flow, so
    // importing "after the fact" would confuse them and potentially overwrite
    // their manual work. Purge them instead.
    async abortOwnedDrafts(rootUri: vscode.Uri) {
        if (!await pathExists(this.draftsRoot)) { return; }
        const target = normalizePath(rootUri.fsPath);
        const entries = await fs.readdir(this.draftsRoot, {withFileTypes: true});
        for (const entry of entries) {
            if (!entry.isDirectory()) { continue; }
            const draftDir = path.join(this.draftsRoot, entry.name);
            const jsonPath = path.join(draftDir, 'draft.json');
            try {
                const draft = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as AgentReviewDraftRecord;
                if (normalizePath(draft.rootPath)!==target) { continue; }
                if (draft.state!=='running' && draft.state!=='submitted') { continue; }
                await fs.rm(draftDir, {recursive: true, force: true});
            } catch {
                // unreadable or already gone — attempt to remove the directory too
                try { await fs.rm(draftDir, {recursive: true, force: true}); } catch { /* ignore */ }
            }
        }
    }

    async submittedDrafts(rootUri: vscode.Uri): Promise<AgentReviewDraftRecord[]> {
        if (!await pathExists(this.draftsRoot)) {
            return [];
        }
        const entries = await fs.readdir(this.draftsRoot, {withFileTypes: true});
        const drafts: AgentReviewDraftRecord[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            try {
                const draft = JSON.parse(await fs.readFile(path.join(this.draftsRoot, entry.name, 'draft.json'), 'utf8')) as AgentReviewDraftRecord;
                if (normalizePath(draft.rootPath)===normalizePath(rootUri.fsPath) && draft.state==='submitted') {
                    drafts.push(draft);
                }
            } catch {
                continue;
            }
        }
        return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    async latestOpenDraft(rootUri: vscode.Uri): Promise<AgentReviewDraftRecord | undefined> {
        if (!await pathExists(this.draftsRoot)) {
            return undefined;
        }
        const entries = await fs.readdir(this.draftsRoot, {withFileTypes: true});
        const drafts: AgentReviewDraftRecord[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            try {
                const draft = JSON.parse(await fs.readFile(path.join(this.draftsRoot, entry.name, 'draft.json'), 'utf8')) as AgentReviewDraftRecord;
                const matchesRoot = normalizePath(draft.rootPath)===normalizePath(rootUri.fsPath);
                if (matchesRoot && (draft.state==='running' || draft.state==='submitted')) {
                    drafts.push(draft);
                }
            } catch {
                continue;
            }
        }
        return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    }

    async markDraftImported(draft: AgentReviewDraftRecord) {
        const draftPath = path.join(path.dirname(draft.baselineRoot), 'draft.json');
        draft.state = 'imported';
        draft.importedAt = new Date().toISOString();
        draft.updatedAt = draft.importedAt;
        try {
            await fs.writeFile(draftPath, JSON.stringify(draft, null, 2));
        } catch {
            // draft may already be gone if deleted concurrently
        }
    }

    // Delete one specific draft directory by id (used when its proposal is fully resolved).
    async removeDraft(draftId: string) {
        const draftDir = path.join(this.draftsRoot, draftId);
        if (!await pathExists(draftDir)) {
            return;
        }
        try {
            await fs.rm(draftDir, {recursive: true, force: true});
        } catch (error) {
            console.warn(`Could not remove agent review draft ${draftId}:`, error);
        }
    }

    async cleanupOldDrafts() {
        if (!await pathExists(this.draftsRoot)) {
            return;
        }
        const registry = await this.readRegistry();
        const registeredRoots = new Set(registry.replicaRoots);
        const entries = await fs.readdir(this.draftsRoot, {withFileTypes: true});
        const now = Date.now();
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const dir = path.join(this.draftsRoot, entry.name);
            const jsonPath = path.join(dir, 'draft.json');
            let draft: AgentReviewDraftRecord;
            try {
                draft = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as AgentReviewDraftRecord;
            } catch {
                // Unreadable draft → remove
                try { await fs.rm(dir, {recursive: true, force: true}); } catch { /* ignore */ }
                continue;
            }
            // A draft whose replica root is not currently registered is an orphan
            // (the user disabled the feature for that root, possibly days ago).
            // Purge regardless of age so we never surface a stale import later.
            if (!registeredRoots.has(normalizePath(draft.rootPath))) {
                try { await fs.rm(dir, {recursive: true, force: true}); } catch { /* ignore */ }
                continue;
            }
            const referenceStamp = Date.parse(draft.updatedAt ?? draft.createdAt);
            if (Number.isNaN(referenceStamp)) {
                continue;
            }
            const age = now-referenceStamp;
            const expired = (draft.state==='imported' && age>IMPORTED_DRAFT_TTL_MS)
                || (draft.state==='aborted' && age>ABORTED_DRAFT_TTL_MS)
                || (draft.state==='running' && age>RUNNING_DRAFT_TTL_MS);
            if (expired) {
                try { await fs.rm(dir, {recursive: true, force: true}); } catch { /* ignore */ }
            }
        }
    }

    resolveWorkspaceRoot(rootUri: vscode.Uri): vscode.Uri | undefined {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const containing = folders
        .filter(folder => folder.uri.scheme==='file' && this.isDirectoryAncestor(folder.uri, rootUri))
        .sort((a, b) => b.uri.fsPath.length-a.uri.fsPath.length)[0];
        if (containing) {
            return containing.uri;
        }
        const firstFileFolder = folders.find(folder => folder.uri.scheme==='file');
        return firstFileFolder?.uri;
    }

    private isDirectoryAncestor(parent: vscode.Uri, child: vscode.Uri) {
        const normalizedParent = parent.fsPath.endsWith(path.sep) ? parent.fsPath : `${parent.fsPath}${path.sep}`;
        return child.fsPath===parent.fsPath || child.fsPath.startsWith(normalizedParent);
    }

    private async readRegistry(): Promise<Registry> {
        const registryPath = path.join(this.metaRootPath, REGISTRY_FILE);
        try {
            const registry = JSON.parse(await fs.readFile(registryPath, 'utf8')) as Registry;
            return {
                replicaRoots: [...new Set((registry.replicaRoots ?? []).map(normalizePath))],
            };
        } catch {
            return {replicaRoots: []};
        }
    }

    private async writeRegistry(registry: Registry) {
        const registryPath = path.join(this.metaRootPath, REGISTRY_FILE);
        await fs.mkdir(path.dirname(registryPath), {recursive: true});
        await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
    }

    // Migrates any workspace-folder-scoped .semantic-researcher-overleaf/agent-review/
    // into the globalStorage metaRoot so only a single location is active going forward.
    private async migrateLegacyWorkspaceMeta() {
        const folders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of folders) {
            if (folder.uri.scheme!=='file') {
                continue;
            }
            const legacyMeta = path.join(folder.uri.fsPath, REPLICA_SETTINGS_DIR, AGENT_REVIEW_DIR);
            if (!await pathExists(legacyMeta) || path.resolve(legacyMeta)===path.resolve(this.metaRootPath)) {
                continue;
            }

            // Merge legacy registry.
            try {
                const legacyRegistry = JSON.parse(await fs.readFile(path.join(legacyMeta, REGISTRY_FILE), 'utf8')) as Registry;
                const current = await this.readRegistry();
                const merged = [...new Set([...current.replicaRoots, ...(legacyRegistry.replicaRoots ?? []).map(normalizePath)])];
                merged.sort((a, b) => a.localeCompare(b));
                await this.writeRegistry({replicaRoots: merged});
            } catch {
                // no legacy registry
            }

            // Move legacy drafts. Baseline/draft paths are absolute within the old meta,
            // so we rewrite them to point at the new meta location.
            const legacyDrafts = path.join(legacyMeta, 'drafts');
            if (await pathExists(legacyDrafts)) {
                await fs.mkdir(this.draftsRoot, {recursive: true});
                const entries = await fs.readdir(legacyDrafts, {withFileTypes: true});
                for (const entry of entries) {
                    if (!entry.isDirectory()) { continue; }
                    const srcDir = path.join(legacyDrafts, entry.name);
                    const dstDir = path.join(this.draftsRoot, entry.name);
                    try {
                        await fs.rename(srcDir, dstDir);
                    } catch {
                        try {
                            await fs.cp(srcDir, dstDir, {recursive: true, force: true});
                            await fs.rm(srcDir, {recursive: true, force: true});
                        } catch (error) {
                            console.warn(`Could not migrate legacy draft ${entry.name}:`, error);
                            continue;
                        }
                    }
                    const draftJsonPath = path.join(dstDir, 'draft.json');
                    try {
                        const draft = JSON.parse(await fs.readFile(draftJsonPath, 'utf8')) as AgentReviewDraftRecord;
                        draft.baselineRoot = path.join(dstDir, 'baseline');
                        draft.draftRoot = path.join(dstDir, 'project');
                        draft.workspaceRoot = this.metaRootPath;
                        await fs.writeFile(draftJsonPath, JSON.stringify(draft, null, 2));
                    } catch {
                        // leave as-is if unreadable
                    }
                }
            }

            // Everything important has moved; drop the legacy dir entirely.
            try {
                await fs.rm(legacyMeta, {recursive: true, force: true});
            } catch (error) {
                console.warn(`Could not remove legacy agent-review meta ${legacyMeta}:`, error);
            }

            // Also clean the parent `.semantic-researcher-overleaf` dir if empty after removal.
            const parentMeta = path.join(folder.uri.fsPath, REPLICA_SETTINGS_DIR);
            try {
                const remaining = await fs.readdir(parentMeta);
                if (remaining.length===0) {
                    await fs.rmdir(parentMeta);
                }
            } catch {
                // ignore
            }
        }
    }
}
