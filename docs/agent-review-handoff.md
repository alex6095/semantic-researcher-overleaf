# Agent Review Handoff

Last updated: 2026-04-21, Asia/Seoul.

This document summarizes the current Semantic Researcher Overleaf Agent Review
implementation after removing default terminal interception.

## User Intent

- Normal `codex` and `claude` CLI usage must keep its normal executable path and
  working directory behavior.
- Human edits to Local Replica `.tex` files must save and sync as before.
- AI agents should be guided through `AGENTS.md` and `CLAUDE.md` to create draft
  proposals instead of directly editing source Local Replica files.
- Submitted proposals should appear in the normal VS Code editor as change-level
  review UI.
- Accepting a change should apply it, save the source file, and let the existing
  Local Replica SCM sync the accepted change to Overleaf.

## Current Design

The implementation now uses:

1. Workspace-root managed instruction blocks in `AGENTS.md` and `CLAUDE.md`.
2. A workspace-local helper script:
   `.semantic-researcher-overleaf/agent-review/bin/overleaf-agent-review`
3. Draft copies under:
   `.semantic-researcher-overleaf/agent-review/drafts/<draft-id>/`
4. Proposal JSON files under the Local Replica metadata directory:
   `.semantic-researcher-overleaf/agent-proposals/`
5. Editor CodeLens, hover actions, decorations, and native diff fallback.

No generated directory is prepended to integrated terminal `PATH`.

Important: managed instruction blocks must be prepended without deleting user
content. If an existing instruction file cannot be read, the extension leaves it
unchanged and shows a warning instead of recreating it.

## Important Files

- `src/agentReview/workspaceInstructionManager.ts`
  - Resolves the workspace root for the active Local Replica.
  - Writes the helper script and registry.
  - Finds submitted/open draft records.
- `src/agentReview/instructionFiles.ts`
  - Updates workspace `AGENTS.md` and `CLAUDE.md` with a managed block.
- `src/agentReview/proposalStore.ts`
  - Imports submitted helper drafts and legacy sessions.
  - Stores change proposals.
- `src/agentReview/editorReviewProvider.ts`
  - Shows changes and performs accept/decline/open-diff/previous/next.
  - Reveals the first pending change when a proposal imports for an open file,
    or when a file with pending changes becomes active.
  - Accept applies the change and saves the document.
- `src/agentReview/saveClassifier.ts`
  - Tracks explicit save intents for editor saves and agent-review accept saves.
- `src/agentReview/agentReviewManager.ts`
  - Orchestrates activation, draft import, direct-write fallback, and commands.
- `src/scm/localReplicaSCM.ts`
  - Calls Agent Review before and after Local Replica pushes.

## Settings And Commands

Settings:

- `semantic-researcher-overleaf.agentReview.enabled`
  - Single source of truth for Agent Review. Older per-replica
    `enableAgentReview` metadata is ignored and stripped during settings
    normalization.

Commands:

- `semantic-researcher-overleaf.agentReview.enable`
- `semantic-researcher-overleaf.agentReview.disable`
  - These toggle the global VS Code setting and then refresh the active Local Replica instructions/drafts.
- `semantic-researcher-overleaf.agentReview.repairInstructions`
- `semantic-researcher-overleaf.agentReview.importProposalDrafts`
  - Title: `Agent Review: Import Proposal Drafts`
- `semantic-researcher-overleaf.agentReview.showStatus`

Internal/editor commands:

- `semantic-researcher-overleaf.agentReview.acceptHunk`
- `semantic-researcher-overleaf.agentReview.declineHunk`
- `semantic-researcher-overleaf.agentReview.openDiff`
- `semantic-researcher-overleaf.agentReview.previousChange`
- `semantic-researcher-overleaf.agentReview.nextChange`

## Helper Protocol

Agents are instructed to run:

```bash
"/path/to/workspace/.semantic-researcher-overleaf/agent-review/bin/overleaf-agent-review" begin --root "/path/to/local-replica"
```

The helper prints `DRAFT_ID`, `SOURCE_ROOT`, and `DRAFT_ROOT`. Agents edit only
files under `DRAFT_ROOT`, then run:

```bash
"/path/to/workspace/.semantic-researcher-overleaf/agent-review/bin/overleaf-agent-review" submit --draft "<DRAFT_ID>"
```

The extension imports submitted drafts on a timer.

## Known Fixture Cleanup

The test Local Replica at `/workspace/ma_research_semantic_sim/manuscript` was
cleaned of old generated files:

- removed root `AGENTS.md`
- removed root `CLAUDE.md`
- removed `.cursor/`
- removed old proposal/session/worktree/shim outputs
- kept `.semantic-researcher-overleaf/settings.json`

The direct-write proposal changes in `content/03_method.tex` were restored to
their proposal baseline text.

## Verification

Completed after the redesign:

```bash
cd /workspace/Overleaf-Workshop
npm run lint
npm run compile
```

Both passed.

Recommended manual pass:

1. Reload VS Code.
2. Open or activate the Local Replica.
3. Confirm workspace-root `AGENTS.md` and `CLAUDE.md` contain the managed block.
4. Confirm `which codex` does not point into `.semantic-researcher-overleaf`.
5. Run the helper `begin`/`submit` flow manually or through Codex.
6. Confirm submitted drafts import into editor changes.
7. Confirm an already-open changed file moves focus to the first change.
8. Confirm `Agent Review: Next Change` and `Agent Review: Previous Change`
   cycle through pending changes in the active file.
9. Accept one change and confirm the file is saved and synced through Local Replica.
