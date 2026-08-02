import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_STATE } from "../src/settings/settings";
import GitLabSyncSettingsTab, { vaultSetupViewState } from "../src/settings/settings-tab";
import { MockElement } from "../mock-obsidian";

describe("settings setup view state", () => {
  it("shows setup choices before the vault is initialized", () => {
    const view = vaultSetupViewState({
      ...DEFAULT_STATE,
      initialized: false,
      lastSyncedCommitSha: null,
    });

    expect(view.title).toBe("Choose vault setup");
    expect(view.showSetupActions).toBe(true);
    expect(view.showResetAction).toBe(false);
  });

  it("hides setup choices after the vault is connected", () => {
    const view = vaultSetupViewState({
      ...DEFAULT_STATE,
      initialized: true,
      lastSyncedCommitSha: "abcdef123456",
      dirtyEntries: {
        "note.md": {
          path: "note.md",
          operation: "upsert",
          recordedAt: 1,
        },
      },
    });

    expect(view.title).toBe("Vault connected");
    expect(view.description).toContain("abcdef12");
    expect(view.description).toContain("Local pending changes: 1");
    expect(view.showSetupActions).toBe(false);
    expect(view.showResetAction).toBe(true);
  });
});

function fakePlugin() {
  return {
    app: { key: "app" },
    settings: { ...DEFAULT_SETTINGS, projectPath: "group/project", branch: "main" },
    pluginData: {
      settings: { ...DEFAULT_SETTINGS, projectPath: "group/project", branch: "main" },
      state: { ...DEFAULT_STATE, initialized: false, lastSyncedCommitSha: null },
    },
    previewConnect: vi.fn(async () => null),
    connect: vi.fn(async () => undefined),
    saveSettings: vi.fn(async () => undefined),
  };
}

function renderTab(plugin: ReturnType<typeof fakePlugin>) {
  const tab = new GitLabSyncSettingsTab(plugin.app as any, plugin as any);
  const container = new MockElement("div");
  (tab as any).containerEl = container;
  tab.display();
  return container;
}

describe("settings tab render", () => {
  it("renders a single Connect to GitLab button when setup is available", () => {
    const container = renderTab(fakePlugin());
    const labels = container.buttons.map((button) => button.buttonText);

    expect(labels).toContain("Connect to GitLab");
    expect(labels).not.toContain("Initialize empty");
    expect(labels).not.toContain("Adopt existing");
  });

  it("clicking Connect to GitLab previews the connection", async () => {
    const plugin = fakePlugin();
    const container = renderTab(plugin);
    const connectButton = container.buttons.find(
      (button) => button.buttonText === "Connect to GitLab",
    );

    expect(connectButton).toBeDefined();
    await connectButton!.clickHandler!();

    expect(plugin.previewConnect).toHaveBeenCalledTimes(1);
  });
});
