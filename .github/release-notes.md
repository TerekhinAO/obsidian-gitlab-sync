# GitLab Gitless Sync 1.0.22

This release substantially improves merge correctness, mobile crash recovery, and protection against silent data loss.

## Highlights

- Reworked three-way auto-merge: overlapping edits become conflicts, context is preserved, duplicate insertions and reordered lines are fixed, and very large notes no longer crash sync.
- Added crash-safe GitLab transaction recovery: interrupted mobile commits are identified by transaction markers, recovered from the accepted commit, and not duplicated.
- Protected user edits during recovery, including edits made while Obsidian was closed or while another plugin raced to create a file.
- Fixed cases where conflict copies could be deleted or overwritten after a transient write failure.
- Validated settings before saving and made state reset atomic with sync.
- Clarified lifecycle settings: visibility triggers work on desktop and mobile; foreground is recommended on mobile, while background is unstable on mobile.

## Folder Notes compatibility

Folder Notes’ “Auto-create when creating notes” option may convert files created by other plugins into `Untitled/Untitled.md`. Sync now fails closed instead of overwriting such files. Disabling that Folder Notes option on mobile is recommended.

## Updating

### Obsidian Community Plugins

If installed from the Community plugins directory, open **Settings → Community plugins →
Check for updates**, then press **Update** next to **GitLab Gitless Sync**.

### Manual update

For the current GitHub-only distribution, close Obsidian and replace `main.js`,
`manifest.json`, and `styles.css` in `<vault>/.obsidian/plugins/gitlab-gitless-sync/`,
keeping `data.json`. The plugin version should show `1.0.22`.

Verified with 294 automated tests, TypeScript checking, ESLint, and a production archive build.
