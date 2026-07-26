import { describe, expect, it } from "vitest";
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
    expect(data.settings.conflictStrategy).toBe("remote");
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
});
