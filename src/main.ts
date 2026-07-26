import {
  EventRef,
  Plugin,
  WorkspaceLeaf,
  Notice,
} from "obsidian";
import { DEFAULT_STATE, GitHubSyncSettings, type PluginData } from "./settings/settings";
import GitLabSyncSettingsTab from "./settings/settings-tab";
import { StateStore } from "./sync/state-store";
import SyncManager, { ConflictFile, ConflictResolution } from "./sync-manager";
import Logger from "./logger";
import {
  ConflictsResolutionView,
  CONFLICTS_RESOLUTION_VIEW_TYPE,
} from "./views/conflicts-resolution/view";

export default class GitLabGitlessSyncPlugin extends Plugin {
  settings: GitHubSyncSettings;
  pluginData: PluginData;
  stateStore: StateStore;
  syncManager: SyncManager;
  logger: Logger;

  statusBarItem: HTMLElement | null = null;
  syncRibbonIcon: HTMLElement | null = null;
  conflictsRibbonIcon: HTMLElement | null = null;

  activeLeafChangeListener: EventRef | null = null;
  vaultCreateListener: EventRef | null = null;
  vaultModifyListener: EventRef | null = null;

  // Called in ConflictResolutionView when the user solves all the conflicts.
  // This is initialized every time we open the view to set new conflicts so
  // we can notify the SyncManager that everything has been resolved and the sync
  // process can continue on.
  conflictsResolver: ((resolutions: ConflictResolution[]) => void) | null =
    null;

  // We keep track of the sync conflicts in here too in case the
  // conflicts view must be rebuilt, or the user closes the view
  // and it gets destroyed.
  // By keeping them here we can recreate it easily.
  private conflicts: ConflictFile[] = [];

  async onUserEnable() {
    if (
      this.settings.gitlabBaseUrl === "" ||
      this.settings.projectPath === "" ||
      this.settings.branch === ""
    ) {
      new Notice("Go to settings to configure syncing");
    }
  }

  getConflictsView(): ConflictsResolutionView | null {
    const leaves = this.app.workspace.getLeavesOfType(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
    );
    if (leaves.length === 0) {
      return null;
    }
    return leaves[0].view as ConflictsResolutionView;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(CONFLICTS_RESOLUTION_VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getLeaf(false)!;
      await leaf.setViewState({
        type: CONFLICTS_RESOLUTION_VIEW_TYPE,
        active: true,
      });
    }
    workspace.revealLeaf(leaf);
  }

  async onload() {
    await this.loadSettings();

    this.logger = new Logger(this.app.vault, this.settings.loggingEnabled);
    this.logger.init();

    this.registerView(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
      (leaf) => new ConflictsResolutionView(leaf, this, this.conflicts),
    );

    this.addSettingTab(new GitLabSyncSettingsTab(this.app, this));

    this.syncManager = new SyncManager(
      this.app.vault,
      this.settings,
      this.onConflicts.bind(this),
      this.logger,
    );
    await this.syncManager.loadMetadata();

    this.app.workspace.onLayoutReady(async () => {
      // Create the events handling only after tha layout is ready to avoid
      // getting spammed with create events.
      // See the official Obsidian docs:
      // https://docs.obsidian.md/Reference/TypeScript+API/Vault/on('create')
      this.syncManager.startEventsListener(this);

      // Load the ribbons after layout is ready so they're shown after the core
      // buttons
      if (this.settings.showRibbonIcon) {
        this.showSyncRibbonIcon();
      }

      if (this.settings.syncOnStartup && this.pluginData.state.initialized) {
        await this.sync();
      }
    });

    this.addCommand({
      id: "sync-files",
      name: "Sync with GitLab",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.sync.bind(this),
    });

    this.addCommand({
      id: "merge",
      name: "Open sync conflicts view",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.openConflictsView.bind(this),
    });
  }

  async sync() {
    if (
      this.settings.gitlabBaseUrl === "" ||
      this.settings.projectPath === "" ||
      this.settings.branch === ""
    ) {
      new Notice("Sync plugin not configured");
      return;
    }
    if (this.settings.firstSync) {
      const notice = new Notice("Syncing...");
      try {
        await this.syncManager.firstSync();
        this.settings.firstSync = false;
        this.saveSettings();
        // Shown only if sync doesn't fail
        new Notice("Sync successful", 5000);
      } catch (err) {
        // Show the error to the user, it's not automatically dismissed to make sure
        // the user sees it.
        new Notice(`Error syncing. ${err}`);
      }
      notice.hide();
    } else {
      await this.syncManager.sync();
    }
    this.updateStatusBarItem();
  }

  async onunload() {
    this.stopSyncInterval();
  }

  showStatusBarItem() {
    if (this.statusBarItem) {
      return;
    }
    this.statusBarItem = this.addStatusBarItem();

    if (!this.activeLeafChangeListener) {
      this.activeLeafChangeListener = this.app.workspace.on(
        "active-leaf-change",
        () => this.updateStatusBarItem(),
      );
    }
    if (!this.vaultCreateListener) {
      this.vaultCreateListener = this.app.vault.on("create", () => {
        this.updateStatusBarItem();
      });
    }
    if (!this.vaultModifyListener) {
      this.vaultModifyListener = this.app.vault.on("modify", () => {
        this.updateStatusBarItem();
      });
    }
  }

  hideStatusBarItem() {
    this.statusBarItem?.remove();
    this.statusBarItem = null;
  }

  updateStatusBarItem() {
    if (!this.statusBarItem) {
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      return;
    }

    let state = "Unknown";
    const fileData = this.syncManager.getFileMetadata(activeFile.path);
    if (!fileData) {
      state = "Untracked";
    } else if (fileData.dirty) {
      state = "Outdated";
    } else if (!fileData.dirty) {
      state = "Up to date";
    }

    this.statusBarItem.setText(`GitLab: ${state}`);
  }

  showSyncRibbonIcon() {
    if (this.syncRibbonIcon) {
      return;
    }
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with GitLab",
      this.sync.bind(this),
    );
  }

  hideSyncRibbonIcon() {
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
  }

  showConflictsRibbonIcon() {
    if (this.conflictsRibbonIcon) {
      return;
    }
    this.conflictsRibbonIcon = this.addRibbonIcon(
      "merge",
      "Open sync conflicts view",
      this.openConflictsView.bind(this),
    );
  }

  hideConflictsRibbonIcon() {
    this.conflictsRibbonIcon?.remove();
    this.conflictsRibbonIcon = null;
  }

  async openConflictsView() {
    await this.activateView();
    this.getConflictsView()?.setConflictFiles(this.conflicts);
  }

  async onConflicts(conflicts: ConflictFile[]): Promise<ConflictResolution[]> {
    this.conflicts = conflicts;
    return await new Promise(async (resolve) => {
      this.conflictsResolver = resolve;
      await this.activateView();
      this.getConflictsView()?.setConflictFiles(conflicts);
    });
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

  // Proxy methods from sync manager to ease handling the interval
  // when settings are changed
  startSyncInterval() {
    const intervalID = this.syncManager.startSyncInterval(
      this.settings.syncInterval,
    );
    this.registerInterval(intervalID);
  }

  stopSyncInterval() {
    this.syncManager.stopSyncInterval();
  }

  restartSyncInterval() {
    this.syncManager.stopSyncInterval();
    this.syncManager.startSyncInterval(this.settings.syncInterval);
  }

  async reset() {
    this.pluginData.state = { ...DEFAULT_STATE };
    await this.saveSettings();
    await this.syncManager.resetMetadata();
  }
}
