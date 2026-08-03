# Connect-to-GitLab flow — design

Date: 2026-08-02
Status: approved (pending spec review)

## Problem

The vault-setup screen exposes two buttons, **Initialize empty** and **Adopt
existing**, and both are confusing or broken in practice:

- **Initialize empty** requires a strictly empty vault
  (`BootstrapService.assertVaultEmptyForBootstrap`). A freshly created Obsidian
  vault always contains a default welcome note (locale-dependent name, e.g.
  `Welcome.md` / `Добро пожаловать.md`), so the check throws
  `"The local vault must be empty before importing from GitLab"`.
- The failure is **silent**: `GitLabGitlessSyncPlugin.initializeFromGitLab`
  (`src/main.ts`) and the button's `onClick` (`src/settings/settings-tab.ts`)
  have no `try/catch` and never call the logger. The thrown error becomes an
  unhandled promise rejection — no `Notice`, no log entry. The user sees the
  button "do nothing".
- Two buttons for one conceptual action ("connect this vault to a GitLab repo")
  is unnecessary surface area.

### Engine constraint discovered during design

`adopt` alone cannot populate an empty vault. `RemoteDiffService.discover`
computes changes as a diff of `baseSha..remoteSha`. `adoptExistingVault` sets
`base = HEAD`, so the next sync runs `compare(HEAD, HEAD)` → empty diff →
**downloads nothing**. The `audit` trigger only scans local files; it does not
pull remote files either. Therefore the connect flow must **physically
materialize** repository files, not rely on a subsequent sync. Bulk download
via the repository archive (today done by `BootstrapService`) is the efficient
mechanism and must be preserved.

## Goals

- One button: **Connect to GitLab**.
- Always **non-destructive merge**: nothing local is ever deleted or
  overwritten in place.
- Physically download repository files into the vault during connect.
- A confirmation dialog with a summary before any change.
- Every failure is surfaced (`Notice` + logged); no silent failures.

## Non-goals

- No "GitLab is source of truth, replace local" (destructive pull) mode.
- No direction-picker dialog.
- No change to the already-initialized state UI (the `Reset local sync state`
  action stays as-is).

## Behavior

State `initialized: false` shows a single **Connect to GitLab** button under the
existing "Vault setup" heading. `vaultSetupViewState` keeps deciding
setup-vs-reset; only the button set in the `showSetupActions` branch changes.

Connect flow on click:

1. **Preview (read-only, no writes, no state change).** Validate config + token;
   fetch branch + tree. Compute:
   - `remoteFileCount` — blobs in the tree minus hard-excluded paths
     (`.git`, the active plugin folder, metadata files).
   - `localPushCount` / `localPushPaths` — local files absent from the tree or
     whose content differs from the tree (same comparison as
     `auditLocalChanges`, but nothing is persisted).
   - `conflictCount` — files that exist and differ on both sides.
2. **Confirmation modal** (`ConnectConfirmModal`) shows the summary. Cap the
   file-name preview at 10 names + `…and N more`; when many files, lead with the
   count and show names only as examples. Cancel aborts with no change.
3. **On Connect** — run the non-destructive merge (below), set `base = HEAD`,
   write the tracked index, then refresh the settings view. Show
   `Notice("Connected to GitLab")`.

### Non-destructive merge (materialization)

For each repository file (content available from the downloaded archive):

- **remote-only** (absent locally) → write it (create).
- **present locally, identical bytes** → adopt as-is (tracked, clean).
- **present locally, differs** → keep both versions via the existing
  `ConflictResolver` unknown-base path (`resolveUnknownBase`), honoring
  `conflictStrategy`. The losing side becomes a conflict copy.

Local files not present in the repository (e.g. the default welcome note) are
left untouched and marked dirty so they are pushed on the next sync. The summary
in step 2 makes this explicit, so the user can cancel and delete the welcome
note first if they don't want it in the repo.

After materialization, persist:
`initialized = true`, `lastSyncedCommitSha = HEAD`, `trackedFiles = <repo tree>`,
`dirtyEntries = <local-only/local-diff files>`, `pendingTransaction = null`,
`lastSyncAt = now`, `lastSyncResult = "success"`.

No separate follow-up sync is required — remote files are already on disk.

## Components

- **`src/settings/settings-tab.ts`** — replace the two-button block with a single
  **Connect to GitLab** button whose handler runs preview → modal → connect,
  each step wrapped in `try/catch` with `logger.error` + `Notice`.
- **`src/views/connect-confirm-modal.ts`** (new) — `ConnectConfirmModal`
  rendering the summary from preview data. Text-only via `setText`/`createEl`
  (no `innerHTML`); sentence case; `[Connect]` is the CTA.
- **`BootstrapService` → connect/merge service** (`src/sync/bootstrap-service.ts`)
  — remove `assertVaultEmptyForBootstrap`; rename `initialize()` → `connect()`;
  keep archive download; replace the "assume empty, just write" policy with the
  three-case merge policy above, routing both-sides-differ through
  `ConflictResolver`. Add a read-only `preview()` method on this same service
  that returns `{ remoteFileCount, localPushCount, localPushPaths, conflictCount }`
  and never persists state. The local-diff comparison shared by `preview()` and
  the audit path is extracted into a shared helper so both use identical logic.
- **`src/main.ts`** — replace `initializeFromGitLab()` with `connectToGitLab()`
  that drives `preview()` → modal → `connect()`, each wrapped in `try/catch` +
  `logger.error` so no path fails silently. The `adoptExistingVault()` plugin
  method and `SyncManager.adoptExistingVault` are removed — the connect service
  now covers their case; any still-needed local-audit logic is the shared helper
  above.

## Data flow

click → `previewAdoption()` [getBranch, getTree, local scan] → counts →
`ConnectConfirmModal` → confirm → `connect()` [downloadArchive, per-file merge,
ConflictResolver for diffs] → `stateStore.update(...)` → `display()` + Notice.

## Error handling

- Preview errors (missing token, 401/404, empty remote, network) → caught in the
  handler → `logger.error` + `Notice("Could not read GitLab: <message>")`;
  abort.
- Connect/merge errors → caught → `logger.error` + `Notice("Connect failed:
  <message>")`; state is not marked initialized on failure.
- `main.ts` entry points also `try/catch` + log as defense in depth. This fixes
  the current silent-failure bug directly.

## Testing

- **Preview**: empty vault → `remoteFileCount = tree size`, `localPushCount = 0`;
  vault with a welcome note → `localPushCount = 1`, path listed; hard-excluded
  paths omitted from both counts.
- **Merge materialization**:
  - remote-only file is written;
  - identical local file is adopted with no rewrite/conflict;
  - differing local file produces a conflict copy (per `conflictStrategy`) and
    both versions survive;
  - local-only file is untouched and marked dirty.
- **State**: after connect, `base = HEAD`, tracked index matches tree, dirty set
  matches local-only/diff files.
- **Error surfacing**: a thrown preview/connect error triggers `Notice` +
  `logger.error` and leaves `initialized = false`.
- **Modal**: name list caps at 10 + `…and N more`; `localPushCount = 0` renders
  the "0 files to push" line.
- Remove obsolete `BootstrapService.initialize` empty-vault tests; replace with
  merge tests.

## Migration / compatibility

- Users already `initialized: true` are unaffected (still see Reset).
- Desktop ordinary-Git workflows remain compatible: connect only sets a
  device-local base + index and writes files; it commits nothing to the repo and
  writes no metadata into the vault.
