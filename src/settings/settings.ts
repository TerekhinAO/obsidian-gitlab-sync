import type { GitLabSyncSettings, LocalSyncState, PluginData } from "../sync/types";

export type { GitLabSyncSettings, LocalSyncState, PluginData };

export type GitHubSyncSettings = GitLabSyncSettings & Record<string, any>;

export const DEFAULT_SETTINGS: GitLabSyncSettings = {
  gitlabBaseUrl: "https://gitlab.com",
  projectPath: "",
  branch: "main",
  tokenSecretName: "gitlab-gitless-sync-token",
  authorName: "",
  authorEmail: "",
  syncOnStartup: true,
  showRibbonIcon: true,
  loggingEnabled: false,
};

export const DEFAULT_STATE: LocalSyncState = {
  schemaVersion: 1,
  initialized: false,
  lastSyncedCommitSha: null,
  trackedFiles: {},
  dirtyEntries: {},
  pendingTransaction: null,
  lastSyncAt: null,
  lastSyncResult: "never",
};
