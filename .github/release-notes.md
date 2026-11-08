Mobile sync reliability for large, incremental GitLab syncs.

On iPhone, a large remote change set could burst the API and hit a GitLab rate limit, returning
`429` and, after about a minute, a request timeout. This release makes big raw-file transfers
reliable:

- **Paced requests.** Request starts are spaced so a sync stays under GitLab's per-minute limit
  instead of firing a burst. A large remote change set can take a little longer on purpose.
- **Honors `Retry-After`.** A `429` now waits for GitLab's `Retry-After` (or 60 seconds when it is
  missing or invalid) and retries up to three times, so a throttled transfer resumes on its own.
- **Safe reads only.** Idempotent GETs that time out are retried, but a failed commit upload is
  never retried automatically — a timed-out push is ambiguous and must not create a duplicate
  commit.
- **Persisted backoff.** The wait is saved locally before the request is re-sent, so automatic
  foreground, background, edit, and interval triggers hold off until the backoff window passes even
  if Obsidian is suspended mid-wait.
- **Fewer duplicate reads.** A normal sync now reads the branch once and memoizes remote file reads
  within a single plan, cutting redundant requests.

Normal sync keeps using the incremental raw-file endpoints on every device; the `archive.zip`
download remains Connect/bootstrap-only. No Reset or reconnecting is required — just install the
update.

## Connect self-signed certificate opt-in

Fixes desktop Connect failing with `self signed certificate in certificate chain` on a network that
uses TLS interception. The Vault setup block now shows a default-off toggle **Allow self-signed
certificate for Connect**.

- It disables TLS verification **only** for the desktop Node HTTPS archive download used by the
  initial Connect operation.
- Normal incremental sync, raw reads, commit uploads, and Obsidian `requestUrl` certificate handling
  are unchanged.
- Enable it only when Connect reports a certificate error against a GitLab and network you trust —
  an intercepted connection could otherwise expose your GitLab token.
- The control is hidden after a successful Connect; its stored value stays dormant because normal
  sync never uses the archive fallback.