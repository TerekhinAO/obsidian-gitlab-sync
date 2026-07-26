import { Notice, Plugin } from "obsidian";
import { DEFAULT_STATE, type GitLabSyncSettings, type PluginData } from "./settings/settings";
import GitLabSyncSettingsTab from "./settings/settings-tab";
import Logger from "./logger";
import { StateStore } from "./sync/state-store";
import SyncManager, {
  type ConflictResolution,
  type SyncResult,
} from "./sync/sync-manager";

export default class GitLabGitlessSyncPlugin extends Plugin {
  settings: GitLabSyncSettings;
  pluginData: PluginData;
  stateStore: StateStore;
  syncManager: SyncManager;
  logger: Logger;

  syncRibbonIcon: HTMLElement | null = null;
  conflictsResolver: ((resolutions: ConflictResolution[]) => void) | null = null;

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

      if (this.settings.syncOnStartup && this.pluginData.state.initialized) {
        await this.sync("startup");
      } else {
        await this.syncManager.recoverIfNeeded();
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
      callback: () => void this.sync("audit"),
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
}
