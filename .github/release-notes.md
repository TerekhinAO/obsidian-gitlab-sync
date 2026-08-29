GitLab connection reliability update.

- Restores repository archive downloads when Obsidian's HTTP transport receives `406 Not Acceptable` from GitLab.
- Correctly handles the generated root directory in GitLab ZIP archives while retaining path traversal and symlink protections.
- Shows persistent loading notices during connection checks and downloads.
- Disables Connect controls while work is in progress to prevent duplicate connection attempts.
- Adds safer request diagnostics without exposing GitLab token values.
