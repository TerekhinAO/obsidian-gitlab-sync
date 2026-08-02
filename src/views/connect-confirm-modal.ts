import { Modal, Setting } from "obsidian";
import type { ConnectPreview } from "../sync/bootstrap-service";

const MAX_NAMES = 10;

export class ConnectConfirmModal extends Modal {
  constructor(
    app: any,
    private readonly projectPath: string,
    private readonly branch: string,
    private readonly preview: ConnectPreview,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Connect to GitLab");
    this.contentEl.empty();

    this.contentEl.createEl("p", {
      text: `Repository (${this.projectPath} · branch ${this.branch}):`,
    });
    this.contentEl.createEl("p", {
      text: `${this.preview.remoteFileCount} files will be downloaded to this vault.`,
    });

    this.contentEl.createEl("p", { text: "This vault:" });
    if (this.preview.localPushCount === 0) {
      this.contentEl.createEl("p", { text: "0 files to push." });
    } else {
      this.contentEl.createEl("p", {
        text: `${this.preview.localPushCount} local files will be pushed to GitLab on the next sync, e.g.:`,
      });
      const list = this.contentEl.createEl("ul");
      for (const path of this.preview.localPushPaths.slice(0, MAX_NAMES)) {
        list.createEl("li", { text: path });
      }
      const remainder =
        this.preview.localPushCount - Math.min(this.preview.localPushPaths.length, MAX_NAMES);
      if (remainder > 0) {
        list.createEl("li", { text: `…and ${remainder} more` });
      }
    }
    this.contentEl.createEl("p", {
      text: `${this.preview.conflictCount} files changed on both sides.`,
    });
    this.contentEl.createEl("p", {
      text: "Nothing is deleted. When the same file differs on both sides, both versions are kept.",
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button.setButtonText("Connect").setCta().onClick(() => this.confirm()),
      );
  }

  confirm(): void {
    this.close();
    this.onConfirm();
  }
}
