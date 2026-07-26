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
      loadData: async () => null,
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
      true,
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
});
