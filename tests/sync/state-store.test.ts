import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/sync/state-store";

function fakePlugin(initialData: unknown = null) {
  let savedData: unknown = initialData;
  return {
    plugin: {
      loadData: async () => savedData,
      saveData: async (data: unknown) => {
        savedData = data;
      },
    },
    get savedData() {
      return savedData;
    },
  };
}

describe("StateStore", () => {
  it("loads exact GitLab settings and local state defaults", async () => {
    const { plugin } = fakePlugin();
    const data = await new StateStore(plugin).load();

    expect(data.settings.gitlabBaseUrl).toBe("https://gitlab.com");
    expect(data.settings.projectPath).toBe("");
    expect(data.settings.branch).toBe("main");
    expect(data.settings.tokenSecretName).toBe("gitlab-gitless-sync-token");
    expect(data.settings.syncOnStartup).toBe(true);
    expect(data.settings.syncOnForeground).toBe(true);
    expect(data.settings.syncOnBackground).toBe(false);
    expect(data.settings.loggingLevel).toBe("off");
    expect(data.settings.conflictStrategy).toBe("auto-remote");
    expect(data.state.initialized).toBe(false);
    expect(data.state.lastSyncedCommitSha).toBeNull();
    expect(data.state.trackedFiles).toEqual({});
    expect(data.state.dirtyEntries).toEqual({});
    expect(data.state.pendingTransaction).toBeNull();
  });

  it("normalizes HTTPS GitLab base URLs", async () => {
    const { plugin } = fakePlugin({
      settings: { gitlabBaseUrl: "https://gitlab.example.com///" },
    });

    const data = await new StateStore(plugin).load();

    expect(data.settings.gitlabBaseUrl).toBe("https://gitlab.example.com");
  });

  it("migrates old enabled logging to debug level", async () => {
    const { plugin } = fakePlugin({
      settings: { loggingEnabled: true },
    });

    const data = await new StateStore(plugin).load();

    expect(data.settings.loggingLevel).toBe("debug");
  });

  it("rejects non-HTTPS GitLab base URLs", async () => {
    const { plugin } = fakePlugin({
      settings: { gitlabBaseUrl: "http://gitlab.example.com" },
    });

    await expect(new StateStore(plugin).load()).rejects.toThrow(
      "GitLab base URL must use HTTPS",
    );
  });

  it("serializes concurrent updates through one write chain", async () => {
    const { plugin } = fakePlugin();
    const store = new StateStore(plugin);

    await Promise.all([
      store.update((data) => {
        data.state.dirtyEntries["a.md"] = {
          path: "a.md",
          operation: "upsert",
          recordedAt: 1,
        };
      }),
      store.update((data) => {
        data.state.dirtyEntries["b.md"] = {
          path: "b.md",
          operation: "delete",
          recordedAt: 2,
        };
      }),
    ]);

    const data = await store.load();
    expect(Object.keys(data.state.dirtyEntries).sort()).toEqual(["a.md", "b.md"]);
  });

  it("waits for a pending update before loading state", async () => {
    const { plugin } = fakePlugin();
    const store = new StateStore(plugin);
    let releaseUpdate!: () => void;
    const update = store.update((data) => {
      data.state.dirtyEntries["note.md"] = {
        path: "note.md",
        operation: "upsert",
        recordedAt: 1,
      };
      return new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
    });
    const loaded = store.load();

    await vi.waitFor(() => expect(releaseUpdate).toBeTypeOf("function"));
    releaseUpdate();
    await Promise.all([update, loaded]);

    expect((await loaded).state.dirtyEntries["note.md"]).toEqual({
      path: "note.md",
      operation: "upsert",
      recordedAt: 1,
    });
  });

  it("keeps updates working after a save fails once", async () => {
    let saves = 0;
    const { plugin } = fakePlugin();
    const originalSaveData = plugin.saveData;
    plugin.saveData = async (data: unknown) => {
      saves += 1;
      if (saves === 1) {
        throw new Error("disk temporarily unavailable");
      }
      await originalSaveData(data);
    };
    const store = new StateStore(plugin);

    await expect(store.update((data) => {
      data.state.lastSyncAt = 1;
    })).rejects.toThrow("disk temporarily unavailable");
    await expect(store.update((data) => {
      data.state.lastSyncAt = 2;
    })).resolves.toBeDefined();

    expect((await store.load()).state.lastSyncAt).toBe(2);
  });

  it("migrates schema-1 state to schema 3 without losing tracked files, dirty entries, or transactions", async () => {
    const pendingTransaction = {
      transactionId: "tx-1",
      committedSha: "commit-a",
      materializeOperations: [{ type: "write", path: "a.md", contentBase64: "YQ==" }],
      nextTrackedFiles: { "a.md": { blobId: "blob-a", mode: "100644", size: 1 } },
      acknowledgedDirtyPaths: ["a.md"],
      conflictPaths: [],
      createdAt: 1,
    };
    const { plugin } = fakePlugin({
      settings: { gitlabBaseUrl: "https://gitlab.example.com" },
      state: {
        schemaVersion: 1,
        initialized: true,
        lastSyncedCommitSha: "commit-a",
        trackedFiles: { "a.md": { blobId: "blob-a", mode: "100644", size: 1 } },
        dirtyEntries: {
          "b.md": { path: "b.md", operation: "upsert", recordedAt: 1 },
        },
        pendingTransaction,
        lastSyncAt: 5,
        lastSyncResult: "success",
      },
    });

    const data = await new StateStore(plugin).load();

    expect(data.state.schemaVersion).toBe(3);
    expect(data.state.remoteBackoffUntil).toBeNull();
    expect(data.state.remoteBackoffReason).toBeNull();
    expect(data.state.trackedFiles).toEqual({
      "a.md": { blobId: "blob-a", mode: "100644", size: 1 },
    });
    expect(data.state.dirtyEntries).toEqual({
      "b.md": { path: "b.md", operation: "upsert", recordedAt: 1 },
    });
    expect(data.state.pendingTransaction).toEqual(pendingTransaction);
    expect(data.state.lastSyncedCommitSha).toBe("commit-a");
  });

  it("round-trips persisted remote backoff", async () => {
    const { plugin } = fakePlugin();
    const store = new StateStore(plugin);
    await store.update((data) => {
      data.state.remoteBackoffUntil = 123_456;
      data.state.remoteBackoffReason = "rate-limit";
    });

    const data = await store.load();
    expect(data.state.schemaVersion).toBe(3);
    expect(data.state.remoteBackoffUntil).toBe(123_456);
    expect(data.state.remoteBackoffReason).toBe("rate-limit");
  });

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

  it("loads schema-3 state without an unconfirmed commit as null", async () => {
    const { plugin } = fakePlugin({
      settings: { gitlabBaseUrl: "https://gitlab.example.com" },
      state: {
        schemaVersion: 3,
        initialized: true,
        lastSyncedCommitSha: "commit-a",
      },
    });

    const data = await new StateStore(plugin).load();

    expect(data.state.schemaVersion).toBe(3);
    expect(data.state.unconfirmedCommit).toBeNull();
  });

  it("round-trips an unconfirmed commit intent", async () => {
    const { plugin } = fakePlugin();
    const store = new StateStore(plugin);
    const unconfirmedCommit = {
      transactionId: "sync-tx-1",
      basedOnRemoteSha: "remote-a",
      target: {
        baseUrl: "https://gitlab.example.com",
        projectPath: "group/project",
        branch: "main",
      },
      createdAt: 123,
    };

    await store.update((data) => {
      data.state.unconfirmedCommit = unconfirmedCommit;
    });

    const data = await store.load();
    expect(data.state.unconfirmedCommit).toEqual(unconfirmedCommit);
  });

  it("rejects invalid settings in update before writing disk", async () => {
    const fixture = fakePlugin();
    const plugin = fixture.plugin;
    const store = new StateStore(plugin);

    await expect(store.update((data) => {
      data.settings.gitlabBaseUrl = "";
    })).rejects.toThrow("GitLab base URL must use HTTPS");

    expect(fixture.savedData).toBeNull();
    const data = await store.load();
    expect(data.settings.gitlabBaseUrl).toBe("https://gitlab.com");
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
});
