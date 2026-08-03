# GitLab Gitless Sync

Sync an Obsidian vault with a GitLab repository **without requiring Git on the device**.

GitLab Gitless Sync keeps a vault and a single GitLab repository branch in sync using only the
GitLab REST API. It is designed for mobile devices (where Git is unavailable) while staying fully
interoperable with an ordinary desktop Git workflow against the same branch.

## Features

- No local `.git`, `isomorphic-git`, or shell Git required on the device.
- Commits created by the plugin are ordinary Git commits — desktop users keep using normal Git.
- Sync state is stored **locally on the device** and never committed to the repository.
- Startup and manual sync run the same transactional engine; a normal sync does not scan or hash
  the whole vault.
- Root and nested `.gitignore` rules are honored; already-tracked files stay tracked.
- Conflicts are non-destructive: both versions are always preserved — the losing side becomes a
  conflict copy, with a configurable strategy (see below). Deletion conflicts create a Markdown
  marker instead of losing data.
- Binary files are preserved byte-for-byte.
- Self-managed GitLab (custom HTTPS base URL) is supported alongside GitLab.com.

## Installation

### Community plugins

Once available in the Obsidian Community Plugins registry: open **Settings → Community plugins →
Browse**, search for **GitLab Gitless Sync**, install and enable it.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/TerekhinAO/obsidian-gitlab-sync/releases) and copy them
into `<vault>/.obsidian/plugins/gitlab-gitless-sync/`, then enable the plugin.

## Before first sync

Make a backup of the vault before the first sync or adoption. The plugin preserves both sides when
the same file changed locally and on GitLab, but normal synchronization still applies
non-conflicting remote changes. If a file was deleted in GitLab and did not change locally, the
local copy is deleted too.

## Recommended `.gitignore` for a new vault

The plugin automatically excludes only its own runtime folder
(`.obsidian/plugins/gitlab-gitless-sync/`), its log, the `.git` directory, and sync-metadata
files. **Everything else — including the rest of `.obsidian/` — is synced unless you ignore it.**
Root and nested `.gitignore` rules are honored (for normal syncs and for the first commit when you
initialize an empty repository from the vault).

On a **new vault**, create a `.gitignore` file in the vault root before the first sync. Pick the
scope you want:

- **Recommended — keep settings in sync, drop only device-specific state.** Obsidian's
  `workspace*.json` and caches change constantly per device and cause needless churn/conflicts:

  ```gitignore
  .obsidian/workspace.json
  .obsidian/workspace-mobile.json
  .obsidian/cache
  .trash/
  ```

- **Keep Obsidian config out of the repository entirely** (settings, themes, and other plugins are
  not shared across devices):

  ```gitignore
  .obsidian/
  ```

- **Sync everything** — omit `.gitignore` (or leave it empty). Note the per-device `workspace.json`
  churn described above.

The `.gitignore` file itself is a normal file: it is committed and shared, so the same rules apply
on every device.

## Getting started

First fill in the connection settings under **Settings → GitLab Gitless Sync**:

- **GitLab base URL** (defaults to `https://gitlab.com`; self-managed HTTPS instances are supported).
- **Project path** — namespace and project path in GitLab, for example `developing/obsidian-world`.
- **Branch** to synchronize.
- **GitLab token** — an access token scoped to the project with repository read and write
  permission. It is stored in Obsidian SecretStorage, never in plugin data.
- **Commit author** name and email.

### Recommended GitLab token

Create a separate token for this plugin and limit it to the project you want to sync. In GitLab,
open **Edit profile -> Access Tokens -> Personal Access Token**, create a token for the target
project, and grant only the permissions the plugin needs:

- **Projects**: Project Read
- **Repository**: Commit Read, Commit Create, Branch Read, Code Read, Repository Read,
  Repository Tag Read

Keep the token private. If you stop using the plugin or move the vault to another repository,
revoke the old token in GitLab and create a new project-scoped token.

Then press **Connect to GitLab**. The plugin inspects the vault and the repository and shows a
summary before making any change — nothing is deleted, and when a file differs on both sides both
versions are kept as conflict copies. One button handles every starting state:

- **Empty vault, repository has commits** — the repository files are downloaded into the vault.
- **Vault already has files** — your local files are kept and merged with the repository; local-only
  files are pushed on the next sync.
- **Empty repository (no commits yet)** — your vault is pushed as the first commit, which also
  creates the branch. This requires a **commit author name and email** in settings.

If the repository is not empty but the configured **Branch** does not exist, the plugin lists the
available branches (and the default) in a notice instead of changing anything — set **Branch** to a
listed name and try again.

Keep Obsidian open until the summary confirms completion. After setup, syncs run automatically
according to the sync modes below, and you can always press **Sync with GitLab** (sidebar icon or
command) to sync immediately.

## Sync modes

All automatic sync modes are optional and configured in settings.

- **Sync on startup** — runs one sync after Obsidian is ready. On mobile the app is usually
  suspended before this runs, so prefer *Sync on app foreground* there.
- **Sync on app foreground (mobile only)** — runs one sync when you reopen the app. The reliable
  mobile replacement for startup sync.
- **Sync on app background (mobile only)** — runs one sync when you leave the app. Unstable: some
  devices suspend the app before the sync finishes.
- **Sync after edits** — runs a sync a few seconds after you stop editing (the delay is the
  *Edit debounce* setting).
- **Sync on a timer** — runs a sync on a fixed interval to pull changes from other devices. Great
  for keeping a desktop up to date.
- **Manual** — *Sync with GitLab* runs the same engine on demand.

A normal sync does not scan or hash the whole vault. If a remote commit succeeds but local
materialization is interrupted, the next sync recovers transactionally.

## Conflict strategies

When a file changed on **both** the device and GitLab since the last sync, the plugin never
overwrites either side. The **Conflict strategy** setting chooses how to resolve it:

- **Remote** — keep the GitLab version at the original path; your version is saved next to it as a
  conflict copy.
- **Local** — keep your version at the original path (and commit it); the GitLab version is saved
  as a conflict copy.
- **Auto merge, fallback Remote** *(default)* — first attempt a line-based three-way merge of text
  files; if the merge conflicts or the file is binary, fall back to *Remote*.
- **Auto merge, fallback Local** — same auto-merge, but fall back to *Local* when it cannot merge.

A deletion that clashes with a change on the other side produces a Markdown conflict marker instead
of removing the file. Binary files are preserved byte-for-byte.

## Limitations

- GitLab only, one configured project and one branch, REST API only.
- No local Git, isomorphic-git, shell Git, merge, rebase, force push, branch switching, Git LFS,
  submodules, symlinks, executable-bit editing, or multiple remotes.
- Seeding an empty repository pushes the whole vault in a single first commit (no chunking); very
  large vaults are bounded by GitLab's request size limit.
- Plugin runtime files and sync state are local-only.

## Security

The GitLab token is stored in Obsidian SecretStorage. It is never written to plugin data, logs,
conflict files, URLs, or GitLab commits. Logs redact credential-shaped fields such as
`PRIVATE-TOKEN`, `Authorization`, `token`, and `password`.

## Development

- Install dependencies: `pnpm install`.
- `pnpm build` type-checks (`tsc -noEmit -skipLibCheck`) and bundles the production plugin with
  esbuild to `main.js`.
- `pnpm test` runs the Vitest suite.
- `main.js` and `dist/` are git-ignored build artifacts and are never committed.

## Credits & License

This project is an independently maintained GitLab rewrite, based on
[GitHub Gitless Sync](https://github.com/silvanocerza/github-gitless-sync) by Silvano Cerza.
Modified in 2026 by Alexander Terekhin.

Licensed under **AGPL-3.0-only**. The upstream license and attribution are preserved — see
[`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
