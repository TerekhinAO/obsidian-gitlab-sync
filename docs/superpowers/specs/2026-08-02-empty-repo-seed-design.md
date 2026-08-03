# Connect to an empty GitLab repository — design

Date: 2026-08-02
Status: approved (pending spec review)
Extends: `2026-08-02-connect-to-gitlab-flow-design.md`

## Problem

The single **Connect to GitLab** flow only handles repositories that already have
the configured branch. When the remote repository is brand new and **empty** (no
commits, no branches), `getBranch(<branch>)` returns `404` and Connect fails with
"branch not found". A common onboarding is exactly this: a fresh empty GitLab
project plus an existing vault, where the user wants to **push the vault up as the
first commit**. Connect should support that — but only when the repository is
genuinely empty, never confusing "empty repo" with "wrong branch name" or "no
access".

## Detection gate (safety)

The seed path runs **only** when both hold:
1. `GET /api/v4/projects/<id>` returns `200` (project accessible — rules out
   path/permission problems, which surface as project-level `404`/`401`/`403`).
2. The project's `empty_repo === true` (authoritative GitLab field;
   `default_branch` is `null` for empty repos).

Everything else is NOT seeded:
- Project `404` → existing "Project not found" error (path/access).
- Project `200`, `empty_repo === false`, configured branch `getBranch` `404` →
  the branch simply does not exist. Show a clear error listing available branches
  and the default branch; do NOT seed. (Branch read access == project read access;
  a branch `404` after a successful project fetch means the branch is absent, not
  forbidden.)

## Behavior

`plugin.previewConnect()` becomes mode-aware:
1. Build client, `getProject()`.
2. If `empty_repo === true` → **seed mode**. Get the syncable local file set via
   `syncManager.listSyncableLocalFiles()` (the same source the seed uses). Return
   `{ mode: "seed", branch, localPushPaths, localPushCount }`.
3. Else → try `getBranch(configuredBranch)`:
   - success → **merge mode**: return `{ mode: "merge", ...ConnectPreview }`
     (the existing pull-based summary).
   - `404` → call `listBranches()`, show
     `Notice("Branch \"<branch>\" not found. Default: <default>. Available: <a, b, …>")`,
     log, and return `null` (no modal, nothing changed).

`ConnectConfirmModal` renders a **seed variant** when `preview.mode === "seed"`:
```
Connect to GitLab

The repository is empty.

This vault:
  • 42 files will be pushed to GitLab as the first commit on branch "main", e.g.:
        Welcome.md
        Notes/todo.md
        …and 32 more

Nothing is downloaded and nothing is deleted.

              [ Cancel ]   [ Create first commit ]
```
The merge variant is unchanged from the base spec.

`plugin.connect()` branches on the preview mode captured at click time:
- **seed** → `SyncManager.initializeEmptyRemote()` (below).
- **merge** → existing `BootstrapService.merge()` + `SyncManager.adoptExistingVault()`.

### `SyncManager.initializeEmptyRemote()`

1. Validate settings, incl. **author name and email are non-empty** — the seed
   creates a commit, so both are required. If missing, throw a clear error
   ("Set a commit author name and email before creating the first commit.").
2. List syncable local files (reuse the existing ignore-aware `listLocalFiles` +
   `isHardExcluded`). If there are zero files, throw
   ("The vault has no files to push.").
3. Read each file, build `createCommit` actions (`action: "create"`, base64).
4. `client.createCommit({ message: "Initialize vault", actions })` — on an empty
   repo GitLab creates the branch and the first commit in one call.
5. Finalize state by delegating to the existing `adoptExistingVault()` (re-fetches
   the now-existing branch + tree, sets `base = new HEAD`, builds `trackedFiles`,
   and audits — the just-pushed files match the tree, so the vault is clean).
   This reuses the same finalization the merge path uses.
6. Return a status result mirroring `adoptExistingVault()`
   (`{ status, message, commitSha?, dirtyPaths? }`).

## Components

- **`src/gitlab/client.ts`** — add `getProject(): Promise<{ empty_repo: boolean; default_branch: string | null }>`
  (`GET` the project root) and `listBranches(): Promise<string[]>`
  (`GET /repository/branches`, collect `name`s across pages).
- **`src/gitlab/types.ts`** — add a `GitLabProject` type (subset:
  `empty_repo`, `default_branch`).
- **`src/sync/sync-manager.ts`** — add a public `listSyncableLocalFiles(): Promise<string[]>`
  (ignore-aware: existing `listLocalFiles` + ignore matcher + `isHardExcluded`),
  used by BOTH the seed preview and the seed itself so the modal count can never
  diverge from what is actually pushed. Add `initializeEmptyRemote()` reusing
  `validateSettings`, `listSyncableLocalFiles`, `createClient`,
  `client.createCommit`, and `adoptExistingVault`. Add author-presence validation.
- **`src/main.ts`** — `previewConnect()` gains the mode detection + branch-not-found
  messaging; `connect()` branches on `preview.mode`. Both keep their try/catch +
  logger + Notice.
- **`src/views/connect-confirm-modal.ts`** — render the seed variant when
  `preview.mode === "seed"` (different heading, "Create first commit" CTA, no
  "downloaded" line, no conflicts line).
- **Preview type** — widen to a discriminated union:
  `type ConnectPreview = { mode: "merge"; remoteFileCount; localPushCount; localPushPaths; conflictCount } | { mode: "seed"; branch; localPushCount; localPushPaths }`.
  Update the merge producer (`BootstrapService.preview`) to tag `mode: "merge"`.

## Data flow (seed)

click → `previewConnect()` [getProject → empty_repo] → gather syncable files →
`{mode:"seed", …}` → modal(seed) → confirm → `initializeEmptyRemote()`
[list files → createCommit(actions) → adoptExistingVault] → Notice + `display()`.

## Error handling

- Project `404` / auth → surfaced as today ("Could not read GitLab: …").
- `empty_repo === false` + branch `404` → `Notice` listing branches, return null.
- Missing author (seed) → caught in `connect()` → `Notice("Connect failed: …")`,
  state untouched.
- `createCommit` failure (network, protected default, payload too large) → caught,
  `Notice`, state untouched (no partial state — state is only written by the
  `adoptExistingVault` finalization after the commit succeeds).

## Testing

- **Detection**: `getProject` empty_repo true → seed mode; empty_repo false + branch
  present → merge mode; empty_repo false + branch 404 → branch-not-found Notice
  with the available-branch list, returns null; project 404 → surfaced error.
- **`initializeEmptyRemote`**: builds one create-action per syncable file
  (hard-excluded + gitignored omitted); calls `createCommit` with those actions and
  the configured branch/message; then finalizes via adopt (state initialized, base =
  new sha, tracked index matches, dirty empty). Missing author → throws before any
  commit. Empty vault → throws, no commit.
- **Modal seed variant**: shows "repository is empty", the push count/list capped at
  10, the "Create first commit" CTA, and omits the download/conflicts lines.
- **plugin.connect seed branch**: preview mode "seed" routes to
  `initializeEmptyRemote`, not merge; errors surfaced.
- **No regression**: the merge-mode path (non-empty repo) behaves exactly as before.

## Non-goals

- No auto-creating the project itself (only the first commit into an existing empty
  project).
- No choosing/creating a non-default branch name beyond the configured `branch`.
- No chunked/large-vault commit splitting (single `createCommit`; existing
  `assertPayloadSafe` still guards the max payload and surfaces a clear error).
