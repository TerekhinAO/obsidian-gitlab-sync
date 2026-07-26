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
  public domEvents: { target: EventTarget; type: string; callback: EventListenerOrEventListenerObject }[] = [];

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

  registerDomEvent(
    target: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject,
  ) {
    this.domEvents.push({ target, type, callback });
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

  it("logs app lifecycle events for mobile foreground diagnostics", async () => {
    let log = "";
    const documentTarget = new EventTarget() as Document;
    Object.assign(documentTarget, {
      visibilityState: "visible",
      hidden: false,
      hasFocus: () => true,
    });
    const windowTarget = new EventTarget() as Window;
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("window", windowTarget);
    const plugin = new TestPlugin(
      fakePluginData({ settings: { loggingEnabled: true } }),
      fakeApp((callback) => {
        void callback();
      }),
    );
    vi.spyOn(SyncManager.prototype, "startEventsListener").mockImplementation(() => undefined);
    vi.spyOn(SyncManager.prototype, "recoverIfNeeded").mockResolvedValue(false);
    vi.spyOn(SyncManager.prototype, "sync").mockResolvedValue({
      status: "success",
      trigger: "startup",
      message: "ok",
    });
    plugin.app.vault.adapter.append = async (_path: string, value: string) => {
      log += value;
    };

    await plugin.onload();

    expect(plugin.domEvents.map((event) => event.type)).toEqual([
      "visibilitychange",
      "focus",
      "blur",
      "pageshow",
      "pagehide",
    ]);

    const focusEvent = plugin.domEvents.find((event) => event.type === "focus");
    expect(focusEvent).toBeDefined();
    const callback = focusEvent!.callback;
    if (typeof callback === "function") {
      callback(new Event("focus"));
    } else {
      callback.handleEvent(new Event("focus"));
    }

    await vi.waitFor(() => {
      expect(log).toContain('"message":"App lifecycle event"');
      expect(log).toContain('"event":"focus"');
      expect(log).toContain('"visibilityState"');
      expect(log).toContain('"hasFocus"');
    });

    vi.unstubAllGlobals();
  });

  it("syncs once when the mobile app returns to the foreground", async () => {
    const documentTarget = new EventTarget() as Document;
    Object.assign(documentTarget, {
      visibilityState: "hidden",
      hidden: true,
      hasFocus: () => false,
    });
    const windowTarget = new EventTarget() as Window;
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("window", windowTarget);
    let layoutCallback!: () => Promise<void>;
    const plugin = new TestPlugin(fakePluginData(), fakeApp((callback) => {
      layoutCallback = callback as () => Promise<void>;
    }));
    vi.spyOn(SyncManager.prototype, "startEventsListener").mockImplementation(() => undefined);
    vi.spyOn(SyncManager.prototype, "recoverIfNeeded").mockResolvedValue(false);
    const sync = vi.spyOn(SyncManager.prototype, "sync").mockResolvedValue({
      status: "success",
      trigger: "foreground",
      message: "ok",
    });

    await plugin.onload();
    await layoutCallback();
    sync.mockClear();

    Object.assign(documentTarget, {
      visibilityState: "visible",
      hidden: false,
      hasFocus: () => true,
    });
    const visibilityEvent = plugin.domEvents.find((event) => event.type === "visibilitychange");
    expect(visibilityEvent).toBeDefined();
    const callback = visibilityEvent!.callback;
    if (typeof callback === "function") {
      callback(new Event("visibilitychange"));
      callback(new Event("visibilitychange"));
    } else {
      callback.handleEvent(new Event("visibilitychange"));
      callback.handleEvent(new Event("visibilitychange"));
    }

    await vi.waitFor(() => {
      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledWith("foreground");
    });

    vi.unstubAllGlobals();
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
