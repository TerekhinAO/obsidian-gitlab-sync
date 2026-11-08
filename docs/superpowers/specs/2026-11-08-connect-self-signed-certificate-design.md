# Connect self-signed certificate opt-in — design

Date: 2026-11-08
Status: approved

## Problem

The Connect flow first tries Obsidian `requestUrl` for GitLab's repository ZIP archive. GitLab.com can answer that request with `406 Not Acceptable`, so desktop Connect falls back to Node HTTPS with the curl-compatible headers established in commit `3757914`. In the tested corporate environment, that fallback fails before receiving a response with `self signed certificate in certificate chain`, even though the read-only Connect preview succeeds through Obsidian.

The fallback currently has no supported way to accept the corporate TLS interception certificate. Disabling TLS verification globally would expose normal sync traffic and commit requests, and is not possible for Obsidian `requestUrl` in any case.

## Goal

Add an explicit, default-off setting named **Allow self-signed certificate for Connect**. When enabled, it disables certificate verification only for the desktop Node HTTPS ZIP-archive fallback used by the initial Connect operation.

## User experience

- Show the toggle directly in the **Vault setup** block, immediately with the pre-connect controls.
- Show it only while the vault is not initialized, alongside **Connect to GitLab**; hide it after the vault is connected.
- Exact label: **Allow self-signed certificate for Connect**.
- Description: explain that it affects only the Connect archive download and can expose the GitLab token to interception; recommend enabling it only for a trusted GitLab/network.
- Persist the selection with the existing plugin settings. Existing installations migrate to `false`.

## Behavior and scope

- `false` remains the default and preserves strict TLS validation.
- `true` maps to Node HTTPS `rejectUnauthorized: false` only in `requestArchiveWithNode()`.
- The first Obsidian `requestUrl` archive attempt remains unchanged.
- Connect preview, ordinary incremental sync, raw file/blob reads, scheduler/retries, and commit POST requests remain unchanged.
- The setting does not make self-signed certificates work for Obsidian `requestUrl`; its deliberately narrow name and description reflect the only transport it controls.
- No global environment variables, global HTTPS agent mutation, or `NODE_TLS_REJECT_UNAUTHORIZED` changes are allowed.
- The GitLab token must remain in the request header and redacted from logs and diagnostics.
- This is a pre-release acceptance fix for the still-local `1.0.18`; no version bump is required before the first push/release of `1.0.18`.

## Interfaces

- `GitLabSyncSettings.allowSelfSignedCertificateForConnect: boolean`
- `DEFAULT_SETTINGS.allowSelfSignedCertificateForConnect = false`
- `ArchiveFallbackRequest.rejectUnauthorized: boolean`
- `GitLabClient.downloadArchive()` sets `rejectUnauthorized` to the inverse of the setting when it constructs the Node fallback request.
- `requestArchiveWithNode()` forwards that value to `https.request()` without changing any other request option.

## Security constraints

- The insecure behavior must require an explicit user action and must never be inferred from a certificate failure.
- The option must not silently retry with TLS validation disabled.
- The setting must not affect non-archive requests.
- Diagnostics may record that insecure archive TLS was enabled, but must not log the token or raw request headers containing it.

## Testing and acceptance

- State loading without the new field produces `false` and preserves all existing settings/state.
- The pre-connect Vault setup block renders the exact toggle, persists changes, and hides it after initialization.
- The default archive fallback request carries `rejectUnauthorized: true`.
- With the setting enabled, only the archive fallback request carries `rejectUnauthorized: false`.
- A normal GitLab request remains on Obsidian `requestUrl` and receives no insecure TLS option.
- Production Node HTTPS receives the exact `rejectUnauthorized` value.
- Existing retry, scheduler, Connect, lifecycle, lint, typecheck, and build checks remain green.
- Manual acceptance: install the rebuilt `1.0.18` bundle, enable the toggle in Vault setup, complete Connect against the observed environment, and confirm the vault initializes successfully.

## Considered alternatives

- **Install a specific CA certificate:** safer, but requires certificate distribution and platform-specific trust-store handling.
- **Replace archive bootstrap with raw-file bootstrap:** keeps TLS validation but changes the Connect architecture and request volume.
- **Chosen:** a narrowly scoped, explicit opt-in because it is the smallest change that unblocks the known desktop Connect failure without weakening normal sync.
