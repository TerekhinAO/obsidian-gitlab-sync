Local test candidate: crash-safe and conflict-preserving mobile sync recovery.

- Persists a content-less transaction intent before creating a GitLab commit.
- Tags commits with a unique transaction id and recovers accepted commits from GitLab history without creating duplicates.
- Recovers accepted commits from the actual local base and maintains an exact tracked index even when a local path is deliberately left dirty.
- Protects user edits made during recovery compare, download, replacement, and deletion.
- Rolls back and resumes interrupted protected backup operations.
- Enables per-file optimistic locking through GitLab `last_commit_id`.
- Prevents remote-only resume from advancing the base when a dirty path was skipped.
- Makes conflict reports linear and memory-bounded while preserving safe three-way merge behavior.
- Publishes the installable Obsidian bundle to `dist/obsidian-plugin/gitlab-gitless-sync/` on every build.

- Validates settings before persisting updates so an empty GitLab URL cannot make the plugin unloadable.
- Uses topological GitLab history ordering to avoid false transaction absence after merges.
- Captures exact pre-POST content fingerprints and refuses recovery when local files changed while Obsidian was closed.
- Preserves intact rollback backups when protected replacement ownership is ambiguous.
- Retries transient conflict-copy recovery failures instead of allowing the next sync to delete the conflict copy.
- Fail closed when any unknown local file appears at a new recovery path; keep the GitLab copy recoverable until that file is moved or removed.
- Report detailed protected-write failure reasons and keep recovery intent across repeated external races.
- Resume partial multi-file recovery when an already written path exactly matches the accepted GitLab commit.
