import { REPLICA_SETTINGS_DIR } from '../consts';

/**
 * Paths that are never project content, regardless of the user's configured
 * ignore patterns. These cover extension metadata, watcher probe files and
 * staging directories; treating any of them as replica content would push
 * bookkeeping into the Overleaf project or pull it back over local work, so
 * this list is prepended to (and cannot be overridden by) `ignore-patterns`.
 */
export const PROTECTED_LOCAL_REPLICA_IGNORE_PATTERNS = [
    '**/.output',
    '**/.output/**',
    '**/AGENTS.md',
    '**/CLAUDE.md',
    '**/.cursor/**',
    '**/.codex/**',
    '**/.claude/**',
    `**/${REPLICA_SETTINGS_DIR}`,
    `**/${REPLICA_SETTINGS_DIR}/**`,
    '**/.overleaf',
    '**/.overleaf/**',
    '**/.sr-overleaf-*',
    '**/.sr-overleaf-*/**',
];
