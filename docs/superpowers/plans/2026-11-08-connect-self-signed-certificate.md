# Connect Self-Signed Certificate Opt-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-off **Allow self-signed certificate for Connect** toggle in the Vault setup block that disables certificate validation only for the desktop Node HTTPS archive fallback used by initial Connect.

**Architecture:** Persist one boolean in `GitLabSyncSettings`, render it only with the pre-connect Vault setup controls, and propagate it as an explicit `rejectUnauthorized` value from `GitLabClient.downloadArchive()` into `requestArchiveWithNode()`. Do not mutate global TLS state and do not change Obsidian `requestUrl`, normal incremental sync, raw reads, or commit POST behavior.

**Tech Stack:** TypeScript, Obsidian plugin API, Node `https`, Vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-11-08-connect-self-signed-certificate-design.md`

## Global Constraints

- Exact UI label: `Allow self-signed certificate for Connect`.
- The toggle appears directly in the pre-connect `Vault setup` block and is hidden after initialization.
- Default and migrated value is `false`.
- Only the Node HTTPS ZIP-archive fallback may receive `rejectUnauthorized: false`.
- Never set `NODE_TLS_REJECT_UNAUTHORIZED`, mutate `https.globalAgent`, or disable TLS for Obsidian `requestUrl`.
- Never log the GitLab token or unredacted authenticated headers.
- Keep minimum Obsidian version `1.11.4`.
- Keep the still-unreleased version at `1.0.18`; this is an acceptance fix before its first push/release.
- Generated root `main.js` and `dist/` remain ignored artifacts; rebuild and verify them, but follow the repository's existing tracking convention.

## Review Focus

- Old `data.json` without the new boolean must load as `false` without resetting any settings or sync state.
- A saved `false` value must not be confused with a missing value during settings merging.
- Enabling the option must affect the Node archive fallback only; preview and normal sync must remain strict and on `requestUrl`.
- The insecure option must be passed explicitly to Node `https.request()` and must not leak through a shared/global agent.
- The UI warning and diagnostics must make the narrow scope visible without exposing the token.

---

## File Structure

- `src/sync/types.ts` — add the persisted boolean to `GitLabSyncSettings`.
- `src/settings/settings.ts` — define the safe default used by migration/loading.
- `src/settings/settings-tab.ts` — render and persist the toggle inside the pre-connect Vault setup block.
- `src/gitlab/client.ts` — map the setting to the archive fallback request only.
- `src/gitlab/archive-fallback.ts` — forward explicit TLS verification to Node `https.request()`.
- `tests/settings.test.ts` — pin migration/default persistence.
- `tests/settings-tab.test.ts` — pin placement, exact copy, persistence, and post-connect hiding.
- `tests/gitlab/client.test.ts` — pin safe/default and opted-in fallback request values and non-archive isolation.
- `tests/gitlab/archive-fallback.test.ts` — pin the production adapter's `https.request()` option without network access.
- `README.md` and `.github/release-notes.md` — document the setting, scope, and risk.

---

### Task 1: Persist the safe, default-off setting

**Files:**
- Modify: `src/sync/types.ts:17-35`
- Modify: `src/settings/settings.ts:5-23`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: existing `StateStore.load()` merge with `DEFAULT_SETTINGS`.
- Produces: `GitLabSyncSettings.allowSelfSignedCertificateForConnect: boolean` with default `false`.

- [ ] **Step 1: Write the failing migration/default test**

Add a test named `defaults Connect self-signed certificate access to false for old plugin data`. Load plugin data whose `settings` omits the field but contains representative existing settings and initialized state. Assert:

```ts
expect(data.settings.allowSelfSignedCertificateForConnect).toBe(false);
expect(data.settings.projectPath).toBe("group/project");
expect(data.state.initialized).toBe(true);
```

Add a second assertion to the existing settings persistence test that an explicit `true` survives `save()` and a subsequent `load()`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
./node_modules/.bin/vitest run tests/settings.test.ts
```

Expected: FAIL because the field does not exist in `GitLabSyncSettings` or `DEFAULT_SETTINGS`.

- [ ] **Step 3: Add the setting type and default**

Add to `GitLabSyncSettings` in `src/sync/types.ts`:

```ts
allowSelfSignedCertificateForConnect: boolean;
```

Add to `DEFAULT_SETTINGS` in `src/settings/settings.ts`:

```ts
allowSelfSignedCertificateForConnect: false,
```

Do not change the state schema version: this is a settings default handled by the existing settings merge, not a state-layout migration.

- [ ] **Step 4: Run settings and state-store tests**

Run:

```bash
./node_modules/.bin/vitest run tests/settings.test.ts tests/sync/state-store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the settings model**

```bash
git add src/sync/types.ts src/settings/settings.ts tests/settings.test.ts
git commit -m "feat(settings): add Connect self-signed certificate opt-in"
```

---

### Task 2: Render the toggle directly in the pre-connect Vault setup block

**Files:**
- Modify: `src/settings/settings-tab.ts:149-187`
- Modify: `tests/settings-tab.test.ts`

**Interfaces:**
- Consumes: `GitLabSyncSettings.allowSelfSignedCertificateForConnect` from Task 1 and `plugin.saveSettings()`.
- Produces: a pre-connect-only toggle with exact label `Allow self-signed certificate for Connect`.

- [ ] **Step 1: Write failing settings-tab tests**

Extend the settings UI mock only as needed to inspect toggle name, description, current value, and change handler. Add tests named:

```ts
it("renders the self-signed certificate toggle in the pre-connect Vault setup block")
it("persists the Connect self-signed certificate toggle")
it("hides the Connect self-signed certificate toggle after initialization")
```

Pin these outcomes:

```ts
expect(toggle.name).toBe("Allow self-signed certificate for Connect");
expect(toggle.description).toContain("Connect archive download");
expect(toggle.description).toContain("token");
expect(toggle.value).toBe(false);

await toggle.change(true);
expect(plugin.settings.allowSelfSignedCertificateForConnect).toBe(true);
expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
```

For initialized state, assert no setting with the exact label is rendered.

- [ ] **Step 2: Run the focused UI tests and verify they fail**

Run:

```bash
./node_modules/.bin/vitest run tests/settings-tab.test.ts -t "self-signed certificate"
```

Expected: FAIL because no such toggle is rendered.

- [ ] **Step 3: Implement the pre-connect toggle**

Inside `if (setupState.showSetupActions)` in `src/settings/settings-tab.ts`, render a `Setting` immediately before the existing Connect button setting:

```ts
.setName("Allow self-signed certificate for Connect")
.setDesc(
  "Connect archive download only. Disables TLS certificate verification and can expose the GitLab token. Enable only for a trusted GitLab and network.",
)
```

Bind its toggle to `this.plugin.settings.allowSelfSignedCertificateForConnect`; on change, assign the boolean and await `this.plugin.saveSettings()`.

Keep it inside `showSetupActions` so it disappears after successful Connect. Do not add the toggle to the general Sync section.

- [ ] **Step 4: Run all settings-tab tests**

Run:

```bash
./node_modules/.bin/vitest run tests/settings-tab.test.ts
```

Expected: PASS with the existing single Connect button behavior unchanged.

- [ ] **Step 5: Commit the Vault setup UI**

```bash
git add src/settings/settings-tab.ts tests/settings-tab.test.ts mock-obsidian.ts
git commit -m "feat(settings): show insecure Connect TLS toggle"
```

---

### Task 3: Scope insecure TLS to the Node Connect archive fallback

**Files:**
- Modify: `src/gitlab/archive-fallback.ts:3-44`
- Modify: `src/gitlab/client.ts:225-255`
- Modify: `tests/gitlab/client.test.ts`
- Create: `tests/gitlab/archive-fallback.test.ts`

**Interfaces:**
- Consumes: `GitLabSyncSettings.allowSelfSignedCertificateForConnect` from Task 1.
- Produces: `ArchiveFallbackRequest.rejectUnauthorized: boolean`; `requestArchiveWithNode()` passes it to Node `https.request()`.

- [ ] **Step 1: Write failing client scope tests**

Extend the existing `falls back to curl-equivalent HTTPS when Obsidian rejects the archive` test to assert the injected fallback receives:

```ts
expect(request.rejectUnauthorized).toBe(true);
```

Add a test named `allows a self-signed certificate only for the opted-in Connect archive fallback`. Use settings with `allowSelfSignedCertificateForConnect: true`, queue the existing `406`, capture the injected fallback request, and assert:

```ts
expect(request.rejectUnauthorized).toBe(false);
expect(request.method).toBe("GET");
expect(request.url).toContain("/repository/archive.zip");
```

Also call a normal API method with the same enabled settings and assert it uses the ordinary fake `requestUrl` path and never invokes `requestArchiveFallback`.

- [ ] **Step 2: Write the failing Node adapter test**

Create `tests/gitlab/archive-fallback.test.ts`. Extend the production function with this optional test seam, preserving its one-argument production use:

```ts
export async function requestArchiveWithNode(
  request: ArchiveFallbackRequest,
  transportOverride?: Pick<typeof import("https"), "request">,
): Promise<ArchiveFallbackResponse>
```

Use `transportOverride ?? require(...)` internally. Supply a fake `request` implementation in tests and capture its options. Add tests named:

```ts
it("keeps certificate verification enabled by default")
it("forwards the explicit Connect archive TLS opt-in")
```

Capture the second argument passed to `transport.request` and assert `rejectUnauthorized` is respectively `true` and `false`. Return a minimal event-emitter response so `requestArchiveWithNode()` resolves without network access.

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
./node_modules/.bin/vitest run tests/gitlab/client.test.ts tests/gitlab/archive-fallback.test.ts -t "certificate|archive TLS|curl-equivalent"
```

Expected: FAIL because the request type and Node transport option do not exist.

- [ ] **Step 4: Add the explicit archive TLS request option**

In `src/gitlab/archive-fallback.ts`, extend:

```ts
export interface ArchiveFallbackRequest {
  url: string;
  method: "GET";
  headers: Record<string, string>;
  rejectUnauthorized: boolean;
}
```

Pass it only through the local request options:

```ts
transport.request(url, {
  method: request.method,
  headers: request.headers,
  rejectUnauthorized: request.rejectUnauthorized,
}, callback);
```

Do not create or modify a global agent.

- [ ] **Step 5: Map the persisted setting in `GitLabClient.downloadArchive()`**

When constructing `ArchiveFallbackRequest` in `src/gitlab/client.ts`, add:

```ts
rejectUnauthorized: !this.settings.allowSelfSignedCertificateForConnect,
```

Do not add this value to `RequestUrlOptions`, normal request headers, or the archive diagnostic headers.

- [ ] **Step 6: Run all GitLab client and fallback tests**

Run:

```bash
./node_modules/.bin/vitest run tests/gitlab/client.test.ts tests/gitlab/archive-fallback.test.ts
```

Expected: PASS; default remains strict, opt-in affects only the Node archive fallback, and the token remains redacted from diagnostics.

- [ ] **Step 7: Commit the scoped transport behavior**

```bash
git add src/gitlab/archive-fallback.ts src/gitlab/client.ts tests/gitlab/client.test.ts tests/gitlab/archive-fallback.test.ts
git commit -m "feat(connect): allow opted-in self-signed archive TLS"
```

---

### Task 4: Document, verify, and rebuild the `1.0.18` acceptance bundle

**Files:**
- Modify: `README.md`
- Modify: `.github/release-notes.md`
- Generated: `main.js`
- Generated: `dist/obsidian-plugin/gitlab-gitless-sync/main.js`
- Verify: `manifest.json`, `dist/obsidian-plugin/gitlab-gitless-sync/manifest.json`, `styles.css`

**Interfaces:**
- Consumes: the persisted setting and scoped archive fallback from Tasks 1-3.
- Produces: documented and installable pre-release `1.0.18` bundle for real Obsidian acceptance testing.

- [ ] **Step 1: Document the exact scope and risk**

In the README Connect/troubleshooting sections, document:

- the toggle appears in Vault setup before Connect;
- it only changes the desktop Node archive fallback;
- it should be enabled only when Connect reports a self-signed certificate error on a trusted GitLab/network;
- it does not alter ordinary sync or Obsidian `requestUrl` certificate handling;
- after successful Connect the control is hidden and the stored value is dormant because normal sync never uses the archive fallback; resetting local sync state exposes the control again.

In `.github/release-notes.md`, add the acceptance fix without changing the release version from `1.0.18`.

- [ ] **Step 2: Run the complete automated verification**

Run with a valid Obsidian dependency resolution:

```bash
./node_modules/.bin/vitest run
./node_modules/.bin/tsc --noEmit --skipLibCheck
./node_modules/.bin/eslint src tests
npm run build
```

Expected: all tests pass, TypeScript and ESLint report zero errors, and production build exits `0`. If the workspace's `node_modules/obsidian` symlink is still broken, perform typecheck/build in a clean temporary checkout wired to the installed `obsidian@1.13.1`; do not treat missing module resolution as a product-code failure.

- [ ] **Step 3: Refresh and verify the ignored bundle**

Copy generated files following `AGENTS.md`:

```bash
cp main.js dist/obsidian-plugin/gitlab-gitless-sync/main.js
cp manifest.json dist/obsidian-plugin/gitlab-gitless-sync/manifest.json
cp styles.css dist/obsidian-plugin/gitlab-gitless-sync/styles.css
cmp main.js dist/obsidian-plugin/gitlab-gitless-sync/main.js
cmp manifest.json dist/obsidian-plugin/gitlab-gitless-sync/manifest.json
cmp styles.css dist/obsidian-plugin/gitlab-gitless-sync/styles.css
node -e "const m=require('./dist/obsidian-plugin/gitlab-gitless-sync/manifest.json'); if(m.version!=='1.0.18') process.exit(1)"
```

Expected: all comparisons and the version assertion exit `0`.

- [ ] **Step 4: Commit tracked documentation**

```bash
git add README.md .github/release-notes.md
git commit -m "docs: explain self-signed Connect certificate option"
```

- [ ] **Step 5: Perform manual Obsidian acceptance**

Install the rebuilt bundle into a fresh test vault. Before Connect, confirm the toggle is visible in Vault setup and disabled. Enable it, run Connect against the environment that previously logged `self signed certificate in certificate chain`, and verify:

```text
Connected to GitLab
state.initialized = true
no certificate error in .obsidian/gitlab-gitless-sync.log
```

Then run one ordinary manual sync and confirm it completes through the existing incremental raw API path.

---

## Self-Review Results

- **Spec coverage:** persistence, exact UI placement/copy, transport scoping, security warning, documentation, build, and manual acceptance each map to a task.
- **Step scan:** each step is a single test, implementation, verification, or commit action; no production implementation is included beyond the exact interface and pinned option mapping.
- **Type consistency:** the settings field and `ArchiveFallbackRequest.rejectUnauthorized` names are identical across all tasks.
- **Review focus coverage:** migration is Task 1; UI placement/hiding is Task 2; strict default, opt-in, isolation, and global-agent avoidance are Task 3; user-facing warning and real-vault acceptance are Task 4.
- **Proportion:** four independently reviewable tasks cover one persisted setting, one UI control, one scoped transport option, and release verification without unrelated refactors.
