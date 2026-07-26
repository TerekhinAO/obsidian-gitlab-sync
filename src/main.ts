import { Notice, Plugin } from "obsidian";
import { DEFAULT_STATE, type GitLabSyncSettings, type PluginData } from "./settings/settings";
import GitLabSyncSettingsTab from "./settings/settings-tab";
import Logger from "./logger";
import { StateStore } from "./sync/state-store";
import SyncManager, { type SyncResult } from "./sync/sync-manager";
import { SyncStatusModal } from "./views/sync-status-modal";
import { BootstrapService } from "./sync/bootstrap-service";
import { GitLabClient } from "./gitlab/client";

export default class GitLabGitlessSyncPlugin extends Plugin {
  settings: GitLabSyncSettings;
  pluginData: PluginData;
  stateStore: StateStore;
  syncManager: SyncManager;
  logger: Logger;

  syncRibbonIcon: HTMLElement | null = null;

  async onUserEnable() {
    if (!this.isConfigured()) {
      new Notice("Go to settings to configure syncing");
    }
  }

  async onload() {
    await this.loadSettings();

    this.logger = new Logger(this.app.vault, this.settings.loggingEnabled);
    await this.logger.init();

    this.syncManager = new SyncManager({
      app: this.app,
      vault: this.app.vault,
      plugin: this,
      stateStore: this.stateStore,
      settings: this.settings,
      logger: this.logger,
      createProgressNotice: (message) => new Notice(message, 0),
      notice: (message) => new Notice(message, 5000),
    });

    this.addSettingTab(new GitLabSyncSettingsTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      this.syncManager.startEventsListener(this);

      if (this.settings.showRibbonIcon) {
        this.showSyncRibbonIcon();
      }

      const recovered = await this.syncManager.recoverIfNeeded();
      if (!recovered && this.settings.syncOnStartup && this.pluginData.state.initialized) {
        await this.sync("startup");
      }
    });

    this.addCommand({
      id: "sync-files",
      name: "Sync with GitLab",
      repeatable: false,
      icon: "refresh-cw",
      callback: () => void this.sync("manual"),
    });

    this.addCommand({
      id: "full-audit-sync",
      name: "Full audit and sync",
      repeatable: false,
      icon: "scan-search",
      callback: () => {
        const confirmed = typeof window === "undefined" || window.confirm(
          "Full audit scans local files and can be slow on mobile. Continue?",
        );
        if (confirmed) {
          void this.sync("audit");
        }
      },
    });

    this.addCommand({
      id: "show-gitlab-sync-status",
      name: "Show GitLab sync status",
      repeatable: false,
      icon: "info",
      callback: () => {
        new SyncStatusModal(this.app, this.settings, this.pluginData.state).open();
      },
    });
  }

  async onunload() {
    await this.syncManager?.stopEventsListener();
  }

  async sync(trigger: "startup" | "manual" | "audit" = "manual"): Promise<SyncResult | void> {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }

    const result = await this.syncManager.sync(trigger);
    this.pluginData = await this.stateStore.load();
    return result;
  }

  async initializeFromGitLab(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }
    const token = await this.readToken();
    if (!token) {
      new Notice("GitLab token is missing");
      return;
    }
    const service = new BootstrapService({
      vault: this.app.vault,
      client: new GitLabClient(this.settings, token),
      stateStore: this.stateStore,
      journal: {
        suppress: async (operation) => operation(),
      },
    });
    await service.initialize();
    this.pluginData = await this.stateStore.load();
    new Notice("Vault initialized from GitLab");
  }

  async adoptExistingVault(): Promise<void> {
    if (!this.isConfigured()) {
      new Notice("Sync plugin not configured");
      return;
    }
    await this.syncManager.adoptExistingVault();
    this.pluginData = await this.stateStore.load();
  }

  showSyncRibbonIcon() {
    if (this.syncRibbonIcon) {
      return;
    }
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with GitLab",
      () => void this.sync("manual"),
    );
  }

  hideSyncRibbonIcon() {
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
  }

  async loadSettings() {
    this.stateStore = new StateStore(this);
    this.pluginData = await this.stateStore.load();
    this.settings = this.pluginData.settings;
  }

  async saveSettings() {
    this.pluginData.settings = this.settings;
    await this.stateStore.save(this.pluginData);
  }

  async reset() {
    this.pluginData.state = { ...DEFAULT_STATE, trackedFiles: {}, dirtyEntries: {} };
    await this.saveSettings();
  }

  private isConfigured(): boolean {
    return (
      this.settings.gitlabBaseUrl.trim() !== "" &&
      this.settings.projectPath.trim() !== "" &&
      this.settings.branch.trim() !== ""
    );
  }

  private async readToken(): Promise<string | null> {
    const storage = (this.app as any).secretStorage;
    if (!storage?.getSecret) {
      return null;
    }
    const token = await storage.getSecret(this.settings.tokenSecretName);
    return token?.trim() || null;
  }
}
