# Upstream v0.15.10 Port Audit (0.15.31)

## Purpose

This release incorporates the useful changes published by
`overleaf-workshop/Overleaf-Workshop` after our last common ancestor without
undoing the fork's Local Replica product contract.

The contract remains:

1. local disk is a normal working surface for VS Code, shells, and coding
   agents, including files that are not open in an editor;
2. saved text, media, and folder changes synchronize in both directions;
3. saving a supported source synchronizes that saved file and then compiles;
4. manual and PDF compile never save or transmit unsaved editor buffers;
5. account, project, reload, extension-host, and SSH state cannot authorize a
   write to the wrong Overleaf project;
6. uncertain concurrent changes are preserved as conflicts instead of choosing
   an unproved local or remote winner.

The complete synchronization state-machine rationale is in
[`local-replica-sync-audit-0.15.30.md`](local-replica-sync-audit-0.15.30.md).

## Upstream Disposition

| Upstream change | Disposition | Reason |
| --- | --- | --- |
| `ddb7145` tmp 0.2.7 | Adopted | Compatible maintenance update. |
| `8ed148b` connection resilience | Superseded and verified | The fork already disconnects old sockets, removes listeners, and disposes event handlers across its stronger session fence. A regression test now fixes this behavior. |
| `debdcb5` sync only on save | Not adopted | It would miss closed files modified by agents and shells, violating the primary Local Replica use case. Watchers remain the low-latency path and the compile barrier remains the correctness fallback. |
| `3f6fd42` Node 22 cookie login | Adapted | Upstream `undici 8` requires a newer Node than VS Code 1.80 provides. A small auth-only `http`/`https` transport preserves raw `Set-Cookie` headers on Node 16 through 24 while general API, upload, and download paths retain `node-fetch`. |
| `4ec7d6e`, `d49e70c`, `bb83a59`, `bf2d704`, `4fb8623` dependency updates | Adopted | The compatible shell-quote, form-data, linkify-it, markdown-it, and js-yaml updates are present in the regenerated locks. |
| `3f43b21` dummy-commit revert | No product change | It changes no runtime behavior. |
| `72e8f4d` upstream 0.15.10 metadata | Replaced | This fork releases the reviewed port as 0.15.31. |

`uuid` is updated to 11.1.1 rather than upstream 14 so the packaged extension
continues to run on the minimum VS Code host. Runtime ignore matching uses
`picomatch 4.0.5` instead of the newly vulnerable brace-expansion path, and the
legacy Overleaf Socket.IO client resolves patched `ws 5.2.5`. These choices
produce a zero-finding production dependency audit.

## Authentication Design

Only the login bootstrap uses the compatibility transport. It deliberately:

- requests identity-encoded responses;
- reads every raw `Set-Cookie` header;
- merges cookies by name and replaces stale values;
- preserves `=` inside cookie values;
- uses the standard `Location` header with the legacy response-body redirect
  only as a fallback;
- accepts only a normalized redirect with the configured origin and exact
  `/project` pathname.

Password, browser-cookie, multi-cookie, cookie-replacement, absolute redirect,
and JSON error paths are covered by local HTTP integration tests. The signed-in
demo validates the same candidate `cookiesLogin` code against Overleaf.

## Security and Compatibility

- `npm audit --omit=dev`: 0 vulnerabilities.
- Chat webview production audit: 0 vulnerabilities.
- `ws 5.2.5` passed the legacy Socket.IO automated handshake tests and a real
  v2 `joinProjectResponse` for `Local Replica Sync Demo`.
- `picomatch 4.0.5` passed protected-path, LaTeX-output, and brace-glob
  compatibility tests.
- Node 18 and Node 22 compile and lint pass.
- VS Code 1.130.0 and 1.80.2 each pass 272 source-checkout tests.
- Independent final review reports no unresolved P0, P1, or P2 finding.

No research project or research folder was mutated. Live validation used only
`Local Replica Sync Demo`; the read-only socket join and compile did not change
project files. Existing research extension-host processes were left running.

## Release Artifacts

- Main: `semantic-researcher-overleaf-0.15.31.vsix`
  - 1,255 archive entries
  - 7,366,751 bytes
  - SHA-256
    `66f317b01a673d748f81e733b22407807bfcc270242d5826edb43920712d774f`
- Remote Pack: `semantic-researcher-overleaf-remote-pack-0.15.31.vsix`
  - 301 archive entries
  - 1,839,675 bytes
  - SHA-256
    `9887dd47579ddb1ad9a9a61d68a7ec169b8ddcebff8e54803ea9fd3990bbfc41`

The Main VSIX was unpacked without replacing any product file. The compiled
test bundle and a development-only Mocha link were placed beside the unpacked
extension, so relative imports resolved the packaged `extension/out` modules.
That exact package passed all 272 tests on VS Code 1.130.0 and 1.80.2. The
Remote Pack manifest used by the host-placement test was extracted from its
separately built VSIX. Neither archive contains the test bundle, temporary
release harnesses, or live probes.

## Release Gate

- [x] Upstream changes classified by product contract.
- [x] Closed-file and media synchronization behavior preserved.
- [x] Ctrl+S and manual/PDF compile behavior preserved.
- [x] Runtime production dependency audit is clean.
- [x] Current and minimum VS Code source tests pass.
- [x] Signed-in demo cookie login, compile, and socket join pass.
- [x] Independent source review has no P0, P1, or P2 finding.
- [x] Main and Remote Pack VSIX artifacts built and inspected.
- [x] Exact unpacked Main VSIX tests pass on both VS Code versions.
- [x] GitHub and `/workspace/Overleaf-Workshop` point to the same release commit.
