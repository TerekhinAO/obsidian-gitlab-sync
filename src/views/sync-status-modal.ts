import { Modal, Setting } from "obsidian";
import type { GitLabSyncSettings, LocalSyncState } from "../sync/types";

export class SyncStatusModal extends Modal {
  constructor(
    app: any,
    private readonly settings: GitLabSyncSettings,
    private readonly state: LocalSyncState,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("GitLab sync status");
    this.contentEl.empty();

    const rows: Array<[string, string]> = [
      ["Initialized", this.state.initialized ? "yes" : "no"],
      ["GitLab host", this.settings.gitlabBaseUrl],
      ["Project", this.settings.projectPath],
      ["Branch", this.settings.branch],
      ["Last synced commit", this.state.lastSyncedCommitSha ?? "never"],
      ["Last sync time", this.state.lastSyncAt ? new Date(this.state.lastSyncAt).toISOString() : "never"],
      ["Dirty path count", Object.keys(this.state.dirtyEntries).length.toString()],
      ["Pending recovery", this.state.pendingTransaction ? "yes" : "no"],
      ["Last result", this.state.lastSyncResult],
    ];

    for (const [name, value] of rows) {
      new Setting(this.contentEl).setName(name).setDesc(value);
    }
  }
}
