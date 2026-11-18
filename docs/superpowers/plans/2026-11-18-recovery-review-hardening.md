# Recovery Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three remaining review findings without reintroducing stale-plan recovery.

**Architecture:** Recover an accepted ambiguous commit from its actual GitLab tree while fencing dirty paths by captured revision; make production sync read settings from persisted state instead of a stale object reference; perform reset under the SyncManager lock and an atomic state check.

**Tech Stack:** TypeScript, GitLab REST API v4, existing `RemoteDiffService`, `StreamingRemoteApplier`, `StateStore`, Vitest.

**Spec:** Extends `docs/superpowers/plans/2026-11-18-crash-safe-mobile-commit-recovery.md`.

## Global Constraints

- Never replay a stored content payload for an ambiguous commit.
- Never create a second commit while resolving an already accepted commit.
- Preserve a dirty entry when its revision differs from the revision captured before POST.
- Production `SyncManager` must use persisted settings at the start of each operation.
- Reset must be atomic with respect to persisted intent and serialized with sync/recovery.

## Tasks

### Task 1: Found-commit materialization

- [ ] Add a failing test proving a found accepted commit with a conflict-copy action is materialized from GitLab and does not invoke the planner or `createCommit`.
- [ ] Store content-less captured dirty revisions in `UnconfirmedCommit`.
- [ ] Recover the actual found commit by applying its base-to-commit changes through the streaming applier, skipping currently changed dirty paths.
- [ ] Finalize the found commit and exact unchanged dirty revisions.

### Task 2: Production settings freshness

- [ ] Add a failing lifecycle test showing `SyncManager` continues using the saved branch after `saveSettings()`.
- [ ] Stop passing the mutable settings object from production plugin construction.

### Task 3: Atomic reset

- [ ] Add a failing race test where intent appears between reset's read and update.
- [ ] Move reset under the manager lock and check intent inside `StateStore.update`.

### Task 4: Verification

- [ ] Run tests, typecheck, lint, production build, and diff check.
