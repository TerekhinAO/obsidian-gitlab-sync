Sync progress visibility fix.

- Shows one persistent progress notification during sync on both desktop and mobile.
- Updates the same notification as sync moves through GitLab checks, conflict resolution,
  downloads, commits, and local materialization.
- Shows streamed pull progress as `applied/total` while a large remote change set is written.
- Closes the progress notification when sync finishes or fails, without leaving an empty status
  bar item behind.

This restores the visible progress behavior from before 1.0.20 while preserving the
memory-bounded, resumable sync introduced in that release.
