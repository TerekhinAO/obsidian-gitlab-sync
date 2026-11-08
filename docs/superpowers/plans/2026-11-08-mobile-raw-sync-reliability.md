# Mobile Raw Sync Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large incremental GitLab syncs reliable on iPhone by pacing raw API traffic, honoring GitLab backoff instructions, retrying only safe requests, and preventing automatic sync loops from restarting a throttled transfer.

**Architecture:** Keep the existing incremental `repository/files/:path/raw` and `repository/blobs/:sha/raw` design for normal sync. Add one shared request scheduler per `SyncManager`, bounded retry policy for idempotent GETs, persisted remote backoff state, and per-sync remote-content memoization. Keep `archive.zip` restricted to Connect/bootstrap because its curl-equivalent Node fallback is unavailable on iPhone.

**Tech Stack:** TypeScript, Obsidian `requestUrl`, GitLab REST API v4, Vitest, existing `StateStore`, existing fake GitLab server.

**Spec:** The historical context, decisions, constraints, and acceptance criteria in this plan extend the original `2026-07-26-gitlab-gitless-sync-fork-plan.md` architecture.

## Historical Context

- `fd180a3` introduced `getRawFile`, `getRawBlob`, and `downloadArchive` together. Raw endpoints were selected for normal three-way sync; the archive was selected for initial Connect/bootstrap.
- `8c8f732` fixed raw responses being parsed as JSON. Raw text and binary responses must continue to use `ArrayBuffer` without touching `response.json`.
- `3757914` documented the archive transport failure: Obsidian `requestUrl` received `406 Not Acceptable`, while a curl-equivalent Node HTTPS request with `Accept: application/zip` and `User-Agent: curl/8.7.1` succeeded. The fallback uses Node `https` and `Buffer`, so it is not a mobile transport.
- The original plan required `Retry-After` to be honored for `429`, but the current client only constructs `GitLabRateLimitError`; it does not wait and retry.
- The 2026-11-08 iPhone evidence showed 43 unique raw file requests in about 24 seconds followed by a request timeout after about 61 seconds. A separate run returned `429 Rate limit exceeded`. The failure is request-volume and retry-policy related, not path encoding related.
- Documentation and tests must use aggregate counts and synthetic paths. Do not commit real vault paths, people names, project paths, tokens, or raw diagnostic logs.

## Global Constraints

- Normal sync must not use `downloadArchive`; archive transport remains Connect/bootstrap-only.
- Production network traffic must continue through Obsidian `requestUrl`; do not add Node HTTP dependencies to mobile sync.
- Every authenticated request must keep `PRIVATE-TOKEN` out of URLs and logs.
- Only idempotent GET requests may be retried after transport errors, `429`, or `5xx`.
- Never automatically retry `POST /repository/commits` after a transport timeout or ambiguous `5xx` response.
- `429` retries must honor a valid `Retry-After` header; use 60 seconds when the header is absent or invalid.
- Retry count is bounded: at most three retries after the initial GET attempt.
- Schedule request starts at least 750 ms apart, yielding at most 80 starts per minute per plugin instance before server-requested backoff.
- A server-requested backoff must be persisted before sleeping so an iOS suspension/reload cannot immediately restart the burst.
- Existing transactional materialization rules remain unchanged: do not advance `lastSyncedCommitSha` until local materialization succeeds.
- No persistent remote file-content cache is added in this release. Per-sync memoization is allowed; cross-run resumable downloads are a separate future change.
- Keep plugin minimum Obsidian version `1.11.4` and release the fix as `1.0.18`.

## Review Focus

- `Retry-After` may be missing, invalid, zero, or use different header casing; the client must choose a deterministic safe delay.
- A GET timeout is retryable, but a POST timeout is indeterminate and must never create a second commit automatically.
- iOS may suspend the app during backoff; persisted `remoteBackoffUntil` must prevent foreground/background triggers from immediately restarting.
- A remote commit may change more than 100 files; the integration test must complete without archive use and without losing materialization operations.
- Foreground, background, edit, interval, and manual triggers may arrive while a sync is running or deferred; only one request stream may run.

---

### Task 0: Preserve the reviewed fix plan

**Files:**
- Create: `docs/superpowers/plans/2026-11-08-mobile-raw-sync-reliability.md`

**Interfaces:**
- Consumes: the existing repository history and the original fork plan.
- Produces: the reviewed implementation sequence used by every later task.

- [ ] **Step 1: Commit the reviewed plan before product changes**

```bash
git add docs/superpowers/plans/2026-11-08-mobile-raw-sync-reliability.md
git commit -m "docs: plan mobile raw sync reliability fix"
```

---

### Task 1: Encode the safe GET retry policy

**Files:**
- Modify: `src/gitlab/client.ts`
- Modify: `src/gitlab/errors.ts`
- Modify: `tests/helpers/fake-request-url.ts`
- Modify: `tests/gitlab/client.test.ts`

**Interfaces:**
- Consumes: existing `GitLabRateLimitError.retryAfterSeconds`, `GitLabClientOptions.sleep`.
- Produces: `GitLabTransportError`, bounded GET retry behavior, and `GitLabClientOptions.onBackoff`.

- [ ] **Step 1: Extend the fake transport to queue thrown network errors**

Add:

```ts
queueError(error: Error): void;
```

`requestUrl` must consume responses and errors from one ordered queue so a timeout followed by a success is testable.

- [ ] **Step 2: Write failing client tests for `429`**

Add tests named:

```ts
it("waits for Retry-After and retries an idempotent GET")
it("uses the safe default when Retry-After is missing or invalid")
it("stops after three GET retries and returns GitLabRateLimitError")
```

Pin these assertions:

```ts
expect(sleep).toHaveBeenCalledWith(7_000);
expect(fake.calls).toHaveLength(2);
expect(onBackoff).toHaveBeenCalledWith(expect.objectContaining({
  reason: "rate-limit",
  delayMs: 7_000,
}));
```

- [ ] **Step 3: Run the `429` tests and verify they fail**

Run:

```bash
pnpm vitest run tests/gitlab/client.test.ts -t "Retry-After|three GET retries|safe default"
```

Expected: FAIL because the current client throws immediately on `429`.

- [ ] **Step 4: Write failing tests for transport timeouts and POST safety**

Add tests named:

```ts
it("retries a GET after a requestUrl transport failure")
it("does not retry a POST after a requestUrl transport failure")
it("does not retry a POST after an ambiguous 5xx response")
```

The POST tests must assert `fake.calls` has length `1`.

- [ ] **Step 5: Run the transport tests and verify they fail**

Run:

```bash
pnpm vitest run tests/gitlab/client.test.ts -t "transport failure|ambiguous 5xx"
```

Expected: GET does not retry, and the current generic retry loop retries POST `5xx`.

- [ ] **Step 6: Add the transport error and retry callback types**

In `src/gitlab/errors.ts` add:

```ts
export class GitLabTransportError extends GitLabApiError {
  constructor(message: string) {
    super(0, message);
    this.name = "GitLabTransportError";
  }
}
```

In `src/gitlab/client.ts` add:

```ts
export interface GitLabBackoffDiagnostic {
  reason: "rate-limit" | "server" | "transport";
  method: string;
  path: string;
  attempt: number;
  delayMs: number;
  retryAt: number;
}
```

Extend `GitLabClientOptions` with `maxGetRetries`, `defaultRateLimitDelayMs`, `now`, and `onBackoff`.

- [ ] **Step 7: Implement one bounded retry loop for GET only**

Retain the existing request method and response parsing. The loop must:

- retry GET transport failures with exponential delays `1_000`, `2_000`, `4_000` ms;
- retry GET `5xx` with the existing exponential behavior;
- retry GET `429` after `Retry-After * 1_000`, or `60_000` ms when absent/invalid;
- call and await `onBackoff` before sleeping;
- throw immediately for non-GET transport failures and `5xx`;
- preserve the final typed error after the retry budget is exhausted.

- [ ] **Step 8: Run the focused and full client tests**

Run:

```bash
pnpm vitest run tests/gitlab/client.test.ts
pnpm typecheck
```

Expected: all client tests pass and TypeScript reports no errors.

- [ ] **Step 9: Commit the retry policy**

```bash
git add src/gitlab/client.ts src/gitlab/errors.ts tests/helpers/fake-request-url.ts tests/gitlab/client.test.ts
git commit -m "fix(gitlab): retry throttled and timed-out GET requests"
```

---

### Task 2: Pace all GitLab request starts through one shared scheduler

**Files:**
- Create: `src/gitlab/request-scheduler.ts`
- Create: `tests/gitlab/request-scheduler.test.ts`
- Modify: `src/gitlab/client.ts`
- Modify: `src/sync/sync-manager.ts`
- Modify: `tests/gitlab/client.test.ts`
- Modify: `tests/sync/sync-manager.test.ts`

**Interfaces:**
- Consumes: `GitLabClientOptions.sleep`, `GitLabClientOptions.now`.
- Produces: `GitLabRequestScheduler.waitForTurn()` and `GitLabRequestScheduler.blockUntil()` shared across clients created by one `SyncManager`.

- [ ] **Step 1: Write failing scheduler tests**

Define tests for:

```ts
it("spaces request starts by 750 milliseconds")
it("extends but never shortens a server backoff")
it("serializes simultaneous callers")
```

The first test must assert requested sleep durations and a maximum of 80 scheduled starts in a synthetic minute.

- [ ] **Step 2: Run scheduler tests and verify they fail**

Run:

```bash
pnpm vitest run tests/gitlab/request-scheduler.test.ts
```

Expected: FAIL because the scheduler module does not exist.

- [ ] **Step 3: Implement `GitLabRequestScheduler`**

Create:

```ts
export interface GitLabRequestSchedulerOptions {
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class GitLabRequestScheduler {
  waitForTurn(): Promise<void>;
  blockUntil(timestamp: number): void;
}
```

Use a promise chain so simultaneous callers cannot acquire the same slot. Default `minIntervalMs` to `750`.

- [ ] **Step 4: Inject the scheduler into `GitLabClient`**

Add `requestScheduler?: Pick<GitLabRequestScheduler, "waitForTurn" | "blockUntil">` to `GitLabClientOptions`. Call `waitForTurn()` immediately before every `requestUrl` attempt, including retries. On `429`, call `blockUntil(retryAt)` before `onBackoff`.

- [ ] **Step 5: Share one scheduler across sync runs**

Add a private scheduler field to `SyncManager` and pass it from `createClient()`. Do not create a new scheduler for every foreground/background/manual sync.

- [ ] **Step 6: Verify scheduler integration**

Run:

```bash
pnpm vitest run tests/gitlab/request-scheduler.test.ts tests/gitlab/client.test.ts tests/sync/sync-manager.test.ts
pnpm typecheck
```

Expected: all tests pass; fake clocks prove request starts are serialized and paced.

- [ ] **Step 7: Commit request pacing**

```bash
git add src/gitlab/request-scheduler.ts src/gitlab/client.ts src/sync/sync-manager.ts tests/gitlab/request-scheduler.test.ts tests/gitlab/client.test.ts tests/sync/sync-manager.test.ts
git commit -m "fix(gitlab): pace mobile API request bursts"
```

---

### Task 3: Persist remote backoff across iOS suspension and plugin reload

**Files:**
- Modify: `src/sync/types.ts`
- Modify: `src/settings/settings.ts`
- Modify: `src/sync/state-store.ts`
- Modify: `src/sync/sync-manager.ts`
- Modify: `src/main.ts`
- Modify: `tests/sync/state-store.test.ts`
- Modify: `tests/sync/sync-manager.test.ts`
- Modify: `tests/plugin-lifecycle.test.ts`

**Interfaces:**
- Consumes: `GitLabClientOptions.onBackoff` from Task 1.
- Produces: state schema `2`, `remoteBackoffUntil`, `remoteBackoffReason`, and `SyncResult.status = "deferred"`.

- [ ] **Step 1: Write failing state migration tests**

Add assertions that schema-1 data loads as:

```ts
expect(data.state.schemaVersion).toBe(2);
expect(data.state.remoteBackoffUntil).toBeNull();
expect(data.state.remoteBackoffReason).toBeNull();
```

Also verify existing tracked files, dirty entries, and pending transactions survive migration unchanged.

- [ ] **Step 2: Run state tests and verify they fail**

Run:

```bash
pnpm vitest run tests/sync/state-store.test.ts
```

Expected: FAIL because schema `2` and backoff fields do not exist.

- [ ] **Step 3: Extend and migrate `LocalSyncState`**

Add:

```ts
schemaVersion: 2;
remoteBackoffUntil: number | null;
remoteBackoffReason: "rate-limit" | "server" | "transport" | null;
```

Update `DEFAULT_STATE`, `cloneDefaultState()`, `load()`, and `save()` so old plugin data migrates without reset.

- [ ] **Step 4: Write failing sync deferral tests**

Cover:

```ts
it("persists backoff before the client sleeps")
it("defers sync without network calls while backoff is active")
it("clears remote backoff after a successful sync")
```

The deferred result must include the retry timestamp and must not call `getBranch`.

- [ ] **Step 5: Implement persisted backoff in `SyncManager`**

Extend `SyncResult` with:

```ts
status: "deferred";
retryAt: number;
```

Wire `onBackoff` to `StateStore.update()`. At sync entry, return `deferred` while `now() < remoteBackoffUntil`. Clear both fields only after a successful or conflict-completed sync.

- [ ] **Step 6: Write failing lifecycle tests for automatic triggers**

Assert foreground, background, edit, and interval triggers skip with reason `remote-backoff` and do not invoke `syncManager.sync()` while the timestamp is in the future.

- [ ] **Step 7: Implement lifecycle backpressure**

Add the backoff check to the existing skip-reason helpers in `src/main.ts`. Manual sync uses the same `SyncManager` guard and shows the remaining wait instead of bypassing it.

- [ ] **Step 8: Verify state and lifecycle behavior**

Run:

```bash
pnpm vitest run tests/sync/state-store.test.ts tests/sync/sync-manager.test.ts tests/plugin-lifecycle.test.ts
pnpm typecheck
```

Expected: migration, suspension, reload, and trigger tests pass.

- [ ] **Step 9: Commit persisted backoff**

```bash
git add src/sync/types.ts src/settings/settings.ts src/sync/state-store.ts src/sync/sync-manager.ts src/main.ts tests/sync/state-store.test.ts tests/sync/sync-manager.test.ts tests/plugin-lifecycle.test.ts
git commit -m "fix(sync): preserve GitLab backoff across mobile lifecycle events"
```

---

### Task 4: Remove redundant reads without reintroducing archive sync

**Files:**
- Modify: `src/sync/sync-manager.ts`
- Modify: `tests/sync/sync-manager.test.ts`
- Modify: `tests/integration/gitlab-sync.integration.test.ts`

**Interfaces:**
- Consumes: existing `getRawFile(path, ref)` and `getRawBlob(blobId)`.
- Produces: one memoized remote-version reader per plan attempt, keyed by `remoteSha + path`.

- [ ] **Step 1: Write a failing test for duplicate branch reads**

Assert a normal successful sync performs one initial `getBranch()` before planning, not both `validateAccess()` and `getBranch()`.

- [ ] **Step 2: Write a failing test for duplicate remote-file reads**

Construct a locally and remotely modified path that is needed by conflict planning and optimistic locking. Assert `getRawFile(path, remoteSha)` is called once during a plan attempt.

- [ ] **Step 3: Write the archive regression test**

Add an integration assertion that a normal sync with more than one remote file change never requests `/repository/archive.zip`.

- [ ] **Step 4: Run the focused tests and verify they fail where expected**

Run:

```bash
pnpm vitest run tests/sync/sync-manager.test.ts tests/integration/gitlab-sync.integration.test.ts
```

Expected: redundant-read assertions fail; archive regression passes or documents current behavior.

- [ ] **Step 5: Reuse the first branch response**

Remove `validateAccess()` from normal sync startup. `getBranch()` already validates authentication, existence, and push capability through `validateBranch()`.

- [ ] **Step 6: Memoize remote versions within one plan attempt**

Create one injected reader in `planAndApply()`:

```ts
(path: string, remoteSha: string) => Promise<VersionState>
```

Cache the promise by `${remoteSha}\0${path}` and pass the same reader to all planner operations in that attempt. Change the private factory signature to:

```ts
createPlanner(
  client: GitLabClientLike,
  settings: GitLabSyncSettings,
  getRemoteVersion: (path: string, remoteSha: string) => Promise<VersionState>,
): PlannerLike
```

Drop the cache when a branch race starts a new attempt.

- [ ] **Step 7: Verify request-count reductions**

Run:

```bash
pnpm vitest run tests/sync/sync-manager.test.ts tests/integration/gitlab-sync.integration.test.ts
pnpm typecheck
```

Expected: one initial branch read, one raw file read per ref/path per attempt, and zero archive requests during normal sync.

- [ ] **Step 8: Commit request deduplication**

```bash
git add src/sync/sync-manager.ts tests/sync/sync-manager.test.ts tests/integration/gitlab-sync.integration.test.ts
git commit -m "perf(sync): deduplicate incremental GitLab reads"
```

---

### Task 5: Prove a large throttled mobile sync completes

**Files:**
- Modify: `tests/helpers/gitlab-test-server.ts`
- Modify: `tests/integration/gitlab-sync.integration.test.ts`
- Modify: `tests/plugin-lifecycle.test.ts`

**Interfaces:**
- Consumes: retry policy, scheduler, backoff state, and memoized reader from Tasks 1–4.
- Produces: end-to-end regression coverage for the observed iPhone failure.

- [ ] **Step 1: Add deterministic throttle and transport-failure hooks to the fake GitLab server**

Add test-only methods:

```ts
rateLimitRequest(requestNumber: number, retryAfterSeconds: number): void;
failTransportOnce(predicate: (request: GitLabTestRequest) => boolean): void;
```

Each hook fires once and records the attempted request.

- [ ] **Step 2: Write the 120-file remote update regression test**

Create 120 synthetic remote changes, return `429` during the raw sequence, then allow retry. Assert:

```ts
expect(result.status).toBe("success");
expect(state.lastSyncedCommitSha).toBe(server.head);
expect(server.requests.some(isArchiveRequest)).toBe(false);
```

Loop through the 120 synthetic paths and assert `vault.read(path)` equals the corresponding remote content. Also assert request start times respect the scheduler using injected fake time.

- [ ] **Step 3: Write the single-timeout recovery test**

Fail one raw GET before response, then succeed. Assert the path is materialized once and the sync completes without creating a GitLab commit.

- [ ] **Step 4: Write the exhausted-retry lifecycle test**

Exhaust retries, simulate app background/foreground, and assert no new network call occurs before persisted backoff expires. Advance fake time and assert the next foreground sync resumes normally.

- [ ] **Step 5: Run integration and lifecycle tests**

Run:

```bash
pnpm vitest run tests/integration/gitlab-sync.integration.test.ts tests/plugin-lifecycle.test.ts
```

Expected: all large-sync, timeout, and lifecycle regressions pass without archive use.

- [ ] **Step 6: Run the complete automated suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Expected: zero failures and zero lint/type errors.

- [ ] **Step 7: Commit the end-to-end regression coverage**

```bash
git add tests/helpers/gitlab-test-server.ts tests/integration/gitlab-sync.integration.test.ts tests/plugin-lifecycle.test.ts
git commit -m "test(sync): cover throttled iPhone raw transfers"
```

---

### Task 6: Record the fix in the existing project documentation and release 1.0.18

**Files:**
- Modify: `README.md`
- Modify: `.github/release-notes.md`
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `versions.json`
- Modify: `dist/obsidian-plugin/gitlab-gitless-sync/main.js`
- Modify: `dist/obsidian-plugin/gitlab-gitless-sync/manifest.json`
- Modify: `dist/obsidian-plugin/gitlab-gitless-sync/styles.css`
- Modify: generated root `main.js`

**Interfaces:**
- Consumes: completed behavior and test evidence from Tasks 1–5.
- Produces: user-facing operational guidance, historical release notes, and installable `1.0.18` bundle.

- [ ] **Step 1: Update README behavior and troubleshooting**

Document only shipped behavior:

- normal sync remains incremental and uses raw endpoints;
- Connect/bootstrap alone uses archive download;
- `429` waits for `Retry-After` and retries automatically;
- safe GET timeouts retry, commit POST timeouts do not;
- automatic triggers respect persisted GitLab backoff;
- a large remote change set can take longer because requests are deliberately paced.

Add a troubleshooting note instructing users not to repeatedly press Sync after `429`.

- [ ] **Step 2: Replace current release notes with the 1.0.18 history**

In `.github/release-notes.md`, explain:

- the observed mobile `429` and 60-second timeout symptoms;
- why normal sync continues using raw endpoints instead of archive;
- request pacing, `Retry-After`, safe GET retry, persisted backoff, and reduced duplicate reads;
- no Reset or reconnect is required.

Do not include real project names, paths, commits, or people names from diagnostic logs.

- [ ] **Step 3: Bump the version to 1.0.18**

Run the repository's existing version workflow:

```bash
npm version 1.0.18 --no-git-tag-version
```

The npm `version` lifecycle invokes `node version-bump.mjs` with `npm_package_version=1.0.18`; do not run that script a second time without the lifecycle environment. Verify `manifest.json`, `package.json`, and `versions.json` all contain `1.0.18`.

- [ ] **Step 4: Run the full release check**

Run:

```bash
pnpm check
```

Expected: tests, typecheck, lint, and production build all pass.

- [ ] **Step 5: Refresh the finished Obsidian bundle**

Following `AGENTS.md`, copy generated `main.js`, `manifest.json`, and `styles.css` into:

```text
dist/obsidian-plugin/gitlab-gitless-sync/
```

- [ ] **Step 6: Verify the bundle**

Run:

```bash
cmp main.js dist/obsidian-plugin/gitlab-gitless-sync/main.js
cmp manifest.json dist/obsidian-plugin/gitlab-gitless-sync/manifest.json
cmp styles.css dist/obsidian-plugin/gitlab-gitless-sync/styles.css
node -e "const m=require('./dist/obsidian-plugin/gitlab-gitless-sync/manifest.json'); if(m.version!=='1.0.18') process.exit(1)"
```

Expected: all commands exit `0`.

- [ ] **Step 7: Commit documentation and release artifacts**

```bash
git add README.md .github/release-notes.md manifest.json package.json versions.json main.js dist/obsidian-plugin/gitlab-gitless-sync/
git commit -m "chore: release 1.0.18"
```

---

## Final Verification

- [ ] Run `pnpm check` from a clean working tree.
- [ ] Confirm `git diff --check` reports no whitespace errors.
- [ ] Confirm normal-sync tests contain no `downloadArchive` call.
- [ ] Confirm client tests prove `Retry-After` is actually awaited, not merely parsed.
- [ ] Confirm POST transport and ambiguous `5xx` failures are attempted exactly once.
- [ ] Confirm schema-1 state migrates to schema 2 without losing tracked files, dirty entries, or pending transactions.
- [ ] Confirm the 120-file integration case reaches the remote head and writes every file locally.
- [ ] Confirm logs and documentation contain no real vault paths, project path, token, or user data.
- [ ] Confirm the final installable bundle is `dist/obsidian-plugin/gitlab-gitless-sync/` version `1.0.18`.
