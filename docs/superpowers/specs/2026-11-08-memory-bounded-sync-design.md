# Memory-bounded, resumable remote-only sync — design

Date: 2026-11-08
Status: draft (approved scope: A+B, bounded to the pure remote-only path)

## Problem

On the phone, a large remote-only sync (pure pull, no local pending changes) now actually
executes because of the 750 ms request pacing that replaced the 429-burst failure mode. The
regression log shows a ~855-file change set on a ~8800-file vault; Obsidian closes and reopens
mid-sync (a hard iOS process kill), which is the signature of a memory (jetsam) kill, not a
freeze.

Two concrete sources accumulate the whole change set in memory during one plan attempt:

1. `SyncPlanner.plan()` builds `materializeWithoutCommit`, holding the base64 of **every**
   remote file it materializes, before any of it is written to disk.
2. `SyncManager.memoizedRemoteVersion()` caches a `getRawFile` promise (holding a `Uint8Array`)
   per path for the entire plan attempt, so every downloaded file stays alive until the attempt
   finishes.

The combined peak is roughly `N × ~2.3× file size` (base64 is ~1.33×, plus the raw bytes, plus
transient copies), i.e. hundreds of MB for ~855 files — enough to trigger the iOS kill.

A second, compounding problem is that a kill/restart discards all progress. The same ~855-file
set was downloaded roughly four times across consecutive syncs because nothing is persisted
between runs; there is no way to resume, only to re-run the whole plan.

## Goal

Make remote-only materialization **memory-bounded** (peak memory proportional to a small chunk,
not to the change-set size) and **resumable** (a kill/restart continues from the persisted
resume point instead of re-downloading the whole set). The change is confined to the pure
remote-only path — the one that crashes — and must not alter the commit/conflict path.

## Non-goals and scope

- Only the **remote-only** path (where the plan produces no commit actions) is changed.
  The commit path (`plan.actions.length > 0`) keeps the existing planner and materialization.
- No change to request pacing, retries, or backoff semantics.
- No change to the archive/bootstrap Connect flow.
- No user-facing setting. `CHUNK_SIZE` is an internal constant, not a preference.
- Resume is bounded to the **remote-only** path (`plan.actions.length === 0`). When local
  snapshots exist and resolve to remote (e.g. `auto-remote`), their few materializations and
  index mutations are computed by the planner and captured in `nextTrackedFiles` **before**
  streaming begins; resume only continues the bulk remote-only changes. If local pending changes
  require a commit, the sync is a commit path and never streams. After a resumed pull finalizes,
  any subsequently recorded local changes are handled by the next normal sync.
- Version stays `1.0.18`; this is a pre-release acceptance fix like the prior work.

## Current flow (remote-only)

`planAndApply()` runs `planner.plan()`, which for the pure remote-only case downloads every
remote file into `materializeWithoutCommit` (base64) and updates `nextTrackedFiles` from the
downloaded bytes. Then `applyRemoteOnlyPlan()` calls `materializer.apply(...)` to write them all,
and finalizes state (`lastSyncedCommitSha = remoteSha`, `trackedFiles = nextTrackedFiles`).

For the pure remote-only case (no local snapshots), the planner's **decision** phase — conflict
resolution, `actions`, `acknowledgedDirtyPaths`, `conflictPaths` — reads no remote file bytes at
all. All downloads happen in `materializeRemoteOnlyChange`/`materializeRemotePath`. This split is
the basis of the redesign: keep the decision, replace the bulk materialization with a streaming
applier.

## Architecture

### 1. Streaming remote-only applier

A new module, `src/sync/remote-only-stream.ts`, exports a `StreamingRemoteApplier` that owns
remote-only materialization and index building. It is driven by the ordered list of remote
changes **not** touched by any local snapshot, the base index, and the GitLab client.

It processes changes in bounded windows (`CHUNK_SIZE`, an internal constant, default `32`). For
each chunk it:

- Downloads each file's bytes through a **chunk-scoped** reader (no cross-chunk memo cache), so a
  downloaded `Uint8Array` is released as soon as the chunk is applied.
- Writes/deletes on disk through the materializer (see §3 for byte-direct writes).
- Computes each file's `TrackedFile` (`blobId` from the Git blob hash of the transient bytes,
  `mode: "100644"`, `size`) and mutates the partial index.
- Applies renames as delete-old + write-new.
- Runs `pruneEmptyParents` for the chunk's deletions.
- Persists a resume point (§2) after the chunk completes, then releases the chunk's bytes.

The applier returns the final `nextTrackedFiles` index.

Peak memory is bounded by one chunk of file bytes plus the (small) partial index, not by the
change-set size.

### 2. Chunk-scoped remote reader replaces the attempt-scoped memo

`memoizedRemoteVersion()` caches promises for the whole plan attempt, which is what pins every
downloaded buffer. In the streaming path, each file is downloaded exactly once per chunk, so a
cross-chunk cache is unnecessary. The streaming applier uses a reader scoped to the current chunk
(or a per-change fetch) and lets the buffers be garbage-collected between chunks.

The existing attempt-scoped memo remains only for the commit/conflict path, which legitimately
re-reads a few paths across the plan.

### 3. Byte-direct materializer writes

`getRawFile` already returns an `ArrayBuffer`. The current path base64-encodes it in the planner
(`toBase64`) and base64-decodes it again in `LocalMaterializer.write`. For the streaming path,
add a write entry point that accepts the raw bytes and writes them directly, avoiding the base64
encode/decode round trip and its extra transient allocation. It preserves the existing
temp-then-rename atomic write and the `pruneEmptyParents` behavior.

### 4. Resume state (state schema 3)

Extend `LocalSyncState` from `schemaVersion: 2` to `schemaVersion: 3` with a single optional
field:

```
remoteApply: {
  remoteSha: string;                          // the remote commit being applied
  remainingChanges: RemoteChange[];           // ordered tail not yet applied
  nextTrackedFiles: Record<string, TrackedFile>; // partial index after applied chunks
} | null
```

- `StateStore.load()/save()` default `remoteApply` to `null` and emit `schemaVersion: 3`.
  Existing `schemaVersion: 2` data migrates by just gaining `remoteApply: null`; all existing
  fields are preserved.
- The streaming applier persists `remoteApply` after each chunk via `stateStore.update`, clearing
  `nextTrackedFiles`'s already-applied entries and shrinking `remainingChanges`.
- `applyRemoteOnlyPlan` clears `remoteApply` to `null` when it finalizes.

Resume entry in `syncLocked()`: after `getBranch()` and `validateBranch()`, if
`state.remoteApply !== null` and `state.remoteApply.remoteSha === firstBranch.commit.id`, resume
instead of re-planning:

- Continue applying `state.remoteApply.remainingChanges` onto `state.remoteApply.nextTrackedFiles`
  with the streaming applier.
- Finalize exactly like a normal remote-only apply (`lastSyncedCommitSha = remoteSha`,
  `trackedFiles = final index`, `pendingTransaction = null`, clear `remoteApply`,
  `lastSyncResult = "success"`).

Branch-race handling: if `state.remoteApply.remoteSha !== firstBranch.commit.id` (the remote
moved, or a different branch), the stale resume point is discarded and a fresh full plan runs.

Error handling: if the streaming apply throws mid-way, the most recent chunk-boundary `remoteApply`
is already persisted; `syncLocked`'s normal `markError` path runs, and the next sync resumes from
that point. Writes are idempotent (write overwrites, delete ignores a missing file), so resuming
never corrupts already-applied files.

## Data flow

```
syncLocked
  getBranch -> firstRemoteSha
  has resumable remoteApply (same remoteSha)? ----yes--> resume: stream remaining -> finalize
  |  no
  planAndApply
    plan.plan() (decision only for remote-only: no bulk download)
    actions.length === 0?  ----no--> existing commit path (unchanged)
    |  yes (remote-only)
    streaming applier: for each chunk
        download (chunk-scoped) -> materialize (byte-direct) -> build index
        persist remoteApply (remainingChanges + nextTrackedFiles)
    finalize (clear remoteApply)
```

## Interfaces

- `LocalSyncState.schemaVersion: 3` and `LocalSyncState.remoteApply: RemoteApply | null`
  (new type `RemoteApply` in `src/sync/types.ts`).
- `DEFAULT_STATE` gains `remoteApply: null`, `schemaVersion: 3`.
- `StateStore.load()/save()` migrate schema 2 → 3 (default `remoteApply: null`).
- `SyncPlanner` gains a streaming-aware remote-only mode that returns the ordered remote-only
  change list and bounded snapshot/conflict handling without building `materializeWithoutCommit`
  for the bulk. (`plan()` is retained for the commit path.)
- `LocalMaterializer` gains a byte-direct write entry point.
- New `StreamingRemoteApplier` (new file `src/sync/remote-only-stream.ts`).
- `SyncManager` wires resume detection and the streaming applier into `syncLocked`/`planAndApply`.

## Security constraints

- No change to TLS handling, token handling, or request headers.
- Diagnostics must continue to avoid logging file contents or tokens.
- The persisted `remoteApply.nextTrackedFiles` contains only metadata (paths, blob ids, sizes),
  never file bytes or base64.

## Testing and acceptance

- **Schema migration:** existing `schemaVersion: 2` state loads with `remoteApply: null` and
  `schemaVersion: 3`, preserving all fields; save emits `schemaVersion: 3`.
- **Streaming applier (unit):** applies an ordered change set correctly; index matches a full
  non-streamed apply; renames handled; deletes prune empty parents.
- **Memory bound (regression):** with a large synthetic change set, the applier never holds more
  than `CHUNK_SIZE` files in flight — assert the chunk-scoped reader is not invoked again until
  the previous chunk's materialization completed (no cross-chunk caching).
- **Byte-direct writes:** the materializer writes the exact bytes without base64 corruption.
- **Resume (unit):** a partial apply persists `remainingChanges` + `nextTrackedFiles`; a second
  `SyncManager`/applier instance with the same `remoteSha` applies only the remaining changes;
  with a different `remoteSha` the stale resume is discarded.
- **Resume finalization:** after resume, `lastSyncedCommitSha`, `trackedFiles`, `pendingTransaction
  = null`, and `remoteApply = null` match a full non-resumed apply.
- **Existing suite:** all fixtures bumped to schema 3; existing planner, sync-manager,
  state-store, scheduler, retry, Connect, lifecycle, lint, typecheck, and build checks stay green.
- **Integration:** a large remote-only sync completes correctly; a kill/restart mid-apply resumes
  and downloads only the remaining files.
- **Manual acceptance:** install the rebuilt `1.0.18` bundle on the phone, trigger the large sync,
  and confirm it no longer closes/reopens and completes; kill Obsidian mid-sync, reopen, and
  confirm the next sync resumes rather than re-downloading the whole set.

## Considered alternatives

- **Just disable/limit the memo cache (A only, no resume):** bounds peak memory but still re-runs
  the whole plan after a kill — the ~4× re-download problem remains. Rejected as insufficient; the
  user explicitly wants B.
- **Persist resume as a cursor into the full change list:** avoids storing `nextTrackedFiles`, but
  requires replaying applied changes to rebuild the index, which needs the full ordered list plus
  each applied file's blob id — effectively the same data, with more complex reconstruction.
  Storing the partial index is simpler and crash-safe.
- **Always fetch the full tree for blob ids:** avoids computing `blobId` from bytes, but adds a
  large tree request on the compare path and still requires downloading every file to write it.
  Computing `blobId` from the transient bytes during the chunk costs nothing extra.
- **Chosen:** chunked streaming with byte-direct writes (A) plus a persisted partial-index resume
  point (B), confined to the pure remote-only path.