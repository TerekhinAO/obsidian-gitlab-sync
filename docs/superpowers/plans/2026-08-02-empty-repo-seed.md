# Connect to an empty GitLab repository — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let **Connect to GitLab** initialize a genuinely-empty remote repository by pushing the vault as the first commit, gated on GitLab's `empty_repo` flag so it is never confused with a wrong branch name or an access problem.

**Architecture:** Add `getProject()` + `listBranches()` to the GitLab client. `previewConnect()` fetches the project first: `empty_repo === true` → **seed mode** (push local files as the first commit); otherwise the existing **merge mode**, with a `404` on the configured branch reported as "branch not found" (with the available-branch list) instead of seeding. The seed itself is `SyncManager.initializeEmptyRemote()` — build create-actions from the ignore-aware local file set, `createCommit` (which creates the branch on an empty repo), then reuse the existing adopt finalization for state. `ConnectPreview` becomes a discriminated union so the modal renders a seed variant.

**Tech Stack:** TypeScript, esbuild, Vitest (`obsidian` aliased to `mock-obsidian.ts`), Obsidian plugin API, GitLab REST v4.

**Spec:** `docs/superpowers/specs/2026-08-02-empty-repo-seed-design.md`

## Environment (this sandbox)
- `pnpm` is NOT installed. Use these commands:
  - Tests: `ESBUILD_BINARY_PATH=/tmp/esbuild-linux-28/node_modules/@esbuild/linux-arm64/bin/esbuild node_modules/.bin/vitest run <file>` (omit `<file>` for full suite)
  - Typecheck: `node_modules/.bin/tsc --noEmit --skipLibCheck`
  - Lint: `node_modules/.bin/eslint src tests`
- Branch: `feat/connect-to-gitlab` (continue on it). Baseline: 134 tests passing.
- Commit trailer (last line): `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

- `src/gitlab/types.ts` — MODIFY. Add `GitLabProject`.
- `src/gitlab/client.ts` — MODIFY. Add `getProject()`, `listBranches()`.
- `src/sync/conflict-resolver.ts` — MODIFY. Export the existing `toBase64`.
- `src/sync/sync-manager.ts` — MODIFY. Add `listSyncableLocalFiles()`, extract `finalizeAdoption()`, add `initializeEmptyRemote()`.
- `src/sync/bootstrap-service.ts` — MODIFY. Make `ConnectPreview` a discriminated union; tag `preview()` result `mode: "merge"`.
- `src/views/connect-confirm-modal.ts` — MODIFY. Render the seed variant.
- `src/main.ts` — MODIFY. `previewConnect()` detection; `connect(preview)` branches on mode.
- `src/settings/settings-tab.ts` — MODIFY. Pass the preview to `connect(preview)`.
- Tests alongside each.

---

## Task 1: GitLab client — `getProject()` and `listBranches()`

**Files:**
- Modify: `src/gitlab/types.ts`
- Modify: `src/gitlab/client.ts`
- Test: `tests/gitlab/client.test.ts`

- [ ] **Step 1: Write failing tests**

In `tests/gitlab/client.test.ts` (harness: `fake.queue({status,json,headers})`, then call the client; assert `fake.calls[i].url`). Add:

```ts
it("fetches the project and reports empty_repo", async () => {
  fake.queue({ status: 200, json: { empty_repo: true, default_branch: null } });
  const project = await new GitLabClient(settings, "glpat-test").getProject();
  expect(fake.calls[0].url).toBe(
    "https://gitlab.com/api/v4/projects/developing1382536%2Fobsidian-vault",
  );
  expect(project.empty_repo).toBe(true);
  expect(project.default_branch).toBeNull();
});

it("lists branch names across pages", async () => {
  fake.queue({ status: 200, json: [{ name: "main" }, { name: "dev" }], headers: { "X-Next-Page": "2" } });
  fake.queue({ status: 200, json: [{ name: "release" }], headers: { "X-Next-Page": "" } });
  const names = await new GitLabClient(settings, "glpat-test").listBranches();
  expect(names).toEqual(["main", "dev", "release"]);
  expect(fake.calls[0].url).toBe(
    "https://gitlab.com/api/v4/projects/developing1382536%2Fobsidian-vault/repository/branches?per_page=100&page=1",
  );
  expect(fake.calls[1].url).toContain("page=2");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `ESBUILD_BINARY_PATH=/tmp/esbuild-linux-28/node_modules/@esbuild/linux-arm64/bin/esbuild node_modules/.bin/vitest run tests/gitlab/client.test.ts -t "project|branch names"`
Expected: FAIL — `getProject`/`listBranches` are not functions.

- [ ] **Step 3: Add the type**

In `src/gitlab/types.ts` add:

```ts
export interface GitLabProject {
  empty_repo: boolean;
  default_branch: string | null;
}
```

- [ ] **Step 4: Implement the client methods**

In `src/gitlab/client.ts`, import the type (add `GitLabProject` to the existing `import type { ... } from "./types"`). Add methods next to `getBranch`:

```ts
async getProject(): Promise<GitLabProject> {
  return await this.requestJson<GitLabProject>("");
}

async listBranches(): Promise<string[]> {
  const names: string[] = [];
  let page = "1";
  while (page) {
    const response = await this.requestJsonResponse<Array<{ name: string }>>(
      `/repository/branches?per_page=100&page=${page}`,
    );
    names.push(...response.json.map((branch) => branch.name));
    page = this.header(response.headers, "X-Next-Page") ?? "";
  }
  return names;
}
```

Note: `requestJson("")` yields URL `${apiBase}` = `.../projects/<id>` (the project resource). `requestJsonResponse` + `this.header(..., "X-Next-Page")` is the exact pagination pattern already used by `getTree`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `ESBUILD_BINARY_PATH=/tmp/esbuild-linux-28/node_modules/@esbuild/linux-arm64/bin/esbuild node_modules/.bin/vitest run tests/gitlab/client.test.ts`
Expected: PASS. Then full suite + typecheck + lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/gitlab/types.ts src/gitlab/client.ts tests/gitlab/client.test.ts
git commit -m "feat(gitlab): add getProject and listBranches"
```

---

## Task 2: `SyncManager.listSyncableLocalFiles()` + export `toBase64`

**Files:**
- Modify: `src/sync/conflict-resolver.ts` (export `toBase64`)
- Modify: `src/sync/sync-manager.ts` (add public `listSyncableLocalFiles`)
- Test: `tests/sync/sync-manager.test.ts`

- [ ] **Step 1: Export `toBase64`**

In `src/sync/conflict-resolver.ts` change `function toBase64(` to `export function toBase64(`. (It already exists and is used internally.)

- [ ] **Step 2: Write the failing test**

Read `tests/sync/sync-manager.test.ts` for its harness (how it constructs a `SyncManager` with a fake vault/adapter and `createIgnoreMatcher`). Add a test that `listSyncableLocalFiles()` returns local files minus hard-excluded and minus ignored:

```ts
it("lists syncable local files excluding hard-excluded and ignored paths", async () => {
  const manager = makeManager({
    localFiles: ["note.md", "Welcome.md", ".obsidian/plugins/gitlab-gitless-sync/main.js", "secret.md"],
    ignored: ["secret.md"],
  });
  const files = await manager.listSyncableLocalFiles();
  expect(files).toEqual(["Welcome.md", "note.md"]);
});
```

Adapt `makeManager`/option names to the file's actual harness (it already builds a manager with a fake vault + ignore matcher for `auditLocalChanges` tests — reuse that setup; the active-plugin path is hard-excluded, `secret.md` is ignored).

- [ ] **Step 3: Run test to verify it fails**

Run: `ESBUILD_BINARY_PATH=/tmp/esbuild-linux-28/node_modules/@esbuild/linux-arm64/bin/esbuild node_modules/.bin/vitest run tests/sync/sync-manager.test.ts -t "syncable"`
Expected: FAIL — `listSyncableLocalFiles` is not a function.

- [ ] **Step 4: Implement it**

In `src/sync/sync-manager.ts`, add a public method mirroring the untracked-file handling in `auditLocalChanges`:

```ts
async listSyncableLocalFiles(): Promise<string[]> {
  if (!this.options.vault) {
    return [];
  }
  const ignoreMatcher = this.createIgnoreMatcher();
  await ignoreMatcher.reload();
  const localFiles = await this.listLocalFiles("", ignoreMatcher);
  return localFiles.filter((path) => !ignoreMatcher.isIgnored(path, {})).sort();
}
```

`listLocalFiles` already filters `isHardExcluded` and prunes ignored directories; the extra `isIgnored(path, {})` filter drops individually-ignored files (empty tracked index, since nothing is tracked yet at seed time). This matches how `auditLocalChanges` decides an untracked file is syncable.

- [ ] **Step 5: Run test to verify it passes**

Run the sync-manager test file, then full suite + typecheck + lint.
Expected: PASS, all green.

- [ ] **Step 6: Commit**

```bash
git add src/sync/conflict-resolver.ts src/sync/sync-manager.ts tests/sync/sync-manager.test.ts
git commit -m "feat(sync): export toBase64 and add listSyncableLocalFiles"
```

---

## Task 3: `SyncManager.initializeEmptyRemote()` (+ extract `finalizeAdoption`)

**Files:**
- Modify: `src/sync/sync-manager.ts`
- Test: `tests/sync/sync-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests (reuse the sync-manager harness; it can stub the GitLab client via `createGitLabClient` option — check the file for how it injects a fake client). Cover: builds one create-action per syncable file and finalizes; missing author throws before committing; empty vault throws.

```ts
it("initializes an empty remote from the vault and finalizes state", async () => {
  const createCommit = vi.fn(async () => ({ id: "seed-sha", parent_ids: [] }));
  const manager = makeManager({
    settings: { authorName: "A", authorEmail: "a@b.c", branch: "main" },
    localFiles: { "note.md": "hello", "Welcome.md": "hi" },
    client: {
      createCommit,
      getBranch: async () => ({ name: "main", can_push: true, commit: { id: "seed-sha", parent_ids: [] } }),
      getTree: async () => [
        { id: "b1", name: "note.md", type: "blob", path: "note.md", mode: "100644" },
        { id: "b2", name: "Welcome.md", type: "blob", path: "Welcome.md", mode: "100644" },
      ],
      validateAccess: async () => {},
    },
  });

  const result = await manager.initializeEmptyRemote();

  expect(createCommit).toHaveBeenCalledTimes(1);
  const actions = createCommit.mock.calls[0][0].actions;
  expect(actions.map((a: any) => [a.action, a.file_path, a.encoding])).toEqual([
    ["create", "Welcome.md", "base64"],
    ["create", "note.md", "base64"],
  ]);
  expect(result.status).toBe("success");
  expect(result.commitSha).toBe("seed-sha");
  const state = (await manager.__stateStore().load()).state; // use the harness's store accessor
  expect(state.initialized).toBe(true);
  expect(state.lastSyncedCommitSha).toBe("seed-sha");
});

it("refuses to seed without a commit author", async () => {
  const createCommit = vi.fn();
  const manager = makeManager({
    settings: { authorName: "", authorEmail: "", branch: "main" },
    localFiles: { "note.md": "hi" },
    client: { createCommit },
  });
  const result = await manager.initializeEmptyRemote();
  expect(result.status).toBe("error");
  expect(result.message).toMatch(/author/i);
  expect(createCommit).not.toHaveBeenCalled();
});

it("refuses to seed an empty vault", async () => {
  const createCommit = vi.fn();
  const manager = makeManager({
    settings: { authorName: "A", authorEmail: "a@b.c", branch: "main" },
    localFiles: {},
    client: { createCommit },
  });
  const result = await manager.initializeEmptyRemote();
  expect(result.status).toBe("error");
  expect(result.message).toMatch(/no files/i);
  expect(createCommit).not.toHaveBeenCalled();
});
```

Adjust `makeManager`/store-accessor names to the actual harness. `initializeEmptyRemote` catches its own errors and returns `{status:"error"}` (mirroring `adoptExistingVault`), so the author/empty tests assert on the returned status, not a throw.

- [ ] **Step 2: Run tests to verify they fail**

Run: `ESBUILD_BINARY_PATH=/tmp/esbuild-linux-28/node_modules/@esbuild/linux-arm64/bin/esbuild node_modules/.bin/vitest run tests/sync/sync-manager.test.ts -t "empty remote|author|empty vault"`
Expected: FAIL — `initializeEmptyRemote` is not a function.

- [ ] **Step 3: Extract `finalizeAdoption` from `adoptExistingVault`**

In `src/sync/sync-manager.ts`, replace the body of `adoptExistingVault`'s `try` block (from `const branch = await client.getBranch();` through computing `dirtyPaths` and the notice) with a call to a new private method, keeping behavior identical:

```ts
private async finalizeAdoption(
  client: GitLabClientLike,
): Promise<{ commitSha: string; dirtyPaths: number }> {
  const branch = await client.getBranch();
  this.validateBranch(branch);
  const trackedFiles = treeToTrackedFiles(
    await client.getTree(branch.commit.id),
    this.isHardExcluded.bind(this),
  );
  await this.options.stateStore.update((next) => {
    next.state.initialized = true;
    next.state.lastSyncedCommitSha = branch.commit.id;
    next.state.trackedFiles = trackedFiles;
    next.state.dirtyEntries = {};
    next.state.pendingTransaction = null;
    next.state.lastSyncAt = this.now();
    next.state.lastSyncResult = "success";
  });
  await this.auditLocalChanges();
  const adopted = await this.options.stateStore.load();
  return { commitSha: branch.commit.id, dirtyPaths: Object.keys(adopted.state.dirtyEntries).length };
}
```

`adoptExistingVault` then becomes (inside its existing guard/try/catch/finally):

```ts
const data = await this.options.stateStore.load();
const settings = this.validateSettings(this.options.settings ?? data.settings);
await this.logGitLabTarget("Adopt existing vault target", settings);
const token = await this.readToken(settings);
const client = this.createClient(settings, token);
await client.validateAccess?.();
const { commitSha, dirtyPaths } = await this.finalizeAdoption(client);
this.options.notice?.(
  dirtyPaths === 0 ? "Existing vault adopted" : `Existing vault adopted with ${dirtyPaths} local changes`,
);
return { status: "success", message: "Existing vault adopted", commitSha, dirtyPaths };
```

Run the full suite now to confirm the extraction is behavior-preserving (the 8 integration tests seed via adopt and must stay green).

- [ ] **Step 4: Implement `initializeEmptyRemote`**

Add import at top: `import { toBase64 } from "./conflict-resolver";` (join the existing `calculateGitBlobId` import from that module). Then:

```ts
async initializeEmptyRemote(): Promise<{
  status: "success" | "error" | "already-running";
  message: string;
  commitSha?: string;
  dirtyPaths?: number;
}> {
  if (this.syncing) {
    this.options.notice?.("Sync already running");
    return { status: "already-running", message: "Sync already running" };
  }
  this.syncing = true;
  const progress = this.options.createProgressNotice?.("Creating first commit…");
  try {
    const data = await this.options.stateStore.load();
    const settings = this.validateSettings(this.options.settings ?? data.settings);
    if (!settings.authorName.trim() || !settings.authorEmail.trim()) {
      throw new Error("Set a commit author name and email before creating the first commit.");
    }
    await this.logGitLabTarget("Initialize empty remote target", settings);
    const token = await this.readToken(settings);
    const client = this.createClient(settings, token);

    const paths = await this.listSyncableLocalFiles();
    if (paths.length === 0) {
      throw new Error("The vault has no files to push.");
    }
    const actions: GitLabCommitAction[] = [];
    for (const path of paths) {
      const bytes = new Uint8Array(await this.options.vault!.adapter.readBinary(path));
      actions.push({ action: "create", file_path: path, content: toBase64(bytes), encoding: "base64" });
    }
    const commit = await client.createCommit({ message: "Initialize vault", actions });
    const { dirtyPaths } = await this.finalizeAdoption(client);
    this.options.notice?.("Repository initialized from vault");
    return { status: "success", message: "Repository initialized", commitSha: commit.id, dirtyPaths };
  } catch (error) {
    const message = errorMessage(error);
    await this.options.logger?.error("Initialize empty remote failed", { message });
    this.options.notice?.(`Error initializing repository. ${message}`);
    return { status: "error", message };
  } finally {
    progress?.hide?.();
    this.syncing = false;
  }
}
```

`GitLabCommitAction` is already imported in this file (used elsewhere); if not, add it to the `import type { ... } from "../gitlab/types"`. `errorMessage` is the existing module helper used by `adoptExistingVault`. `createCommit` on the client already sets `branch`, author, and message from settings; passing `actions` is enough.

- [ ] **Step 5: Run tests to verify they pass**

Run the sync-manager test file, then full suite + typecheck + lint.
Expected: PASS, all green (including the 8 integration tests through the refactored adopt).

- [ ] **Step 6: Commit**

```bash
git add src/sync/sync-manager.ts tests/sync/sync-manager.test.ts
git commit -m "feat(sync): initializeEmptyRemote seeds an empty repository from the vault"
```

---

## Task 4: `ConnectPreview` discriminated union + modal seed variant

**Files:**
- Modify: `src/sync/bootstrap-service.ts` (union + tag `preview()`)
- Modify: `src/views/connect-confirm-modal.ts` (seed variant)
- Test: `tests/sync/bootstrap-service.test.ts`, `tests/views/connect-confirm-modal.test.ts`

- [ ] **Step 1: Update the type + preview tag (with test)**

In `tests/sync/bootstrap-service.test.ts`, update the existing preview test to expect `mode: "merge"`:
add `expect(preview.mode).toBe("merge");` to the "counts remote files…" test.

Then in `src/sync/bootstrap-service.ts` replace the `ConnectPreview` interface with:

```ts
export interface ConnectMergePreview {
  mode: "merge";
  remoteFileCount: number;
  /** Local-only files plus conflicting files (both get pushed on the next sync). */
  localPushCount: number;
  localPushPaths: string[];
  conflictCount: number;
}

export interface ConnectSeedPreview {
  mode: "seed";
  branch: string;
  localPushCount: number;
  localPushPaths: string[];
}

export type ConnectPreview = ConnectMergePreview | ConnectSeedPreview;
```

And in `preview()`'s return, add `mode: "merge",` as the first field.

- [ ] **Step 2: Run bootstrap test to verify RED→GREEN for the tag**

Run: `ESBUILD_BINARY_PATH=/tmp/esbuild-linux-28/node_modules/@esbuild/linux-arm64/bin/esbuild node_modules/.bin/vitest run tests/sync/bootstrap-service.test.ts -t preview`
Expected: FAIL before the `mode: "merge"` return edit, PASS after.

- [ ] **Step 3: Write failing modal seed-variant test**

In `tests/views/connect-confirm-modal.test.ts` add:

```ts
it("renders the seed variant for an empty repository", () => {
  const preview = { mode: "seed" as const, branch: "main", localPushCount: 42,
    localPushPaths: Array.from({ length: 42 }, (_, i) => `n-${i}.md`) };
  const modal = new ConnectConfirmModal(makeApp(), "g/p", "main", preview, vi.fn());
  modal.onOpen();
  const text = modal.contentEl.textContent ?? "";
  expect(text).toContain("repository is empty");
  expect(text).toContain("42 files will be pushed");
  expect(text).toContain('first commit on branch "main"');
  expect(text).toContain("and 32 more");
  expect(text).not.toContain("will be downloaded"); // no merge lines
});
```

Also update the existing merge-variant tests' `preview` literals to include `mode: "merge"` (TypeScript now requires the tag).

- [ ] **Step 4: Run modal test to verify it fails**

Run: `... vitest run tests/views/connect-confirm-modal.test.ts`
Expected: FAIL — seed branch not rendered.

- [ ] **Step 5: Implement the modal seed variant**

In `src/views/connect-confirm-modal.ts`, update the import to `import type { ConnectPreview } from "../sync/bootstrap-service";` (unchanged) and branch `onOpen()` on `this.preview.mode`:

```ts
onOpen(): void {
  this.titleEl.setText("Connect to GitLab");
  this.contentEl.empty();
  if (this.preview.mode === "seed") {
    this.renderSeed(this.preview);
  } else {
    this.renderMerge(this.preview);
  }
  new Setting(this.contentEl)
    .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
    .addButton((button) =>
      button
        .setButtonText(this.preview.mode === "seed" ? "Create first commit" : "Connect")
        .setCta()
        .onClick(() => this.confirm()),
    );
}
```

Move the current body into `private renderMerge(preview: ConnectMergePreview)` (unchanged text, reading from `preview` instead of `this.preview`), and add:

```ts
private renderSeed(preview: ConnectSeedPreview): void {
  this.contentEl.createEl("p", { text: "The repository is empty." });
  this.contentEl.createEl("p", {
    text: `${preview.localPushCount} files will be pushed to GitLab as the first commit on branch "${preview.branch}", e.g.:`,
  });
  const list = this.contentEl.createEl("ul");
  for (const path of preview.localPushPaths.slice(0, 10)) {
    list.createEl("li", { text: path });
  }
  const remainder = preview.localPushCount - Math.min(preview.localPushPaths.length, 10);
  if (remainder > 0) {
    list.createEl("li", { text: `…and ${remainder} more` });
  }
  this.contentEl.createEl("p", { text: "Nothing is downloaded and nothing is deleted." });
}
```

Import the two sub-types: `import type { ConnectMergePreview, ConnectSeedPreview } from "../sync/bootstrap-service";`.

- [ ] **Step 6: Run tests to verify they pass**

Run both test files, then full suite + typecheck + lint. Fix any merge-variant test literals still missing `mode: "merge"`.

- [ ] **Step 7: Commit**

```bash
git add src/sync/bootstrap-service.ts src/views/connect-confirm-modal.ts tests/sync/bootstrap-service.test.ts tests/views/connect-confirm-modal.test.ts
git commit -m "feat: ConnectPreview union and modal seed variant"
```

---

## Task 5: Plugin orchestration — detection + seed routing

**Files:**
- Modify: `src/main.ts` (`previewConnect`, `connect`, a `makeConnectContext` helper)
- Modify: `src/settings/settings-tab.ts` (pass preview to `connect`)
- Test: `tests/plugin-lifecycle.test.ts`

- [ ] **Step 1: Write failing tests**

In `tests/plugin-lifecycle.test.ts` (reuse the connect harness). Add three tests:

```ts
it("previewConnect returns seed mode for an empty repository", async () => {
  const plugin = makeTestPlugin();
  configureConnect(plugin); // sets projectPath/branch/token as the existing connect tests do
  vi.spyOn(GitLabClient.prototype, "getProject").mockResolvedValue({ empty_repo: true, default_branch: null });
  vi.spyOn(plugin.syncManager, "listSyncableLocalFiles").mockResolvedValue(["Welcome.md", "note.md"]);
  const preview = await plugin.previewConnect();
  expect(preview).toMatchObject({ mode: "seed", branch: "main", localPushCount: 2, localPushPaths: ["Welcome.md", "note.md"] });
});

it("connect routes seed previews to initializeEmptyRemote", async () => {
  const plugin = makeTestPlugin();
  configureConnect(plugin);
  const seed = vi.spyOn(plugin.syncManager, "initializeEmptyRemote").mockResolvedValue({ status: "success", message: "ok" } as any);
  const merge = vi.spyOn(BootstrapService.prototype, "merge");
  await plugin.connect({ mode: "seed", branch: "main", localPushCount: 1, localPushPaths: ["a.md"] } as any);
  expect(seed).toHaveBeenCalledTimes(1);
  expect(merge).not.toHaveBeenCalled();
});

it("previewConnect reports branch-not-found with available branches", async () => {
  const plugin = makeTestPlugin();
  configureConnect(plugin);
  vi.spyOn(GitLabClient.prototype, "getProject").mockResolvedValue({ empty_repo: false, default_branch: "master" });
  vi.spyOn(BootstrapService.prototype, "preview").mockRejectedValue(new GitLabNotFoundError("404 Branch Not Found"));
  vi.spyOn(GitLabClient.prototype, "listBranches").mockResolvedValue(["master", "dev"]);
  const errorSpy = vi.spyOn(plugin.logger, "error");
  const preview = await plugin.previewConnect();
  expect(preview).toBeNull();
  expect(errorSpy).toHaveBeenCalled();
});
```

`configureConnect` is whatever the existing connect tests use to set projectPath/branch/tokenSecretName + stub the token; reuse it. Import `GitLabClient` and `GitLabNotFoundError` in the test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `... vitest run tests/plugin-lifecycle.test.ts -t "seed|branch-not-found"`
Expected: FAIL (previewConnect has no detection; connect takes no argument).

- [ ] **Step 3: Implement in `src/main.ts`**

Add imports: `import { GitLabNotFoundError } from "./gitlab/errors";` and the preview types `import { BootstrapService, type ConnectPreview } from "./sync/bootstrap-service";` (already imported — extend if needed).

Replace `makeBootstrapService()` with a context builder that also exposes the client:

```ts
private async makeConnectContext(): Promise<{ client: GitLabClient; service: BootstrapService } | null> {
  if (!this.isConfigured()) {
    new Notice("Sync plugin not configured");
    return null;
  }
  const token = await this.readToken();
  if (!token) {
    new Notice("GitLab token is missing");
    return null;
  }
  const client = new GitLabClient(this.settings, token);
  const service = new BootstrapService({
    vault: this.app.vault,
    client,
    journal: { suppress: async (operation) => operation() },
  });
  return { client, service };
}
```

Rewrite `previewConnect()`:

```ts
async previewConnect(): Promise<ConnectPreview | null> {
  const ctx = await this.makeConnectContext();
  if (!ctx) return null;
  try {
    const project = await ctx.client.getProject();
    if (project.empty_repo) {
      const paths = await this.syncManager.listSyncableLocalFiles();
      return { mode: "seed", branch: this.settings.branch, localPushCount: paths.length, localPushPaths: paths };
    }
    try {
      return await ctx.service.preview();
    } catch (error) {
      if (error instanceof GitLabNotFoundError) {
        const branches = await ctx.client.listBranches();
        const fallback = project.default_branch ? `Default: ${project.default_branch}. ` : "";
        await this.logger.error("Connect branch not found", { branch: this.settings.branch, branches });
        new Notice(`Branch "${this.settings.branch}" not found. ${fallback}Available: ${branches.join(", ")}`);
        return null;
      }
      throw error;
    }
  } catch (error) {
    await this.logger.error("Connect preview failed", { error: String(error) });
    new Notice(`Could not read GitLab: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
```

Rewrite `connect()` to take the preview and branch on mode:

```ts
async connect(preview: ConnectPreview): Promise<void> {
  const ctx = await this.makeConnectContext();
  if (!ctx) return;
  try {
    const result = preview.mode === "seed"
      ? await this.syncManager.initializeEmptyRemote()
      : await this.connectMerge(ctx.service);
    this.pluginData = await this.stateStore.load();
    if (result.status !== "success") {
      await this.logger.error("Connect failed", { status: result.status, message: result.message });
      new Notice(`Connect failed: ${result.message}`);
      return;
    }
    new Notice(preview.mode === "seed" ? "Repository initialized from vault" : "Connected to GitLab");
  } catch (error) {
    await this.logger.error("Connect failed", { error: String(error) });
    new Notice(`Connect failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

private async connectMerge(service: BootstrapService): Promise<{ status: string; message: string }> {
  await service.merge();
  return await this.syncManager.adoptExistingVault();
}
```

(If `GitLabClient` isn't imported in `main.ts` yet, add `import { GitLabClient } from "./gitlab/client";` — it was used by the removed inline construction, confirm.)

- [ ] **Step 4: Update settings-tab to pass the preview**

In `src/settings/settings-tab.ts`, the modal's `onConfirm` now calls `this.plugin.connect(preview)`:

```ts
const preview = await this.plugin.previewConnect();
if (!preview) return;
new ConnectConfirmModal(
  this.plugin.app,
  this.plugin.settings.projectPath,
  this.plugin.settings.branch,
  preview,
  async () => {
    await this.plugin.connect(preview);
    this.display();
  },
).open();
```

Update the settings-tab render test that asserts the click path if it invokes `connect` — it should now expect `connect` called with the preview object (or simply `toHaveBeenCalled()`).

- [ ] **Step 5: Run tests to verify they pass**

Run `tests/plugin-lifecycle.test.ts` and `tests/settings-tab.test.ts`, then full suite + typecheck + lint. Fix any callers of the old `connect()` (no-arg) or `makeBootstrapService` in tests.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/settings/settings-tab.ts tests/plugin-lifecycle.test.ts tests/settings-tab.test.ts
git commit -m "feat: detect empty repo and route Connect to seed or merge"
```

---

## Task 6: Full check + manual verification

- [ ] **Step 1: Full automated check**

Run:
```
ESBUILD_BINARY_PATH=/tmp/esbuild-linux-28/node_modules/@esbuild/linux-arm64/bin/esbuild node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit --skipLibCheck
node_modules/.bin/eslint src tests
ESBUILD_BINARY_PATH=/tmp/esbuild-linux/node_modules/@esbuild/linux-arm64/bin/esbuild node esbuild.config.mjs production
```
Expected: all green; `main.js` regenerated.

- [ ] **Step 2: Manual verification (real vault, per superpowers:verification-before-completion)**

Copy `main.js`/`manifest.json`/`styles.css` into the test vault's plugin folder. With a genuinely empty GitLab project and author name/email set:
- Connect → modal says "The repository is empty" with the correct file count and "Create first commit" CTA.
- Confirm → first commit appears in GitLab with the vault files; the vault becomes initialized/clean.
Then, against a non-empty repo with a wrong branch name: Connect → a Notice lists the available branches (no seeding). Against a valid branch: the normal merge flow still works.

- [ ] **Step 3: Commit any build/doc updates**

```bash
git add -A && git commit -m "chore: empty-repo seed verified; regen build"
```

---

## Self-Review

**Spec coverage:** detection gate (Task 5 `previewConnect`); `getProject`/`listBranches` (Task 1); seed via `initializeEmptyRemote` with author validation + reuse of adopt finalization (Task 3); ignore-aware shared file source `listSyncableLocalFiles` (Task 2); `ConnectPreview` union + modal seed variant (Task 4); branch-not-found messaging (Task 5); merge path unchanged (Tasks 4/5 keep merge behavior); error handling incl. false-success guard reused for seed (Task 5 checks `result.status`).

**Placeholders:** test-harness helper names (`makeManager`, `makeTestPlugin`, `configureConnect`, store accessors) are explicitly flagged as "match the file's actual harness" because those helpers must be read at implementation time; all production steps contain complete code.

**Type consistency:** `ConnectPreview` = `ConnectMergePreview | ConnectSeedPreview` (Task 4) is consumed by the modal (Task 4), `previewConnect`/`connect` (Task 5) with the same tag field `mode` and fields `localPushCount`/`localPushPaths`/`branch`. `initializeEmptyRemote`/`finalizeAdoption`/`listSyncableLocalFiles` names are consistent across Tasks 2, 3, 5. `getProject`/`listBranches`/`GitLabProject` consistent across Tasks 1 and 5.
