# Official Overleaf realtime audit for 0.16.0

## Scope and reference

The official [`overleaf/overleaf`](https://github.com/overleaf/overleaf) repository was
cloned read-only to `/workspace/overleaf-official` and audited at commit
`28ad3b03b71c`. The clone is reference material only; the extension remains in
`/workspace/Overleaf-Workshop`.

The official realtime invariant is not “read a document and subscribe later.”
The server joins the document room and subscribes to applied operations before it
returns the joined document snapshot. A reconnecting web client supplies its known
version, catches up missing operations, processes them in version order, and fails
closed when a version gap cannot be recovered.

Relevant official implementation points:

- `services/real-time/app/js/WebsocketController.js` (`joinDoc`)
- `services/real-time/app/js/RoomManager.js` (room subscription)
- `services/real-time/app/js/DocumentUpdaterController.js` (applied-operation feed)
- `services/web/frontend/js/features/ide-react/editor/document-container.ts`
  (client join with `fromVersion`)
- `services/web/frontend/js/features/ide-react/editor/share-js-doc.ts`
  (ordered operation application and gap handling)

## What the extension adopts

The stateless HTTP batch is only a fast bootstrap. It must never populate the VFS
document cache as an authoritative joined document, because that would let VFS
skip `joinDoc`. Every bootstrapped text document therefore stays in
`pendingInitialDocumentSubscriptions` until a current `joinDoc` read has passed
the ordinary Local Replica guarded pull/merge path.

The VFS serializes document joins because the Overleaf socket protocol has a
single join epoch. It retries when collaborator revision changes during a read,
and fails closed if the document never becomes coherent. Compile waits for the
pending-subscription set to clear.

Regression coverage:

- `src/test/suite/lifecycleIsolation.test.ts`: join retry, continuous collaborator
  advance, version/ack ambiguity and reconnect isolation.
- `src/test/suite/snapshotSubscriptionHandoff.test.ts`: HTTP snapshot A followed
  by remote B, simultaneous local L/remote R, failed join then recovery, and
  teardown during verification.

## Why the complete official web algorithm is not sufficient locally

Official browser editing has one server-owned version stream for an open text
document. Local Replica is a multi-writer adapter across that stream and an OS
filesystem. Agents, shells and local compilers can replace inodes, write partial
files, change closed documents, create binary/media entities, rename directories,
work offline, or delete paths through APIs that do not offer text OT or a remote
conditional mutation.

Consequently the official version/ACK rules are necessary for text but do not
replace the manifest baseline, stable local reads, guarded binary replacement,
three-way merge, ownership fence, or persisted conflicts. Those extra mechanisms
exist to provide the same user-level property across a wider system: no uncertain
state silently chooses a winner.

## Remaining-item disposition

| Priority | Item | Disposition | Evidence |
| --- | --- | --- | --- |
| P0 | Clean/new/deleted path changes after the first compile scan | Closed | `flushBeforeCompile` performs its ordinary whole-tree source scan, publishes discovered changes, waits for the quiet window, and then reuses the same whole-tree scanner against the current manifest; three boundary tests are in `stableSnapshotPush.test.ts`. |
| P0 | HTTP snapshot to Socket.IO subscription race | Closed | Official join ordering retained; four upper-layer handoff tests plus the existing VFS epoch/version tests pass. |
| P0 | Extension activation through PDF webview | Closed at the strongest deterministic VS Code test boundary | The extension-host suite proves the production command/custom-editor registrations and the missing-output → ready → render-ACK cache protocol. VS Code exposes no API for injecting into or inspecting the isolated PDF.js DOM; the actual signed-in Remote SSH reload/compile/render path is therefore retained as live validation. |
| P1 | Registered Select Folder cancel/rollback | Closed | The activated host is checked for the production command and the same production registration factory is executed through the VS Code command registry with deterministic downstream cancellation; direct folder-policy tests remain separate. |
| P1 | Actual HTTP/2 stream, GOAWAY and concurrency | Closed | A real local Node HTTP/2 server verifies the eight-stream ceiling, request ordering, authenticated fallback after GOAWAY, and prompt fallback after RST. |

Validation at the close of this audit: `430 passing` on VS Code 1.130.0, with
TypeScript compilation and ESLint included in the test command.
