import { describe, expect, it, vi } from "vitest";
import { LocalSnapshotService } from "../../src/sync/local-snapshot";
import type { DirtyEntry, TrackedFile } from "../../src/sync/types";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function vault(files: Record<string, Uint8Array>) {
  return {
    adapter: {
      exists: vi.fn(async (path: string) => Object.prototype.hasOwnProperty.call(files, path)),
      readBinary: vi.fn(async (path: string) => arrayBuffer(files[path])),
    },
  };
}

describe("LocalSnapshotService", () => {
  it("reads local bytes from the vault and base bytes from the tracked blob", async () => {
    const tracked: Record<string, TrackedFile> = {
      "note.md": { blobId: "base-sha", mode: "100644", size: 4 },
    };
    const fakeVault = vault({ "note.md": bytes("mine") });
    const getRawBlob = vi.fn(async (blobId: string) => arrayBuffer(bytes(`base:${blobId}`)));

    await expect(
      new LocalSnapshotService(fakeVault, getRawBlob).snapshot([
        dirty("note.md", "upsert"),
      ], tracked),
    ).resolves.toEqual([
      {
        path: "note.md",
        operation: "upsert",
        local: { exists: true, bytes: bytes("mine") },
        base: { exists: true, bytes: bytes("base:base-sha") },
      },
    ]);

    expect(fakeVault.adapter.readBinary).toHaveBeenCalledWith("note.md");
    expect(getRawBlob).toHaveBeenCalledWith("base-sha");
  });

  it("records absent local and absent base states without reading missing content", async () => {
    const fakeVault = vault({});
    const getRawBlob = vi.fn();

    await expect(
      new LocalSnapshotService(fakeVault, getRawBlob).snapshot([
        dirty("new.md", "delete"),
      ], {}),
    ).resolves.toEqual([
      {
        path: "new.md",
        operation: "delete",
        local: { exists: false, bytes: null },
        base: { exists: false, bytes: null },
      },
    ]);

    expect(fakeVault.adapter.readBinary).not.toHaveBeenCalled();
    expect(getRawBlob).not.toHaveBeenCalled();
  });

  it("uses an unknown base when the tracked blob cannot be fetched", async () => {
    const fakeVault = vault({ "note.md": bytes("mine") });
    const getRawBlob = vi.fn(async () => null);

    await expect(
      new LocalSnapshotService(fakeVault, getRawBlob).snapshot([
        dirty("note.md", "upsert"),
      ], {
        "note.md": { blobId: "missing", mode: "100644", size: 4 },
      }),
    ).resolves.toEqual([
      {
        path: "note.md",
        operation: "upsert",
        local: { exists: true, bytes: bytes("mine") },
        base: null,
      },
    ]);
  });

  it("omits ignored untracked files before reading local or remote bytes", async () => {
    const fakeVault = vault({ "scratch.tmp": bytes("skip"), "tracked.tmp": bytes("keep") });
    const getRawBlob = vi.fn(async () => arrayBuffer(bytes("old")));
    const isIgnored = vi.fn((path: string) => path.endsWith(".tmp"));
    const tracked = {
      "tracked.tmp": { blobId: "old", mode: "100644", size: 3 },
    };

    const snapshots = await new LocalSnapshotService(fakeVault, getRawBlob, isIgnored).snapshot([
      dirty("scratch.tmp", "upsert"),
      dirty("tracked.tmp", "upsert"),
    ], tracked);

    expect(snapshots.map((entry) => entry.path)).toEqual(["tracked.tmp"]);
    expect(fakeVault.adapter.readBinary).toHaveBeenCalledTimes(1);
    expect(fakeVault.adapter.readBinary).toHaveBeenCalledWith("tracked.tmp");
    expect(isIgnored).toHaveBeenCalledWith("scratch.tmp", tracked);
  });

  it("loads entries sequentially so large files are not buffered concurrently", async () => {
    const activeReads: string[] = [];
    const completedReads: string[] = [];
    const fakeVault = {
      adapter: {
        exists: vi.fn(async () => true),
        readBinary: vi.fn(async (path: string) => {
          expect(activeReads).toEqual([]);
          activeReads.push(path);
          await Promise.resolve();
          completedReads.push(path);
          activeReads.pop();
          return arrayBuffer(bytes(path));
        }),
      },
    };

    await new LocalSnapshotService(fakeVault, vi.fn()).snapshot([
      dirty("one.bin", "upsert"),
      dirty("two.bin", "upsert"),
      dirty("three.bin", "upsert"),
    ], {});

    expect(completedReads).toEqual(["one.bin", "two.bin", "three.bin"]);
  });
});

function dirty(path: string, operation: DirtyEntry["operation"]): DirtyEntry {
  return { path, operation, recordedAt: 1 };
}
