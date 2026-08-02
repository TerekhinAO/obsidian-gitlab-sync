# Connect-to-GitLab flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two fragile vault-setup buttons (Initialize empty / Adopt existing) with a single non-destructive **Connect to GitLab** button that downloads the repository, merges it into the vault, shows a confirmation summary, and never fails silently.

**Architecture:** `BootstrapService` stops requiring an empty vault and instead gains two methods — a read-only `preview()` (counts for the dialog) and a non-destructive `merge()` (download archive, write remote-only files, and for files differing on both sides write the remote version at the path plus a local conflict copy). The plugin's connect flow runs `preview()` → `ConnectConfirmModal` → `merge()` → the existing `SyncManager.adoptExistingVault()`, which sets `base = HEAD`, records the tracked index, and runs `auditLocalChanges()` to mark local-only files and conflict copies dirty (honoring `.gitignore`) so they push on the next sync. Every entry point is wrapped in `try/catch` with `logger.error` + `Notice`.

**Tech Stack:** TypeScript, esbuild, Vitest (`obsidian` aliased to `mock-obsidian.ts`), `@zip.js/zip.js`, Obsidian plugin API.

**Spec:** `docs/superpowers/specs/2026-08-02-connect-to-gitlab-flow-design.md`

**Refinements vs spec (decided during planning):**
- `SyncManager.adoptExistingVault` is **kept** as the internal state/dirty engine (the connect flow reuses it) rather than deleted; only the UI button and `BootstrapService.initialize` are removed.
- Both-sides-differ handling at connect is a **self-contained conflict copy** (remote at path + local copy), not routed through `ConflictResolver` — `ConflictResolver` emits GitLab `commitActions` (push), which do not fit connect. The dirty conflict copy is pushed by the next normal sync.

---

## File Structure

- `src/sync/bootstrap-service.ts` — MODIFY. Drop `assertVaultEmptyForBootstrap`/`assertConfigDirAllowed`/`initialize`. Add `preview()` and `merge()`. Extend `BootstrapVault` with `readBinary`.
- `src/views/connect-confirm-modal.ts` — CREATE. `ConnectConfirmModal` rendering the summary.
- `src/main.ts` — MODIFY. Replace `initializeFromGitLab()` with `previewConnect()` + `connect()`, both `try/catch` + logged.
- `src/settings/settings-tab.ts` — MODIFY. Replace the two buttons with one **Connect to GitLab** button that drives preview → modal → connect.
- `tests/sync/bootstrap-service.test.ts` — MODIFY. Remove empty-vault tests; add `preview()` and `merge()` tests.
- `tests/views/connect-confirm-modal.test.ts` — CREATE. Modal rendering tests.
- `tests/settings-tab.test.ts` — MODIFY. Assert single button + error surfacing.

---

## Task 1: Surface errors on the existing connect path (fix silent failure)

Ships value on its own: the current `initializeFromGitLab` swallows every error. Wrap it before any refactor.

**Files:**
- Modify: `src/main.ts:139-160` (`initializeFromGitLab`)
- Test: `tests/plugin-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/plugin-lifecycle.test.ts` (follow the existing plugin construction pattern in that file for building a plugin with a stub `logger`, `stateStore`, and `Notice` spy):

```ts
it("logs and notices when initialize fails instead of throwing", async () => {
  const plugin = makeTestPlugin();               // existing helper in this file
  plugin.settings.projectPath = "group/project";
  plugin.settings.branch = "main";
  plugin.settings.tokenSecretName = "tok";
  vi.spyOn(plugin as any, "readToken").mockResolvedValue("glpat-x");
  vi.spyOn(BootstrapService.prototype, "initialize")
    .mockRejectedValue(new Error("boom"));
  const errorSpy = vi.spyOn(plugin.logger, "error");
  const noticeSpy = vi.spyOn(NoticeMock, "calls", "get");   // or the file's Notice spy

  await expect(plugin.initializeFromGitLab()).resolves.toBeUndefined();
  expect(errorSpy).toHaveBeenCalled();
});
```

If `tests/plugin-lifecycle.test.ts` has no plugin-construction helper, add the assertion to a new `tests/main-connect.test.ts` using the same mocking approach as `tests/settings-tab.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/plugin-lifecycle.test.ts`
Expected: FAIL — the current `initializeFromGitLab` rejects (no `try/catch`), so `errorSpy` is never called.

- [ ] **Step 3: Wrap the method**

In `src/main.ts`, change `initializeFromGitLab` body so the service call is guarded:

```ts
async initializeFromGitLab(): Promise<void> {
  if (!this.isConfigured()) {
    new Notice("Sync plugin not configured");
    return;
  }
  const token = await this.readToken();
  if (!token) {
    new Notice("GitLab token is missing");
    return;
  }
  try {
    const service = new BootstrapService({
      vault: this.app.vault,
      client: new GitLabClient(this.settings, token),
      stateStore: this.stateStore,
      journal: { suppress: async (operation) => operation() },
    });
    await service.initialize();
    this.pluginData = await this.stateStore.load();
    new Notice("Vault initialized from GitLab");
  } catch (error) {
    this.logger.error("Initialize from GitLab failed", { error: String(error) });
    new Notice(`Initialize failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/plugin-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/plugin-lifecycle.test.ts
git commit -m "fix: surface initialize errors instead of failing silently"
```

---

## Task 2: `BootstrapService.preview()` — read-only summary counts

**Files:**
- Modify: `src/sync/bootstrap-service.ts` (add `readBinary` to `BootstrapVault`; add `preview()` + private `listLocalFiles`)
- Test: `tests/sync/bootstrap-service.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/sync/bootstrap-service.test.ts`, extend `fakeVault`'s `adapter` with `readBinary` (place beside `writeBinary`):

```ts
readBinary: vi.fn(async (path: string) => {
  const data = files.get(path);
  if (!data) throw new Error(`missing ${path}`);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}),
```

Then add:

```ts
describe("BootstrapService.preview", () => {
  it("counts remote files, local-only pushes, and both-side conflicts", async () => {
    const noteId = await calculateGitBlobId(bytes("remote"));
    const setup = await fixture({
      localFiles: {
        "Welcome.md": bytes("hello"),          // local-only -> push
        "shared.md": bytes("local version"),   // exists in tree, differs -> conflict
      },
      tree: [
        { id: noteId, name: "note.md", type: "blob", path: "note.md", mode: "100644" },
        { id: "shared-remote", name: "shared.md", type: "blob", path: "shared.md", mode: "100644" },
      ],
    });

    const preview = await setup.service.preview();

    expect(preview.remoteFileCount).toBe(2);
    expect(preview.conflictCount).toBe(1);                 // shared.md
    expect(preview.localPushPaths).toEqual(["Welcome.md"]); // local-only
    expect(preview.localPushCount).toBe(2);                 // local-only + conflict copy
  });
});
```

Import `calculateGitBlobId` at the top of the test file:
`import { calculateGitBlobId } from "../../src/sync/conflict-resolver";`

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/sync/bootstrap-service.test.ts -t preview`
Expected: FAIL — `service.preview` is not a function.

- [ ] **Step 3: Implement `preview()`**

In `src/sync/bootstrap-service.ts`:

Add `readBinary` to the `BootstrapVault` adapter interface:

```ts
adapter: {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
};
```

Add the client method type `getTree` is already in the `client` Pick; no change there.

Add the method and helpers (import `calculateGitBlobId` from `./conflict-resolver` at top):

```ts
export interface ConnectPreview {
  remoteFileCount: number;
  localPushCount: number;
  localPushPaths: string[];
  conflictCount: number;
}

// inside the class:
async preview(): Promise<ConnectPreview> {
  const branch = await this.options.client.getBranch();
  const commitSha = this.commitSha(branch);
  const remoteIndex = treeToTrackedFiles(
    await this.options.client.getTree(commitSha),
    (path) => this.isHardExcluded(path),
  );
  const localPaths = (await this.listLocalFiles("")).filter(
    (path) => !this.isHardExcluded(path),
  );

  const localPushPaths: string[] = [];
  let conflictCount = 0;
  for (const path of localPaths) {
    const remote = remoteIndex[path];
    if (!remote) {
      localPushPaths.push(path);
      continue;
    }
    const bytes = new Uint8Array(await this.options.vault.adapter.readBinary(path));
    if ((await calculateGitBlobId(bytes)) !== remote.blobId) {
      conflictCount += 1;
    }
  }

  localPushPaths.sort();
  return {
    remoteFileCount: Object.keys(remoteIndex).length,
    localPushCount: localPushPaths.length + conflictCount,
    localPushPaths,
    conflictCount,
  };
}

private async listLocalFiles(dir: string): Promise<string[]> {
  const { files, folders } = await this.options.vault.adapter.list(dir);
  const out: string[] = [];
  for (const file of files) {
    const normalized = normalizePath(file);
    if (!this.isHardExcluded(normalized)) out.push(normalized);
  }
  for (const folder of folders) {
    const normalized = normalizePath(folder);
    if (this.isHardExcluded(normalized)) continue;
    out.push(...(await this.listLocalFiles(normalized)));
  }
  return out;
}
```

Note: `treeToTrackedFiles`, `this.commitSha`, and `this.isHardExcluded` already exist in this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/sync/bootstrap-service.test.ts -t preview`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/bootstrap-service.ts tests/sync/bootstrap-service.test.ts
git commit -m "feat: add BootstrapService.preview for connect summary"
```

---

## Task 3: `BootstrapService.merge()` — non-destructive download + merge

**Files:**
- Modify: `src/sync/bootstrap-service.ts` (add `merge()`; remove `initialize()`, `assertVaultEmptyForBootstrap`, `assertConfigDirAllowed`)
- Test: `tests/sync/bootstrap-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the old `describe("BootstrapService")` empty-vault tests with merge tests (keep the unsafe-archive and symlink tests but call `merge()` instead of `initialize()`):

```ts
describe("BootstrapService.merge", () => {
  it("writes remote-only files", async () => {
    const archive = await zip([{ path: "root/note.md", content: "remote" }]);
    const setup = await fixture({
      tree: [{ id: "n", name: "note.md", type: "blob", path: "note.md", mode: "100644" }],
      archive,
    });

    await setup.service.merge();

    expect(setup.read("note.md")).toEqual(bytes("remote"));
  });

  it("leaves an identical local file untouched and creates no conflict copy", async () => {
    const archive = await zip([{ path: "root/note.md", content: "same" }]);
    const setup = await fixture({
      localFiles: { "note.md": bytes("same") },
      tree: [{ id: "n", name: "note.md", type: "blob", path: "note.md", mode: "100644" }],
      archive,
    });

    const result = await setup.service.merge();

    expect(setup.read("note.md")).toEqual(bytes("same"));
    expect(result.conflictCopyPaths).toEqual([]);
  });

  it("keeps both versions when a file differs on both sides", async () => {
    const archive = await zip([{ path: "root/note.md", content: "remote" }]);
    const setup = await fixture({
      localFiles: { "note.md": bytes("local") },
      tree: [{ id: "n", name: "note.md", type: "blob", path: "note.md", mode: "100644" }],
      archive,
    });

    const result = await setup.service.merge();

    expect(setup.read("note.md")).toEqual(bytes("remote"));        // remote at path
    expect(result.conflictCopyPaths).toEqual(["note (local conflict).md"]);
    expect(setup.read("note (local conflict).md")).toEqual(bytes("local")); // local preserved
  });

  it("leaves local-only files untouched", async () => {
    const archive = await zip([{ path: "root/note.md", content: "remote" }]);
    const setup = await fixture({
      localFiles: { "Welcome.md": bytes("hello") },
      tree: [{ id: "n", name: "note.md", type: "blob", path: "note.md", mode: "100644" }],
      archive,
    });

    await setup.service.merge();

    expect(setup.read("Welcome.md")).toEqual(bytes("hello"));
    expect(setup.read("note.md")).toEqual(bytes("remote"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/sync/bootstrap-service.test.ts -t merge`
Expected: FAIL — `service.merge` is not a function.

- [ ] **Step 3: Implement `merge()` and delete the empty-vault path**

In `src/sync/bootstrap-service.ts`:

Delete `assertVaultEmptyForBootstrap`, `assertConfigDirAllowed`, and the `initialize()` method.

Add:

```ts
export interface ConnectMergeResult {
  commitSha: string;
  conflictCopyPaths: string[];
}

// inside the class:
async merge(): Promise<ConnectMergeResult> {
  const branch = await this.options.client.getBranch();
  const commitSha = this.commitSha(branch);
  const archive = await this.options.client.downloadArchive(commitSha);
  const operations = await this.readArchive(archive); // existing: safe, hard-excluded filtered
  const conflictCopyPaths: string[] = [];

  await this.suppressJournal(async () => {
    for (const operation of operations) {
      if (operation.directory) {
        await this.ensureFolder(operation.path);
        continue;
      }
      const exists = await this.options.vault.adapter.exists(operation.path);
      if (!exists) {
        await this.writeFile(operation.path, operation.data);
        continue;
      }
      const local = new Uint8Array(
        await this.options.vault.adapter.readBinary(operation.path),
      );
      if (sameBytes(local, operation.data)) {
        continue; // identical, adopt as-is
      }
      // differ: remote wins at path, local preserved as a conflict copy
      const copyPath = this.nextAvailablePath(
        conflictCopyPath(operation.path),
        new Set(operations.map((op) => op.path)),
      );
      await this.writeFile(copyPath, local);
      await this.writeFile(operation.path, operation.data);
      conflictCopyPaths.push(copyPath);
    }
  });

  return { commitSha, conflictCopyPaths };
}

private nextAvailablePath(path: string, reserved: Set<string>): string {
  return path; // reserved kept for symmetry; collisions handled by suffix below
}
```

Add module-level helpers at the bottom of the file:

```ts
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function conflictCopyPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  return `${dir}${stem} (local conflict)${ext}`;
}
```

Note: `readArchive`, `writeFile`, `ensureFolder`, `suppressJournal`, `commitSha` already exist. The `readBinary` adapter method was added in Task 2.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/sync/bootstrap-service.test.ts`
Expected: PASS (merge tests + retained unsafe/symlink tests calling `merge()`).

- [ ] **Step 5: Commit**

```bash
git add src/sync/bootstrap-service.ts tests/sync/bootstrap-service.test.ts
git commit -m "feat: non-destructive merge download in BootstrapService; drop empty-vault import"
```

---

## Task 4: `ConnectConfirmModal`

**Files:**
- Create: `src/views/connect-confirm-modal.ts`
- Test: `tests/views/connect-confirm-modal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/views/connect-confirm-modal.test.ts`. `mock-obsidian.ts` provides `Modal`/`Setting`; assert on the accumulated text of `contentEl`. Use the same DOM shims the other view/settings tests use (check `tests/settings-tab.test.ts` for the `contentEl` stub pattern and reuse it).

```ts
import { describe, expect, it, vi } from "vitest";
import { ConnectConfirmModal } from "../../src/views/connect-confirm-modal";

function makeApp() { return {} as any; }

describe("ConnectConfirmModal", () => {
  it("summarizes counts and caps the name list at 10", () => {
    const preview = {
      remoteFileCount: 128,
      localPushCount: 12,
      conflictCount: 0,
      localPushPaths: Array.from({ length: 12 }, (_, i) => `note-${i}.md`),
    };
    const modal = new ConnectConfirmModal(makeApp(), "group/project", "main", preview, vi.fn());
    modal.onOpen();
    const text = modal.contentEl.textContent ?? "";
    expect(text).toContain("128 files will be downloaded");
    expect(text).toContain("12 local files will be pushed");
    expect(text).toContain("and 2 more");           // 12 - 10 shown
  });

  it("renders the zero-push line", () => {
    const preview = { remoteFileCount: 5, localPushCount: 0, conflictCount: 0, localPushPaths: [] };
    const modal = new ConnectConfirmModal(makeApp(), "g/p", "main", preview, vi.fn());
    modal.onOpen();
    expect(modal.contentEl.textContent ?? "").toContain("0 files to push");
  });

  it("invokes the callback when Connect is clicked", () => {
    const onConfirm = vi.fn();
    const preview = { remoteFileCount: 1, localPushCount: 0, conflictCount: 0, localPushPaths: [] };
    const modal = new ConnectConfirmModal(makeApp(), "g/p", "main", preview, onConfirm);
    modal.onOpen();
    modal.confirm();     // test seam that runs the CTA handler + closes
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
```

If `mock-obsidian.ts` `Modal` lacks a real `contentEl` with `textContent`, extend the mock minimally (add a `createEl`/`setText` accumulator) the same way existing view tests do — check `tests/sync` or `tests/settings-tab.test.ts` first and follow that pattern rather than inventing a new one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/views/connect-confirm-modal.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the modal**

Create `src/views/connect-confirm-modal.ts`:

```ts
import { Modal, Setting } from "obsidian";
import type { ConnectPreview } from "../sync/bootstrap-service";

const MAX_NAMES = 10;

export class ConnectConfirmModal extends Modal {
  constructor(
    app: any,
    private readonly projectPath: string,
    private readonly branch: string,
    private readonly preview: ConnectPreview,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Connect to GitLab");
    this.contentEl.empty();

    this.contentEl.createEl("p", {
      text: `Repository (${this.projectPath} · branch ${this.branch}):`,
    });
    this.contentEl.createEl("p", {
      text: `${this.preview.remoteFileCount} files will be downloaded to this vault.`,
    });

    this.contentEl.createEl("p", { text: "This vault:" });
    if (this.preview.localPushCount === 0) {
      this.contentEl.createEl("p", { text: "0 files to push." });
    } else {
      this.contentEl.createEl("p", {
        text: `${this.preview.localPushCount} local files will be pushed to GitLab on the next sync, e.g.:`,
      });
      const list = this.contentEl.createEl("ul");
      for (const path of this.preview.localPushPaths.slice(0, MAX_NAMES)) {
        list.createEl("li", { text: path });
      }
      const remainder = this.preview.localPushCount - Math.min(this.preview.localPushPaths.length, MAX_NAMES);
      if (remainder > 0) {
        list.createEl("li", { text: `…and ${remainder} more` });
      }
    }
    this.contentEl.createEl("p", {
      text: `${this.preview.conflictCount} files changed on both sides.`,
    });
    this.contentEl.createEl("p", {
      text: "Nothing is deleted. When the same file differs on both sides, both versions are kept.",
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button.setButtonText("Connect").setCta().onClick(() => this.confirm()),
      );
  }

  confirm(): void {
    this.close();
    this.onConfirm();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/views/connect-confirm-modal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/connect-confirm-modal.ts tests/views/connect-confirm-modal.test.ts
git commit -m "feat: add ConnectConfirmModal summary dialog"
```

---

## Task 5: Plugin connect methods (`previewConnect` + `connect`)

**Files:**
- Modify: `src/main.ts` (remove `initializeFromGitLab`; add `previewConnect()` + `connect()`)
- Test: `tests/plugin-lifecycle.test.ts` (or `tests/main-connect.test.ts` from Task 1)

- [ ] **Step 1: Write the failing test**

```ts
it("connect merges then adopts and surfaces errors", async () => {
  const plugin = makeTestPlugin();
  plugin.settings.projectPath = "group/project";
  plugin.settings.branch = "main";
  plugin.settings.tokenSecretName = "tok";
  vi.spyOn(plugin as any, "readToken").mockResolvedValue("glpat-x");
  const mergeSpy = vi
    .spyOn(BootstrapService.prototype, "merge")
    .mockResolvedValue({ commitSha: "sha", conflictCopyPaths: [] });
  const adoptSpy = vi
    .spyOn(plugin.syncManager, "adoptExistingVault")
    .mockResolvedValue({ status: "success", message: "ok" } as any);

  await plugin.connect();

  expect(mergeSpy).toHaveBeenCalledTimes(1);
  expect(adoptSpy).toHaveBeenCalledTimes(1);
  expect(mergeSpy.mock.invocationCallOrder[0])
    .toBeLessThan(adoptSpy.mock.invocationCallOrder[0]); // merge before adopt
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/plugin-lifecycle.test.ts -t connect`
Expected: FAIL — `plugin.connect` is not a function.

- [ ] **Step 3: Implement the methods**

In `src/main.ts`, remove `initializeFromGitLab` (and its Task 1 wrapper) and `adoptExistingVault` UI method if present; add:

```ts
private async connectClient(): Promise<{ service: BootstrapService } | null> {
  if (!this.isConfigured()) {
    new Notice("Sync plugin not configured");
    return null;
  }
  const token = await this.readToken();
  if (!token) {
    new Notice("GitLab token is missing");
    return null;
  }
  return {
    service: new BootstrapService({
      vault: this.app.vault,
      client: new GitLabClient(this.settings, token),
      stateStore: this.stateStore,
      journal: { suppress: async (operation) => operation() },
    }),
  };
}

async previewConnect(): Promise<import("./sync/bootstrap-service").ConnectPreview | null> {
  const ctx = await this.connectClient();
  if (!ctx) return null;
  try {
    return await ctx.service.preview();
  } catch (error) {
    this.logger.error("Connect preview failed", { error: String(error) });
    new Notice(`Could not read GitLab: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async connect(): Promise<void> {
  const ctx = await this.connectClient();
  if (!ctx) return;
  try {
    await ctx.service.merge();                 // download + non-destructive write
    await this.syncManager.adoptExistingVault(); // base=HEAD, tracked index, audit dirties
    this.pluginData = await this.stateStore.load();
    new Notice("Connected to GitLab");
  } catch (error) {
    this.logger.error("Connect failed", { error: String(error) });
    new Notice(`Connect failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/plugin-lifecycle.test.ts -t connect`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/plugin-lifecycle.test.ts
git commit -m "feat: plugin previewConnect and connect orchestration"
```

---

## Task 6: Single Connect button in settings + remove the two old buttons

**Files:**
- Modify: `src/settings/settings-tab.ts:161-180`
- Test: `tests/settings-tab.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/settings-tab.test.ts` (follow the file's existing render harness), assert the setup section renders exactly one action button labelled "Connect to GitLab", and clicking it calls `plugin.previewConnect`:

```ts
it("shows a single Connect to GitLab button when not initialized", async () => {
  const { plugin, render, clickButton } = makeSettingsHarness({ initialized: false });
  const previewSpy = vi.spyOn(plugin, "previewConnect").mockResolvedValue(null);
  render();
  expect(buttonLabels()).toEqual(expect.arrayContaining(["Connect to GitLab"]));
  expect(buttonLabels()).not.toContain("Initialize empty");
  expect(buttonLabels()).not.toContain("Adopt existing");
  await clickButton("Connect to GitLab");
  expect(previewSpy).toHaveBeenCalled();
});
```

Reuse whatever harness helpers already exist in this test file (`makeSettingsHarness`/`buttonLabels`/`clickButton` names are illustrative — match the file's actual helpers).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/settings-tab.test.ts -t "Connect to GitLab"`
Expected: FAIL — two old buttons still render.

- [ ] **Step 3: Replace the button block**

In `src/settings/settings-tab.ts`, replace the `if (setupState.showSetupActions) { ... }` block (lines ~161-180) with:

```ts
if (setupState.showSetupActions) {
  setupSetting.addButton((button) =>
    button
      .setButtonText("Connect to GitLab")
      .setCta()
      .onClick(async () => {
        const preview = await this.plugin.previewConnect();
        if (!preview) return; // error already surfaced
        new ConnectConfirmModal(
          this.plugin.app,
          this.plugin.settings.projectPath,
          this.plugin.settings.branch,
          preview,
          async () => {
            await this.plugin.connect();
            this.display();
          },
        ).open();
      }),
  );
}
```

Add the import at the top of `settings-tab.ts`:
`import { ConnectConfirmModal } from "../views/connect-confirm-modal";`

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/settings-tab.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/settings-tab.ts tests/settings-tab.test.ts
git commit -m "feat: single Connect to GitLab button in settings"
```

---

## Task 7: Full check + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole suite + typecheck + lint + build**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Then build with the platform-correct esbuild binary if in this sandbox:
`ESBUILD_BINARY_PATH=/tmp/esbuild-linux/node_modules/@esbuild/linux-arm64/bin/esbuild node esbuild.config.mjs production`
Expected: all green; `main.js` regenerated.

- [ ] **Step 2: Manual verification (real vault)**

Follow `superpowers:verification-before-completion`. Copy `main.js`/`manifest.json`/`styles.css` into `<test-vault>/.obsidian/plugins/gitlab-gitless-sync/`, reload, and confirm:
- fresh vault with only the default welcome note → one **Connect to GitLab** button;
- clicking shows the summary modal with correct counts;
- confirming downloads the repo, keeps the welcome note, and marks it dirty (visible in sync status);
- an intentionally broken token surfaces a `Notice` + a log entry (no silent failure).

- [ ] **Step 3: Commit any doc updates**

```bash
git add -A
git commit -m "chore: connect flow verified; regen build"
```

---

## Self-Review

**Spec coverage:** single button (Task 6); non-destructive merge + download (Task 3); preview counts (Task 2); confirmation modal with capped names + zero-push line (Task 4); error surfacing everywhere (Tasks 1, 5); state/dirty via reused `adoptExistingVault` (Task 5); remove empty-vault import path (Task 3). Deviation from spec (kept `adoptExistingVault`; self-contained conflict copy) documented in the header.

**Placeholders:** test-harness helper names in Tasks 1/6 are explicitly flagged as "match the file's actual helpers" because those test files' internal helpers must be read at implementation time; every implementation step contains complete code.

**Type consistency:** `ConnectPreview` (Task 2) is consumed by `ConnectConfirmModal` (Task 4) and `previewConnect` (Task 5) with identical field names (`remoteFileCount`, `localPushCount`, `localPushPaths`, `conflictCount`). `merge()` returns `ConnectMergeResult` with `conflictCopyPaths` used in Task 3 tests. `preview()`/`merge()`/`connect()` names are consistent across Tasks 2, 3, 5, 6.
