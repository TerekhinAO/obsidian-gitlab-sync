import { Notice, Plugin } from "obsidian";
import { DEFAULT_STATE, type GitLabSyncSettings, type PluginData } from "./settings/settings";
import GitLabSyncSettingsTab from "./settings/settings-tab";
import Logger from "./logger";
import { StateStore } from "./sync/state-store";
import SyncManager, { type SyncResult, type SyncTrigger } from "./sync/sync-manager";
import { SyncStatusModal } from "./views/sync-status-modal";
import { BootstrapService } from "./sync/bootstrap-service";
import { GitLabClient } from "./gitlab/client";

const FOREGROUND_SYNC_COOLDOWN_MS = 30_000;
const BACKGROUND_SYNC_COOLDOWN_MS = 30_000;
const AUTO_SYNC_COOLDOWN_MS = 30_000;
const EDIT_SYNC_COOLDOWN_MS = 10_000;
const INTERVAL_SYNC_COOLDOWN_MS = 10_000;
const DEFAULT_EDIT_DEBOUNCE_SECONDS = 8;
const DEFAULT_INTERVAL_MINUTES = 10;
const MIN_EDIT_DEBOUNCE_SECONDS = 1;
const MIN_INTERVAL_MINUTES = 1;

export default class GitLabGitlessSyncPlugin extends Plugin {
  settings: GitLabSyncSettings;
  pluginData: PluginData;
  stateStore: StateStore;
  syncManager: SyncManager;
  logger: Logger;

  syncRibbonIcon: HTMLElement | null = null;
  private layoutReady = false;
  private lastForegroundSyncAt: number | null = null;
  private lastBackgroundSyncAt: number | null = null;
  private lastAutoSyncAt: number | null = null;
  private lastAutoSyncTrigger: "foreground" | "background" | null = null;
  private lastEditSyncAt: number | null = null;
  private lastIntervalSyncAt: number | null = null;
  private editSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSyncIntervalHandle: ReturnType<typeof setInterval> | null = null;

  async onUserEnable() {
    if (!this.isConfigured()) {
      new Notice("Go to settings to configure syncing");
    }
  }

  async onload() {
    await this.loadSettings();

    this.logger = new Logger(this.app.vault, this.settings.loggingLevel);
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
    this.registerAppLifecycleHandlers();

    this.addSettingTab(new GitLabSyncSettingsTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      this.syncManager.startEventsListener(this);
      this.layoutReady = true;

      if (this.settings.showRibbonIcon) {
        this.showSyncRibbonIcon();
      }

      this.registerEditSyncListeners();
      this.refreshAutoSyncInterval();

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
    if (this.editSyncTimer !== null) {
      clearTimeout(this.editSyncTimer);
      this.editSyncTimer = null;
    }
    if (this.autoSyncIntervalHandle !== null) {
      clearInterval(this.autoSyncIntervalHandle);
      this.autoSyncIntervalHandle = null;
    }
    await this.syncManager?.stopEventsListener();
  }

  async sync(trigger: SyncTrigger = "manual"): Promise<SyncResult | void> {
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
    try {
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
    } catch (error) {
      await this.logger.error("Initialize from GitLab failed", { error: String(error) });
      new Notice(
        `Initialize failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  private registerAppLifecycleHandlers(): void {
    if (typeof document !== "undefined") {
      this.registerDomEvent(document, "visibilitychange", (event) => {
        void this.logAppLifecycleEvent(event);
        void this.syncOnVisibilityChangeIfNeeded();
      });
    }

    if (typeof window !== "undefined") {
      for (const eventName of ["focus", "blur", "pageshow", "pagehide"] as const) {
        this.registerDomEvent(window, eventName, (event) => {
          void this.logAppLifecycleEvent(event);
        });
      }
    }
  }

  private async logAppLifecycleEvent(event: Event): Promise<void> {
    await this.logger.debug("App lifecycle event", {
      event: event.type,
      visibilityState: typeof document === "undefined" ? null : document.visibilityState,
      documentHidden: typeof document === "undefined" ? null : document.hidden,
      hasFocus: typeof document === "undefined" ? null : document.hasFocus(),
      persisted: "persisted" in event ? Boolean((event as PageTransitionEvent).persisted) : null,
    });
  }

  private async syncOnForegroundIfNeeded(): Promise<void> {
    const reason = this.foregroundSyncSkipReason();
    if (reason) {
      await this.logger.debug("Foreground sync skipped", { reason });
      return;
    }

    this.lastForegroundSyncAt = Date.now();
    this.rememberAutoSync("foreground");
    await this.logger.info("Foreground sync started", {
      cooldownMs: FOREGROUND_SYNC_COOLDOWN_MS,
    });
    await this.logAutoSyncResult("Foreground", await this.sync("foreground"));
  }

  private async syncOnVisibilityChangeIfNeeded(): Promise<void> {
    if (typeof document === "undefined") {
      await this.logger.debug("Visibility sync skipped", { reason: "document-unavailable" });
      return;
    }

    if (document.visibilityState === "hidden" || document.hidden) {
      await this.syncOnBackgroundIfNeeded();
      return;
    }

    await this.syncOnForegroundIfNeeded();
  }

  private async syncOnBackgroundIfNeeded(): Promise<void> {
    const reason = this.backgroundSyncSkipReason();
    if (reason) {
      await this.logger.debug("Background sync skipped", { reason });
      return;
    }

    this.lastBackgroundSyncAt = Date.now();
    this.rememberAutoSync("background");
    await this.logger.info("Background sync started", {
      cooldownMs: BACKGROUND_SYNC_COOLDOWN_MS,
    });
    await this.logAutoSyncResult("Background", await this.sync("background"));
  }

  private foregroundSyncSkipReason(): string | null {
    if (typeof document === "undefined") {
      return "document-unavailable";
    }
    if (document.visibilityState !== "visible" || document.hidden) {
      return "not-visible";
    }
    if (!this.settings.syncOnForeground) {
      return "setting-disabled";
    }
    if (!this.layoutReady) {
      return "layout-not-ready";
    }
    if (!this.pluginData.state.initialized) {
      return "vault-not-initialized";
    }
    if (this.syncManager.isSyncing()) {
      return "sync-already-running";
    }
    if (this.wasRecentAutoSync("background")) {
      return "recent-background-sync";
    }
    if (
      this.lastForegroundSyncAt !== null &&
      Date.now() - this.lastForegroundSyncAt < FOREGROUND_SYNC_COOLDOWN_MS
    ) {
      return "cooldown";
    }
    return null;
  }

  private backgroundSyncSkipReason(): string | null {
    if (typeof document === "undefined") {
      return "document-unavailable";
    }
    if (document.visibilityState !== "hidden" && !document.hidden) {
      return "not-hidden";
    }
    if (!this.settings.syncOnBackground) {
      return "setting-disabled";
    }
    if (!this.layoutReady) {
      return "layout-not-ready";
    }
    if (!this.pluginData.state.initialized) {
      return "vault-not-initialized";
    }
    if (this.syncManager.isSyncing()) {
      return "sync-already-running";
    }
    if (
      this.lastBackgroundSyncAt !== null &&
      Date.now() - this.lastBackgroundSyncAt < BACKGROUND_SYNC_COOLDOWN_MS
    ) {
      return "cooldown";
    }
    return null;
  }

  private rememberAutoSync(trigger: "foreground" | "background"): void {
    this.lastAutoSyncAt = Date.now();
    this.lastAutoSyncTrigger = trigger;
  }

  private wasRecentAutoSync(trigger: "foreground" | "background"): boolean {
    return (
      this.lastAutoSyncTrigger === trigger &&
      this.lastAutoSyncAt !== null &&
      Date.now() - this.lastAutoSyncAt < AUTO_SYNC_COOLDOWN_MS
    );
  }

  private registerEditSyncListeners(): void {
    const vault = this.app.vault as unknown as {
      on?: (name: string, callback: (...args: unknown[]) => void) => unknown;
    };
    if (typeof vault.on !== "function") {
      return;
    }
    for (const name of ["create", "modify", "delete", "rename"] as const) {
      const ref = vault.on(name, () => this.scheduleEditSync());
      this.registerEvent(ref as never);
    }
  }

  private scheduleEditSync(): void {
    if (!this.settings.syncAfterEdit) {
      return;
    }
    // Ignore file events emitted by the plugin's own writes during a sync so
    // materialization does not trigger a follow-up sync loop.
    if (this.syncManager.isSyncing()) {
      return;
    }
    if (this.editSyncTimer !== null) {
      clearTimeout(this.editSyncTimer);
    }
    const seconds = Math.max(
      MIN_EDIT_DEBOUNCE_SECONDS,
      this.settings.syncAfterEditDebounceSeconds || DEFAULT_EDIT_DEBOUNCE_SECONDS,
    );
    this.editSyncTimer = setTimeout(() => {
      this.editSyncTimer = null;
      void this.syncOnEditIfNeeded();
    }, seconds * 1000);
  }

  private async syncOnEditIfNeeded(): Promise<void> {
    const reason =
      this.autoSyncBaseSkipReason() ??
      (!this.settings.syncAfterEdit ? "setting-disabled" : null) ??
      (this.lastEditSyncAt !== null && Date.now() - this.lastEditSyncAt < EDIT_SYNC_COOLDOWN_MS
        ? "cooldown"
        : null);
    if (reason) {
      await this.logger.debug("Edit sync skipped", { reason });
      return;
    }

    this.lastEditSyncAt = Date.now();
    await this.logger.info("Edit sync started", {
      debounceSeconds: this.settings.syncAfterEditDebounceSeconds,
    });
    await this.logAutoSyncResult("Edit", await this.sync("edit"));
  }

  refreshAutoSyncInterval(): void {
    if (this.autoSyncIntervalHandle !== null) {
      clearInterval(this.autoSyncIntervalHandle);
      this.autoSyncIntervalHandle = null;
    }
    if (!this.settings.syncOnInterval) {
      return;
    }
    const minutes = Math.max(
      MIN_INTERVAL_MINUTES,
      this.settings.syncIntervalMinutes || DEFAULT_INTERVAL_MINUTES,
    );
    this.autoSyncIntervalHandle = setInterval(() => {
      void this.syncOnIntervalIfNeeded();
    }, minutes * 60_000);
    this.registerInterval(this.autoSyncIntervalHandle as unknown as number);
  }

  private async syncOnIntervalIfNeeded(): Promise<void> {
    const reason =
      this.autoSyncBaseSkipReason() ??
      (!this.settings.syncOnInterval ? "setting-disabled" : null) ??
      (this.lastIntervalSyncAt !== null &&
      Date.now() - this.lastIntervalSyncAt < INTERVAL_SYNC_COOLDOWN_MS
        ? "cooldown"
        : null);
    if (reason) {
      await this.logger.debug("Interval sync skipped", { reason });
      return;
    }

    this.lastIntervalSyncAt = Date.now();
    await this.logger.info("Interval sync started", {
      intervalMinutes: this.settings.syncIntervalMinutes,
    });
    await this.logAutoSyncResult("Interval", await this.sync("interval"));
  }

  private autoSyncBaseSkipReason(): string | null {
    if (!this.layoutReady) {
      return "layout-not-ready";
    }
    if (!this.pluginData.state.initialized) {
      return "vault-not-initialized";
    }
    if (this.syncManager.isSyncing()) {
      return "sync-already-running";
    }
    return null;
  }

  private async logAutoSyncResult(
    label: "Foreground" | "Background" | "Edit" | "Interval",
    result: SyncResult | void,
  ): Promise<void> {
    if (!result) {
      await this.logger.info(`${label} sync finished`, { status: "skipped" });
      return;
    }
    await this.logger.info(`${label} sync finished`, {
      status: result.status,
      trigger: result.trigger,
      commitSha: result.commitSha ?? null,
      recovered: result.recovered ?? false,
      attempts: result.attempts ?? null,
    });
  }
}
