import { describe, expect, it } from "vitest";
import { IgnoreMatcher } from "../../src/sync/ignore-matcher";

function fakeVault(files: Record<string, string>) {
  const folders = new Set<string>([""]);
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      folders.add(parts.slice(0, i).join("/"));
    }
  }

  return {
    configDir: ".obsidian",
    adapter: {
      exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path),
      read: async (path: string) => files[path],
      list: async (dir: string) => {
        const prefix = dir ? `${dir}/` : "";
        const childFiles: string[] = [];
        const childFolders = new Set<string>();

        for (const path of Object.keys(files)) {
          if (!path.startsWith(prefix)) {
            continue;
          }
          const rest = path.slice(prefix.length);
          const [first, ...remaining] = rest.split("/");
          if (!first) {
            continue;
          }
          if (remaining.length === 0) {
            childFiles.push(path);
          } else {
            childFolders.add(`${prefix}${first}`);
          }
        }

        for (const folder of folders) {
          if (!folder.startsWith(prefix) || folder === dir) {
            continue;
          }
          const rest = folder.slice(prefix.length);
          if (rest && !rest.includes("/")) {
            childFolders.add(folder);
          }
        }

        return {
          files: childFiles.sort(),
          folders: [...childFolders].sort(),
        };
      },
    },
  };
}

describe("IgnoreMatcher", () => {
  it("honors root gitignore rules for untracked files", async () => {
    const matcher = new IgnoreMatcher(fakeVault({
      ".gitignore": [
        "*.tmp",
        ".cache/",
        "!important.tmp",
        "/root-only.md",
        "docs/*.pdf",
        "**/.DS_Store",
      ].join("\n"),
    }));
    await matcher.reload();

    expect(matcher.isIgnored("scratch.tmp", {})).toBe(true);
    expect(matcher.isIgnored(".cache/data.json", {})).toBe(true);
    expect(matcher.isIgnored("important.tmp", {})).toBe(false);
    expect(matcher.isIgnored("root-only.md", {})).toBe(true);
    expect(matcher.isIgnored("nested/root-only.md", {})).toBe(false);
    expect(matcher.isIgnored("docs/file.pdf", {})).toBe(true);
    expect(matcher.isIgnored("docs/deep/file.pdf", {})).toBe(false);
    expect(matcher.isIgnored("a/b/.DS_Store", {})).toBe(true);
  });

  it("does not ignore tracked files even when rules match", async () => {
    const matcher = new IgnoreMatcher(fakeVault({ ".gitignore": "*.tmp" }));
    await matcher.reload();

    expect(
      matcher.isIgnored("tracked.tmp", {
        "tracked.tmp": { blobId: "a", mode: "100644", size: 1 },
      }),
    ).toBe(false);
  });

  it("applies nested gitignore rules only below their directory", async () => {
    const matcher = new IgnoreMatcher(fakeVault({
      ".gitignore": "*.tmp",
      "docs/.gitignore": "*.md\n!keep.md",
      "assets/raw/.gitignore": "*.bin",
    }));
    await matcher.reload();

    expect(matcher.isIgnored("docs/draft.md", {})).toBe(true);
    expect(matcher.isIgnored("docs/keep.md", {})).toBe(false);
    expect(matcher.isIgnored("other/draft.md", {})).toBe(false);
    expect(matcher.isIgnored("assets/raw/source.bin", {})).toBe(true);
    expect(matcher.isIgnored("assets/source.bin", {})).toBe(false);
  });

  it("supports Unicode and emoji paths", async () => {
    const matcher = new IgnoreMatcher(fakeVault({
      ".gitignore": "черновик-*.md\n🧪/",
    }));
    await matcher.reload();

    expect(matcher.isIgnored("черновик-план.md", {})).toBe(true);
    expect(matcher.isIgnored("🧪/result.md", {})).toBe(true);
  });

  it("hard-excludes plugin runtime paths regardless of negation", async () => {
    const matcher = new IgnoreMatcher(fakeVault({
      ".gitignore": "!.obsidian/plugins/gitlab-gitless-sync/main.js",
    }));
    await matcher.reload();

    expect(
      matcher.isIgnored(".obsidian/plugins/gitlab-gitless-sync/main.js", {}),
    ).toBe(true);
  });
});
