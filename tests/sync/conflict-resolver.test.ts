import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConflictResolver, type VersionState } from "../../src/sync/conflict-resolver";
import type { LocalSnapshotEntry } from "../../src/sync/local-snapshot";
import type { TrackedFile } from "../../src/sync/types";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64(text: string): string {
  return Buffer.from(text).toString("base64");
}

function blobId(text: string): string {
  return blobIdBytes(bytes(text));
}

function blobIdBytes(value: Uint8Array): string {
  return createHash("sha1")
    .update(Buffer.from(`blob ${value.byteLength}\0`))
    .update(value)
    .digest("hex");
}

const now = new Date("2026-07-26T20:15:00+03:00");

describe("ConflictResolver", () => {
  it.each([
    {
      name: "absent / created A / absent creates original A",
      path: "note.md",
      base: missing(),
      local: present("A"),
      remote: missing(),
      wantActions: [{ action: "create", file_path: "note.md", content: base64("A"), encoding: "base64" }],
      wantMaterialize: [],
      wantConflicts: [],
      wantMutations: [{ type: "set", path: "note.md", file: tracked("A") }],
    },
    {
      name: "absent / created A / created A has no conflict",
      path: "note.md",
      base: missing(),
      local: present("A"),
      remote: present("A"),
      wantActions: [],
      wantMaterialize: [],
      wantConflicts: [],
      wantMutations: [],
    },
    {
      name: "absent / created A / created B keeps remote B and creates conflict copy A",
      path: "note.md",
      base: missing(),
      local: present("A"),
      remote: present("B"),
      wantActions: [{
        action: "create",
        file_path: "note — conflict iPhone 2026-07-26 20-15.md",
        content: base64("A"),
        encoding: "base64",
      }],
      wantMaterialize: [
        { type: "write", path: "note.md", contentBase64: base64("B") },
        { type: "write", path: "note — conflict iPhone 2026-07-26 20-15.md", contentBase64: base64("A") },
      ],
      wantConflicts: ["note — conflict iPhone 2026-07-26 20-15.md"],
      wantMutations: [{
        type: "set",
        path: "note — conflict iPhone 2026-07-26 20-15.md",
        file: tracked("A"),
      }],
    },
    {
      name: "A / unchanged A / changed B materializes remote B",
      path: "note.md",
      base: present("A"),
      local: present("A"),
      remote: present("B"),
      wantActions: [],
      wantMaterialize: [{ type: "write", path: "note.md", contentBase64: base64("B") }],
      wantConflicts: [],
      wantMutations: [],
    },
    {
      name: "A / changed B / unchanged A updates original B",
      path: "note.md",
      base: present("A"),
      local: present("B"),
      remote: present("A"),
      wantActions: [{ action: "update", file_path: "note.md", content: base64("B"), encoding: "base64" }],
      wantMaterialize: [],
      wantConflicts: [],
      wantMutations: [{ type: "set", path: "note.md", file: tracked("B") }],
    },
    {
      name: "A / changed B / changed B has no conflict",
      path: "note.md",
      base: present("A"),
      local: present("B"),
      remote: present("B"),
      wantActions: [],
      wantMaterialize: [],
      wantConflicts: [],
      wantMutations: [],
    },
    {
      name: "A / changed B / changed C keeps remote C and creates conflict copy B",
      path: "note.md",
      base: present("A"),
      local: present("B"),
      remote: present("C"),
      wantActions: [{
        action: "create",
        file_path: "note — conflict iPhone 2026-07-26 20-15.md",
        content: base64("B"),
        encoding: "base64",
      }],
      wantMaterialize: [
        { type: "write", path: "note.md", contentBase64: base64("C") },
        { type: "write", path: "note — conflict iPhone 2026-07-26 20-15.md", contentBase64: base64("B") },
      ],
      wantConflicts: ["note — conflict iPhone 2026-07-26 20-15.md"],
      wantMutations: [{
        type: "set",
        path: "note — conflict iPhone 2026-07-26 20-15.md",
        file: tracked("B"),
      }],
    },
    {
      name: "A / deleted / unchanged A deletes original",
      path: "note.md",
      base: present("A"),
      local: missing(),
      remote: present("A"),
      wantActions: [{ action: "delete", file_path: "note.md" }],
      wantMaterialize: [],
      wantConflicts: [],
      wantMutations: [{ type: "delete", path: "note.md" }],
    },
    {
      name: "A / deleted / changed B keeps remote B and creates deletion marker",
      path: "Notes/Plan.md",
      base: present("A"),
      local: missing(),
      remote: present("B"),
      wantActions: [{
        action: "create",
        file_path: "Notes/Plan — deletion conflict iPhone 2026-07-26 20-15.md",
        content: base64([
          "# Sync conflict: deletion on iPhone",
          "",
          "The file `Notes/Plan.md` was deleted on iPhone, but the GitLab version changed after the last successful sync.",
          "",
          "The GitLab version was kept at the original path. Review it and delete it manually if deletion is still intended.",
          "",
        ].join("\n")),
        encoding: "base64",
      }],
      wantMaterialize: [
        { type: "write", path: "Notes/Plan.md", contentBase64: base64("B") },
        {
          type: "write",
          path: "Notes/Plan — deletion conflict iPhone 2026-07-26 20-15.md",
          contentBase64: base64([
            "# Sync conflict: deletion on iPhone",
            "",
            "The file `Notes/Plan.md` was deleted on iPhone, but the GitLab version changed after the last successful sync.",
            "",
            "The GitLab version was kept at the original path. Review it and delete it manually if deletion is still intended.",
            "",
          ].join("\n")),
        },
      ],
      wantConflicts: ["Notes/Plan — deletion conflict iPhone 2026-07-26 20-15.md"],
      wantMutations: [{
        type: "set",
        path: "Notes/Plan — deletion conflict iPhone 2026-07-26 20-15.md",
        file: tracked([
          "# Sync conflict: deletion on iPhone",
          "",
          "The file `Notes/Plan.md` was deleted on iPhone, but the GitLab version changed after the last successful sync.",
          "",
          "The GitLab version was kept at the original path. Review it and delete it manually if deletion is still intended.",
          "",
        ].join("\n")),
      }],
    },
    {
      name: "A / changed B / deleted keeps original deleted and creates conflict copy B",
      path: "note.md",
      base: present("A"),
      local: present("B"),
      remote: missing(),
      wantActions: [{
        action: "create",
        file_path: "note — conflict iPhone 2026-07-26 20-15.md",
        content: base64("B"),
        encoding: "base64",
      }],
      wantMaterialize: [
        { type: "delete", path: "note.md" },
        { type: "write", path: "note — conflict iPhone 2026-07-26 20-15.md", contentBase64: base64("B") },
      ],
      wantConflicts: ["note — conflict iPhone 2026-07-26 20-15.md"],
      wantMutations: [{
        type: "set",
        path: "note — conflict iPhone 2026-07-26 20-15.md",
        file: tracked("B"),
      }],
    },
    {
      name: "A / deleted / deleted has no change",
      path: "note.md",
      base: present("A"),
      local: missing(),
      remote: missing(),
      wantActions: [],
      wantMaterialize: [],
      wantConflicts: [],
      wantMutations: [],
    },
    {
      name: "unknown / changed B / different remote preserves remote and creates conflict copy B",
      path: "note.md",
      base: null,
      local: present("B"),
      remote: present("C"),
      wantActions: [{
        action: "create",
        file_path: "note — conflict iPhone 2026-07-26 20-15.md",
        content: base64("B"),
        encoding: "base64",
      }],
      wantMaterialize: [
        { type: "write", path: "note.md", contentBase64: base64("C") },
        { type: "write", path: "note — conflict iPhone 2026-07-26 20-15.md", contentBase64: base64("B") },
      ],
      wantConflicts: ["note — conflict iPhone 2026-07-26 20-15.md"],
      wantMutations: [{
        type: "set",
        path: "note — conflict iPhone 2026-07-26 20-15.md",
        file: tracked("B"),
      }],
    },
  ])("$name", async (testCase) => {
    await expect(
      new ConflictResolver().resolve({
        snapshots: [snapshot(testCase.path, testCase.local, testCase.base)],
        remote: { [testCase.path]: testCase.remote },
        trackedFiles: {},
        now,
      }),
    ).resolves.toEqual({
      commitActions: testCase.wantActions,
      materializeOperations: testCase.wantMaterialize,
      conflictPaths: testCase.wantConflicts,
      nextIndexMutations: testCase.wantMutations,
    });
  });

  it("compares bytes instead of decoded text", async () => {
    const invalidUtf8A = new Uint8Array([0xff, 0x00]);
    const invalidUtf8B = new Uint8Array([0xff, 0x01]);

    const plan = await new ConflictResolver().resolve({
      snapshots: [snapshot("asset.bin", { exists: true, bytes: invalidUtf8A }, missing())],
      remote: { "asset.bin": { exists: true, bytes: invalidUtf8B } },
      trackedFiles: {},
      now,
    });

    expect(plan.commitActions).toEqual([{
      action: "create",
      file_path: "asset — conflict iPhone 2026-07-26 20-15.bin",
      content: Buffer.from(invalidUtf8A).toString("base64"),
      encoding: "base64",
    }]);
    expect(plan.materializeOperations[0]).toEqual({
      type: "write",
      path: "asset.bin",
      contentBase64: Buffer.from(invalidUtf8B).toString("base64"),
    });
  });

  it("keeps binary content base64 encoded in actions and materialization", async () => {
    const binary = new Uint8Array([0, 255, 10, 13]);
    const plan = await new ConflictResolver().resolve({
      snapshots: [snapshot("image.jpg", { exists: true, bytes: binary }, missing())],
      remote: { "image.jpg": missing() },
      trackedFiles: {},
      now,
    });

    expect(plan.commitActions).toEqual([{
      action: "create",
      file_path: "image.jpg",
      content: "AP8KDQ==",
      encoding: "base64",
    }]);
    expect(plan.nextIndexMutations).toEqual([{
      type: "set",
      path: "image.jpg",
      file: {
        blobId: blobIdBytes(binary),
        mode: "100644",
        size: 4,
      },
    }]);
  });

  it("appends a numeric suffix when conflict names are occupied", async () => {
    const plan = await new ConflictResolver().resolve({
      snapshots: [snapshot("README", present("mine"), present("base"))],
      remote: { README: present("remote") },
      trackedFiles: {
        "README — conflict iPhone 2026-07-26 20-15": tracked("occupied"),
        "README — conflict iPhone 2026-07-26 20-15-2": tracked("occupied"),
      },
      now,
    });

    expect(plan.conflictPaths).toEqual(["README — conflict iPhone 2026-07-26 20-15-3"]);
  });
});

function present(text: string): VersionState {
  return { exists: true, bytes: bytes(text) };
}

function missing(): VersionState {
  return { exists: false, bytes: null };
}

function tracked(text: string): TrackedFile {
  const value = bytes(text);
  return { blobId: blobId(text), mode: "100644", size: value.byteLength };
}

function snapshot(
  path: string,
  local: VersionState,
  base: VersionState | null,
): LocalSnapshotEntry {
  return { path, operation: local.exists ? "upsert" : "delete", local, base };
}
