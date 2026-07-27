import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RemoteChange } from "../../src/sync/remote-diff";
import { SyncPlanner } from "../../src/sync/sync-planner";
import type { LocalSnapshotEntry, VersionState } from "../../src/sync/local-snapshot";
import type { DirtyEntry, TrackedFile } from "../../src/sync/types";

const now = new Date("2026-07-26T20:15:00+03:00");

describe("SyncPlanner", () => {
  it("returns an empty plan when remote and local have no effective changes", async () => {
    const planner = plannerWithRemote({});

    await expect(planner.plan({
      baseSha: "base",
      remoteSha: "remote",
      trackedFiles: { "note.md": tracked("A") },
      dirtyEntries: [dirty("note.md", "upsert")],
      remoteChanges: [],
      localSnapshots: [snapshot("note.md", present("A"), present("A"))],
      now,
    })).resolves.toEqual({
      basedOnRemoteSha: "remote",
      actions: [],
      materializeAfterCommit: [],
      materializeWithoutCommit: [],
      nextTrackedFiles: { "note.md": tracked("A") },
      acknowledgedDirtyPaths: ["note.md"],
      conflictPaths: [],
    });
  });

  it("materializes remote-only create, update, delete, and rename without GitLab commit actions", async () => {
    const planner = plannerWithRemote({
      "created.md": present("created"),
      "updated.md": present("updated"),
      "renamed.md": present("renamed"),
    });

    const plan = await planner.plan({
      baseSha: "base",
      remoteSha: "remote",
      trackedFiles: {
        "updated.md": tracked("old"),
        "deleted.md": tracked("delete me"),
        "old-name.md": tracked("renamed"),
      },
      dirtyEntries: [],
      remoteChanges: [
        { type: "create", path: "created.md" },
        { type: "update", path: "updated.md" },
        { type: "delete", path: "deleted.md" },
        { type: "rename", oldPath: "old-name.md", newPath: "renamed.md" },
      ],
      localSnapshots: [],
      now,
    });

    expect(plan.actions).toEqual([]);
    expect(plan.materializeWithoutCommit).toEqual([
      { type: "write", path: "created.md", contentBase64: base64("created") },
      { type: "write", path: "updated.md", contentBase64: base64("updated") },
      { type: "delete", path: "deleted.md" },
      { type: "delete", path: "old-name.md" },
      { type: "write", path: "renamed.md", contentBase64: base64("renamed") },
    ]);
    expect(plan.nextTrackedFiles).toEqual({
      "created.md": tracked("created"),
      "updated.md": tracked("updated"),
      "renamed.md": tracked("renamed"),
    });
    expect(plan.acknowledgedDirtyPaths).toEqual([]);
  });

  it("turns local-only creates, updates, and deletes into GitLab batch actions with optimistic locks", async () => {
    const planner = plannerWithRemote({
      "updated.md": present("old"),
      "deleted.md": present("delete me"),
    }, {
      "updated.md": "remote-update-last-commit",
      "deleted.md": "remote-delete-last-commit",
    });

    const plan = await planner.plan({
      baseSha: "base",
      remoteSha: "remote",
      trackedFiles: {
        "updated.md": tracked("old"),
        "deleted.md": tracked("delete me"),
      },
      dirtyEntries: [
        dirty("created.md", "upsert"),
        dirty("updated.md", "upsert"),
        dirty("deleted.md", "delete"),
      ],
      remoteChanges: [],
      localSnapshots: [
        snapshot("created.md", present("created"), missing()),
        snapshot("updated.md", present("updated"), present("old")),
        snapshot("deleted.md", missing(), present("delete me")),
      ],
      now,
    });

    expect(plan.actions).toEqual([
      { action: "create", file_path: "created.md", content: base64("created"), encoding: "base64" },
      {
        action: "update",
        file_path: "updated.md",
        content: base64("updated"),
        encoding: "base64",
        last_commit_id: "remote-update-last-commit",
      },
      { action: "delete", file_path: "deleted.md", last_commit_id: "remote-delete-last-commit" },
    ]);
    expect(plan.materializeAfterCommit).toEqual([]);
    expect(plan.materializeWithoutCommit).toEqual([]);
    expect(plan.nextTrackedFiles).toEqual({
      "created.md": tracked("created"),
      "updated.md": tracked("updated"),
    });
    expect(plan.acknowledgedDirtyPaths).toEqual(["created.md", "updated.md", "deleted.md"]);
  });

  it("drops stale delete actions and rewrites updates for files missing from the remote head", async () => {
    const planner = plannerWithRemote({
      "present.md": present("remote"),
      // "gone.md" and "phantom.md" are absent from the remote head.
    });

    const plan = await planner.plan({
      baseSha: "base",
      remoteSha: "remote",
      trackedFiles: {
        "gone.md": tracked("stale"),
        "present.md": tracked("old"),
        "phantom.md": tracked("stale2"),
      },
      dirtyEntries: [
        dirty("gone.md", "delete"),
        dirty("present.md", "delete"),
        dirty("phantom.md", "upsert"),
      ],
      remoteChanges: [],
      localSnapshots: [
        snapshot("gone.md", missing(), present("stale")),
        snapshot("present.md", missing(), present("old")),
        snapshot("phantom.md", present("new"), present("stale2")),
      ],
      now,
    });

    expect(plan.actions).toEqual([
      { action: "delete", file_path: "present.md" },
      { action: "create", file_path: "phantom.md", content: base64("new"), encoding: "base64" },
    ]);
  });

  it("creates conflict files in GitLab and materializes remote content only after the commit succeeds", async () => {
    const planner = plannerWithRemote({
      "note.md": present("remote"),
      "deleted-remotely.md": missing(),
      "remote-edited.md": present("remote edit"),
    });

    const plan = await planner.plan({
      baseSha: "base",
      remoteSha: "remote",
      trackedFiles: {
        "note.md": tracked("base"),
        "deleted-remotely.md": tracked("base"),
        "remote-edited.md": tracked("base"),
      },
      dirtyEntries: [
        dirty("note.md", "upsert"),
        dirty("deleted-remotely.md", "upsert"),
        dirty("remote-edited.md", "delete"),
      ],
      remoteChanges: [
        { type: "update", path: "note.md" },
        { type: "delete", path: "deleted-remotely.md" },
        { type: "update", path: "remote-edited.md" },
      ],
      localSnapshots: [
        snapshot("note.md", present("local"), present("base")),
        snapshot("deleted-remotely.md", present("local delete conflict"), present("base")),
        snapshot("remote-edited.md", missing(), present("base")),
      ],
      now,
    });

    const noteReport = report("note.md", "GitLab", "iPhone", "local", "remote");
    const deletedRemoteReport = report(
      "deleted-remotely.md",
      "GitLab",
      "iPhone",
      "local delete conflict",
      "[deleted]",
    );

    expect(plan.actions).toEqual([
      {
        action: "create",
        file_path: "note — conflict iPhone 2026-07-26 20-15.md",
        content: base64(noteReport),
        encoding: "base64",
      },
      {
        action: "create",
        file_path: "deleted-remotely — conflict iPhone 2026-07-26 20-15.md",
        content: base64(deletedRemoteReport),
        encoding: "base64",
      },
      {
        action: "create",
        file_path: "remote-edited — deletion conflict iPhone 2026-07-26 20-15.md",
        content: base64([
          "# Sync conflict: deletion on iPhone",
          "",
          "The file `remote-edited.md` was deleted on iPhone, but the GitLab version changed after the last successful sync.",
          "",
          "The GitLab version was kept at the original path. Review it and delete it manually if deletion is still intended.",
          "",
        ].join("\n")),
        encoding: "base64",
      },
    ]);
    expect(plan.materializeWithoutCommit).toEqual([]);
    expect(plan.materializeAfterCommit).toEqual([
      { type: "write", path: "note.md", contentBase64: base64("remote") },
      {
        type: "write",
        path: "note — conflict iPhone 2026-07-26 20-15.md",
        contentBase64: base64(noteReport),
      },
      { type: "delete", path: "deleted-remotely.md" },
      {
        type: "write",
        path: "deleted-remotely — conflict iPhone 2026-07-26 20-15.md",
        contentBase64: base64(deletedRemoteReport),
      },
      { type: "write", path: "remote-edited.md", contentBase64: base64("remote edit") },
      {
        type: "write",
        path: "remote-edited — deletion conflict iPhone 2026-07-26 20-15.md",
        contentBase64: base64([
          "# Sync conflict: deletion on iPhone",
          "",
          "The file `remote-edited.md` was deleted on iPhone, but the GitLab version changed after the last successful sync.",
          "",
          "The GitLab version was kept at the original path. Review it and delete it manually if deletion is still intended.",
          "",
        ].join("\n")),
      },
    ]);
    expect(plan.conflictPaths).toEqual([
      "note — conflict iPhone 2026-07-26 20-15.md",
      "deleted-remotely — conflict iPhone 2026-07-26 20-15.md",
      "remote-edited — deletion conflict iPhone 2026-07-26 20-15.md",
    ]);
    expect(plan.nextTrackedFiles).toEqual({
      "note.md": tracked("remote"),
      "remote-edited.md": tracked("remote edit"),
      "note — conflict iPhone 2026-07-26 20-15.md": tracked(noteReport),
      "deleted-remotely — conflict iPhone 2026-07-26 20-15.md": tracked(deletedRemoteReport),
      "remote-edited — deletion conflict iPhone 2026-07-26 20-15.md": tracked([
        "# Sync conflict: deletion on iPhone",
        "",
        "The file `remote-edited.md` was deleted on iPhone, but the GitLab version changed after the last successful sync.",
        "",
        "The GitLab version was kept at the original path. Review it and delete it manually if deletion is still intended.",
        "",
      ].join("\n")),
    });
    expect(plan.acknowledgedDirtyPaths).toEqual([
      "note.md",
      "deleted-remotely.md",
      "remote-edited.md",
    ]);
  });
});

function plannerWithRemote(
  remote: Record<string, VersionState>,
  lastCommitIds: Record<string, string> = {},
): SyncPlanner {
  return new SyncPlanner({
    getRemoteVersion: async (path: string) => remote[path] ?? missing(),
    getLastCommitId: async (path: string) => lastCommitIds[path] ?? null,
  });
}

function dirty(path: string, operation: DirtyEntry["operation"]): DirtyEntry {
  return { path, operation, recordedAt: now.getTime() };
}

function snapshot(
  path: string,
  local: VersionState,
  base: VersionState | null,
): LocalSnapshotEntry {
  return { path, operation: local.exists ? "upsert" : "delete", local, base };
}

function present(text: string): VersionState {
  return { exists: true, bytes: bytes(text) };
}

function missing(): VersionState {
  return { exists: false, bytes: null };
}

function tracked(text: string): TrackedFile {
  const value = bytes(text);
  return { blobId: blobId(value), mode: "100644", size: value.byteLength };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64(text: string): string {
  return Buffer.from(text).toString("base64");
}

function report(
  path: string,
  keptAtOriginalPath: string,
  conflictCopyContains: string,
  localText: string,
  remoteText: string,
): string {
  return [
    "# Sync conflict",
    "",
    `Original path: \`${path}\``,
    `Kept at original path: ${keptAtOriginalPath}`,
    `Conflict copy contains: ${conflictCopyContains}`,
    "",
    "## Diff",
    "",
    "```diff",
    `- GitLab: ${remoteText}`,
    `+ iPhone: ${localText}`,
    "```",
    "",
    "## iPhone version",
    "",
    "```markdown",
    localText,
    "```",
    "",
    "## GitLab version",
    "",
    "```markdown",
    remoteText,
    "```",
    "",
  ].join("\n");
}

function blobId(value: Uint8Array): string {
  return createHash("sha1")
    .update(Buffer.from(`blob ${value.byteLength}\0`))
    .update(value)
    .digest("hex");
}
