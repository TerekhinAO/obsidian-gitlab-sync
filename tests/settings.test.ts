import { describe, expect, it } from "vitest";
import Logger from "../src/logger";
import { StateStore } from "../src/sync/state-store";

describe("GitLab settings persistence", () => {
  it("stores only the token secret name in plugin data", async () => {
    let savedData: unknown = null;
    const app = {
      secretStorage: new Map<string, string>(),
    };
    app.secretStorage.set("gitlab-gitless-sync-token", "glpat-test");

    const store = new StateStore({
      loadData: async () => savedData,
      saveData: async (data: unknown) => {
        savedData = data;
      },
    });

    const data = await store.load();
    await store.save(data);

    expect(JSON.stringify(savedData)).not.toContain("glpat-");
    expect((savedData as any).settings.tokenSecretName).toBe(
      "gitlab-gitless-sync-token",
    );

    // An explicit opt-in must survive save() and a subsequent load().
    data.settings.allowSelfSignedCertificateForConnect = true;
    await store.save(data);
    const reloaded = await store.load();
    expect(reloaded.settings.allowSelfSignedCertificateForConnect).toBe(true);
  });

  it("defaults Connect self-signed certificate access to false for old plugin data", async () => {
    const store = new StateStore({
      loadData: async () => ({
        settings: {
          gitlabBaseUrl: "https://gitlab.example.com",
          projectPath: "group/project",
          branch: "main",
          tokenSecretName: "gitlab-token",
          authorName: "Mobile User",
          authorEmail: "mobile@example.com",
          // allowSelfSignedCertificateForConnect intentionally omitted (old data)
        },
        state: {
          schemaVersion: 2,
          initialized: true,
          lastSyncedCommitSha: "sha",
          trackedFiles: {},
          dirtyEntries: {},
          pendingTransaction: null,
          lastSyncAt: 1,
          lastSyncResult: "success",
          remoteBackoffUntil: null,
          remoteBackoffReason: null,
        },
      }),
      saveData: async () => undefined,
    });

    const data = await store.load();

    expect(data.settings.allowSelfSignedCertificateForConnect).toBe(false);
    expect(data.settings.projectPath).toBe("group/project");
    expect(data.state.initialized).toBe(true);
  });

  it("redacts credential-shaped fields from logs", async () => {
    let log = "";
    const logger = new Logger(
      {
        configDir: ".obsidian",
        adapter: {
          exists: async () => true,
          append: async (_path: string, value: string) => {
            log += value;
          },
          read: async () => log,
          write: async (_path: string, value: string) => {
            log = value;
          },
        },
      } as any,
      "debug",
    );

    await logger.info("request failed", {
      headers: { "PRIVATE-TOKEN": "glpat-test" },
      nested: { password: "hidden", token: "hidden" },
      safe: "visible",
    });

    expect(log).not.toContain("glpat-");
    expect(log).not.toContain("hidden");
    expect(log).toContain("[REDACTED]");
    expect(log).toContain("visible");
  });

  it("filters log entries by configured level", async () => {
    let log = "";
    const logger = new Logger(
      {
        configDir: ".obsidian",
        adapter: {
          exists: async () => true,
          append: async (_path: string, value: string) => {
            log += value;
          },
          read: async () => log,
          write: async (_path: string, value: string) => {
            log = value;
          },
        },
      } as any,
      "info",
    );

    await logger.debug("debug noise");
    await logger.info("important info");
    logger.setLevel("error");
    await logger.info("hidden info");
    await logger.error("important error");

    expect(log).not.toContain("debug noise");
    expect(log).toContain("important info");
    expect(log).not.toContain("hidden info");
    expect(log).toContain("important error");
  });
});
