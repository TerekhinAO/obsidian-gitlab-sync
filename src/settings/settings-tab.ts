import { App, Modal, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import GitLabGitlessSyncPlugin from "../main";
import type { LocalSyncState } from "../settings/settings";
import { copyToClipboard } from "../utils";
import { ConnectConfirmModal } from "../views/connect-confirm-modal";

function secretStorage(app: App): {
  getSecret?: (key: string) => Promise<string | null>;
  setSecret?: (key: string, value: string) => Promise<void>;
} {
  return (app as any).secretStorage ?? {};
}

export interface VaultSetupViewState {
  initialized: boolean;
  title: string;
  description: string;
  showSetupActions: boolean;
  showResetAction: boolean;
}

export function vaultSetupViewState(state: LocalSyncState): VaultSetupViewState {
  if (!state.initialized) {
    return {
      initialized: false,
      title: "Connect to GitLab",
      description:
        "Download the GitLab repository into this vault. Existing local files are kept and pushed on the next sync; nothing is deleted.",
      showSetupActions: true,
      showResetAction: false,
    };
  }

  const dirtyCount = Object.keys(state.dirtyEntries).length;
  const base = state.lastSyncedCommitSha?.slice(0, 8) ?? "unknown";
  return {
    initialized: true,
    title: "Vault connected",
    description: `Base commit ${base}. Local pending changes: ${dirtyCount}.`,
    showSetupActions: false,
    showResetAction: true,
  };
}

export default class GitLabSyncSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: GitLabGitlessSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("GitLab repository").setHeading();

    new Setting(containerEl)
      .setName("GitLab base URL")
      .setDesc("HTTPS GitLab instance URL")
      .addText((text) =>
        text
          .setPlaceholder("https://gitlab.com")
          .setValue(this.plugin.settings.gitlabBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.gitlabBaseUrl = value.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Project path")
      .setDesc("Namespace and project path in GitLab, for example developing/obsidian-world")
      .addText((text) =>
        text
          .setPlaceholder("group/project")
          .setValue(this.plugin.settings.projectPath)
          .onChange(async (value) => {
            this.plugin.settings.projectPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Branch to synchronize")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this.plugin.settings.branch)
          .onChange(async (value) => {
            this.plugin.settings.branch = value.trim() || "main";
            await this.plugin.saveSettings();
          }),
      );

    let tokenInput: TextComponent;
    new Setting(containerEl)
      .setName("GitLab token")
      .setDesc("Stored in Obsidian SecretStorage, not plugin data")
      .addButton((button) =>
        button.setIcon("eye-off").onClick(() => {
          tokenInput.inputEl.type =
            tokenInput.inputEl.type === "password" ? "text" : "password";
          button.setIcon(tokenInput.inputEl.type === "password" ? "eye-off" : "eye");
        }),
      )
      .addText((text) => {
        text.setPlaceholder("glpat-...").onChange(async (value) => {
          const storage = secretStorage(this.app);
          if (!storage.setSecret) {
            new Notice("SecretStorage is not available in this Obsidian version");
            return;
          }
          await storage.setSecret(this.plugin.settings.tokenSecretName, value);
        });
        text.inputEl.type = "password";
        tokenInput = text;
      });

    new Setting(containerEl)
      .setName("Token secret name")
      .setDesc("Local SecretStorage key used for the GitLab token")
      .addText((text) =>
        text
          .setPlaceholder("gitlab-gitless-sync-token")
          .setValue(this.plugin.settings.tokenSecretName)
          .onChange(async (value) => {
            this.plugin.settings.tokenSecretName =
              value.trim() || "gitlab-gitless-sync-token";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Commit author").setHeading();

    new Setting(containerEl)
      .setName("Author name")
      .addText((text) =>
        text.setValue(this.plugin.settings.authorName).onChange(async (value) => {
          this.plugin.settings.authorName = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Author email")
      .addText((text) =>
        text.setValue(this.plugin.settings.authorEmail).onChange(async (value) => {
          this.plugin.settings.authorEmail = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Vault setup").setHeading();

    const setupState = vaultSetupViewState(this.plugin.pluginData.state);
    const setupSetting = new Setting(containerEl)
      .setName(setupState.title)
      .setDesc(setupState.description);

    if (setupState.showSetupActions) {
      setupSetting.addButton((button) =>
        button
          .setButtonText("Connect to GitLab")
          .setCta()
          .onClick(async () => {
            const preview = await this.plugin.previewConnect();
            if (!preview) return; // error/misconfig already surfaced by previewConnect
            new ConnectConfirmModal(
              this.plugin.app,
              this.plugin.settings.projectPath,
              this.plugin.settings.branch,
              preview,
              async () => {
                await this.plugin.connect(preview);
                this.display();
              },
            ).open();
          }),
      );
    }

    if (setupState.showResetAction) {
      new Setting(containerEl)
        .setName("Reset local sync state")
        .setDesc("Forget the local base commit, tracked index, dirty journal, and pending transaction")
        .addButton((button) => {
          button
            .setButtonText("Reset")
            .setWarning()
            .onClick(() => {
              const modal = new Modal(this.plugin.app);
              modal.setTitle("Reset local sync state?");
              modal.setContent("This does not delete files or change GitLab.");
              new Setting(modal.contentEl).addButton((btn) =>
                btn
                  .setButtonText("Reset")
                  .setWarning()
                  .onClick(async () => {
                    await this.plugin.reset();
                    modal.close();
                    this.display();
                  }),
              );
              modal.open();
            });
        });
    }

    new Setting(containerEl).setName("Sync").setHeading();

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc(
        "Run one sync after Obsidian is ready. On mobile the app is usually suspended before this runs — use \"Sync on app foreground\" there instead.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync on app foreground (mobile only)")
      .setDesc(
        "Mobile only. Runs one sync when the app returns to the foreground (you reopen Obsidian). This is the reliable mobile replacement for \"Sync on startup\".",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnForeground).onChange(async (value) => {
          this.plugin.settings.syncOnForeground = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync on app background (mobile only)")
      .setDesc(
        "Mobile only. Runs one sync when the app is sent to the background (you leave Obsidian). Unstable — some devices suspend the app before the sync finishes.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnBackground).onChange(async (value) => {
          this.plugin.settings.syncOnBackground = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync after edits")
      .setDesc("Run a sync a few seconds after you stop editing (see \"Edit debounce\" below)")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncAfterEdit).onChange(async (value) => {
          this.plugin.settings.syncAfterEdit = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Edit debounce (seconds)")
      .setDesc("How long to wait after the last change before syncing")
      .addText((text) =>
        text
          .setPlaceholder("8")
          .setValue(String(this.plugin.settings.syncAfterEditDebounceSeconds))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.syncAfterEditDebounceSeconds =
              Number.isFinite(parsed) && parsed >= 1 ? parsed : 8;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync on a timer")
      .setDesc(
        "Run a sync periodically to pull changes made on other devices. Great for keeping a desktop up to date.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnInterval).onChange(async (value) => {
          this.plugin.settings.syncOnInterval = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAutoSyncInterval();
        }),
      );

    new Setting(containerEl)
      .setName("Timer interval (minutes)")
      .setDesc("How often the periodic sync runs")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.syncIntervalMinutes =
              Number.isFinite(parsed) && parsed >= 1 ? parsed : 10;
            await this.plugin.saveSettings();
            this.plugin.refreshAutoSyncInterval();
          }),
      );

    new Setting(containerEl)
      .setName("Conflict strategy")
      .setDesc(
        "How to resolve a file changed on both sides since the last sync. " +
          "Remote: keep the GitLab version at the original path and save yours as a conflict copy. " +
          "Local: keep your version at the original path and save GitLab's as a conflict copy. " +
          "Auto merge variants first attempt a line-based three-way merge of text files and only " +
          "fall back to Remote/Local when the merge conflicts or the file is binary.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("remote", "Remote")
          .addOption("local", "Local")
          .addOption("auto-remote", "Auto merge, fallback Remote")
          .addOption("auto-local", "Auto merge, fallback Local")
          .setValue(this.plugin.settings.conflictStrategy)
          .onChange(async (value) => {
            this.plugin.settings.conflictStrategy =
              value === "local" || value === "auto-remote" || value === "auto-local"
                ? value
                : "remote";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Interface").setHeading();

    new Setting(containerEl)
      .setName("Show sidebar icon")
      .setDesc("Show a quick sync button in the left sidebar")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showRibbonIcon).onChange(async (value) => {
          this.plugin.settings.showRibbonIcon = value;
          if (value) {
            this.plugin.showSyncRibbonIcon();
          } else {
            this.plugin.hideSyncRibbonIcon();
          }
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Log level")
      .setDesc("Use Debug only while diagnosing sync behavior")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("off", "Off")
          .addOption("error", "Error")
          .addOption("info", "Info")
          .addOption("debug", "Debug")
          .setValue(this.plugin.settings.loggingLevel)
          .onChange(async (value) => {
            this.plugin.settings.loggingLevel =
              value === "error" || value === "info" || value === "debug" ? value : "off";
            this.plugin.settings.loggingEnabled = this.plugin.settings.loggingLevel !== "off";
            this.plugin.logger.setLevel(this.plugin.settings.loggingLevel);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Copy logs")
      .addButton((button) =>
        button.setButtonText("Copy").onClick(async () => {
          try {
            await copyToClipboard(await this.plugin.logger.read());
            new Notice("Logs copied", 5000);
          } catch (err) {
            new Notice(`Failed copying logs: ${err}`, 10000);
          }
        }),
      );

    new Setting(containerEl)
      .setName("Clean logs")
      .addButton((button) =>
        button.setButtonText("Clean").onClick(() => this.plugin.logger.clean()),
      );
  }
}
