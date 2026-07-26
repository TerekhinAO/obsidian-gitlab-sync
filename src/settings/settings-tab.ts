import { App, Modal, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import GitLabGitlessSyncPlugin from "../main";
import { copyToClipboard } from "../utils";

function secretStorage(app: App): {
  getSecret?: (key: string) => Promise<string | null>;
  setSecret?: (key: string, value: string) => Promise<void>;
} {
  return (app as any).secretStorage ?? {};
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
      .setDesc("Namespace and project path, for example developing1382536/obsidian-vault")
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

    new Setting(containerEl).setName("Sync").setHeading();

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run one sync after Obsidian layout is ready")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync on app foreground")
      .setDesc("Run one sync when Obsidian returns from the background")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnForeground).onChange(async (value) => {
          this.plugin.settings.syncOnForeground = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Initialize empty vault from GitLab")
      .setDesc("Import the configured branch into an empty vault")
      .addButton((button) =>
        button.setButtonText("Initialize").onClick(() => this.plugin.initializeFromGitLab()),
      );

    new Setting(containerEl)
      .setName("Adopt existing vault from GitLab")
      .setDesc("Use the current GitLab branch as the sync base, then audit local differences")
      .addButton((button) =>
        button.setButtonText("Adopt").onClick(() => {
          const confirmed = typeof window === "undefined" || window.confirm(
            "This keeps current local files, records the GitLab branch as the sync base, and marks local differences for the next sync. Continue?",
          );
          if (confirmed) {
            void this.plugin.adoptExistingVault();
          }
        }),
      );

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
                }),
            );
            modal.open();
          });
      });

    new Setting(containerEl).setName("Interface").setHeading();

    new Setting(containerEl)
      .setName("Show ribbon icon")
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
      .setName("Enable logging")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.loggingEnabled).onChange(async (value) => {
          this.plugin.settings.loggingEnabled = value;
          if (value) {
            this.plugin.logger.enable();
          } else {
            this.plugin.logger.disable();
          }
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
