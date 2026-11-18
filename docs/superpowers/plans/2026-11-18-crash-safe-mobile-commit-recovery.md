# Crash-Safe Mobile Commit Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an accepted-but-unacknowledged mobile GitLab commit from leaving the next sync on a stale base or creating a duplicate commit.

**Architecture:** Persist a durable intent before every `POST /repository/commits`, tag that commit message with a unique sync transaction id, and resolve the intent on the next network sync by searching branch history from its head back to the intended base. If the tagged commit is found, convert the intent to the existing confirmed `pendingTransaction` and recover local materialization. If history proves the tagged commit was not accepted, clear the intent and resume normal planning; if ancestry is unknown, never retry the POST automatically.

**Tech Stack:** TypeScript, Obsidian `requestUrl`, GitLab REST API v4, Vitest, existing `StateStore`, `SyncManager`, and `LocalMaterializer`.

**Spec:** This plan extends `docs/superpowers/plans/2026-11-08-mobile-raw-sync-reliability.md`, especially its rule that an ambiguous POST must never be automatically retried.

## Global Constraints

- Persist the pre-commit intent before starting `POST /repository/commits`.
- Every generated commit message must contain exactly one parseable transaction id.
- Never automatically resend a commit while its transaction outcome is unknown.
- Search branch history through the intended base SHA before concluding that an unconfirmed POST was not accepted.
- If the intended base is no longer an ancestor or history is unavailable, fail recovery rather than risking a duplicate POST.
- Preserve the existing invariant: `lastSyncedCommitSha` advances only after local materialization succeeds.
- Keep transaction ids opaque; do not persist or log vault contents in the intent.
- Keep the current `PendingTransaction` recovery behavior unchanged.
- No retry-policy change for POST transport errors or ambiguous 5xx responses.
- Existing schema-3 data must load without migration; the new nullable field defaults to `null`.

## Review Focus

- POST is accepted but iOS kills Obsidian before the HTTP response: the next foreground sync must find the commit by transaction id and recover from it.
- POST times out without acceptance and the branch is still at the intended base: the next sync must safely discard the intent and re-plan, not retry the old payload blindly.
- Another device commits after the mobile commit: transaction search must inspect ancestry, not only branch HEAD.
- A force push removes the intended base or transaction commit: recovery must remain blocked rather than create a possible duplicate.
- A confirmed commit exists but local materialization died midway: the existing `pendingTransaction` resume/finalization behavior must remain intact.

---

### Task 1: Commit the reviewed recovery plan

**Files:**
- Create: `docs/superpowers/plans/2026-11-18-crash-safe-mobile-commit-recovery.md`

**Interfaces:**
- Produces the authoritative implementation sequence for Tasks 2–5.

- [ ] Commit this plan before changing production code.

### Task 2: GitLab commit-history reader

**Files:**
- Modify: `src/gitlab/types.ts`
- Modify: `src/gitlab/client.ts`
- Test: `tests/gitlab/client.test.ts`

**Interfaces:**
- Produces `GitLabCommitSummary { id, parent_ids, title, message }`.
- Produces `GitLabClient.listCommits(ref: string, page?: string): Promise<GitLabCommitSummary[]>`.

**TDD steps:**

- [ ] Add a failing client test for `GET /repository/commits?ref_name=...&per_page=100&page=2`.
- [ ] Verify it fails because `listCommits` does not exist.
- [ ] Implement the paged REST reader without adding retries or changing POST behavior.
- [ ] Run GitLab client tests and commit only this task.

### Task 3: Durable pre-commit intent state

**Files:**
- Modify: `src/sync/types.ts`
- Modify: `src/sync/state-store.ts`
- Test: `tests/sync/state-store.test.ts`

**Interfaces:**
- Produces `UnconfirmedCommit { transactionId, basedOnRemoteSha, plan, createdAt }`.
- Adds nullable `LocalSyncState.unconfirmedCommit`.

**TDD steps:**

- [ ] Add a failing schema-compatibility test proving old schema-3 state loads with `unconfirmedCommit: null`.
- [ ] Add a failing round-trip test proving a saved `unconfirmedCommit` is preserved exactly.
- [ ] Implement state persistence while retaining schema version 3.
- [ ] Run state-store tests and commit only this task.

### Task 4: Transaction ids and pre-commit persistence

**Files:**
- Modify: `src/sync/sync-manager.ts`
- Test: `tests/sync/sync-manager.test.ts`

**Interfaces:**
- Produces manager helpers for transaction-id generation, commit-message tagging/parsing, and atomic intent persistence/clearing.

**TDD steps:**

- [ ] Add failing message tests for idempotent parse and generation.
- [ ] Add a failing sync test proving `unconfirmedCommit` is saved before `createCommit` resolves.
- [ ] Add a failing test proving the successful response atomically replaces the intent with the existing confirmed `pendingTransaction`.
- [ ] Implement the minimum manager changes.
- [ ] Run focused manager tests and commit only this task.

### Task 5: Resolve ambiguous transactions from branch history

**Files:**
- Modify: `src/sync/sync-manager.ts`
- Test: `tests/sync/sync-manager.test.ts`

**Interfaces:**
- Consumes `listCommits`.
- Consumes `UnconfirmedCommit`.
- Produces an outcome of `"found" | "absent" | "unknown"`.

**TDD steps:**

- [ ] Add a failing test: accepted mobile commit behind a newer desktop commit is found by id, converted to `pendingTransaction`, and recovered without another POST.
- [ ] Add a failing test: branch history reaches the intended base without the id, so the intent is cleared and a fresh plan may run.
- [ ] Add a failing test: intended base is absent from available history, so recovery returns an error and does not call `createCommit`.
- [ ] Add a failing test: successful POST followed by death before response processing is recovered through the same id search path.
- [ ] Implement bounded ancestry search and integrate it after `getBranch`, before normal planning.
- [ ] Run focused tests and commit only this task.

### Task 6: Final review and verification

**Files:**
- No additional production files.

**TDD steps:**

- [ ] Run the complete suite: `node_modules/.bin/vitest run`.
- [ ] Run `node_modules/.bin/tsc --noEmit --skipLibCheck`.
- [ ] Run `node_modules/.bin/eslint src tests`.
- [ ] Run production esbuild.
- [ ] Review that no automatic POST retry path can run with an unconfirmed transaction.
- [ ] Commit final corrections, if any.
