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
- Conflicts are non-destructive: the GitLab version stays at its path and the local version is
  written as a conflict copy. Deletion conflicts create a Markdown marker instead of losing data.
- Binary files are preserved byte-for-byte.
- Self-managed GitLab (custom HTTPS base URL) is supported alongside GitLab.com.

## Installation

### Community plugins

Once available in the Obsidian Community Plugins registry: open **Settings → Community plugins →
Browse**, search for **GitLab Gitless Sync**, install and enable it.

### BRAT (beta / early access)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. In BRAT, add the beta repository `TerekhinAO/obsidian-gitlab-gitless-sync`.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest release](https://github.com/TerekhinAO/obsidian-gitlab-gitless-sync/releases) and copy them
into `<vault>/.obsidian/plugins/gitlab-gitless-sync/`, then enable the plugin.

## Getting started

1. Push and verify the desktop vault in GitLab.
2. Create a new **empty** Obsidian vault on the mobile device.
3. Install and enable GitLab Gitless Sync.
4. Create a GitLab access token scoped to the vault project with repository read and write
   permission.
5. Store the token through the plugin's secret input.
6. Enter the GitLab base URL, project path, branch, author name, and author email.
7. Tap **Initialize empty vault from GitLab** and keep Obsidian open until the import completes.
8. Reload Obsidian.
9. Future syncs run at startup; use **Sync with GitLab** to send changes immediately.

## How it works

- Startup sync runs once after the Obsidian layout is ready, when the vault is initialized.
- Manual **Sync with GitLab** uses the same engine as startup sync.
- A full audit-and-sync is manual and may be slower because it scans local files.
- If a remote commit succeeds but local materialization is interrupted, the next sync recovers
  transactionally.

## Limitations

- GitLab only, one configured project and one branch, REST API only.
- No local Git, isomorphic-git, shell Git, merge, rebase, force push, branch switching, Git LFS,
  submodules, symlinks, executable-bit editing, or multiple remotes.
- Initial import is only supported into an empty vault.
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
