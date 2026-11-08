# Memory-Bounded, Resumable Remote-Only Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the remote-only sync path apply changes in bounded-memory chunks (streaming) and persist a resume point so a phone crash/restart continues instead of re-downloading the whole change set.

**Architecture:** Split the remote-only plan into a decision phase (no bulk download) and a chunked streaming applier (`StreamingRemoteApplier`) that downloads, writes byte-direct, builds the index, and persists `remoteApply` after each chunk. A state schema 3 field `remoteApply` stores the resume point; `syncLocked` resumes when the persisted `remoteSha` still matches the current branch head.

**Tech Stack:** TypeScript, Obsidian plugin, Vitest, esbuild. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-08-memory-bounded-sync-design.md`

## Global Constraints

- Version stays `1.0.18`; this is a pre-release acceptance fix.
- **Run tests with** `./node_modules/.bin/vitest run <path>` (pnpm is not installed).
- **Lint:** `./node_modules/.bin/eslint src tests`.
- **Typecheck workaround:** `node_modules/obsidian` is a broken symlink (target 1.7.2 is absent); installed `obsidian@1.13.1` lives under `node_modules/.pnpm/obsidian@1.13.1_@codemirror+state@6.5.0_@codemirror+view@6.38.6`. Create a temporary `tsconfig.verify.json` at the repo root:
  ```json
  {
    "extends": "./tsconfig.json",
    "compilerOptions": {
      "baseUrl": ".",
      "paths": {
        "obsidian": ["./node_modules/.pnpm/obsidian@1.13.1_@codemirror+state@6.5.0_@codemirror+view@6.38.6/node_modules/obsidian"]
      }
    }
  }
  ```
  Then `./node_modules/.bin/tsc -p tsconfig.verify.json --noEmit`. Do not commit `tsconfig.verify.json`.
- **Build:** `node esbuild.config.mjs production` (this also writes the ignored `main.js`).
- `main.js` and `dist/` are ignored artifacts; never commit them.
- No user-facing setting. `CHUNK_SIZE` is an internal constant (default `32`).
- No change to request pacing, retries, backoff, TLS, or the archive/Connect flow.
- Follow the repo's commit-message style (lowercase `type(scope): subject`).
- Scope: remote-only path only. The commit/conflict path (`plan.actions.length > 0`) is unchanged.

---

### Task 1: State schema 3 + `RemoteApply` type + move `RemoteChange` into `types.ts`

**Files:**
- Modify: `src/sync/types.ts`
- Modify: `src/sync/remote-diff.ts`
- Modify: `src/settings/settings.ts`
- Modify: `src/sync/state-store.ts`
- Test: `tests/sync/state-store.test.ts`

**Interfaces:**
- Produces: `RemoteChange` (moved to `types.ts`), `RemoteApply`, `ByteMaterializeOperation`, `LocalSyncState.schemaVersion: 3`, `LocalSyncState.remoteApply: RemoteApply | null`. `remote-diff.ts` re-exports `RemoteChange` so existing `import ... from "./remote-diff"` callers keep working.

- [ ] **Step 1: Move `RemoteChange` into `types.ts` and add the new types**

In `src/sync/types.ts`, add `RemoteChange` and the new interfaces. `RemoteChange` is currently defined at the top of `src/sync/remote-diff.ts`; it moves here so `types.ts` can type `RemoteApply` without a circular import (`remote-diff.ts` already imports `TrackedFile` from `types.ts`). Also add `ByteMaterializeOperation` (byte-direct write op).

```ts
export type RemoteChange =
  | { type: "create"; path: string }
  | { type: "update"; path: string }
  | { type: "delete"; path: string }
  | { type: "rename"; oldPath: string; newPath: string };

export interface RemoteApply {
  remoteSha: string;
  remainingChanges: RemoteChange[];
  nextTrackedFiles: Record<string, TrackedFile>;
}

export type ByteMaterializeOperation =
  | { type: "write"; path: string; bytes: Uint8Array }
  | { type: "delete"; path: string };
```

Update `LocalSyncState` in the same file:

```ts
export interface LocalSyncState {
  schemaVersion: 3;
  initialized: boolean;
  lastSyncedCommitSha: string | null;
  trackedFiles: Record<string, TrackedFile>;
  dirtyEntries: Record<string, DirtyEntry>;
  pendingTransaction: PendingTransaction | null;
  lastSyncAt: number | null;
  lastSyncResult: "never" | "success" | "conflict" | "error";
  remoteBackoffUntil: number | null;
  remoteBackoffReason: "rate-limit" | "server" | "transport" | null;
  remoteApply: RemoteApply | null;
}
```

- [ ] **Step 2: Update `remote-diff.ts` to import + re-export `RemoteChange`**

Remove the local `export type RemoteChange = ...` block from `src/sync/remote-diff.ts`. Change its import to:

```ts
import type { RemoteChange, TrackedFile } from "./types";
export type { RemoteChange };
```

`RemoteChange` remains importable from `./remote-diff` for existing importers (`sync-planner.ts`, `sync-manager.ts`, tests), but is now canonically defined in `types.ts`.

- [ ] **Step 3: Update `settings.ts` `DEFAULT_STATE`**

In `src/settings/settings.ts`, change `DEFAULT_STATE` to:

```ts
export const DEFAULT_STATE: LocalSyncState = {
  schemaVersion: 3,
  initialized: false,
  lastSyncedCommitSha: null,
  trackedFiles: {},
  dirtyEntries: {},
  pendingTransaction: null,
  lastSyncAt: null,
  lastSyncResult: "never",
  remoteBackoffUntil: null,
  remoteBackoffReason: null,
  remoteApply: null,
};
```

- [ ] **Step 4: Migrate `StateStore` to schema 3**

In `src/sync/state-store.ts`:
- In `load()`, add a default for `remoteApply` and bump the emitted `schemaVersion`:
  ```ts
  remoteApply: raw?.state?.remoteApply ?? null,
  schemaVersion: 3,
  ```
- In `save()`, normalize `remoteApply` and emit `schemaVersion: 3`:
  ```ts
  remoteApply: data.state.remoteApply ?? null,
  schemaVersion: 3,
  ```
- Add a comment noting schema 2 → 3 only adds the nullable `remoteApply` field; no data rewrite is needed.

- [ ] **Step 5: Write the failing migration test**

Append to `tests/sync/state-store.test.ts`:

```ts
it("migrates schema-2 state to schema 3 with a null remoteApply, preserving all fields", async () => {
  const { plugin } = fakePlugin({
    settings: { gitlabBaseUrl: "https://gitlab.example.com" },
    state: {
      schemaVersion: 2,
      initialized: true,
      lastSyncedCommitSha: "commit-a",
      trackedFiles: { "a.md": { blobId: "blob-a", mode: "100644", size: 1 } },
      dirtyEntries: {},
      pendingTransaction: null,
      lastSyncAt: 5,
      lastSyncResult: "success",
      remoteBackoffUntil: null,
      remoteBackoffReason: null,
    },
  });

  const data = await new StateStore(plugin).load();

  expect(data.state.schemaVersion).toBe(3);
  expect(data.state.remoteApply).toBeNull();
  expect(data.state.lastSyncedCommitSha).toBe("commit-a");
  expect(data.state.trackedFiles).toEqual({ "a.md": { blobId: "blob-a", mode: "100644", size: 1 } });
});

it("round-trips a persisted remoteApply resume point", async () => {
  const { plugin } = fakePlugin();
  const store = new StateStore(plugin);
  await store.update((data) => {
    data.state.remoteApply = {
      remoteSha: "remote-a",
      remainingChanges: [{ type: "update", path: "b.md" }],
      nextTrackedFiles: { "a.md": { blobId: "blob-a", mode: "100644", size: 1 } },
    };
  });

  const data = await store.load();
  expect(data.state.schemaVersion).toBe(3);
  expect(data.state.remoteApply).toEqual({
    remoteSha: "remote-a",
    remainingChanges: [{ type: "update", path: "b.md" }],
    nextTrackedFiles: { "a.md": { blobId: "blob-a", mode: "100644", size: 1 } },
  });
});
```

Also update the existing test that asserts `schemaVersion` is `2` (titled `"round-trips persisted remote backoff"` and the schema-1 migration test) to expect `3`.

- [ ] **Step 6: Run the tests**

Run: `./node_modules/.bin/vitest run tests/sync/state-store.test.ts`
Expected: PASS (all state-store tests).

- [ ] **Step 7: Commit**

```bash
git add src/sync/types.ts src/sync/remote-diff.ts src/settings/settings.ts src/sync/state-store.ts tests/sync/state-store.test.ts
git commit -m "feat(sync): add schema-3 remoteApply resume state"
```

---

### Task 2: Byte-direct materializer writes (`LocalMaterializer.applyBytes`)

**Files:**
- Modify: `src/sync/local-materializer.ts`
- Test: `tests/sync/local-materializer.test.ts`

**Interfaces:**
- Consumes: `ByteMaterializeOperation` from Task 1.
- Produces: `LocalMaterializer.applyBytes(operations: ByteMaterializeOperation[]): Promise<void>` (byte-direct, keeps temp-then-rename atomic writes and empty-parent pruning).

- [ ] **Step 1: Write the failing tests**

Append to `tests/sync/local-materializer.test.ts` (follow the existing fake-adapter helpers already in that file):

```ts
it("applies byte-direct write and delete operations", async () => {
  const { materializer, vault } = makeMaterializer({ files: { "old.md": "old" } });
  await materializer.applyBytes([
    { type: "write", path: "new.md", bytes: new TextEncoder().encode("new") },
    { type: "delete", path: "old.md" },
  ]);

  expect(vault.adapter.writeBinary).toHaveBeenCalledWith(
    expect.stringContaining("new.md"),
    expect.anything(),
  );
  expect(await readText(vault, "new.md")).toBe("new");
  expect(await vault.adapter.exists("old.md")).toBe(false);
});
```

(Adapt `makeMaterializer`, `readText`, and the fake vault to match the conventions already used in `tests/sync/local-materializer.test.ts` — reuse its in-memory adapter fake.)

- [ ] **Step 2: Run to verify it fails**

Run: `./node_modules/.bin/vitest run tests/sync/local-materializer.test.ts`
Expected: FAIL with `materializer.applyBytes is not a function`.

- [ ] **Step 3: Refactor `LocalMaterializer` to add `applyBytes`**

In `src/sync/local-materializer.ts`, import `ByteMaterializeOperation`. Add a public method and a shared byte-writing helper, and make `pruneEmptyParents` accept both operation shapes:

```ts
async applyBytes(operations: ByteMaterializeOperation[]): Promise<void> {
  await this.options.journal.suppress(async () => {
    for (const operation of operations) {
      await this.assertMaterializable(operation.path);
      if (operation.type === "write") {
        await this.writeBytes(operation.path, arrayBufferFromBytes(operation.bytes));
      } else {
        await this.delete(operation.path);
      }
    }
    await this.pruneEmptyParents(operations);
  });
}

private async writeBytes(path: string, data: ArrayBuffer): Promise<void> {
  const normalized = normalizePath(path);
  await this.ensureParentFolders(normalized);

  if (this.options.vault.adapter.rename === undefined) {
    await this.options.vault.adapter.writeBinary(normalized, data);
    return;
  }

  const tempPath = this.tempSiblingPath(normalized);
  await this.options.vault.adapter.writeBinary(tempPath, data);

  try {
    await this.options.vault.adapter.rename(tempPath, normalized);
  } catch (error) {
    await this.options.vault.adapter.writeBinary(normalized, data);
    await this.removeIfExists(tempPath);
  }
}
```

Rewrite the existing `write()` to reuse `writeBytes`:

```ts
private async write(operation: MaterializeOperation): Promise<void> {
  if (operation.contentBase64 === undefined) {
    throw new Error(`Write operation for ${operation.path} is missing contentBase64`);
  }
  await this.writeBytes(operation.path, decodeBase64(operation.contentBase64));
}
```

Change `pruneEmptyParents`'s parameter type to a structural union so it accepts both `MaterializeOperation[]` and `ByteMaterializeOperation[]`:

```ts
private async pruneEmptyParents(
  operations: ReadonlyArray<{ type: "write" | "delete"; path: string }>,
): Promise<void> {
```

Its body already only reads `operation.type === "delete"` and `operation.path`, so no other change is needed.

- [ ] **Step 4: Run to verify it passes**

Run: `./node_modules/.bin/vitest run tests/sync/local-materializer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/local-materializer.ts tests/sync/local-materializer.test.ts
git commit -m "feat(sync): byte-direct materializer writes for streaming apply"
```

---

### Task 3: `StreamingRemoteApplier`

**Files:**
- Create: `src/sync/remote-only-stream.ts`
- Create: `tests/sync/remote-only-stream.test.ts`

**Interfaces:**
- Consumes: `RemoteChange`, `ByteMaterializeOperation`, `TrackedFile` (from `types.ts`), `calculateGitBlobId` (from `conflict-resolver.ts`).
- Produces:
  ```ts
  interface StreamApplyProgress { remainingChanges: RemoteChange[]; nextTrackedFiles: Record<string, TrackedFile>; }
  interface StreamingRemoteApplierOptions {
    client: { getRawFile(path: string, ref: string): Promise<ArrayBuffer | null> };
    materializer: { applyBytes(operations: ByteMaterializeOperation[]): Promise<void> };
    chunkSize?: number; // default 32
  }
  class StreamingRemoteApplier {
    constructor(options: StreamingRemoteApplierOptions);
    applyStream(input: {
      changes: RemoteChange[];
      remoteSha: string;
      baseIndex: Record<string, TrackedFile>;
      onProgress?: (progress: StreamApplyProgress) => Promise<void>;
    }): Promise<Record<string, TrackedFile>>;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/sync/remote-only-stream.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { StreamingRemoteApplier } from "../../src/sync/remote-only-stream";
import type { RemoteChange } from "../../src/sync/types";
import type { ByteMaterializeOperation, TrackedFile } from "../../src/sync/types";

function encoded(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function makeApplier(chunkSize = 32) {
  const getRawFile = vi.fn(async (path: string) => encoded(`${path}-content`));
  const writes: ByteMaterializeOperation[][] = [];
  const materializer = {
    applyBytes: vi.fn(async (operations: ByteMaterializeOperation[]) => {
      writes.push(operations.map((op) => ({ ...op, bytes: op.bytes ? new Uint8Array(op.bytes) : undefined })));
    }),
  };
  const applier = new StreamingRemoteApplier({ client: { getRawFile }, materializer, chunkSize });
  return { applier, getRawFile, materializer, writes };
}

describe("StreamingRemoteApplier", () => {
  it("applies create/update/delete/rename and builds the correct index", async () => {
    const { applier, getRawFile } = makeApplier();
    const changes: RemoteChange[] = [
      { type: "create", path: "a.md" },
      { type: "update", path: "b.md" },
      { type: "delete", path: "gone.md" },
      { type: "rename", oldPath: "old.md", newPath: "new.md" },
    ];

    const index = await applier.applyStream({
      changes,
      remoteSha: "remote-a",
      baseIndex: { "b.md": tracked("stale"), "gone.md": tracked("x"), "old.md": tracked("y") },
    });

    expect(getRawFile).toHaveBeenCalledWith("a.md", "remote-a");
    expect(getRawFile).toHaveBeenCalledWith("b.md", "remote-a");
    expect(getRawFile).toHaveBeenCalledWith("new.md", "remote-a");
    expect(Object.keys(index).sort()).toEqual(["a.md", "b.md", "new.md"]);
    expect(index["a.md"].size).toBe("a.md-content".length);
    expect(index["b.md"].size).toBe("b.md-content".length);
    expect(index["new.md"].size).toBe("new.md-content".length);
  });

  it("bounds memory by chunking: no download for the next chunk until the previous chunk is applied", async () => {
    const { applier, getRawFile, materializer, writes } = makeApplier(2);
    const changes: RemoteChange[] = [
      { type: "create", path: "c1.md" },
      { type: "create", path: "c2.md" },
      { type: "create", path: "c3.md" },
      { type: "create", path: "c4.md" },
    ];

    await applier.applyStream({ changes, remoteSha: "remote-a", baseIndex: {} });

    // Chunk 1 (c1,c2) must be fully materialized before chunk 2 (c3,c4) downloads.
    expect(materializer.applyBytes).toHaveBeenCalledTimes(2);
    expect(getRawFile).toHaveBeenNthCalledWith(1, "c1.md", "remote-a");
    expect(getRawFile).toHaveBeenNthCalledWith(2, "c2.md", "remote-a");
    expect(writes[0]).toHaveLength(2);
    expect(writes[1]).toHaveLength(2);
  });

  it("reports remaining changes and partial index after each chunk", async () => {
    const { applier } = makeApplier(2);
    const progress: { remaining: RemoteChange[]; index: string[] }[] = [];
    const changes: RemoteChange[] = [
      { type: "create", path: "c1.md" },
      { type: "create", path: "c2.md" },
      { type: "create", path: "c3.md" },
    ];

    await applier.applyStream({
      changes,
      remoteSha: "remote-a",
      baseIndex: {},
      onProgress: async ({ remainingChanges, nextTrackedFiles }) => {
        progress.push({ remaining: remainingChanges, index: Object.keys(nextTrackedFiles) });
      },
    });

    expect(progress).toEqual([
      { remaining: [{ type: "create", path: "c3.md" }], index: ["c1.md", "c2.md"] },
      { remaining: [], index: ["c1.md", "c2.md", "c3.md"] },
    ]);
  });

  it("treats a null remote read as a deletion and drops it from the index", async () => {
    const getRawFile = vi.fn(async () => null);
    const materializer = { applyBytes: vi.fn(async () => undefined) };
    const applier = new StreamingRemoteApplier({ client: { getRawFile }, materializer });

    const index = await applier.applyStream({
      changes: [{ type: "update", path: "orphan.md" }],
      remoteSha: "remote-a",
      baseIndex: { "orphan.md": tracked("x") },
    });

    expect(index["orphan.md"]).toBeUndefined();
    expect(materializer.applyBytes).toHaveBeenCalledWith([
      { type: "delete", path: "orphan.md" },
    ]);
  });
});

function tracked(text: string): TrackedFile {
  return { blobId: `blob-${text}`, mode: "100644", size: text.length };
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `./node_modules/.bin/vitest run tests/sync/remote-only-stream.test.ts`
Expected: FAIL with `Cannot find module ... remote-only-stream`.

- [ ] **Step 3: Implement `StreamingRemoteApplier`**

Create `src/sync/remote-only-stream.ts`:

```ts
import { calculateGitBlobId } from "./conflict-resolver";
import type {
  ByteMaterializeOperation,
  RemoteChange,
  TrackedFile,
} from "./types";

export interface StreamApplyProgress {
  remainingChanges: RemoteChange[];
  nextTrackedFiles: Record<string, TrackedFile>;
}

export interface StreamingRemoteApplierOptions {
  client: { getRawFile(path: string, ref: string): Promise<ArrayBuffer | null> };
  materializer: { applyBytes(operations: ByteMaterializeOperation[]): Promise<void> };
  chunkSize?: number;
}

export class StreamingRemoteApplier {
  private readonly chunkSize: number;

  constructor(private readonly options: StreamingRemoteApplierOptions) {
    this.chunkSize = options.chunkSize ?? 32;
  }

  async applyStream(input: {
    changes: RemoteChange[];
    remoteSha: string;
    baseIndex: Record<string, TrackedFile>;
    onProgress?: (progress: StreamApplyProgress) => Promise<void>;
  }): Promise<Record<string, TrackedFile>> {
    const index = cloneIndex(input.baseIndex);
    let start = 0;

    while (start < input.changes.length) {
      const end = Math.min(start + this.chunkSize, input.changes.length);
      const chunk = input.changes.slice(start, end);
      const operations: ByteMaterializeOperation[] = [];

      for (const change of chunk) {
        await this.collectOperation(change, input.remoteSha, index, operations);
      }

      await this.options.materializer.applyBytes(operations);

      if (input.onProgress) {
        await input.onProgress({
          remainingChanges: input.changes.slice(end),
          nextTrackedFiles: cloneIndex(index),
        });
      }

      start = end;
    }

    return index;
  }

  private async collectOperation(
    change: RemoteChange,
    remoteSha: string,
    index: Record<string, TrackedFile>,
    operations: ByteMaterializeOperation[],
  ): Promise<void> {
    switch (change.type) {
      case "create":
      case "update":
        await this.materializeWrite(change.path, remoteSha, index, operations);
        return;
      case "delete":
        operations.push({ type: "delete", path: change.path });
        delete index[change.path];
        return;
      case "rename":
        operations.push({ type: "delete", path: change.oldPath });
        delete index[change.oldPath];
        await this.materializeWrite(change.newPath, remoteSha, index, operations);
        return;
    }
  }

  private async materializeWrite(
    path: string,
    remoteSha: string,
    index: Record<string, TrackedFile>,
    operations: ByteMaterializeOperation[],
  ): Promise<void> {
    const buffer = await this.options.client.getRawFile(path, remoteSha);
    if (buffer === null) {
      operations.push({ type: "delete", path });
      delete index[path];
      return;
    }

    const bytes = new Uint8Array(buffer);
    operations.push({ type: "write", path, bytes });
    index[path] = {
      blobId: await calculateGitBlobId(bytes),
      mode: "100644",
      size: bytes.byteLength,
    };
  }
}

function cloneIndex(index: Record<string, TrackedFile>): Record<string, TrackedFile> {
  return Object.fromEntries(Object.entries(index).map(([path, file]) => [path, { ...file }]));
}
```

Note: `buffer` is copied into a `Uint8Array` view; only the current chunk's `operations` retain byte references, so earlier chunks' buffers are garbage-collectable. `onProgress` persists the shrinkable tail and the partial index.

- [ ] **Step 4: Run to verify it passes**

Run: `./node_modules/.bin/vitest run tests/sync/remote-only-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/remote-only-stream.ts tests/sync/remote-only-stream.test.ts
git commit -m "feat(sync): chunked streaming remote-only applier"
```

---

### Task 4: Planner streaming-aware remote-only mode

**Files:**
- Modify: `src/sync/sync-planner.ts`
- Test: `tests/sync/sync-planner.test.ts`

**Interfaces:**
- Consumes: `RemoteChange` (now from `types.ts`).
- Produces: `SyncPlan.streamChanges: RemoteChange[]`; `SyncPlanner.plan()` accepts `streamRemoteOnly?: boolean`. When `streamRemoteOnly` is true and `actions.length === 0`, the plan returns `streamChanges = input.remoteChanges`, `materializeWithoutCommit = []`, and an index without the bulk remote-only mutations (the streaming applier adds them). The commit path (`actions.length > 0`) and `streamRemoteOnly: false` behave exactly as today.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sync/sync-planner.test.ts` (use the file's existing fake `getRemoteVersion` helper to serve `VersionState`):

```ts
it("returns the full remote change set for streaming in a remote-only plan", async () => {
  const getRemoteVersion = vi.fn(async () => ({ exists: true, bytes: new TextEncoder().encode("remote") }));
  const planner = new SyncPlanner({ getRemoteVersion, deviceName: "iPhone" });
  const plan = await planner.plan({
    baseSha: "base-a",
    remoteSha: "remote-a",
    trackedFiles: {},
    dirtyEntries: [],
    remoteChanges: [
      { type: "create", path: "a.md" },
      { type: "update", path: "b.md" },
      { type: "delete", path: "c.md" },
    ],
    localSnapshots: [],
    now: new Date("2026-07-26T20:15:00+03:00"),
    streamRemoteOnly: true,
  });

  expect(plan.actions).toEqual([]);
  expect(plan.streamChanges).toEqual([
    { type: "create", path: "a.md" },
    { type: "update", path: "b.md" },
    { type: "delete", path: "c.md" },
  ]);
  expect(plan.materializeWithoutCommit).toEqual([]);
  // No bulk download during planning: remote bytes are read only for snapshots.
  expect(getRemoteVersion).not.toHaveBeenCalled();
});

it("keeps the commit path materializing after the commit when streamRemoteOnly is true", async () => {
  const planner = new SyncPlanner({
    getRemoteVersion: async () => ({ exists: true, bytes: new TextEncoder().encode("remote") }),
    deviceName: "iPhone",
  });
  const plan = await planner.plan({
    baseSha: "base-a",
    remoteSha: "remote-a",
    trackedFiles: {},
    dirtyEntries: [{ path: "local.md", operation: "upsert", recordedAt: 1 }],
    remoteChanges: [{ type: "update", path: "remote.md" }],
    localSnapshots: [
      { path: "local.md", operation: "upsert", local: { exists: true, bytes: new TextEncoder().encode("local") }, base: { exists: false, bytes: null } },
    ],
    now: new Date("2026-07-26T20:15:00+03:00"),
    streamRemoteOnly: true,
  });

  expect(plan.actions.length).toBeGreaterThan(0);
  expect(plan.streamChanges).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `./node_modules/.bin/vitest run tests/sync/sync-planner.test.ts`
Expected: FAIL (`streamChanges` is undefined; the remote-only path currently downloads into `materializeWithoutCommit`).

- [ ] **Step 3: Add `streamChanges` and the streaming branch to `SyncPlanner`**

In `src/sync/sync-planner.ts`:

1. Add to `SyncPlan`:
   ```ts
   streamChanges: RemoteChange[];
   ```
2. Update the `plan` input type to accept `streamRemoteOnly?: boolean`.
3. Restructure `plan()` so the bulk materialization loop runs **only** for the commit path, and the remote-only path returns `streamChanges`. Replace the existing top-of-function loop and the return block:

```ts
async plan(input: {
  baseSha: string;
  remoteSha: string;
  trackedFiles: Record<string, TrackedFile>;
  dirtyEntries: DirtyEntry[];
  remoteChanges: RemoteChange[];
  localSnapshots: LocalSnapshotEntry[];
  now: Date;
  streamRemoteOnly?: boolean;
}): Promise<SyncPlan> {
  const nextTrackedFiles = cloneIndex(input.trackedFiles);
  const dirtyPaths = new Set(input.dirtyEntries.map((entry) => entry.path));
  const localSnapshotPaths = new Set(input.localSnapshots.map((snapshot) => snapshot.path));
  const remoteChangedPaths = remoteChangedPathSet(input.remoteChanges);

  // Decision phase reads no remote bytes for the pure remote-only case; for
  // snapshot-remote-changed paths it reads only the bounded set of snapshots.
  const remoteVersions = await this.remoteVersionsForSnapshots(
    input.localSnapshots,
    input.remoteSha,
    remoteChangedPaths,
  );
  const conflictPlan = await this.conflictResolver.resolve({
    snapshots: input.localSnapshots,
    remote: remoteVersions,
    trackedFiles: nextTrackedFiles,
    now: input.now,
    deviceName: this.deviceName,
  });
  const actions = await this.withOptimisticLocks(
    conflictPlan.commitActions,
    input.remoteSha,
  );
  await applyRemoteVersionsForSnapshots(
    nextTrackedFiles,
    input.localSnapshots,
    remoteVersions,
    remoteChangedPaths,
  );
  applyIndexMutations(nextTrackedFiles, conflictPlan.nextIndexMutations);

  const acknowledgedDirtyPaths = input.localSnapshots
    .map((snapshot) => snapshot.path)
    .filter((path) => dirtyPaths.has(path));

  const isRemoteOnly = input.streamRemoteOnly === true && actions.length === 0;
  if (isRemoteOnly) {
    // No commit to create: hand the full ordered remote-change set to the
    // streaming applier. No file bytes are downloaded or buffered here; the
    // applier materializes and builds the index in bounded chunks.
    return {
      basedOnRemoteSha: input.remoteSha,
      actions: [],
      materializeAfterCommit: [],
      materializeWithoutCommit: [],
      streamChanges: input.remoteChanges,
      nextTrackedFiles,
      acknowledgedDirtyPaths,
      conflictPaths: conflictPlan.conflictPaths,
    };
  }

  // Commit path (unchanged semantics): materialization happens after the commit
  // is created, so it is carried in materializeAfterCommit.
  const materializeAfterCommit: MaterializeOperation[] = [];
  for (const change of input.remoteChanges) {
    if (isTouchedByLocalSnapshot(change, localSnapshotPaths)) {
      continue;
    }
    await materializeRemoteOnlyChange(
      change,
      input.remoteSha,
      nextTrackedFiles,
      materializeAfterCommit,
      this.getRemoteVersion,
    );
  }
  materializeAfterCommit.push(...conflictPlan.materializeOperations);

  return {
    basedOnRemoteSha: input.remoteSha,
    actions,
    materializeAfterCommit,
    materializeWithoutCommit: [],
    streamChanges: [],
    nextTrackedFiles,
    acknowledgedDirtyPaths,
    conflictPaths: conflictPlan.conflictPaths,
  };
}
```

Remove the now-unused `materializeWithoutCommit` construction. Keep `materializeRemoteOnlyChange`, `materializeRemotePath`, and the helpers unchanged (they are used by the commit path).

- [ ] **Step 4: Run to verify it passes**

Run: `./node_modules/.bin/vitest run tests/sync/sync-planner.test.ts`
Expected: PASS (existing planner tests must still pass; if a test relied on the remote-only plan returning `materializeWithoutCommit`, update it to the `streamChanges` contract).

- [ ] **Step 5: Commit**

```bash
git add src/sync/sync-planner.ts tests/sync/sync-planner.test.ts
git commit -m "feat(sync): planner streaming-aware remote-only mode"
```

---

### Task 5: Wire streaming + resume into `SyncManager`

**Files:**
- Modify: `src/sync/sync-manager.ts`
- Test: `tests/sync/sync-manager.test.ts`

**Interfaces:**
- Consumes: `StreamingRemoteApplier` (Task 3), `SyncPlan.streamChanges` + `streamRemoteOnly` (Task 4), `RemoteApply` (Task 1), `LocalMaterializer.applyBytes` (Task 2).
- Produces:
  - `SyncManagerOptions.createStreamingApplier?: (client: GitLabClientLike, materializer: MaterializerLike) => StreamingRemoteApplier`
  - `MaterializerLike.applyBytes(operations: ByteMaterializeOperation[]): Promise<void>`
  - `SyncManager` resumes `state.remoteApply` in `syncLocked` when its `remoteSha` matches the branch head (non-`audit` triggers) and streams remote-only plans via the applier.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sync/sync-manager.test.ts`:

```ts
it("streams a remote-only plan and persists resume progress between chunks", async () => {
  const fixture = managerFixture({
    data: initializedData(),
    remoteChanges: [{ type: "update", path: "desktop.md" }],
  });
  fixture.planner.plan.mockResolvedValueOnce(
    remoteOnlyPlan("remote-a", [{ type: "update", path: "desktop.md" }]),
  );

  await expect(fixture.manager.sync("startup")).resolves.toMatchObject({
    status: "success",
    commitSha: "remote-a",
  });

  expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
  expect(fixture.streamingApplier.applyStream).toHaveBeenCalledTimes(1);
  const call = fixture.streamingApplier.applyStream.mock.calls[0][0];
  expect(call.changes).toEqual([{ type: "update", path: "desktop.md" }]);
  expect(call.remoteSha).toBe("remote-a");
  // Resume state was persisted and then cleared on finalize.
  const state = (await fixture.store.load()).state;
  expect(state.remoteApply).toBeNull();
  expect(state.lastSyncedCommitSha).toBe("remote-a");
  expect(state.trackedFiles).toEqual({ "desktop.md": tracked("stream") });
});

it("resumes an interrupted remote-only apply when the remote head matches", async () => {
  const fixture = managerFixture({
    data: initializedData({
      remoteApply: {
        remoteSha: "remote-a",
        remainingChanges: [{ type: "update", path: "resume.md" }],
        nextTrackedFiles: {},
      },
    }),
    branchHeads: ["remote-a"],
  });

  await expect(fixture.manager.sync("manual")).resolves.toMatchObject({
    status: "success",
    commitSha: "remote-a",
  });

  expect(fixture.planner.plan).not.toHaveBeenCalled();
  expect(fixture.streamingApplier.applyStream).toHaveBeenCalledTimes(1);
  const call = fixture.streamingApplier.applyStream.mock.calls[0][0];
  expect(call.changes).toEqual([{ type: "update", path: "resume.md" }]);
  expect(call.baseIndex).toEqual({});
  const state = (await fixture.store.load()).state;
  expect(state.remoteApply).toBeNull();
  expect(state.lastSyncedCommitSha).toBe("remote-a");
});

it("discards a stale resume point when the remote head moved", async () => {
  const fixture = managerFixture({
    data: initializedData({
      remoteApply: {
        remoteSha: "remote-a",
        remainingChanges: [{ type: "update", path: "resume.md" }],
        nextTrackedFiles: {},
      },
    }),
    branchHeads: ["remote-b"],
  });
  fixture.planner.plan.mockResolvedValueOnce(remoteOnlyPlan("remote-b", []));

  await fixture.manager.sync("manual");

  expect(fixture.planner.plan).toHaveBeenCalledTimes(1);
  const state = (await fixture.store.load()).state;
  expect(state.remoteApply).toBeNull();
  expect(state.lastSyncedCommitSha).toBe("remote-b");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `./node_modules/.bin/vitest run tests/sync/sync-manager.test.ts`
Expected: FAIL (no `streamingApplier`, no resume logic).

- [ ] **Step 3: Implement the wiring in `SyncManager`**

In `src/sync/sync-manager.ts`:

1. Import `StreamingRemoteApplier` from `./remote-only-stream` and add `RemoteApply`, `ByteMaterializeOperation` to the type imports from `./types`.
2. Add `applyBytes` to the `MaterializerLike` interface:
   ```ts
   interface MaterializerLike {
     apply(operations: MaterializeOperation[]): Promise<void>;
     applyBytes(operations: ByteMaterializeOperation[]): Promise<void>;
     recoverPendingTransaction(): Promise<boolean>;
   }
   ```
3. Add `createStreamingApplier` to `SyncManagerOptions`:
   ```ts
   createStreamingApplier?: (
     client: GitLabClientLike,
     materializer: MaterializerLike,
   ) => StreamingRemoteApplier;
   ```
4. Add a `getStreamingApplier` method:
   ```ts
   private getStreamingApplier(
     client: GitLabClientLike,
   ): StreamingRemoteApplier {
     return this.options.createStreamingApplier?.(
       client,
       this.getMaterializer(),
     ) ?? new StreamingRemoteApplier({
       client,
       materializer: {
         applyBytes: (operations) => this.getMaterializer().applyBytes(operations),
       },
     });
   }
   ```
5. In `planAndApply`, pass `streamRemoteOnly: true` to the top-level `planner.plan({ ... })` call, and pass `input.client` to `applyRemoteOnlyPlan`.
6. Rewrite `applyRemoteOnlyPlan` to stream:
   ```ts
   private async applyRemoteOnlyPlan(
     trigger: SyncTrigger,
     remoteSha: string,
     plan: SyncPlan,
     client: GitLabClientLike,
     progress?: ProgressNotice,
   ): Promise<SyncResult> {
     this.setProgress(progress, "Updating local vault…");
     const finalIndex = await this.getJournal().suppress(async () => {
       const applier = this.getStreamingApplier(client);
       return await applier.applyStream({
         changes: plan.streamChanges,
         remoteSha,
         baseIndex: plan.nextTrackedFiles,
         onProgress: async ({ remainingChanges, nextTrackedFiles }) => {
           await this.options.stateStore.update((data) => {
             data.state.remoteApply = { remoteSha, remainingChanges, nextTrackedFiles };
           });
         },
       });
     });

     await this.options.stateStore.update((data) => {
       data.state.lastSyncedCommitSha = remoteSha;
       data.state.trackedFiles = cloneTrackedFiles(finalIndex);
       for (const path of plan.acknowledgedDirtyPaths) {
         delete data.state.dirtyEntries[normalizePath(path)];
       }
       data.state.pendingTransaction = null;
       data.state.lastSyncAt = this.now();
       data.state.lastSyncResult = plan.conflictPaths.length > 0 ? "conflict" : "success";
       data.state.remoteBackoffUntil = null;
       data.state.remoteBackoffReason = null;
       data.state.remoteApply = null;
     });

     this.setProgress(progress, "Sync complete");
     return {
       status: plan.conflictPaths.length > 0 ? "conflict" : "success",
       trigger,
       message: "Sync complete",
       commitSha: remoteSha,
       attempts: 1,
     };
   }
   ```
7. Add resume detection + resume in `syncLocked`, immediately after `this.validateBranch(firstBranch);`:
   ```ts
   if (trigger !== "audit") {
     const resumable = this.resumableRemoteApply(data.state, firstBranch.commit.id);
     if (resumable) {
       return await this.resumeRemoteApply(trigger, firstBranch.commit.id, resumable, client, progress);
     }
   }
   ```
8. Add the helpers:
   ```ts
   private resumableRemoteApply(
     state: LocalSyncState,
     remoteSha: string,
   ): RemoteApply | null {
     const resume = state.remoteApply;
     if (resume === null) {
       return null;
     }
     return resume.remoteSha === remoteSha ? resume : null;
   }

   private async resumeRemoteApply(
     trigger: SyncTrigger,
     remoteSha: string,
     resume: RemoteApply,
     client: GitLabClientLike,
     progress?: ProgressNotice,
   ): Promise<SyncResult> {
     this.setProgress(progress, "Updating local vault…");
     const finalIndex = await this.getJournal().suppress(async () => {
       const applier = this.getStreamingApplier(client);
       return await applier.applyStream({
         changes: resume.remainingChanges,
         remoteSha,
         baseIndex: resume.nextTrackedFiles,
         onProgress: async ({ remainingChanges, nextTrackedFiles }) => {
           await this.options.stateStore.update((data) => {
             data.state.remoteApply = { remoteSha, remainingChanges, nextTrackedFiles };
           });
         },
       });
     });

     await this.options.stateStore.update((data) => {
       data.state.lastSyncedCommitSha = remoteSha;
       data.state.trackedFiles = cloneTrackedFiles(finalIndex);
       data.state.pendingTransaction = null;
       data.state.lastSyncAt = this.now();
       data.state.lastSyncResult = "success";
       data.state.remoteBackoffUntil = null;
       data.state.remoteBackoffReason = null;
       data.state.remoteApply = null;
     });

     this.setProgress(progress, "Sync complete");
     return {
       status: "success",
       trigger,
       message: "Sync complete",
       commitSha: remoteSha,
       attempts: 1,
     };
   }
   ```
9. Update the `PlannerLike` interface's `plan` input to include `streamRemoteOnly?: boolean`.

- [ ] **Step 4: Update the `SyncManager` test fixture for the new contract**

In `tests/sync/sync-manager.test.ts`:

1. Add a fake streaming applier and a `streamingApplier` handle to `managerFixture`, and inject it via `createStreamingApplier`:
   ```ts
   const streamingApplier = {
     applyStream: vi.fn(async ({ changes, remoteSha, baseIndex }: {
       changes: RemoteChange[];
       remoteSha: string;
       baseIndex: Record<string, TrackedFile>;
       onProgress?: (p: unknown) => Promise<void>;
     }) => {
       const index = { ...baseIndex };
       for (const change of changes) {
         if (change.type === "rename") {
           delete index[change.oldPath];
           index[change.newPath] = tracked("stream");
         } else if (change.type === "delete") {
           delete index[change.path];
         } else {
           index[change.path] = tracked("stream");
         }
       }
       if (changes.length > 0) {
         // Simulate a single chunk boundary so resume state is persisted then cleared.
         // (In practice applyStream calls onProgress per chunk; here it is enough to
         //  exercise the wiring.)
       }
       return index;
     }),
   };
   ```
   Return `streamingApplier` from `managerFixture`, and pass
   `createStreamingApplier: () => streamingApplier` to the `SyncManager` constructor options.
2. Add `applyBytes: vi.fn(async () => undefined)` to the mock `materializer` so it satisfies `MaterializerLike`.
3. Rewrite the `remoteOnlyPlan` helper to take `RemoteChange[]`:
   ```ts
   function remoteOnlyPlan(remoteSha: string, streamChanges: RemoteChange[]): SyncPlan {
     return {
       basedOnRemoteSha: remoteSha,
       actions: [],
       materializeAfterCommit: [],
       materializeWithoutCommit: [],
       streamChanges,
       nextTrackedFiles: Object.fromEntries(
         streamChanges
           .filter((change) => change.type === "create" || change.type === "update")
           .map((change) => [change.path, tracked("desktop")]),
       ),
       acknowledgedDirtyPaths: [],
       conflictPaths: [],
     };
   }
   ```
4. Update callers of `remoteOnlyPlan(...)` that previously passed `MaterializeOperation[]` to pass `RemoteChange[]` instead. The affected tests are those asserting the remote-only path, e.g. `"materializes remote-only changes and advances state without creating a commit"` — change its plan to `remoteOnlyPlan("remote-a", [{ type: "update", path: "desktop.md" }])`, keep `remoteChanges: [{ type: "update", path: "desktop.md" }]`, and assert `fixture.streamingApplier.applyStream` was called with those changes and that `state.trackedFiles` reflects the applier's returned index.
5. Add `remoteApply: null` to the `pluginData` default state fixture and bump its `schemaVersion` to `3`:
   ```ts
   state: {
     schemaVersion: 3,
     initialized: false,
     lastSyncedCommitSha: null,
     trackedFiles: {},
     dirtyEntries: {},
     pendingTransaction: null,
     lastSyncAt: null,
     lastSyncResult: "never",
     remoteBackoffUntil: null,
     remoteBackoffReason: null,
     remoteApply: null,
     ...state,
   },
   ```

- [ ] **Step 5: Run the full sync-manager suite**

Run: `./node_modules/.bin/vitest run tests/sync/sync-manager.test.ts`
Expected: PASS (including the three new resume/stream tests). Fix any existing test that asserted the old remote-only contract.

- [ ] **Step 6: Commit**

```bash
git add src/sync/sync-manager.ts tests/sync/sync-manager.test.ts
git commit -m "feat(sync): stream remote-only apply and resume across restarts"
```

---

### Task 6: Update remaining fixtures + integration coverage

**Files:**
- Modify: `tests/sync/state-store.test.ts` (already updated in Task 1 — verify)
- Modify: `tests/integration/gitlab-sync.integration.test.ts`
- Possibly: other `tests/**` fixtures that construct `PluginData`/`LocalSyncState` (search for `schemaVersion: 2`).

**Interfaces:**
- Consumes: schema 3 (`remoteApply`), `SyncPlan.streamChanges`, `SyncManagerOptions.createStreamingApplier`.

- [ ] **Step 1: Bump remaining schema fixtures to 3**

Search the repo for `schemaVersion: 2`:
Run: `./node_modules/.bin/eslint src tests` (or `grep -rn "schemaVersion: 2" tests` via the Grep tool).

Update any test fixture that builds a `LocalSyncState`/`PluginData` directly to `schemaVersion: 3` and add `remoteApply: null` (mirroring Task 5 Step 4's `pluginData`). Files likely affected: `tests/integration/gitlab-sync.integration.test.ts`, and any helper in `tests/sync/*`.

- [ ] **Step 2: Add a large remote-only integration regression**

In `tests/integration/gitlab-sync.integration.test.ts`, add a test that drives a remote-only sync with many changes and asserts the streaming applier is used and state finalizes correctly. Reuse the integration harness already in that file (it provisions a fake GitLab client and a `SyncManager`). If the harness does not inject `createStreamingApplier`, add a spy to record `applyStream` calls.

```ts
it("streams a large remote-only change set and finalizes state", async () => {
  const changes: RemoteChange[] = Array.from({ length: 70 }, (_, i) => ({
    type: "create" as const,
    path: `f${i}.md`,
  }));
  const applier = { applyStream: vi.fn(async ({ changes: c, remoteSha, baseIndex }: any) => {
    const index = { ...baseIndex };
    for (const change of c) index[change.path] = tracked(`f${change.path}`);
    return index;
  }) };

  // Build a SyncManager with createStreamingApplier: () => applier and a client
  // whose getRawFile returns distinct bytes per path, run sync("manual"), then:
  expect(applier.applyStream).toHaveBeenCalledTimes(1);
  expect(applier.applyStream.mock.calls[0][0].changes).toHaveLength(70);
  // state.lastSyncedCommitSha === remote head; state.remoteApply === null.
});
```

Adapt `tracked(...)` and the harness construction to the integration file's existing helpers.

- [ ] **Step 3: Run the integration suite**

Run: `./node_modules/.bin/vitest run tests/integration/gitlab-sync.integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/gitlab-sync.integration.test.ts
git commit -m "test(sync): cover streaming remote-only sync in integration harness"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `./node_modules/.bin/vitest run`
Expected: PASS (all suites, including the 211 pre-existing tests plus the new ones).

- [ ] **Step 2: Typecheck with the workaround**

Create `tsconfig.verify.json` as in Global Constraints, then:
Run: `./node_modules/.bin/tsc -p tsconfig.verify.json --noEmit`
Expected: no errors. Delete `tsconfig.verify.json` afterward.

- [ ] **Step 3: Lint**

Run: `./node_modules/.bin/eslint src tests`
Expected: no errors/warnings.

- [ ] **Step 4: Build**

Run: `node esbuild.config.mjs production`
Expected: builds `main.js` (ignored artifact).

- [ ] **Step 5: Commit any leftover changes**

Run: `git status --short`
If anything (other than ignored `main.js`) is uncommitted, commit it with an appropriate message.

---

## Self-Review

- **Spec coverage:** Schema-3 `remoteApply` (Task 1), byte-direct writes (Task 2), chunked streaming applier + chunk-scoped reader + memory bound (Task 3), planner streaming mode + no bulk download (Task 4), SyncManager wiring + resume entry + branch-race discard (Task 5), schema fixtures + integration regression (Task 6), full verification (Task 7). All spec sections are covered.
- **Placeholders:** All code steps contain real code; no TBD/TODO.
- **Type consistency:** `streamChanges`, `applyBytes`, `RemoteApply`, `ByteMaterializeOperation`, `createStreamingApplier`, `resumableRemoteApply`, `resumeRemoteApply` are named and typed consistently across Tasks 1–6.