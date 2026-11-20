# GitLab Gitless Sync 1.0.23

This release republishes the corrected `1.0.22` build through plugin update channels.

## What changed

- Corrects the release distribution bundle so updates no longer receive the stale lifecycle-setting labels.
- Makes release publishing idempotent: retrying a tag now replaces its existing release assets instead of leaving old files behind.
- Keeps the `1.0.22` sync, merge, recovery, and data-protection fixes.

## Folder Notes compatibility

Folder Notes’ “Auto-create when creating notes” option may convert files created by other plugins into `Untitled/Untitled.md`. Sync now fails closed instead of overwriting such files. Disabling that Folder Notes option on mobile is recommended.

## Updating

### Obsidian Community Plugins

If installed from the Community plugins directory, open **Settings → Community plugins →
Check for updates**, then press **Update** next to **GitLab Gitless Sync**.

### Manual update

For the current GitHub-only distribution, close Obsidian and replace `main.js`,
`manifest.json`, and `styles.css` in `<vault>/.obsidian/plugins/gitlab-gitless-sync/`,
keeping `data.json`. The plugin version should show `1.0.23`.

Verified with 295 automated tests, TypeScript checking, ESLint, and a production archive build.
