# GitLab Gitless Sync

GitLab Gitless Sync is an Obsidian plugin that synchronizes a vault with one GitLab repository and branch without requiring Git on the device.

This project is a GitLab-only fork of Silvano Cerza's GitHub Gitless Sync.
It remains licensed under AGPL-3.0-only.

## Installation

1. Push and verify the desktop vault in GitLab.
2. Create a new empty Obsidian vault on iPhone.
3. Install GitLab Gitless Sync manually or through BRAT.
4. Create a GitLab access token limited to the vault project with repository download and push permission.
5. Store the token through the plugin's secret input.
6. Enter GitLab base URL, project path, branch, author name, and author email.
7. Tap Initialize empty vault from GitLab.
8. Keep Obsidian open until import completes.
9. Reload Obsidian.
10. Future syncs run at startup; use Sync with GitLab to send changes immediately.

## Behavior

- Mobile devices do not need a local `.git` directory.
- GitLab commits created by the plugin are ordinary Git commits.
- Desktop users keep using normal Git against the same branch.
- Plugin sync state is local to the device and is not committed to the repository.
- GitLab.com is the default host; self-managed HTTPS GitLab base URLs are supported.
- Startup sync runs once after Obsidian layout is ready when the vault is initialized.
- Manual Sync with GitLab uses the same sync engine as startup sync.
- Full audit and sync is manual and may be slower because it scans local files.
- Root and nested `.gitignore` files apply to untracked local files.
- Files already tracked remain tracked even if a later ignore rule matches them.
- Conflicts preserve both sides: the GitLab version stays at the original path and the iPhone version is written as a conflict copy.
- Deletion conflicts are non-destructive and create a Markdown marker.
- Binary files are preserved byte-for-byte.

## Limitations

- GitLab only.
- One configured project and one branch.
- GitLab REST API only.
- No local Git, isomorphic-git, shell Git, iSH, merge, rebase, force push, branch switching, Git LFS, submodules, symlinks, executable-bit editing, or multiple remotes.
- Initial import is only supported into an empty vault.
- Local plugin runtime files and sync state are local-only.

## Security

The GitLab token is stored in Obsidian SecretStorage. It is not stored in plugin data, logs, conflict files, URLs, or GitLab commits. Logs redact credential-shaped fields such as `PRIVATE-TOKEN`, `Authorization`, `token`, and `password`.

## Development

- Install dependencies with `pnpm install`.
- `pnpm build` type-checks (`tsc -noEmit -skipLibCheck`) and bundles the production plugin with esbuild. The bundle is written to the repository root as `main.js`; this is what `release.yml` publishes alongside `manifest.json` and `styles.css`.
- The deployable plugin bundle is staged in `dist/obsidian-plugin/gitlab-gitless-sync/`. After a build, copy `main.js`, `manifest.json`, and `styles.css` into that folder. It mirrors the layout of an Obsidian plugin directory, so its contents drop straight into a vault's `.obsidian/plugins/gitlab-gitless-sync/`.
- `main.js` and `dist/` are git-ignored build artifacts and are never committed.
- Run the test suite with `pnpm test` (Vitest).

## Fork Attribution

This fork preserves the upstream AGPL-3.0-only license and attribution. See `THIRD_PARTY_NOTICES.md` for the upstream URL and base commit.
