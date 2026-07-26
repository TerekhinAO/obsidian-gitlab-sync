import type { GitLabSyncSettings, LocalSyncState, PluginData } from "../sync/types";

export type { GitLabSyncSettings, LocalSyncState, PluginData };

export const DEFAULT_SETTINGS: GitLabSyncSettings = {
  gitlabBaseUrl: "https://gitlab.com",
  projectPath: "",
  branch: "main",
  tokenSecretName: "gitlab-gitless-sync-token",
  authorName: "",
  authorEmail: "",
  syncOnStartup: true,
  syncOnForeground: true,
  syncOnBackground: false,
  showRibbonIcon: true,
  loggingLevel: "off",
  loggingEnabled: false,
  conflictStrategy: "remote",
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
