import { describe, expect, it, vi } from "vitest";
import GitLabGitlessSyncPlugin from "../src/main";
import { DEFAULT_SETTINGS, DEFAULT_STATE } from "../src/settings/settings";
import { SyncStatusModal } from "../src/views/sync-status-modal";
import SyncManager from "../src/sync/sync-manager";

function fakePluginData(overrides: any = {}) {
  return {
    settings: { ...DEFAULT_SETTINGS, projectPath: "group/project", ...overrides.settings },
    state: {
      ...DEFAULT_STATE,
      initialized: true,
      lastSyncedCommitSha: "base",
      ...overrides.state,
    },
  };
}

function fakeApp(onLayoutReady: (callback: () => void | Promise<void>) => void) {
  const commands: any[] = [];
  return {
    vault: {
      configDir: ".obsidian",
      adapter: {
        exists: async () => true,
        write: async () => undefined,
        read: async () => "",
        append: async () => undefined,
      },
    },
    workspace: { onLayoutReady },
    commands,
  };
}

class TestPlugin extends GitLabGitlessSyncPlugin {
  private data: any;
  public commands: any[] = [];
  public ribbonCalls: string[] = [];
  public settingTabs: any[] = [];
  public intervals: unknown[] = [];

  constructor(data: any, app: any) {
    super(app, {} as any);
    this.app = app;
    this.data = data;
  }

  async loadData() {
    return this.data;
  }

  async saveData(data: any) {
    this.data = data;
  }

  addSettingTab(tab: any) {
    this.settingTabs.push(tab);
  }

  addCommand(command: any) {
    this.commands.push(command);
    return command;
  }

  addRibbonIcon(_icon: string, title: string, _callback: (evt: MouseEvent) => any) {
    this.ribbonCalls.push(title);
    return { remove: vi.fn() } as any;
  }

  registerInterval(interval: number) {
    this.intervals.push(interval);
    return interval;
  }
}

describe("plugin lifecycle", () => {
  it("runs pending recovery before startup sync", async () => {
    let layoutCallback!: () => Promise<void>;
    const plugin = new TestPlugin(fakePluginData(), fakeApp((callback) => {
      layoutCallback = callback as () => Promise<void>;
    }));
    const order: string[] = [];
    vi.spyOn(SyncManager.prototype, "startEventsListener").mockImplementation(() => undefined);
    vi.spyOn(SyncManager.prototype, "recoverIfNeeded").mockImplementation(async () => {
      order.push("recover");
      return false;
    });
    vi.spyOn(SyncManager.prototype, "sync").mockImplementation(async () => {
      order.push("sync");
      return { status: "success", trigger: "startup", message: "ok" };
    });

    await plugin.onload();
    await layoutCallback();

    expect(order).toEqual(["recover", "sync"]);
  });

  it("does not startup sync an uninitialized vault", async () => {
    let layoutCallback!: () => Promise<void>;
    const plugin = new TestPlugin(
      fakePluginData({ state: { initialized: false, lastSyncedCommitSha: null } }),
      fakeApp((callback) => {
        layoutCallback = callback as () => Promise<void>;
      }),
    );
    const sync = vi.spyOn(SyncManager.prototype, "sync").mockResolvedValue({
      status: "success",
      trigger: "startup",
      message: "ok",
    });
    vi.spyOn(SyncManager.prototype, "recoverIfNeeded").mockResolvedValue(false);

    await plugin.onload();
    await layoutCallback();

    expect(sync).not.toHaveBeenCalled();
  });

  it("registers ribbon, manual sync, full audit, and no fixed interval", async () => {
    let layoutCallback!: () => Promise<void>;
    const plugin = new TestPlugin(fakePluginData(), fakeApp((callback) => {
      layoutCallback = callback as () => Promise<void>;
    }));
    vi.spyOn(SyncManager.prototype, "startEventsListener").mockImplementation(() => undefined);
    vi.spyOn(SyncManager.prototype, "recoverIfNeeded").mockResolvedValue(false);
    vi.spyOn(SyncManager.prototype, "sync").mockResolvedValue({
      status: "success",
      trigger: "startup",
      message: "ok",
    });

    await plugin.onload();
    await layoutCallback();

    expect(plugin.ribbonCalls).toEqual(["Sync with GitLab"]);
    expect(plugin.commands.map((command) => command.name)).toEqual([
      "Sync with GitLab",
      "Full audit and sync",
      "Show GitLab sync status",
    ]);
    expect(plugin.intervals).toEqual([]);
  });

  it("status modal never displays the token secret value", () => {
    const modal = new SyncStatusModal(
      {
        key: "app",
      },
      { ...DEFAULT_SETTINGS, projectPath: "group/project" },
      { ...DEFAULT_STATE, dirtyEntries: { "a.md": { path: "a.md", operation: "upsert", recordedAt: 1 } } },
    );
    (modal as any).titleEl = { setText: vi.fn() };
    (modal as any).contentEl = {
      rows: [],
      empty: vi.fn(),
    };

    modal.onOpen();

    expect(JSON.stringify((modal as any).contentEl.rows)).not.toContain(
      "gitlab-gitless-sync-token",
    );
  });
});
