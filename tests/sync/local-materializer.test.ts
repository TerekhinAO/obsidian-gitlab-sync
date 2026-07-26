import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/sync/state-store";
import { LocalMaterializer } from "../../src/sync/local-materializer";
import type { MaterializeOperation, PendingTransaction, PluginData } from "../../src/sync/types";

function bytes(value: string | number[]): Uint8Array {
  return typeof value === "string"
    ? new TextEncoder().encode(value)
    : Uint8Array.from(value);
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function base64(value: string | number[]): string {
  return Buffer.from(bytes(value)).toString("base64");
}

function fakeStore(initialData: any = {}) {
  let savedData: unknown = initialData;
  return {
    store: new StateStore({
      loadData: async () => savedData,
      saveData: async (data: unknown) => {
        savedData = data;
      },
    }),
    get data() {
      return savedData as PluginData;
    },
  };
}

function fakeJournal() {
  return {
    suppress: vi.fn(async (operation: () => Promise<unknown>) => operation()),
    acknowledge: vi.fn(async () => undefined),
  };
}

function fakeVault(initialFiles: Record<string, Uint8Array> = {}) {
  const files = new Map(Object.entries(initialFiles));
  const folders = new Set<string>([""]);
  const calls: Array<[string, string, string?]> = [];

  const parent = (path: string) => {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
  };

  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path) || folders.has(path)),
    mkdir: vi.fn(async (path: string) => {
      calls.push(["mkdir", path]);
      folders.add(path);
    }),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      calls.push(["writeBinary", path]);
      folders.add(parent(path));
      files.set(path, new Uint8Array(data.slice(0)));
    }),
    remove: vi.fn(async (path: string) => {
      calls.push(["remove", path]);
      files.delete(path);
    }),
    rename: vi.fn(async (path: string, newPath: string) => {
      calls.push(["rename", path, newPath]);
      const value = files.get(path);
      if (value === undefined) {
        throw new Error(`missing source: ${path}`);
      }
      files.delete(path);
      folders.add(parent(newPath));
      files.set(newPath, value);
    }),
  };

  return {
    vault: { configDir: ".obsidian", adapter },
    read(path: string) {
      return files.get(path);
    },
    exists(path: string) {
      return files.has(path);
    },
    calls,
  };
}

function materializer(options: {
  initialFiles?: Record<string, Uint8Array>;
  initialData?: any;
  journal?: ReturnType<typeof fakeJournal>;
}) {
  const vault = fakeVault(options.initialFiles);
  const store = fakeStore(options.initialData);
  const journal = options.journal ?? fakeJournal();

  return {
    ...vault,
    ...store,
    journal,
    materializer: new LocalMaterializer({
      vault: vault.vault as any,
      stateStore: store.store,
      journal: journal as any,
      now: () => 1234,
    }),
  };
}

describe("LocalMaterializer", () => {
  it("creates nested folders and writes text and binary content", async () => {
    const fixture = materializer({});

    await fixture.materializer.apply([
      { type: "write", path: "folder/deep/note.md", contentBase64: base64("hello") },
      { type: "write", path: "bin/data.bin", contentBase64: base64([0, 255, 1]) },
    ]);

    expect(fixture.read("folder/deep/note.md")).toEqual(bytes("hello"));
    expect(fixture.read("bin/data.bin")).toEqual(bytes([0, 255, 1]));
    expect(fixture.vault.adapter.mkdir).toHaveBeenCalledWith("folder");
    expect(fixture.vault.adapter.mkdir).toHaveBeenCalledWith("folder/deep");
    expect(fixture.vault.adapter.rename).toHaveBeenCalledWith(
      expect.stringContaining("folder/deep/"),
      "folder/deep/note.md",
    );
  });

  it("deletes existing files and treats missing deletes as already applied", async () => {
    const fixture = materializer({
      initialFiles: { "old.md": bytes("old") },
    });

    await fixture.materializer.apply([
      { type: "delete", path: "old.md" },
      { type: "delete", path: "missing.md" },
    ]);

    expect(fixture.exists("old.md")).toBe(false);
    expect(fixture.vault.adapter.remove).toHaveBeenCalledTimes(1);
    expect(fixture.vault.adapter.remove).toHaveBeenCalledWith("old.md");
  });

  it("replaces an existing local original with remote content", async () => {
    const fixture = materializer({
      initialFiles: { "note.md": bytes("local conflict") },
    });

    await fixture.materializer.apply([
      { type: "write", path: "note.md", contentBase64: base64("remote") },
    ]);

    expect(fixture.read("note.md")).toEqual(bytes("remote"));
  });

  it("suppresses journal events around plugin-generated changes", async () => {
    const journal = fakeJournal();
    const fixture = materializer({ journal });

    await fixture.materializer.apply([
      { type: "write", path: "note.md", contentBase64: base64("remote") },
      { type: "delete", path: "gone.md" },
    ]);

    expect(journal.suppress).toHaveBeenCalledTimes(1);
    expect(journal.acknowledge).not.toHaveBeenCalled();
  });

  it("does not overwrite or delete the plugin runtime directory", async () => {
    const fixture = materializer({
      initialFiles: {
        ".obsidian/plugins/gitlab-gitless-sync/main.js": bytes("runtime"),
      },
    });

    await expect(fixture.materializer.apply([
      {
        type: "write",
        path: ".obsidian/plugins/gitlab-gitless-sync/main.js",
        contentBase64: base64("remote"),
      },
    ])).rejects.toThrow("Cannot materialize hard-excluded path");
    await expect(fixture.materializer.apply([
      { type: "delete", path: ".obsidian/plugins/gitlab-gitless-sync/main.js" },
    ])).rejects.toThrow("Cannot materialize hard-excluded path");

    expect(fixture.read(".obsidian/plugins/gitlab-gitless-sync/main.js")).toEqual(bytes("runtime"));
  });

  it("falls back to direct binary write when sibling rename is unavailable", async () => {
    const fixture = materializer({});
    fixture.vault.adapter.rename.mockRejectedValueOnce(new Error("rename unsupported"));

    await fixture.materializer.apply([
      { type: "write", path: "note.md", contentBase64: base64("remote") },
    ]);

    expect(fixture.read("note.md")).toEqual(bytes("remote"));
    expect(fixture.vault.adapter.rename).toHaveBeenCalled();
    expect(fixture.vault.adapter.writeBinary).toHaveBeenCalledWith("note.md", expect.any(ArrayBuffer));
  });

  it("recovers a pending transaction by reapplying operations before finalizing state", async () => {
    const pending = pendingTransaction();
    const fixture = materializer({
      initialFiles: { "old.md": bytes("partially stale") },
      initialData: {
        state: {
          initialized: true,
          lastSyncedCommitSha: "base",
          dirtyEntries: {
            "note.md": { path: "note.md", operation: "upsert", recordedAt: 1 },
            "old.md": { path: "old.md", operation: "delete", recordedAt: 2 },
            "other.md": { path: "other.md", operation: "upsert", recordedAt: 3 },
          },
          trackedFiles: { "old.md": { blobId: "old", mode: "100644", size: 3 } },
          pendingTransaction: pending,
        },
      },
    });

    await expect(fixture.materializer.recoverPendingTransaction()).resolves.toBe(true);

    expect(fixture.read("note.md")).toEqual(bytes("remote"));
    expect(fixture.exists("old.md")).toBe(false);
    const data = await fixture.store.load();
    expect(data.state.lastSyncedCommitSha).toBe("commit-sha");
    expect(data.state.trackedFiles).toEqual(pending.nextTrackedFiles);
    expect(data.state.dirtyEntries).toEqual({
      "other.md": { path: "other.md", operation: "upsert", recordedAt: 3 },
    });
    expect(data.state.pendingTransaction).toBeNull();
    expect(fixture.journal.acknowledge).not.toHaveBeenCalled();
    expect(fixture.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining(["writeBinary", "rename", "remove"]),
    );
  });

  it("finalizes recovery when local operations had already applied before restart", async () => {
    const pending = pendingTransaction();
    const fixture = materializer({
      initialFiles: { "note.md": bytes("remote") },
      initialData: {
        state: {
          initialized: true,
          lastSyncedCommitSha: "base",
          dirtyEntries: {
            "note.md": { path: "note.md", operation: "upsert", recordedAt: 1 },
            "old.md": { path: "old.md", operation: "delete", recordedAt: 2 },
          },
          pendingTransaction: pending,
        },
      },
    });

    await expect(fixture.materializer.recoverPendingTransaction()).resolves.toBe(true);

    expect(fixture.read("note.md")).toEqual(bytes("remote"));
    const data = await fixture.store.load();
    expect(data.state.lastSyncedCommitSha).toBe("commit-sha");
    expect(data.state.trackedFiles).toEqual(pending.nextTrackedFiles);
    expect(data.state.dirtyEntries).toEqual({});
    expect(data.state.pendingTransaction).toBeNull();
  });

  it("reports no recovery work when there is no pending transaction", async () => {
    const fixture = materializer({});

    await expect(fixture.materializer.recoverPendingTransaction()).resolves.toBe(false);

    expect(fixture.vault.adapter.writeBinary).not.toHaveBeenCalled();
  });
});

function pendingTransaction(): PendingTransaction {
  return {
    transactionId: "tx-1",
    committedSha: "commit-sha",
    materializeOperations: [
      { type: "write", path: "note.md", contentBase64: base64("remote") },
      { type: "delete", path: "old.md" },
    ],
    nextTrackedFiles: {
      "note.md": { blobId: "remote-blob", mode: "100644", size: 6 },
    },
    acknowledgedDirtyPaths: ["note.md", "old.md"],
    conflictPaths: [],
    createdAt: 123,
  };
}
