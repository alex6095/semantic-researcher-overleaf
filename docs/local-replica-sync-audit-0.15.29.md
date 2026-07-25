# Local Replica Sync Audit and Review Handoff (0.15.29)

## Status

This document describes the 0.15.29 Local Replica work before release. It is
intended to let another engineer or review agent evaluate the design, not just
the final diff.

- Package version under test: `0.15.29`
- SSH source checkout, VS Code 1.130.0: 166 tests passing
- TypeScript and ESLint: passing
- SSH minimum supported VS Code 1.80.2: 166 tests passing
- Packaged VSIX: exact unpacked artifact passed all 166 tests on VS Code
  1.130.0 and installed as `alex6095.semantic-researcher-overleaf@0.15.29`
- Final VSIX SHA-256:
  `b1f28a71d0b82c6866c6583fcf11c0cec38e59e2a5d8ec7e5974d9246e871a02`
  (`7,380,787` bytes)
- Signed-in Overleaf demo: the final source passed the guarded live round trip
  described under Test Coverage and restored the privacy-safe demo tree.
- Independent review: compile, lint, and 166 tests passing; no unresolved
  P0/P1/P2 findings
- Release commit: prepared from the reviewed final diff; GitHub push was
  explicitly requested

Do not treat the version number alone as a release signal. The release gate is
the checklist at the end of this document.

## Product Intent

`Select Project Folder Locally` should make an Overleaf project feel like a
normal local VS Code folder:

1. VS Code, shell tools, and coding agents can edit any project file, including
   files that are not open in an editor.
2. Saved local changes reach Overleaf, and collaborator changes reach disk.
3. Text, binary media, empty folders, renames, and deletes work in both
   directions.
4. A source-file save is a delivery barrier and then triggers compilation.
5. Manual Compile and PDF Recompile use saved state. They do not save or include
   unsaved editor buffers.
6. Reload, reconnect, SSH extension-host placement, and project switching do not
   let stale work mutate the newly active replica.
7. When the extension cannot prove which side is newer, it preserves both sides
   and records a conflict instead of applying a hidden "local wins" or "remote
   wins" rule.

Instantaneous refresh of the PDF displayed in the Overleaf website is not a
requirement. Editor/file synchronization is the required guarantee.

## State Model

The implementation is based on five invariants:

1. **No verified baseline, no automatic winner.**
   One-sided or differing state is quarantined unless a per-path common
   baseline proves a safe action.
2. **The remote bytes used to decide a write follow that write into the VFS.**
   A Local Replica document push supplies its authoritative remote snapshot to
   the VFS. If the VFS has advanced, it performs one verified three-way merge;
   if that cannot be proven safe, it sends no OT and persists a conflict.
3. **Durable intent precedes a destructive rename.**
   Local swaps/deletes and remote staged deletes write an operation record
   before the visible path is hidden.
4. **A stale generation cannot commit state.**
   Async reads, retries, manifest publication, startup activation, and review
   imports recheck their owning generation after awaited work.
5. **The healthy edit path does not pay recovery costs.**
   Reconnect, operation journals, directory fsync, and authoritative refresh
   are reserved for destructive or ambiguous paths. The first normal push
   attempt is immediate.

### Per-path baseline

`.semantic-researcher-overleaf/sync-manifest.json` is an atomic, serialized
manifest with:

- project identity;
- `baselineComplete`;
- file remote fingerprint, local SHA-1, size/mtime, and optional mergeable text
  baseline;
- tracked directories;
- persisted path conflicts with reason and local conflict revision.

The loader accepts v1/v2 manifests for migration, but validates the complete
runtime shape:

- `baselineComplete` must be boolean when present;
- paths must be absolute canonical replica paths;
- file and directory entries cannot describe an impossible tree;
- sizes, timestamps, SHA-1 values, dates, and base64 text baselines are checked;
- a text baseline must hash to the stored local digest.

A missing manifest in a genuinely new selected folder is a fresh baseline. A
missing, malformed, wrong-project, or incomplete manifest in a pre-existing
replica is an unavailable baseline. Identical local/remote text or media can
establish a new baseline; differing or one-sided paths become conflicts.

`baselineComplete` remains false while any initial pull is unverified. It is
promoted only after both the failed-pull set and conflict set are empty. Retry
and explicit ignore actions persist that transition.

### Three-way merge

Text is auto-merged only when all three inputs are available and decodable:

- stored common base;
- current saved local bytes;
- current authoritative Overleaf bytes.

`node-diff3` is pinned to `3.2.1`. Any conflict region, binary input, missing
base, or unsupported content falls back to an explicit conflict. Binary/media
state is never content-merged.

The same merge helper is used by the Local Replica state machine and the VFS
document-write boundary. This avoids two subtly different definitions of a
"safe" merge.

### Baseline-aware VFS writes

Local Replica may already have merged saved local bytes with an authoritative
Overleaf read before it asks the VFS to emit OT. A closed-document VFS cache can
lag behind that read, so applying its cached remote delta to the already-merged
content would duplicate the collaborator edit.

`writeFileFromRemoteBaseline` therefore receives the exact remote bytes used by
Local Replica:

1. if the current VFS remote cache still equals that baseline, emit only the
   desired delta;
2. if the current VFS remote cache already equals the desired bytes, treat the
   operation as delivered and emit no duplicate OT;
3. if the cache advanced again, three-way merge baseline/desired/current once;
4. if that merge conflicts, emit no OT and return a typed conflict to the Local
   Replica state machine.

Writes to one Overleaf document are serialized. Before sending OT, the VFS
registers the submitted version and collaborator revision, then waits for
Overleaf's sender-only `otUpdateApplied` event. In the healthy case with no
collaborator operation, that event is the completion signal and no extra
authoritative join is needed.

The alternative non-Socket.IO transport has no sender-applied event; its
successful write callback remains the completion signal, so this safety work
does not add a five-second wait to that mode.

If a collaborator OT arrives while the write is in flight, or if the socket ACK
is lost, the VFS rejoins the document and uses the authoritative text/version:

- a confirmed sender event means the returned authoritative state includes the
  submitted operation, even if Overleaf transformed it;
- without that event, success is allowed only when a three-way proof shows the
  desired change is already contained in the authoritative result;
- an explicit rejection against an unchanged authoritative base may use the
  bounded retry policy;
- an ACK timeout or otherwise ambiguous result is never retransmitted
  automatically. It becomes a persisted Local Replica conflict;
- if the post-submit authoritative rejoin itself fails, the failure is also
  typed as ambiguous, caches are invalidated, and Local Replica cannot retry
  against the pre-submit cache.

Because sender-only events do not carry a request ID, any submission that
finishes without a correlated sender event leaves an in-doubt version barrier.
A later write while that barrier exists cannot take the sender-event fast path:
it performs an immediate authoritative rejoin, without waiting five seconds.
An uncorrelated sender event consumes the oldest barrier; if it might instead
belong to the current submission, the current version becomes the replacement
barrier. An explicit rejection can therefore never be converted into success
by a delayed event from an earlier write.

An authoritative rejoin can overtake a delayed sender event. Older sender-only
events contain no operation, so they can clear their in-doubt barrier but
cannot invalidate content or acknowledge a newer pending write.

The VFS returns the bytes actually written. Local Replica writes those bytes
back to disk before publishing the manifest, so disk, manifest, and Overleaf
share one final revision.

### Persisted conflicts

Conflicts are not only an in-memory warning. The manifest stores the path,
reason, and exact local revision seen when the conflict was created. This is
needed for cases that cannot be reconstructed from content alone, such as a
same-content remote file recreated during an interrupted delete.

The conflicted revision is blocked. A later saved local revision can be treated
as an explicit resolution and, after successful synchronization, removes and
persists the conflict. Ancestor folder conflicts are cleared only after their
state is verified as resolved.

## Normal Paths

### Local save to Overleaf

1. VS Code writes the document to disk.
2. `onDidSaveTextDocument` passes only that saved local URI to the compile
   manager.
3. The Local Replica compile barrier flushes or synthesizes its push, bypassing
   the normal 250 ms watcher debounce.
4. Remote readback and manifest state are verified.
5. Compilation starts only after the saved disk state is delivered.

There is no VFS reconnect, operation journal, directory fsync, or fixed retry
sleep before the first healthy push attempt.

### Closed files and agent edits

The local file watcher handles the ordinary real-time path. Before every
compile, a fallback scan compares the complete saved project tree against the
manifest and current sync state. It catches:

- closed source edits and deletes;
- media edits, additions, renames, and deletes;
- empty folder additions/deletes;
- changes missed because the watcher was unavailable or exhausted.

The scan hashes content even if size and mtime are unchanged. That full-content
check is deliberately retained: removing it would weaken the explicit
"closed-file changes are guaranteed before compile" requirement.

Watcher construction succeeding does not prove that events are being delivered.
An asynchronous health monitor writes an ignored metadata probe after startup
and after each one-second idle health interval, then waits up to 750 ms for the
matching event. Real watcher activity postpones the next probe. Neither startup,
Ctrl+S, nor an ordinary watcher-driven edit awaits this diagnostic.

If a probe event is missing, Local Replica shows one warning and enters the
generation-scoped degraded state, with an exact-content scan every 750 ms.
Scans do not overlap. Probes continue while degraded; a later probe or real file
event returns the state to healthy and immediately stops scheduling full scans.
Each probe object owns its generation and timeout, and the complete probe is
registered as session I/O. Disposal resolves that exact probe; an old probe's
cleanup can neither clear a new session's timer nor outlive session draining.
All timers and in-flight ownership are generation-checked and stop on
disposal/reload. This covers startup failure, a watcher that dies later, false
degradation, text, media, folders, and deletes between compiles; the compile
barrier remains the final delivery guarantee.

### Echo suppression

The short-lived directional digest cache only suppresses an event when the
current manifest/base also proves that the bytes are synchronized. Every
successful push or pull advances both directional synchronized digests. Thus an
immediate transport echo is ignored, while a real A-to-B-to-A local revert is
not confused with the historical first A.

### Remote collaborator update to disk

Remote events are coalesced per path and pulled through the same merge/conflict
logic. Out-of-order OT invalidation now emits a file-change notification so
Local Replica performs an authoritative join/read instead of leaving stale
cached text on disk.

## Exceptional and Destructive Paths

### Local operation journal

Local pull writes and pull-side deletes use:

`<replica>/.semantic-researcher-overleaf/operations/`

Each operation has a durable JSON intent, an optional committed marker, and a
tracked old-inode guard. The intent file is fsynced and renamed atomically
before the visible path is moved. Relevant directory renames are followed by a
best-effort directory fsync.

Recovery distinguishes:

- prepared but not installed;
- installed but not committed;
- committed with an unchanged old inode;
- old inode changed through a previously open descriptor;
- target recreated while rollback was in progress;
- file-to-directory or directory-to-file replacement.

Hard-link restore is preferred because the original inode becomes visible.
When hard links are unavailable, exclusive copy restore retains the original
inode under its journal guard so a later write is still detectable.

Committed guards are checked before compile and after activation. If an old
descriptor changed one, that inode is restored to the visible path and a
conflict blocks compilation. Concurrent visible bytes are moved to
`concurrent-recovery` rather than discarded.

On Linux/SSH, unchanged guards are released in the background only after
`/proc/*/fd` proves that no open descriptor references the guard or any guarded
descendant. This cleanup is not awaited by the current compile. If the platform
cannot prove descriptor closure, the guard is retained for safety.

### Remote delete journal

Remote deletes use a deterministic same-directory stage:

`.sr-overleaf-delete-<operation-id>`

and a durable local record under:

`.semantic-researcher-overleaf/remote-delete-operations/`

On activation, a retained stage is resumed or restored. Lost API responses
trigger a one-shot VFS reconnect before reconciliation so the decision is based
on a newly joined authoritative project tree, not the pre-request cache.

The target is checked again after stage deletion. If a collaborator recreated
it, even with identical bytes, it is preserved and a persisted conflict blocks
future retries.

### Retry policy

Push and pull use `[0, 300, 900, 2400]` ms attempt offsets. The first attempt is
immediate. Delays occur only after a failed operation. Between attempts the
code passively observes the existing connection state instead of starting a
reconnect storm. Compile-on-save therefore has no artificial healthy-path
delay, but a failing network can delay or cancel compile rather than compiling
known-stale state.

## Compile UX

The prior implementation saved all dirty documents when Compile was invoked.
That did not match the requested UX and could include unrelated unsaved work.

The current contract is:

| Action | Saves editor buffers | Local Replica barrier | Compile |
| --- | --- | --- | --- |
| Save supported source | VS Code saves that document | Flush saved URI plus closed-file fallback scan | Yes |
| Save while compile is running | Saves that document | Flush immediately | Queue one coalesced follow-up per project |
| Manual Compile | No | Scan saved disk state | Yes |
| PDF Recompile | No | Scan saved disk state | Yes |

Supported save-trigger extensions include TeX sources and common bibliography,
class, style, and configuration sources.

The follow-up queue is keyed with the same normalized server/user/project
identity as the VFS. Saves in different projects cannot replace each other,
while saves of multiple documents in one project coalesce into one follow-up
compile with all saved local URIs retained.

## Lifecycle and SSH Isolation

- The main extension is `extensionKind: ["workspace"]`; it owns filesystem,
  manifest, watcher, and sync state in the SSH/WSL extension host.
- The Remote Pack remains a UI extension and only forwards commands.
- VFS identity is keyed by server authority, user, and project, not by a raw
  query string or display/project path.
- VFS/provider disposal is idempotent and tears down socket, watcher, SCM,
  collaboration, timers, and event emitters.
- Local Replica has a monotonically increasing generation. Reactivation drains
  already-started owned I/O; old reads cannot adopt a new generation.
- Persisted Local Replica mappings are validated against the marker's project.
  Missing mappings are removed, temporarily unavailable mappings are retained,
  and duplicates are reduced to the active valid mapping.
- SCM creation rechecks disposal after slow marker inspection and trigger
  initialization.
- Agent Review activation/imports are serialized and generation-checked so a
  previous replica cannot publish into the new root.

## Remote API and Collaboration Corrections

- Rejected add-document, upload, create-folder, rename, move, and delete
  responses now throw. A rejected server mutation can no longer be recorded as
  synchronized.
- Socket.IO v2 project data is passed through the handshake `query` option.
- Collaboration cursor updates tolerate a reconnecting/missing tree, validate
  positions, and dispose decorations/timers safely.
- Clean editor refresh uses disk reversion without invoking save participants,
  skips dirty models, and rechecks focus/document identity.

## Finding-to-Fix Matrix

| Finding | Why it mattered | Resolution | Evidence |
| --- | --- | --- | --- |
| JSON-valid malformed manifest trusted | Could authorize a false baseline | Full structural and semantic validation | Invalid type/entry tests |
| Local path hidden before durable intent | Reload could strand original bytes | Durable local operation record before rename | Interrupted write/delete tests |
| Remote delete stage had no recovery intent | Reload could leave remote path hidden | Durable deterministic remote-delete journal | Reactivation resume test |
| Ambiguous API result used stale VFS | Could repeat an already-applied mutation | Reconnect before authoritative reconciliation | Stale-cache lost-response test |
| Original write inode changed after final check | Late agent bytes could be unlinked | Committed inode guard and compile recovery | Post-write guard test |
| Deleted/quarantined inode changed late | Late bytes could disappear | Same guard protocol for deletes | Post-delete guard test |
| Rollback failure swallowed | User saw neither error nor recovery path | Surface error and retain journal/guard | Rollback failure + restart test |
| File/folder type replacement | Startup could abort or overwrite a side | Preflight conflict and subtree block | Both replacement directions tested |
| Copy fallback lost ongoing inode | Copy restored a snapshot, not future writes | Keep original inode guarded | EXDEV plus late-write test |
| Conflict mutation crossed generation | Old read could poison new session | Recheck generation before all mutation | Stale conflict-read test |
| SCM disposed during marker read | Disposed manager could resurrect watchers | Post-await disposal checks | Slow marker disposal test |
| Remote target recreated after stage delete | Retry could delete collaborator recreation | Authoritative post-delete target check | Post-stage recreation test |
| Global pending-compile slot | A save in project B could replace project A's follow-up compile | Ordered, normalized per-project compile queue | Multi-project and same-project-document queue test |
| Closed-document VFS cache lagged behind Local Replica's remote read | Reapplying the cached remote delta could duplicate collaborator text | Baseline-aware VFS write, one exact rebase, typed conflict, actual-byte readback | Stale-cache, later-remote, lost-response, and same-line-conflict OT tests |
| OT ACK was lost after the server applied the update | Generic retry could submit the same edit twice | Sender applied-event correlation, authoritative proof, typed ambiguity conflict with no retry | Applied-with-event, applied-without-event, ambiguous-timeout, and persisted-conflict tests |
| Collaborator OT arrived while a local OT was in flight | Pre-ACK cache publication could overwrite transformed collaborator state | Per-document serialization, collaborator revision tracking, authoritative rejoin | Controlled collaborator-before-sender race test |
| Post-submit authoritative readback failed | Generic error handling could retry the uncertain OT against stale cache | Convert every failed post-submit reconciliation to typed ambiguity and invalidate caches | Failed-readback no-retry test |
| Delayed sender event arrived during a later write at the same revision | An old event could approve a rejected conflict-resolution write | In-doubt version barriers plus mandatory immediate authoritative reconciliation | Delayed-sender/rejected-write test |
| Directional echo cache remembered an old digest | A legitimate A-to-B-to-A revert could be swallowed | Advance both synchronized digests and require current manifest proof | A-to-B-to-A revert test |
| Watcher object existed but emitted no events | Closed text/media/folder/delete edits could wait until compile | Continuous health state, degraded 750 ms exact scans, recovery stop | Zero-event and healthy-to-dead-to-recovered watcher tests; SSH ENOSPC run |
| Old watcher probe completed after a new sync session started | Its shared cleanup could clear the new probe timeout and disable fallback forever | Per-probe generation/timer ownership plus session I/O draining | Cross-generation probe-timeout test |
| Persisted binary conflict received another watcher event | A later watcher could clear the conflict and overwrite one side | Block every ordinary push touching a persisted conflict until explicit resolution | Reloaded binary-conflict watcher test and live demo conflict check |
| Remote folder rename emitted only the folder event | Closed descendants could remain at the old local path | Emit the exact created subtree and delete the old subtree | Nested remote folder rename test and live demo folder rename |
| Path-component rename used global string replacement | Matching text in a parent folder name could be corrupted | Replace only the final path component | Exact final-component rename test |
| Concurrent writers each reconnected | Repeated state resets caused socket storms and stale managers | Share one in-flight reconnect per VFS | Concurrent reconnect test |
| Agent Review import overlapped project activation | Review output from one replica could publish into another | Serialize activation/import and drain old project work | Agent Review activation, interception, and disposal tests |
| Platform reported a local delete as `Change` | The missing file could be recreated remotely or the delete ignored | Reclassify from current disk state at debounce execution | Change-as-delete watcher test |
| Delayed remote echo followed a newer local delete | Old remote content could resurrect the deleted local file | Reclassify queued local intent and preserve current pending state | Delayed-echo-after-delete test |
| Local path was recreated while remote delete was in flight | Delete completion could clear the newer create event | Preserve pending local events and queue the recreated state after delete | Local recreate and concurrent remote recreate tests |
| Local or remote event classification failed transiently | Removing pending intent before `stat`/read could silently lose the change | Emit an explicit error, retain intent, and retry after 750 ms | Local and remote classification retry tests |
| Collaborator created a file after missing-path preflight | Baseline-free write could merge against or overwrite the new remote copy | Carry `expectedRemoteMissing` into VFS execution; accept identical bytes or persist conflict after authoritative recheck | Injected collaborator-create race test |
| Local directory collided with a remote file/folder | Blind `addFolder` could repeat, duplicate, or hide a type conflict | Guard directory creation at VFS execution and persist type conflicts | Directory/file type-conflict test |
| Failed remote readback returned empty bytes | An empty local file could be falsely recorded as synchronized against unknown remote content | Throw on failed downloads and use authoritative document/file reads for create verification | Empty create with failed readback test |
| Server explicitly rejected create/upload/folder mutation | Retrying could reconnect the whole project four times for a deterministic error | Typed non-retryable mutation rejection; reconnect only for uncertain transport outcomes | No-reconnect and single-attempt rejection tests |

Additional corrected cases include incomplete baselines during partial pull,
identical legacy media baseline establishment, persisted conflict resolution,
folder preflight, ignored descendants, and same-size/same-mtime media edits.

## Test Coverage

The extension-host suite currently covers:

- compile/manual-save semantics and queued compile-on-save;
- cross-project compile queue ordering and same-project document coalescing;
- local and remote text/media additions, edits, renames, and deletes;
- empty and populated folders in both directions;
- closed source/media edits without watcher events;
- complete degraded-mode reconciliation when a watcher emits no events;
- execution-time watcher reclassification, retained classification failures,
  and bounded retry in both directions;
- same-size/same-mtime content changes;
- three-way offline and live merge ordering;
- stale closed-document VFS baselines, exact-once OT, and conflicting rebase;
- ACK loss with and without sender events, in-flight collaborator OT, and
  ambiguous no-retry conflict persistence;
- failed post-submit readback and delayed sender events crossing a later
  rejected write;
- same-document write serialization and the alternative-transport fast path;
- directional echo suppression with a legitimate A-to-B-to-A revert;
- one-sided, invalid, incomplete, and legacy baselines;
- persisted conflicts and explicit resolution;
- expected-missing file/folder creation races and persisted path-type conflicts;
- generation, disposal, reconnect, and manager initialization races;
- watcher probe timeout ownership across sync generations;
- local/remote operation crashes and ambiguous API responses;
- hard-link failure and open-inode writes;
- exact-folder safety and persisted mapping validation.

Primary commands:

```bash
npm run compile
npm run lint
npm test
VSCODE_TEST_VERSION=1.80.2 npm test
npm run package:vsix
```

Final release evidence:

- SSH source checkout, VS Code 1.130.0: 166 passing.
- SSH source checkout, VS Code 1.80.2: 166 passing.
- Exact unpacked VSIX as the Extension Development Path on VS Code 1.130.0:
  166 passing.
- Isolated VSIX install:
  `alex6095.semantic-researcher-overleaf@0.15.29`.
- Package inspection: version `0.15.29`, engine `^1.80.0`,
  `extensionKind: ["workspace"]`, `node-diff3@3.2.1`, compiled ambiguity and
  watcher-generation logic present, and no `out/test` or `.vscode-test`.
- Final VSIX SHA-256:
  `b1f28a71d0b82c6866c6583fcf11c0cec38e59e2a5d8ec7e5974d9246e871a02`
  (`7,380,787` bytes).
- SSH Electron prerequisite: `libgbm.so.1` resolves through `ldconfig` to
  `/lib/x86_64-linux-gnu/libgbm.so.1`.
- Live project `Local Replica Sync Demo`
  (`6a64b46f14a23ec9404de18b`) with the hard-coded local root
  `/workspace/overleaf-local-replica-demo`: passed initial pull, unopened text
  push, unopened PNG push, local text delete, remote text pull, remote media
  add/delete, remote folder rename with descendant pull, restart-manifest
  restore, and persisted binary-conflict blocking. The harness asserted the
  exact demo project ID and name before any mutation, then restored the
  privacy-safe documentation state containing only `main.tex`,
  `sections/agent-edit.tex`, and `figures/sync-status.png`.

## Performance Assessment

Healthy-path properties:

- save-triggered push starts immediately;
- save bypasses watcher debounce;
- watcher health diagnosis is asynchronous and never gates startup or save;
- real watcher activity postpones the next lightweight health probe;
- healthy watchers do not run periodic fallback scans;
- healthy document OT waits on an event, not a fixed sleep, and avoids
  authoritative rejoin when no collaborator raced it;
- no reconnect on healthy push or pull;
- no local/remote operation journal on a healthy local push;
- no fixed sleeps before success;
- guard descriptor scans run after compile in the background.

Costs intentionally retained:

- A compile barrier reads/hashes saved project content to guarantee detection
  when watcher events and metadata are insufficient.
- After one second without observed watcher activity, a 750 ms probe timeout
  enables exact scans every 750 ms. Thus a watcher that dies after startup is
  normally detected within 1.75 seconds plus scheduler jitter; the first scan
  starts immediately, and scan/network runtime is additional.
- An OT ambiguity or a write following an in-doubt sender event pays for an
  authoritative rejoin. The follow-up skips the fixed sender-event wait and
  rejoins immediately. This is a failure/concurrency cost; the ordinary
  uncontended sender-event path does not perform that read.
- Network failures consume the bounded retry budget.
- Non-Linux platforms retain unchanged old-inode guards because descriptor
  closure cannot be proven with the available APIs.

It is not possible to simultaneously guarantee detection of a missed
same-size/same-mtime edit and skip reading that file without another trusted
change journal. The implementation chooses immediate watcher/save handling on
healthy systems, bounded periodic detection on degraded watchers, and a final
correctness barrier at compile time.

## Objective-to-Evidence Assessment

| Objective | Design choice | Why this choice | Evidence | Status |
| --- | --- | --- | --- | --- |
| Closed agent edits reach Overleaf before compile | Watcher plus complete saved-tree compile barrier | Watchers can miss events or exhaust inotify, and metadata can be preserved | Closed text/media, same-size/mtime, folder, and SSH ENOSPC tests | Achieved for saved disk state |
| Collaborator edits reach local disk | Remote event pull with authoritative read, merge, and clean-editor refresh | Cached OT order and restored editor models can otherwise stay stale | Live pull, out-of-order OT, clean editor, and initial-pull race tests | Achieved |
| No silent local/remote winner | Validated common baseline, 3-way text merge, persisted conflicts | Two independently changed sides cannot be ordered safely without a base | Offline/live merge, binary conflict, restart conflict tests | Achieved |
| Media and structure work both ways | Content fingerprints plus file/folder snapshot reconciliation | Text-only document events do not cover binary files or empty folders | Binary add/edit/rename/delete and folder tests in both directions | Achieved |
| Reload and crashes do not strand hidden paths | Durable local and remote operation journals | An in-memory transaction cannot survive process loss | Prepared/installed/committed and lost-response recovery tests | Achieved |
| Ctrl+S feels immediate | Direct saved-URI flush before compile, first retry at 0 ms | Waiting for watcher debounce makes normal editing feel remote | Healthy path has no reconnect/journal and completes in roughly 100-200 ms in tests | Achieved within network latency |
| A silently dead watcher does not strand agent edits | Continuous health state plus generation-scoped exact scans every 750 ms | A constructed watcher can emit nothing initially or die later | Zero-event and death/recovery tests, including SSH ENOSPC run | Achieved with bounded degraded-mode latency |
| Manual/PDF compile respects unsaved work | Compile saved VFS/disk state without calling document save | A compile command must not commit unrelated editor buffers | Dirty-buffer compile test | Achieved |
| SSH state stays isolated | Workspace extension host plus server/user/project VFS keys and generations | UI-host globals and raw URI paths can alias remote sessions | Host placement, VFS identity, project switch, and minimum-version tests | Achieved |

## Why Findings Appeared Iteratively

The original implementation did not have an explicit transaction or baseline
model. Adding one exposed interactions among compile scheduling, VFS identity,
watchers, crash recovery, and project switching that isolated happy-path tests
could not reveal.

A plan can reduce this, but it cannot prove a concurrent filesystem/network
implementation correct before the failure surfaces are enumerated. The earlier
work was too finding-oriented: review found one race, a local fix was made, and
the next neighboring race became visible. For 0.15.29 the process was changed
to use:

1. product invariants that apply to every code path;
2. a state-transition model for baseline, conflict, operation, and generation;
3. a failure matrix at every read, rename, remote mutation, and persistence
   boundary;
4. tests that inject failures and concurrent changes at those boundaries;
5. independent review before packaging, followed by a review of each review
   fix;
6. one release gate that blocks versioned artifacts and the commit until all
   evidence agrees.

The release reviews still found cross-boundary ownership/lifetime classes:
a global pending-compile slot, a VFS cache whose baseline was older than the
Local Replica decision, an echo digest whose lifetime outlived the synchronized
revision, a watcher object mistaken for proof of event delivery, an ambiguous
OT acknowledgement treated as retryable, and collaborator OT arriving while a
local write still owned an older cache snapshot. Later reviews added
post-submit readback failure escaping as retryable, a delayed sender event
crossing into a later write, an old watcher probe clearing a new session's
timeout, delete events reported as changes, local recreation during a remote
delete, untracked file/folder creation races, local and remote classification
failures, and a failed zero-byte remote readback that could masquerade as a
verified empty file. These are useful evidence that the gate worked, but also
evidence that the first plan did not model every owner and lifetime.

Their resolutions reused the same normalized project identity, common text
merge helper, manifest proof, and generation scope rather than adding
path-specific exceptions. Future changes should start from the invariant and
ownership tables in this document, enumerate each cache or timer's owner and
expiry rule, then extend the failure matrix before implementation.

## Residual Environment Constraints

- The audited SSH host has a low inotify instance/watch limit. The process
  cannot raise `/proc/sys` because that mount is read-only. Continuous probes
  detect event loss and enable exact scans every 750 ms, so correctness no
  longer depends on a later compile. Detection includes up to the one-second
  idle interval, 750 ms timeout, scan time, and network runtime; the user
  receives one warning and scans stop if event delivery recovers.
- The current `package:vsix` script resolves the contemporary `vsce` CLI, which
  requires Node 20 or newer. The final artifact was built with Node 22.23.1;
  Node 18 remains sufficient for this checkout's compile, lint, and test gate
  but not for that packaging CLI.
- Native Chrome file-picker automation for a browser-originated binary upload
  is restricted by the automation environment. Bilateral media behavior is
  covered by extension-host tests and local-to-browser live checks.
- The packaged artifact was therefore verified independently by isolated
  installation and by loading the exact unpacked VSIX in a real Extension Host,
  rather than inferring activation from source-only unit tests.
- DBus/GPU warnings from headless VS Code are environmental when tests pass.
- Browser PDF refresh is not an immediate-sync guarantee.

## Reviewer Instructions

Review the implementation against the invariants, not only against individual
test names.

1. Trace every destructive rename/delete and confirm durable intent exists
   first.
2. Inject a process stop after every journal/rename/install/commit boundary.
3. Confirm every ambiguous remote response refreshes authoritative state before
   deciding success, retry, restore, or conflict.
4. Confirm every awaited read rechecks the same generation before mutating
   state.
5. Confirm a successful conflict resolution is persisted before restart.
6. Confirm no normal save path calls reconnect, fsync, or a delayed retry.
7. Inspect packaged VSIX metadata and activate the installed artifact, not only
   the source checkout.
8. Treat any automatic winner without a verified base as a release blocker.

## Release Gate

Release 0.15.29 only when all items are true:

- [x] TypeScript and ESLint pass after the final diff.
- [x] Local latest, SSH latest, and SSH minimum suites pass.
- [x] Independent review reports no unresolved P0/P1/P2 issue.
- [x] Real closed-file text and media changes synchronize in both directions.
- [x] Ctrl+S syncs saved bytes and compiles.
- [x] Manual/PDF compile leaves unsaved buffers untouched.
- [x] Built VSIX metadata and activation are verified.
- [x] Package, lockfile, changelog, VSIX name, and commit agree on 0.15.29.
- [x] Temporary credentials and transfer archives are removed.
- [x] The release commit contains only the intended files and is pushed to
      GitHub because the user explicitly requested it.
