# Local Replica Sync Audit and Review Handoff (0.15.30)

## Purpose

This document records the product intent, design decisions, fixes, and evidence
for the 0.15.30 Local Replica release candidate. It is written for an
independent reviewer who needs to judge whether the approach is correct, not
only whether the tests pass.

The full 0.15.29 state-machine design remains documented in
[`local-replica-sync-audit-0.15.29.md`](local-replica-sync-audit-0.15.29.md).
This document focuses on the additional review and hardening performed after
that release.

## Product Contract

`Select Project Folder Locally` should make a signed-in Overleaf project behave
like a normal local VS Code folder:

1. VS Code, shell tools, and coding agents can edit files that are open or
   closed.
2. Saved local text, media, and folder changes reach the Overleaf editor.
3. Collaborator changes reach local disk.
4. Add, edit, rename, and delete work in both directions for text, binary media,
   and folders.
5. Saving a supported source file is a synchronization barrier followed by a
   compile.
6. Manual Compile and PDF Recompile use saved disk state but do not save or
   include unsaved editor buffers.
7. SSH/Remote Pack placement, reload, project switching, logout, account
   switching, extension removal, and stale persisted state cannot authorize a
   write to the wrong project or account.
8. When a safe winner cannot be proved, both sides are preserved behind a
   persisted conflict.

Immediate refresh of the PDF displayed by the Overleaf website is not part of
the guarantee. File state in the Overleaf editor is the required guarantee.

## Release-Candidate Status

- Source checkout: `/workspace/Overleaf-Workshop`
- Demo replica: `/workspace/overleaf-local-replica-demo`
- Demo Overleaf project: `Local Replica Sync Demo`
- Current VS Code 1.130.0: 267 tests passing
- Minimum supported VS Code 1.80.2: 267 tests passing
- TypeScript and ESLint: passing without warnings
- Direct signed-in Overleaf compile using the extension's `BaseAPI`:
  `success`, 10 outputs, 0 `latexmk` errors, 0 LaTeX runs with errors
- Independent final source review: no unresolved P0, P1, or P2 findings
- Main and Remote Pack manifests and lockfiles: 0.15.30
- Exact unpacked Main VSIX: 267 tests passing on both VS Code versions

Only the demo project and demo replica may be changed during live validation.
Research projects and folders are out of scope.

## State and Host Isolation

### Dedicated project state

The old state nested SCM mappings inside the cached server project list. That
cache is refreshed by login/project enumeration and is not a durable ownership
boundary. A stale list could lose a selected folder; legacy data could also be
revived after a mapping was removed.

SCM mappings now use a dedicated key:

`semantic-researcher-overleaf.project-scms.<server>.<user>.<project>`

The server, authenticated user, and project are all encoded in the key.
Migration reads a legacy mapping only when its authenticated user matches.
Writing an empty map creates a tombstone so a removed legacy mapping cannot
reappear.

### Account-bound VFS

A persisted Local Replica URI contains its server, user, and project identity.
VFS creation now succeeds only when the current authenticated server state
exists and its user ID matches that URI. The VFS captures the exact CSRF token
and cookie identity used to create its socket. Every later VFS authentication
checks both the user and that captured identity, with a synchronous check
immediately before OT submission. A connected VFS surviving logout or session
replacement therefore cannot emit a write through its old socket.

Every awaited API or socket response is checked again before it mutates VFS
state. This includes initialization/settings, text and binary reads, document
and media creation and create verification, linked-file operations, OT
acknowledgement and readback, folder creation, rename/move/delete, compile,
SyncTeX, spelling, project settings, history, labels, archives, and chat. A
response that started under a removed session is discarded even if it arrives
successfully after login replacement.

Inbound collaboration events use the same fence. Removing an expired server
first disposes every VFS for that server and only then clears persisted login
state, so no socket handler remains authorized during the transition.

Login, project-list, tag, and logout responses also carry request/session
ownership outside the VFS. Only the latest overlapping login attempt may
publish credentials. Delayed project/tag responses cannot replace the new
account's tree or cache, and a delayed logout cannot clear a replacement login.
Even a previously cached VFS root is revalidated before `init()` returns it.

Missing server/login state returns an unavailable result instead of
dereferencing `undefined.login`. This specifically covers partial extension
state, removal/reinstallation, and a replica marker that outlives login state.

### SSH placement

- Main extension: `extensionKind: ["workspace"]`
- Remote Pack: `extensionKind: ["ui"]`

Filesystem watchers, manifests, conflict state, and sync code run beside the
selected folder in the SSH extension host. The Remote Pack remains local and
only supplies UI/browser-login commands.

### Single folder ownership

Two independent VS Code windows can otherwise restore the same marker, watch
the same disk edit, and submit the same OT change twice. This was reproduced in
the signed-in demo: two source IDs transformed one intended edit into duplicate
text.

Every active Local Replica now owns one localhost TCP listener chosen from a
deterministic 64-port sequence derived from the canonical selected-folder path.
The operating system permits only one listener and releases it automatically
when an extension host exits. Each candidate is probed with a root-specific
handshake: a listener for the same root rejects activation, while an unrelated
service or another root is skipped. The listener identifies the canonical root
hash, process, host fingerprint, project, and token.

The folder also contains a durable
`.semantic-researcher-overleaf/sync-owner.json` fence. A fully written temporary
record is atomically installed as the claim and elects a single owner when the
same filesystem is exposed from different hosts. A foreign-host or
incomplete marker is never reclaimed from a heartbeat timeout: without an
Overleaf-side fencing epoch, doing so could let a paused owner resume and write
concurrently. Same-host crash recovery is safe because the OS socket proves
that no prior process still owns the root before its dead-PID marker is
replaced.

Ownership transfer and release stop new watcher work, then wait for activation,
queued sync operations, in-flight VFS I/O, inode guards, and cleanup work. A
release failure keeps the canonical token and process map so the same provider
can retry without admitting another writer, including the case where its socket
has already closed. Detached and logged-out removal must temporarily acquire
this ownership before inspecting journals or removing the mapping.

An incomplete or legacy marker blocks activation. The explicit
`Repair Local Replica Ownership Marker` command snapshots it, requires modal
confirmation that every other window using the folder is closed, rechecks the
snapshot, and then quarantines and removes only that unchanged invalid marker.
It refuses to remove a valid current ownership record.

### Exact-folder selection

The exact-folder command now activates the project without eagerly restoring
older persisted SCMs. It creates the requested selection first and rolls that
activation back if the picker is cancelled. This prevents a stale mapping from
starting while the user is trying to select or switch a folder.

SCM settings use a local cache during creation. Settings are persisted only
after the SCM mapping exists, avoiding a dependency cycle during initialization.

Removing a Local Replica is a lifecycle operation, not only a state-map edit.
The extension first deactivates the matching SCM and its watchers, removes the
dedicated persisted mapping, and disposes the active project VFS when needed.
The local folder and marker remain intact. A workspace-scoped set records every
removed folder whose marker must not auto-restore it after reload; selecting
that exact folder again explicitly removes only its own suppression entry.
Removing an inactive replica neither disconnects nor changes the active root.

## Synchronization Safety

### Closed agent edits

The local watcher is the low-latency path. The compile barrier also scans saved
disk state against the manifest so an edit made by an agent to a closed `.tex`,
image, PDF, or directory is delivered even when no VS Code document or watcher
event exists.

The healthy save path has no fixed sleep, reconnect, or journal operation.
Retries retain an immediate first attempt and add delay only after failure.

The compile barrier queues each discovered push behind any watcher operation
already running for that path. It reclassifies deletes immediately before
execution, and reclassifies updates when they were queued, so a watcher that
finishes during the scan is accepted as already synchronized. This avoids both
a stale duplicate delete and a redundant second read of healthy large media.

### Removal and local inode fencing

Replica removal first closes admission and drains accepted watcher work,
pre-queue handoffs, pending debounce entries, compile scans, and in-flight VFS
I/O. A removal-sensitive classification uses retry offsets
`[0, 25, 100, 300]` ms only after an error. Persistent uncertainty blocks
mapping deletion so an already accepted local change cannot be forgotten.

On filesystems without Linux descriptor confinement, accepted local inode
guards are moved to durable detached records before mapping removal. A staged
record is recovered into the active journal after restart unless a durable
mapping-removal commit marker proves that removal won. Rollback runs in reverse
and removes a staged item only after both its inode and metadata restoration
succeed, so a partial rename or metadata-cleanup error remains retryable.

On Linux, the extension reads through the already opened descriptor and checks
device, inode, size, nanosecond modification time, and nanosecond change time
again after the read. A same-inode truncate or rewrite is rejected, while an
unrelated sibling change does not invalidate or delay the healthy read.

### Text and binary files

Text writes carry the authoritative Overleaf bytes used by Local Replica into
the VFS. The VFS sends OT only when the baseline still matches, accepts an
already-delivered result, or completes one verified three-way merge.

Binary media is never content-merged. It is compared and conflict-tracked by
content revision. Remote file-stat classification accepts Overleaf linked-file
bitmasks for pull only; local symbolic links are not treated as regular local
files. This allows linked images to arrive from Overleaf without weakening the
local path boundary.

An existing binary is replaced with a durable remote transaction:

1. write a journal keyed by path, old digest, and desired digest;
2. rename the proved old target to a hidden, non-overwriting stage;
3. create the desired target only if the visible path is still missing;
4. verify the desired target digest;
5. remove the stage, verify the target again, and then remove the journal.

Failed uploads restore the old stage. A lost upload response is accepted only
when remote readback proves the desired digest. If a collaborator creates a
different target during the operation, that target and the prior staged bytes
are both retained and the path becomes a conflict. Startup recovery runs before
ordinary reconciliation, restores an old-only stage, finalizes a proved desired
target, and blocks when target and stage are both missing.

Recovery preflights older unmarked journals before applying journal order. It
marks a journal superseded only when a newer completed transaction proves the
same result, restores a changed stage to its visible path before blocking, and
never guesses a winner when both target and stage are absent.

### Conflict proof

Each manifest conflict now stores:

- the exact saved local revision;
- remote path kind;
- remote content/tree revision;
- reason and timestamp.

A changed local revision is necessary but no longer sufficient to resolve a
conflict. Before any resolving push, Local Replica:

1. finds the exact or deepest ancestor conflict;
2. rejects the operation if a related initial pull is still unverified;
3. reconnects only on this exceptional conflict-resolution path;
4. captures the current remote revision;
5. compares it with the recorded conflict revision;
6. uses that verified target state for the write/delete.

If Overleaf changed again, the new remote revision is recorded and the push is
blocked. A later local edit can be accepted only after it is checked against
that new revision. Binary files and recursive folder conflicts use the same
remote-proof rule. Ancestor folder proof is refreshed after a verified child
operation and the ancestor is cleared only after the whole subtree is resolved.

Conflicts persisted by older releases may not contain remote proof. Startup
hydrates only those missing proof fields from current Overleaf state while
leaving the conflict's stored local digest unchanged. This makes the next
deliberate local revision a reviewed resolution attempt rather than silently
approving unchanged legacy bytes.

### Failed initial pull quarantine

`failedInitialPulls` is independent from conflict resolution. Neither an
explicit resolution option nor a changed local revision can bypass it for an
update or delete. The guard is cleared only by a successful authoritative pull
or an explicit verified absent/ignored outcome.

This prevents an unread or partially initialized local copy from becoming an
accidental remote-authoritative edit.

## Compile UX

| Action | Saves editor buffers | Sync barrier | Compile |
| --- | --- | --- | --- |
| Save supported source | VS Code saves that document | Saved URI plus closed-file scan | Yes |
| Save during compile | Saves that document | Flush now and queue one follow-up per project | Yes |
| Manual Compile | No | Saved-disk scan | Yes |
| PDF Recompile | No | Saved-disk scan | Yes |

Manual compile no longer force-saves all open documents. A source-file save
flushes its exact URI immediately, then compiles after delivery. Multiple saves
for one project coalesce into one follow-up; another project has an independent
queue.

Compile failures now log structured response information and unexpected
workflow exceptions. The live compile investigation proved that the demo
project currently returns a valid success response; the earlier UI
`Compile Failed` state came from a disconnected/incomplete VS Code host, not
from an unsupported Overleaf response shape.

## Finding-to-Fix Matrix

| Finding | Risk | Resolution | Evidence |
| --- | --- | --- | --- |
| SCM state nested in mutable project cache | Lost/revived mapping or cross-account restore | Dedicated server/user/project key and empty tombstone | State migration/isolation tests |
| VFS accepted only server name at authentication | Old VFS could use a newly logged-in account | Check persisted user at construction and every VFS request | Missing-state and account-mismatch tests |
| Late API/socket response survived logout | Old settings, file bytes, mutation result, or compile output could enter the new session | Exact session fence after every awaited API/socket response and on inbound events | Delayed settings/create/readback/logout tests |
| Overlapping login/project/tag/logout requests published late | An old request could replace the new account state or tree | Latest-login ownership plus exact-session checks before every persisted/tree update | Delayed login, project, tag, and logout tests |
| Cached VFS root bypassed `init()` authentication | A prefetch created under an old account could be returned later | Revalidate the exact session before every cached-root return | Cached-root logout test |
| Exact-folder selection restored older SCMs first | Stale replica could activate during switching | Defer persisted restore for exact-folder command | Command preparation and switch tests |
| Removing a replica only deleted its mapping | Live watchers could continue and the marker could revive the mapping | Stop SCM/VFS first and persist per-root restore suppression | Active/inactive removal and reload tests |
| Two extension hosts watched one selected folder | One disk edit could be submitted twice as separate OT sources | OS-lifetime same-host socket plus durable cross-host folder fence | External owner, handoff drain, foreign marker, and detached removal tests |
| Stale-lock rename used observation without compare-and-swap | A delayed contender could remove a new owner's lock | Permit stale replacement only after exclusive same-host socket proof; never reclaim foreign/incomplete markers | Foreign heartbeat and incomplete-marker tests |
| Ownership release preceded old transaction completion | A successor could replay an edit while old OT was still in flight | Drain activation, queues, VFS I/O, guards, and cleanup before release | Gated handoff and release-retry tests |
| Manual compile force-saved buffers | Unrelated draft text could be transmitted | Compile saved disk only; save event owns delivery+compile | Compile UX tests |
| Closed files depended on open editors/watchers | Agent edits could miss Overleaf | Watcher health fallback and compile-time exact scan | Closed text/media/folder tests |
| Watcher delete completed during compile scan | Compile barrier retried a stale delete and reported failure | Execution-time delete reclassification and already-synced acceptance | Queued-delete compile regression test and live probe |
| Removal discarded accepted debounce or classification work | A closed agent edit could be lost just before mapping deletion | Drain pre-queue/debounce work and block removal on persistent classification uncertainty | Transient/persistent classification and removal-flush tests |
| Detached guard staging was not restart-aware | A restart during replica removal could forget an accepted late inode write | Durable detached records, restart recovery, and mapping-removal commit marker | Restart-before-commit and late-write conflict tests |
| Partial rollback removed its own retry metadata | A rename or cleanup error could strand an inode without tracking | Reverse idempotent rollback that retires each item only after full restoration | Rename and metadata-cleanup fault-injection tests |
| Linux descriptor identity ignored same-inode mutation | A truncate/rewrite during read could be accepted as stable | Post-read device, inode, size, mtime, and ctime proof | Same-inode mutation and sibling-churn tests |
| Packaged tests loaded product modules from the source checkout | Duplicate module singletons could create false failures or false confidence | Allow an explicit packaged test path and external fixture paths so tests import the unpacked VSIX modules | Both version logs show product stacks under the unpacked `extension/out` path |
| Changed local conflict revision implied local wins | A second collaborator edit could be overwritten | Persist and verify remote conflict revision before push | Second remote text/binary tests |
| Binary proof-to-upload race | Collaborator media or the prior remote bytes could be lost | Durable stage, create-if-missing, digest-driven rollback/recovery | Upload/rename loss, collaborator race, cleanup, and restart tests |
| Legacy conflict lacked remote proof | Conflict could become permanently unresolved or be guessed | Hydrate proof while retaining the old local digest | Proof-less conflict restart test |
| Conflict resolution bypassed failed pull | Unverified local bytes could mutate Overleaf | Independent failed-pull guard for update/delete | Failed-pull conflict test |
| Linked files used exact `FileType.File` equality | Remote linked images could be skipped | Pull-only bitmask-aware classification | Linked entity stat test |
| Compile rejection lacked usable diagnostics | UI failure could not be separated from API/project failure | Structured response and workflow error logs | Direct live compile probe |

## Test Coverage

The 267-test suite includes:

- current and minimum VS Code extension hosts;
- pure local and SSH-compatible host placement;
- exact-folder selection, cancellation, switching, duplicate and stale mapping
  cleanup;
- open and closed source saves;
- closed agent edits with no watcher event;
- watcher startup failure, later event loss, recovery, and fallback shutdown;
- text and media add/edit/rename/delete in both directions;
- empty and populated folder changes in both directions;
- linked Overleaf media classification;
- restart reconciliation with valid, absent, malformed, and incomplete
  manifests;
- text three-way merge and binary conflict preservation;
- a second remote text or binary revision during conflict resolution;
- binary replacement upload/rename response loss, rollback, collaborator
  recreation, retained-stage cleanup, and crash recovery;
- failed initial pulls, retry, remote deletion, and quarantine;
- ambiguous OT acknowledgement, authoritative readback, and delayed sender
  events;
- durable local and remote delete journals;
- accepted pre-queue/debounce removal work, transient classification retry, and
  persistent-classification removal blocking;
- staged detached-guard restart recovery and rollback fault injection;
- open-inode late writes, same-inode mutation rejection, sibling-churn
  tolerance, and deterministic recovery;
- project/account/global-state lifecycle isolation;
- overlapping login/project/tag/logout response isolation and cached-root
  session fencing;
- active and inactive Local Replica removal, watcher teardown, tombstones, and
  marker-restoration suppression;
- external-host ownership rejection, host fingerprinting, unrelated-port
  fallback, same-process drained handoff, activation/removal races,
  foreign-host and incomplete-marker fail-closed behavior, explicit invalid
  marker repair, post-socket-close release retry, and ownership-safe detached
  removal;
- Ctrl+S compile queues and manual compile unsaved-buffer behavior.

Exact packaged-artifact verification unzipped the 0.15.30 Main VSIX, placed
only the compiled test bundle and a development-only Mocha link beside it, and
ran the tests from that unpacked extension path. No packaged product file was
replaced. Test fixtures received the actual repository root and the manifest
extracted from the separately built Remote Pack VSIX. Stack traces and the VS
Code launcher both reported the unpacked `extension/out` path, preventing the
source checkout from silently substituting its product modules.

Final release artifacts:

- `semantic-researcher-overleaf-0.15.30.vsix`: 1,258 entries, 7,406,263 bytes,
  SHA-256 `460ee19e9bd9a7109444fe275f5479914b79c4b1e9caa070727b6316fc8861c7`
- `semantic-researcher-overleaf-remote-pack-0.15.30.vsix`: 301 entries,
  1,839,675 bytes,
  SHA-256 `19f4008d37ffcb59145e16d3d1785282eaf111fbf8183cae8a70c317ac44cf9f`

Live validation used only `Local Replica Sync Demo` and
`/workspace/overleaf-local-replica-demo`. Candidate v11 was installed into the
SSH extension host, then tested through its signed-in Overleaf socket and API.
A closed local `.tex` file and a 159,444-byte PNG were created, updated,
renamed, and deleted on Overleaf. In the reverse direction, remote text, PNG,
and populated-folder create, update, rename, and delete operations reached
local disk. The renamed folder contained exact text and media hashes and the
old local folder did not reappear.

Two reloaded demo VS Code windows elected exactly one owner; the other was
blocked before watcher activation. The separate research extension hosts were
left running and untouched. After validation the demo project was restored to
its original privacy-safe tree, with no probe paths, sync conflicts, operation
journals, or manifest residue.

The direct compile probe used the exact extension API class and returned a
successful Overleaf build with 10 outputs and no LaTeX errors. The privacy-safe
demo tree was restored after every probe.

Headless DBus/GPU messages are environmental when the extension host exits 0.
`libgbm.so.1` resolves from `/lib/x86_64-linux-gnu/libgbm.so.1` in the test
host, so the former missing-library failure is no longer present.
The browser PDF refresh is not used as the file-sync oracle.

## Performance

- Normal watcher and save operations start immediately.
- The 250 ms watcher coalescing window is bypassed for the explicitly saved URI.
- Compile scans hash saved content to guarantee closed-file correctness.
- No healthy save waits for reconnect, conflict proof, journal fsync, or retry
  delay.
- Reconnect is reserved for ambiguous remote mutation recovery and explicit
  conflict resolution.
- General remote retry offsets remain `[0, 300, 900, 2400]` ms. Removal-time
  local classification uses `[0, 25, 100, 300]` ms. Both start immediately and
  add delay only after a failure.

The design favors immediate delivery on the healthy path while spending extra
network work only when correctness is uncertain.

## Reviewer Checklist

1. Confirm every VFS write uses the same authenticated user encoded by the
   replica URI.
2. Confirm no dedicated SCM state lookup omits server, user, or project.
3. Confirm every conflict-resolving push verifies the stored remote revision.
4. Confirm failed initial pulls cannot be cleared by conflict resolution.
5. Confirm a second remote text, binary, or folder change is preserved.
6. Confirm no manual/PDF compile saves editor buffers.
7. Confirm a source save flushes its saved URI before compile.
8. Confirm the healthy path has no fixed delay or reconnect.
9. Inspect and test the exact packaged VSIX, not only the source checkout.
10. Treat any unproved local-wins or remote-wins path as a release blocker.

## Release Gate

- [x] TypeScript and ESLint pass.
- [x] VS Code 1.130.0: 267 tests pass.
- [x] VS Code 1.80.2: 267 tests pass.
- [x] Signed-in demo compile succeeds with no LaTeX errors.
- [x] Independent final review has no unresolved P0, P1, or P2 finding.
- [x] Main and Remote Pack versions and lockfiles agree on 0.15.30.
- [x] Exact unpacked Main VSIX passes 267 tests on VS Code 1.130.0 and 1.80.2.
- [x] Remote Pack packages successfully and its extracted manifest is tested.
- [x] VSIX names, metadata, hashes, and changelog agree.
- [x] Temporary credentials, test extensions, transfer files, and isolated
      state copies are removed.
- [x] `/workspace/Overleaf-Workshop` and GitHub contain the same final commit.
