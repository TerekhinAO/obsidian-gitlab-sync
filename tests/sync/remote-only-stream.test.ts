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