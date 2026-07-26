import { describe, expect, it, vi } from "vitest";
import { GitLabConflictError, GitLabNotFoundError } from "../../src/gitlab/errors";
import { RemoteDiffService } from "../../src/sync/remote-diff";
import type { GitLabCompareResult, GitLabTreeItem } from "../../src/gitlab/types";

function client(compare: GitLabCompareResult | Error, tree: GitLabTreeItem[] = []) {
  return {
    compare: vi.fn(async () => {
      if (compare instanceof Error) {
        throw compare;
      }
      return compare;
    }),
    getTree: vi.fn(async () => tree),
  };
}

describe("RemoteDiffService", () => {
  it("translates GitLab compare diffs into remote changes", async () => {
    const fake = client({
      diffs: [
        { old_path: "a.md", new_path: "a.md", new_file: true, renamed_file: false, deleted_file: false },
        { old_path: "b.md", new_path: "b.md", new_file: false, renamed_file: false, deleted_file: false },
        { old_path: "c.md", new_path: "c.md", new_file: false, renamed_file: false, deleted_file: true },
        { old_path: "old.md", new_path: "new.md", new_file: false, renamed_file: true, deleted_file: false },
      ],
    });

    await expect(
      new RemoteDiffService(fake).discover({
        baseSha: "a",
        remoteSha: "b",
        baseIndex: {},
      }),
    ).resolves.toEqual({
      changes: [
        { type: "create", path: "a.md" },
        { type: "update", path: "b.md" },
        { type: "delete", path: "c.md" },
        { type: "rename", oldPath: "old.md", newPath: "new.md" },
      ],
      usedFallback: false,
    });
  });

  it("uses full-tree fallback on compare timeout and oversized diffs", async () => {
    for (const compare of [
      { compare_timeout: true, diffs: [] },
      {
        diffs: [
          { old_path: "a", new_path: "a", new_file: false, renamed_file: false, deleted_file: false, collapsed: true },
        ],
      },
      {
        diffs: [
          { old_path: "a", new_path: "a", new_file: false, renamed_file: false, deleted_file: false, too_large: true },
        ],
      },
    ]) {
      const fake = client(compare, [
        { id: "b", name: "note.md", type: "blob", path: "note.md", mode: "100644" },
      ]);

      const result = await new RemoteDiffService(fake).discover({
        baseSha: "a",
        remoteSha: "b",
        baseIndex: { "note.md": { blobId: "a", mode: "100644", size: 1 } },
      });

      expect(result.usedFallback).toBe(true);
      expect(result.changes).toEqual([{ type: "update", path: "note.md" }]);
    }
  });

  it("uses fallback when compare cannot use the base commit or history", async () => {
    for (const error of [new GitLabNotFoundError("missing"), new GitLabConflictError("rewritten")]) {
      const fake = client(error, []);

      const result = await new RemoteDiffService(fake).discover({
        baseSha: "a",
        remoteSha: "b",
        baseIndex: { "deleted.md": { blobId: "a", mode: "100644", size: 1 } },
      });

      expect(result).toEqual({
        changes: [{ type: "delete", path: "deleted.md" }],
        remoteTree: {},
        usedFallback: true,
      });
    }
  });

  it("diffs full tree maps without rename detection", async () => {
    const fake = client({ compare_timeout: true, diffs: [] }, [
      { id: "same", name: "same.md", type: "blob", path: "same.md", mode: "100644" },
      { id: "changed", name: "changed.md", type: "blob", path: "changed.md", mode: "100644" },
      { id: "new", name: "new.md", type: "blob", path: "new.md", mode: "100644" },
      { id: "tree", name: "docs", type: "tree", path: "docs", mode: "040000" },
    ]);

    const result = await new RemoteDiffService(fake).discover({
      baseSha: "a",
      remoteSha: "b",
      baseIndex: {
        "same.md": { blobId: "same", mode: "100644", size: 1 },
        "changed.md": { blobId: "old", mode: "100644", size: 1 },
        "deleted.md": { blobId: "old", mode: "100644", size: 1 },
      },
    });

    expect(result).toEqual({
      changes: [
        { type: "update", path: "changed.md" },
        { type: "delete", path: "deleted.md" },
        { type: "create", path: "new.md" },
      ],
      remoteTree: {
        "changed.md": { blobId: "changed", mode: "100644", size: 0 },
        "new.md": { blobId: "new", mode: "100644", size: 0 },
        "same.md": { blobId: "same", mode: "100644", size: 0 },
      },
      usedFallback: true,
    });
  });

  it("hard-excludes runtime paths from compare and fallback", async () => {
    const fake = client({ compare_timeout: true, diffs: [] }, [
      { id: "x", name: "main.js", type: "blob", path: ".obsidian/plugins/gitlab-gitless-sync/main.js", mode: "100644" },
    ]);

    const result = await new RemoteDiffService(
      fake,
      (path) => path.startsWith(".obsidian/plugins/gitlab-gitless-sync"),
    ).discover({
      baseSha: "a",
      remoteSha: "b",
      baseIndex: {},
    });

    expect(result.changes).toEqual([]);
    expect(result.remoteTree).toEqual({});
  });
});
