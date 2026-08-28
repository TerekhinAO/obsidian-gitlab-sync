import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_STATE } from "../src/settings/settings";
import GitLabSyncSettingsTab, { vaultSetupViewState } from "../src/settings/settings-tab";
import { ConnectConfirmModal } from "../src/views/connect-confirm-modal";
import type { ConnectPreview } from "../src/sync/bootstrap-service";
import { MockElement } from "../mock-obsidian";

describe("settings setup view state", () => {
  it("shows setup choices before the vault is initialized", () => {
    const view = vaultSetupViewState({
      ...DEFAULT_STATE,
      initialized: false,
      lastSyncedCommitSha: null,
    });

    expect(view.title).toBe("Connect to GitLab");
    expect(view.description).toContain("nothing is deleted");
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
    previewConnect: vi.fn(async (): Promise<ConnectPreview | null> => null),
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("shows loading and blocks a second preview while GitLab is being checked", async () => {
    let finishPreview!: (value: ConnectPreview | null) => void;
    const plugin = fakePlugin();
    plugin.previewConnect = vi.fn(() => new Promise((resolve) => {
      finishPreview = resolve;
    }));
    const notices: string[] = [];
    (globalThis as any).__noticeSpy = (message: string) => notices.push(message);
    const container = renderTab(plugin);
    const connectButton = container.buttons.find(
      (button) => button.buttonText === "Connect to GitLab",
    )!;

    const firstClick = connectButton.clickHandler!();
    connectButton.clickHandler!();

    expect(connectButton.disabled).toBe(true);
    expect(connectButton.buttonText).toBe("Checking GitLab…");
    expect(plugin.previewConnect).toHaveBeenCalledTimes(1);
    expect(notices).toContain("Checking GitLab…");

    finishPreview(null);
    await firstClick;
    expect(connectButton.disabled).toBe(false);
    expect(connectButton.buttonText).toBe("Connect to GitLab");
    delete (globalThis as any).__noticeSpy;
  });

  it("opens the confirm modal and connects when preview is non-null", async () => {
    const plugin = fakePlugin();
    plugin.previewConnect = vi.fn(async (): Promise<ConnectPreview | null> => ({
      mode: "merge",
      remoteFileCount: 2,
      localPushCount: 0,
      localPushPaths: [],
      conflictCount: 0,
    }));

    // ConnectConfirmModal.confirm() runs close() + onConfirm(); by having the
    // spied open() call confirm(), the real onConfirm wires through to connect().
    const openSpy = vi
      .spyOn(ConnectConfirmModal.prototype, "open")
      .mockImplementation(function (this: ConnectConfirmModal) {
        (this as unknown as { confirm(): void }).confirm();
      });

    const container = renderTab(plugin);
    const connectButton = container.buttons.find(
      (button) => button.buttonText === "Connect to GitLab",
    );

    expect(connectButton).toBeDefined();
    await connectButton!.clickHandler!();

    expect(plugin.previewConnect).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.instances[0]).toBeInstanceOf(ConnectConfirmModal);
    expect(plugin.connect).toHaveBeenCalledTimes(1);
  });
});
