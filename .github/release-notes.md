Local test candidate: crash-safe mobile sync recovery.

- Persists a content-less transaction intent before creating a GitLab commit.
- Tags commits with a unique transaction id and recovers accepted commits from GitLab history without creating duplicates.
- Recovers accepted commits from the actual local base and maintains an exact tracked index even when a local path is deliberately left dirty.
- Protects user edits made during recovery compare, download, replacement, and deletion.
- Rolls back and resumes interrupted protected backup operations.
- Enables per-file optimistic locking through GitLab `last_commit_id`.
- Prevents remote-only resume from advancing the base when a dirty path was skipped.
- Makes conflict reports linear and memory-bounded while preserving safe three-way merge behavior.
- Publishes the installable Obsidian bundle to `dist/obsidian-plugin/gitlab-gitless-sync/` on every build.
