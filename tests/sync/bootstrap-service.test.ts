import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it, vi } from "vitest";
import { BootstrapService } from "../../src/sync/bootstrap-service";
import { StateStore } from "../../src/sync/state-store";
import type { GitLabBranch, GitLabTreeItem } from "../../src/gitlab/types";
import type { PluginData } from "../../src/sync/types";

vi.mock("obsidian", () => ({
  normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, ""),
}));

function bytes(value: string | number[]): Uint8Array {
  return typeof value === "string"
    ? new TextEncoder().encode(value)
    : Uint8Array.from(value);
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

async function zip(
  entries: Array<{ path: string; content?: string | number[]; externalFileAttributes?: number }>,
): Promise<ArrayBuffer> {
  const writer = new ZipWriter(new BlobWriter("application/zip"));
  for (const entry of entries) {
    if (entry.content === undefined) {
      await writer.add(entry.path, undefined, {
        directory: true,
        externalFileAttributes: entry.externalFileAttributes,
      });
    } else if (typeof entry.content === "string") {
      await writer.add(entry.path, new TextReader(entry.content), {
        externalFileAttributes: entry.externalFileAttributes,
      });
    } else {
      await writer.add(entry.path, new Uint8ArrayReader(bytes(entry.content)), {
        externalFileAttributes: entry.externalFileAttributes,
      });
    }
  }
  const blob = await writer.close();
  return await blob.arrayBuffer();
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

function fakeVault(initialFiles: Record<string, Uint8Array> = {}) {
  const files = new Map(Object.entries(initialFiles));
  const folders = new Set<string>(["", ".obsidian"]);
  const calls: Array<[string, string]> = [];

  for (const path of files.keys()) {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current === "" ? part : `${current}/${part}`;
      folders.add(current);
    }
  }

  const adapter = {
    list: vi.fn(async (path: string) => {
      const prefix = path === "" ? "" : `${path}/`;
      const localFiles = new Set<string>();
      const localFolders = new Set<string>();

      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) {
          continue;
        }
        const rest = file.slice(prefix.length);
        const firstSlash = rest.indexOf("/");
        if (firstSlash === -1) {
          localFiles.add(file);
        } else {
          localFolders.add(`${prefix}${rest.slice(0, firstSlash)}`);
        }
      }

      for (const folder of folders) {
        if (folder === path || !folder.startsWith(prefix)) {
          continue;
        }
        const rest = folder.slice(prefix.length);
        if (rest !== "" && !rest.includes("/")) {
          localFolders.add(folder);
        }
      }

      return { files: [...localFiles], folders: [...localFolders] };
    }),
    exists: vi.fn(async (path: string) => files.has(path) || folders.has(path)),
    mkdir: vi.fn(async (path: string) => {
      calls.push(["mkdir", path]);
      folders.add(path);
    }),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      calls.push(["writeBinary", path]);
      const parts = path.split("/");
      parts.pop();
      let current = "";
      for (const part of parts) {
        current = current === "" ? part : `${current}/${part}`;
        folders.add(current);
      }
      files.set(path, new Uint8Array(data.slice(0)));
    }),
  };

  return {
    vault: { configDir: ".obsidian", adapter },
    read(path: string) {
      return files.get(path);
    },
    calls,
  };
}

function fakeClient(options: {
  branch?: GitLabBranch;
  tree?: GitLabTreeItem[];
  archive?: ArrayBuffer;
}) {
  const branch =
    options.branch ??
    ({ name: "main", can_push: true, commit: { id: "commit-sha", parent_ids: ["base"] } } satisfies GitLabBranch);

  return {
    getBranch: vi.fn(async () => branch),
    getTree: vi.fn(async () => options.tree ?? []),
    downloadArchive: vi.fn(async () => {
      if (options.archive === undefined) {
        throw new Error("archive not configured");
      }
      return options.archive;
    }),
  };
}

function fakeJournal() {
  return {
    suppress: vi.fn(<T>(operation: () => Promise<T>) => operation()),
  };
}

async function fixture(options: {
  localFiles?: Record<string, Uint8Array>;
  branch?: GitLabBranch;
  tree?: GitLabTreeItem[];
  archive?: ArrayBuffer;
  journal?: ReturnType<typeof fakeJournal>;
}) {
  const vault = fakeVault(options.localFiles);
  const store = fakeStore();
  const client = fakeClient(options);
  const journal = options.journal ?? fakeJournal();
  const service = new BootstrapService({
    vault: vault.vault as any,
    client,
    stateStore: store.store,
    journal: journal as any,
    now: () => 1234,
  });

  return { ...vault, ...store, client, journal, service };
}

describe("BootstrapService", () => {
  it("rejects non-empty vaults before downloading or writing", async () => {
    const setup = await fixture({
      localFiles: {
        ".obsidian/plugins/gitlab-gitless-sync/main.js": bytes("plugin"),
        "notes/local.md": bytes("local"),
      },
    });

    await expect(setup.service.initialize()).rejects.toThrow(
      "The local vault must be empty before importing from GitLab",
    );

    expect(setup.client.downloadArchive).not.toHaveBeenCalled();
    expect(setup.vault.adapter.writeBinary).not.toHaveBeenCalled();
    expect(setup.read("notes/local.md")).toEqual(bytes("local"));
  });

  it("allows only the vault config directory and active plugin directory locally", async () => {
    const archive = await zip([{ path: "project-main/note.md", content: "remote" }]);
    const setup = await fixture({
      localFiles: {
        ".obsidian/app.json": bytes("{}"),
        ".obsidian/plugins/gitlab-gitless-sync/main.js": bytes("plugin"),
      },
      tree: [{ id: "blob-note", name: "note.md", type: "blob", path: "note.md", mode: "100644" }],
      archive,
    });

    await setup.service.initialize();

    expect(setup.read("note.md")).toEqual(bytes("remote"));
  });

  it("rejects unrelated plugin folders non-destructively", async () => {
    const setup = await fixture({
      localFiles: {
        ".obsidian/plugins/gitlab-gitless-sync/main.js": bytes("plugin"),
        ".obsidian/plugins/other-plugin/main.js": bytes("other"),
      },
    });

    await expect(setup.service.initialize()).rejects.toThrow(
      "The local vault must be empty before importing from GitLab",
    );
    expect(setup.read(".obsidian/plugins/other-plugin/main.js")).toEqual(bytes("other"));
    expect(setup.vault.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("strips exactly one generated archive root and skips the active plugin directory", async () => {
    const archive = await zip([
      { path: "generated-root/folder/note.md", content: "hello" },
      { path: "generated-root/.obsidian/plugins/gitlab-gitless-sync/main.js", content: "remote plugin" },
    ]);
    const setup = await fixture({
      localFiles: {
        ".obsidian/plugins/gitlab-gitless-sync/main.js": bytes("local plugin"),
      },
      tree: [
        { id: "blob-note", name: "note.md", type: "blob", path: "folder/note.md", mode: "100644" },
        {
          id: "blob-plugin",
          name: "main.js",
          type: "blob",
          path: ".obsidian/plugins/gitlab-gitless-sync/main.js",
          mode: "100644",
        },
      ],
      archive,
    });

    const result = await setup.service.initialize();

    expect(setup.read("folder/note.md")).toEqual(bytes("hello"));
    expect(setup.read(".obsidian/plugins/gitlab-gitless-sync/main.js")).toEqual(bytes("local plugin"));
    expect(setup.read("generated-root/folder/note.md")).toBeUndefined();
    expect(result.trackedFiles).toEqual({
      "folder/note.md": { blobId: "blob-note", mode: "100644", size: 0 },
    });
  });

  it.each([
    "root/../escape.md",
    "/absolute.md",
    "root/folder/..\\escape.md",
  ])("rejects unsafe archive entry %s without persisting state", async (path) => {
    const setup = await fixture({
      tree: [],
      archive: await zip([{ path, content: "bad" }]),
    });

    await expect(setup.service.initialize()).rejects.toThrow("Unsafe GitLab archive entry");

    expect(setup.vault.adapter.writeBinary).not.toHaveBeenCalled();
    const data = await setup.store.load();
    expect(data.state.initialized).toBe(false);
  });

  it("rejects symlink entries when detectable", async () => {
    const setup = await fixture({
      tree: [],
      archive: await zip([
        {
          path: "root/link.md",
          content: "target",
          externalFileAttributes: 0o120000 << 16,
        },
      ]),
    });

    await expect(setup.service.initialize()).rejects.toThrow("Unsafe GitLab archive entry");
  });

  it("preserves binary bytes and Unicode paths during extraction", async () => {
    const archive = await zip([
      { path: "project/Привет/emoji-🙂.md", content: "Здравствуйте" },
      { path: "project/images/pixel.png", content: [0, 255, 137, 80, 78, 71] },
    ]);
    const setup = await fixture({
      tree: [
        { id: "unicode", name: "emoji-🙂.md", type: "blob", path: "Привет/emoji-🙂.md", mode: "100644" },
        { id: "png", name: "pixel.png", type: "blob", path: "images/pixel.png", mode: "100644" },
      ],
      archive,
    });

    await setup.service.initialize();

    expect(setup.read("Привет/emoji-🙂.md")).toEqual(bytes("Здравствуйте"));
    expect(setup.read("images/pixel.png")).toEqual(bytes([0, 255, 137, 80, 78, 71]));
  });

  it("builds the tracked index from GitLab blobs and finalizes clean state after extraction", async () => {
    const archive = await zip([{ path: "root/note.md", content: "remote" }]);
    const journal = fakeJournal();
    const setup = await fixture({
      archive,
      journal,
      tree: [
        { id: "tree", name: "docs", type: "tree", path: "docs", mode: "040000" },
        { id: "ignore", name: ".gitignore", type: "blob", path: ".gitignore", mode: "100644" },
        { id: "note", name: "note.md", type: "blob", path: "note.md", mode: "100644" },
      ],
    });

    const result = await setup.service.initialize();

    expect(setup.client.getTree).toHaveBeenCalledWith("commit-sha");
    expect(journal.suppress).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      commitSha: "commit-sha",
      trackedFiles: {
        ".gitignore": { blobId: "ignore", mode: "100644", size: 0 },
        "note.md": { blobId: "note", mode: "100644", size: 0 },
      },
    });
    const data = await setup.store.load();
    expect(data.state).toMatchObject({
      initialized: true,
      lastSyncedCommitSha: "commit-sha",
      trackedFiles: result.trackedFiles,
      dirtyEntries: {},
      pendingTransaction: null,
      lastSyncAt: 1234,
      lastSyncResult: "success",
    });
  });

  it("throws a clear error for empty remote branches", async () => {
    const setup = await fixture({
      branch: { name: "main", can_push: true, commit: { id: "", parent_ids: [] } },
    });

    await expect(setup.service.initialize()).rejects.toThrow(
      "The GitLab branch has no commit to import. Create an initial commit in GitLab, then try again.",
    );

    expect(setup.client.getTree).not.toHaveBeenCalled();
    expect(setup.client.downloadArchive).not.toHaveBeenCalled();
  });
});
