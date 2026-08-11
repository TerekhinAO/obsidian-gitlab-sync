# GitLab Gitless Sync

Sync an Obsidian vault with a GitLab repository **without requiring Git on the device**.

GitLab Gitless Sync keeps a vault and a single GitLab repository branch in sync using only the
GitLab REST API. It is designed for mobile devices (where Git is unavailable) while staying fully
interoperable with an ordinary desktop Git workflow against the same branch.

## Installation

### Community plugins

Once available in the Obsidian Community Plugins registry: open **Settings → Community plugins →
Browse**, search for **GitLab Gitless Sync**, install and enable it.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/TerekhinAO/obsidian-gitlab-sync/releases) and copy them
into `<vault>/.obsidian/plugins/gitlab-gitless-sync/`, then enable the plugin.

## Getting started

Four steps: create the repository and a token, connect the vault, turn on automatic sync, add a
`.gitignore`.

### Step 1 — Create the GitLab repository and an access token

1. Create a project in GitLab — either on [gitlab.com](https://gitlab.com) or on a self-managed
   instance (any HTTPS base URL works). A brand-new **empty** project is fine: the plugin can create
   the first commit from your vault. An existing project with content is fine too.
2. Create a token for the plugin. A **project access token** is preferred — it can only reach that
   one project:

   **Project → Settings → Access tokens → Add new token**
   - **Role:** `Maintainer`. GitLab protects the default branch of a new project against pushes from
     Developers, so a Developer token gets `403 You are not allowed to push into this branch`.
   - **Scope:** `api`.

   Why `api`: the plugin creates commits through `POST /repository/commits`, and that endpoint only
   accepts `api`. The `write_repository` scope covers Git-over-HTTP (`git push`) **only** and will
   fail here with `403 insufficient_scope`.

3. If project access tokens are disabled on your instance, use a personal access token instead —
   **User settings → Access tokens → Add new token**, scope `api` — and make sure your account has
   at least the Maintainer role in the project. Note that an `api` PAT reaches every project you can
   access, so prefer a project token where possible.

4. On instances with [fine-grained tokens](https://docs.gitlab.com/auth/tokens/fine_grained_access_tokens_rest/)
   you can replace the `api` scope with these permissions:

   - **Projects:** Project Read
   - **Repository:** Repository Read, Code Read, Commit Read, Commit Create, Branch Read,
     Repository Tag Read

   Fine-grained permissions do not cascade — grant each one explicitly. If the target branch is
   protected, add Protected Branch Read.

Keep the token private. If you stop using the plugin or move the vault to another repository, revoke
the old token and create a new one.

### Step 2 — Connect the vault

**Back up the vault before connecting.** The plugin never deletes a file and never overwrites one
side silently, but connecting does bring remote content into the vault.

Fill in **Settings → GitLab Gitless Sync → GitLab repository**:

- **GitLab base URL** — `https://gitlab.com`, or your self-managed HTTPS instance
  (e.g. `https://gitlab.example.com`). HTTPS is required.
- **Project path** — namespace and project path, for example `developing/obsidian-world`.
- **Branch** — the branch to synchronize, for example `main`.
- **GitLab token** — the token from step 1. Stored in Obsidian SecretStorage, never in plugin data.
- **Commit author name** and **Commit author email** — used as the author of every commit the plugin
  creates. Required.

Then press **Connect to GitLab**. The plugin inspects both sides and shows a summary before changing
anything; nothing happens until you confirm. One button handles every starting state:

- **Repository has commits (the default case) → merge.** Remote files are downloaded into the vault.
  Files that exist only locally are kept and pushed on the next sync. When the same file exists on
  both sides and differs, **both versions are kept**: the GitLab version takes the original path and
  your version is saved beside it as `<name> (local conflict).<ext>`. Nothing is deleted.
- **Repository is empty (no commits, no branches) → initial commit.** Your whole vault is pushed as
  the first commit, and that commit creates the branch named in **Branch**, whatever you typed there —
  it does not have to match the default branch GitLab preconfigured for the project. Nothing is
  downloaded and nothing is deleted. This path needs the commit author name and email, and the vault
  must contain at least one syncable file (an empty vault plus an empty repository has nothing to
  push and reports an error).
- **Repository has commits but the configured Branch does not exist.** Nothing is changed: a notice
  lists the available branches and the repository default. Set **Branch** to one of them and press
  Connect again.

Keep Obsidian open until the confirmation notice appears. After that, **Sync with GitLab** (sidebar
icon or command palette) syncs on demand at any time.

### Step 3 — Turn on automatic sync

All automatic modes live under **Settings → GitLab Gitless Sync → Sync** and are off-by-default
except *Sync on startup*. Pick the set that matches the device.

**On desktop — sync by time.** The desktop app stays open for hours, so time-based triggers are what
keep it current:

- **Sync after edits** — on. Runs a sync a few seconds after you stop typing.
- **Edit debounce (seconds)** — `8` is a good starting point; raise it if you get commits mid-thought.
- **Sync on a timer** — on. Pulls in what other devices pushed while you were idle.
- **Timer interval (minutes)** — `10` for an actively shared vault, `60` if you mostly write alone.
- **Sync on startup** — on. One sync when Obsidian launches.

**On mobile — sync on app lifecycle.** iOS and Android suspend the app instead of leaving it
running, so timers and startup sync are unreliable there; the system foreground/background
transitions are the signal that actually fires:

- **Sync on app foreground (mobile only)** — on. Runs a sync when you reopen Obsidian from the
  background. This is the reliable mobile replacement for *Sync on startup*.
- **Sync on app background (mobile only)** — optional. Runs a sync when you leave the app. It gets
  your latest notes out sooner, but some devices suspend the app before the request finishes, so
  treat it as best-effort rather than a guarantee.
- **Sync on startup** — off. The app is usually suspended before it would run.
- **Sync on a timer** — off. A suspended app has no timer.

Every mode runs the same engine as the manual button, and each trigger has a cooldown so overlapping
events cannot stack up syncs.

### Step 4 — Add a `.gitignore`

The plugin excludes only its own runtime folder (`.obsidian/plugins/gitlab-gitless-sync/`), its log,
the `.git` directory, and sync-metadata files. **Everything else — including the rest of
`.obsidian/` — is synced unless you ignore it.** So on a new vault, create a `.gitignore` in the
vault root.

**Recommended — keep settings shared, drop device-specific state.** Obsidian's `workspace*.json` and
caches change on every device on every session and cause constant churn and needless conflicts:

```gitignore
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
```

**Also reasonable — keep Obsidian's config out of the repository entirely.** Choose this when
settings, themes, and plugin sets should stay per-device:

```gitignore
.obsidian/
```

**Not recommended — no `.gitignore` at all.** Everything syncs, including `workspace.json`, which
means the desktop and the phone fight over layout state on every sync and generate conflict copies
of a file you never edit by hand.

Root and nested `.gitignore` files are both honored, for normal syncs and for the first commit when
seeding an empty repository. Files that are already tracked stay tracked even if a rule starts
matching them later — ignore rules keep new files out, they do not remove history. `.gitignore`
itself is an ordinary file: it is committed and shared, so the rules apply on every device.

## Features

**Works without Git on the device.** No local `.git`, no `isomorphic-git`, no shell Git — only HTTPS
calls to the GitLab REST API. That is what makes it work on iOS and Android.

**Ordinary Git commits.** The plugin writes real commits with your configured author, so desktop
collaborators keep using plain `git pull`/`git push` on the same branch and see nothing unusual.

**Nothing is silently lost.** Both sides of a conflict are always preserved; the losing version
becomes a conflict copy instead of being overwritten. A delete that clashes with an edit produces a
Markdown marker rather than removing the file. Binary files are copied byte-for-byte.

**Fast, incremental syncs.** A normal sync does not scan or hash the whole vault — it works from a
local journal of what changed plus a remote diff. There is a separate **Full audit and sync** command
for when you want an exhaustive local rescan.

**Crash-safe.** Sync runs as a transaction. If a remote commit succeeds but writing files locally is
interrupted, the next sync detects the pending transaction and finishes it.

**Local-only sync state.** The tracked-file index, base commit, and journal live on the device and
are never committed, so the repository stays clean and devices never fight over metadata.

**Self-managed GitLab.** Any HTTPS GitLab instance works, alongside gitlab.com.

## Settings reference

### Sync modes

| Setting | What it does |
| --- | --- |
| **Sync on startup** | One sync after Obsidian is ready. Desktop-oriented — on mobile the app is usually suspended before it runs. |
| **Sync on app foreground** (mobile only) | One sync when you reopen the app. The reliable mobile trigger. |
| **Sync on app background** (mobile only) | One sync when you leave the app. Best-effort: the OS may suspend the app first. |
| **Sync after edits** | One sync a few seconds after your last change, per **Edit debounce**. |
| **Sync on a timer** | One sync every **Timer interval** minutes, to pull other devices' changes. |
| **Manual** | *Sync with GitLab* — sidebar icon or command palette — runs the same engine on demand. |

### Conflict strategy

A conflict is a file that changed on **both** the device and GitLab since the last sync. The plugin
never overwrites either side; this setting only decides which version keeps the original path.

- **Auto merge, fallback Remote** *(default)* — try a line-based three-way merge of the text file
  first; if it conflicts or the file is binary, fall back to *Remote*.
- **Auto merge, fallback Local** — same merge attempt, falling back to *Local*.
- **Remote** — GitLab's version keeps the path; yours is saved as `<name> (local conflict).<ext>`.
- **Local** — your version keeps the path and gets committed; GitLab's is saved as a conflict copy.

A deletion that clashes with a change on the other side produces a Markdown conflict marker instead
of removing the file.

### Interface and diagnostics

- **Show sidebar icon** — a one-tap sync button in the left ribbon.
- **Log level** — `Off` by default. Use `Debug` only while diagnosing sync behavior.
- **Copy logs** / **Clean logs** — export or clear the plugin log.
- **Show GitLab sync status** (command) — base commit, pending local changes, last sync result.
- **Reset local sync state** — forgets the local base commit, tracked index, and journal. It does not
  delete files and does not change GitLab; the next Connect re-reads the repository as the source of
  truth.

## Limitations

- GitLab only, one project and one branch, REST API only.
- No local Git: no merge, rebase, force push, branch switching, Git LFS, submodules, symlinks,
  executable-bit changes, or multiple remotes.
- Seeding an empty repository pushes the whole vault in one commit (no chunking), so a very large
  vault is bounded by GitLab's request size limit.
- Automatic mobile sync depends on OS lifecycle events; background sync can be cut short by the
  system.
- Plugin runtime files and sync state are local-only and never committed.

## Security

The GitLab token is stored in Obsidian SecretStorage. It is never written to plugin data, logs,
conflict files, URLs, or GitLab commits. Logs redact credential-shaped fields such as
`PRIVATE-TOKEN`, `Authorization`, `token`, and `password`. All traffic is HTTPS — a non-HTTPS base
URL is rejected.

## Development

- Install dependencies: `pnpm install`.
- `pnpm build` type-checks (`tsc -noEmit -skipLibCheck`) and bundles the production plugin with
  esbuild to `main.js`.
- `pnpm test` runs the Vitest suite.
- `pnpm check` runs tests, type-check, lint, and build.
- `main.js` and `dist/` are git-ignored build artifacts and are never committed.

## Credits & License

This project is an independently maintained GitLab rewrite, based on
[GitHub Gitless Sync](https://github.com/silvanocerza/github-gitless-sync) by Silvano Cerza.
Modified in 2026 by Alexander Terekhin.

Licensed under **AGPL-3.0-only**. The upstream license and attribution are preserved — see
[`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
