# Agent Review Implementation Plan

Last updated: 2026-04-21, Asia/Seoul.

## Goal

Implement Local Replica Agent Review without globally intercepting normal
`codex` or `claude` CLI usage.

The extension should guide agents through `AGENTS.md` and `CLAUDE.md`, ask them
to write proposed LaTeX edits into a managed draft copy, import those drafts into
a VS Code diff viewer, and only apply a change to the source Local Replica when
the user accepts it. Accepting a change should apply, save, and then sync through
the existing Local Replica SCM path.

## Core Decisions

- Do not prepend `.semantic-researcher-overleaf/bin` to integrated terminal
  `PATH`.
- Do not force regular `codex` or `claude` invocations into staging.
- Write managed instruction blocks at the current VS Code workspace root so
  Codex launched from that workspace sees the rule. Do not write Local Replica
  root instruction files unless the Local Replica root is also the workspace
  root.
- Write `CLAUDE.md` directly because Claude Code does not read `AGENTS.md`
  unless imported.
- Provide an explicit helper script path in the instructions instead of relying
  on shell PATH mutation.
- Keep source direct-write quarantine only as a fallback safety layer.
- Use `semantic-researcher-overleaf.agentReview.enabled` as the single Agent
  Review switch. Older per-replica `enableAgentReview` values are legacy
  metadata and are stripped during settings normalization.

## TODO

1. [x] Clean the test Local Replica by removing generated agent instruction
   files, Cursor rules, shims, sessions, proposals, and worktrees while keeping
   `.semantic-researcher-overleaf/settings.json`.
2. [x] Replace terminal PATH shim activation with workspace/root instruction
   generation.
3. [x] Add a workspace-local `overleaf-agent-review` helper script that creates
   draft copies and marks drafts submitted.
4. [x] Add submitted draft import into proposal storage.
5. [x] Make change records context-aware so accepted changes can be relocated after
   previous changes move line numbers.
6. [x] Change Accept Change into apply-and-save flow; remove accepted-but-unsaved
   as the normal path.
7. [x] Replace manual-save timing heuristics with explicit save intent tokens
   for human saves and agent-review accept saves.
8. [x] Keep direct source writes from active/submitted agent flows as fallback
   proposal conversion or sync block.
9. [x] Update settings, commands, docs, and handoff notes to remove default
   terminal interception.
10. [x] Run lint and compile.
11. [x] Fix instruction writer so existing `AGENTS.md`/`CLAUDE.md` content is
   preserved below the managed block, and existing files are left untouched if
   they cannot be read.
12. [x] Clean stale fixture review outputs from the test Local Replica and
   workspace metadata while keeping the current helper/registry and replica
   settings.
13. [x] Add first-change reveal on proposal import/file activation, add
   previous/next change navigation, and change visible review wording from hunk
   to change.
14. [x] Keep only the global `agentReview.enabled` settings switch; strip older
    per-replica `enableAgentReview` metadata during settings normalization.

## Files To Modify

- `src/agentReview/types.ts`
- `src/agentReview/diff.ts`
- `src/agentReview/saveClassifier.ts`
- `src/agentReview/instructionFiles.ts`
- `src/agentReview/proposalStore.ts`
- `src/agentReview/editorReviewProvider.ts`
- `src/agentReview/agentReviewManager.ts`
- `src/agentReview/workspaceInstructionManager.ts`
- `src/scm/localReplicaSCM.ts`
- `package.json`
- `package.nls.json`
- `docs/wiki.md`
- `docs/agent-review-handoff.md`

## Verification

- `which codex` from a new integrated terminal must not point to a generated
  Local Replica shim.
- `AGENTS.md` and `CLAUDE.md` at the workspace root must contain one managed
  block listing registered Local Replica roots and the helper path.
- Running the helper manually must create a draft copy without touching source.
- Marking a draft submitted must open proposal changes in the Agent Review diff
  viewer after import.
- Accepting a change must modify the file, save it, and allow Local Replica sync.
- Direct user edits and saves must continue to sync normally.
- `npm run lint`
- `npm run compile`
