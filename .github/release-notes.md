# GitLab Gitless Sync 1.0.22

This release substantially improves merge correctness, mobile crash recovery, and protection against silent data loss.

## Highlights

- Reworked three-way auto-merge: overlapping edits become conflicts, context is preserved, duplicate insertions and reordered lines are fixed, and very large notes no longer crash sync.
- Added crash-safe GitLab transaction recovery: interrupted mobile commits are identified by transaction markers, recovered from the accepted commit, and not duplicated.
- Protected user edits during recovery, including edits made while Obsidian was closed or while another plugin raced to create a file.
- Fixed cases where conflict copies could be deleted or overwritten after a transient write failure.
- Validated settings before saving and made state reset atomic with sync.

## Folder Notes compatibility

Folder Notes’ “Auto-create when creating notes” option may convert files created by other plugins into `Untitled/Untitled.md`. Sync now fails closed instead of overwriting such files. Disabling that Folder Notes option on mobile is recommended.

## Upgrade

Close Obsidian, replace `main.js`, `manifest.json`, and `styles.css`, and keep `data.json`. The plugin version should show `1.0.22`.

Verified with 293 automated tests, TypeScript checking, ESLint, and a production archive build.
