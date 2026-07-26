export type DirtyOperation = "upsert" | "delete";

export interface DirtyEntry {
  path: string;
  operation: DirtyOperation;
  recordedAt: number;
}

export interface TrackedFile {
  blobId: string;
  mode: string;
  size: number;
}

export interface GitLabSyncSettings {
  gitlabBaseUrl: string;
  projectPath: string;
  branch: string;
  tokenSecretName: string;
  authorName: string;
  authorEmail: string;
  syncOnStartup: boolean;
  syncOnForeground: boolean;
  syncOnBackground: boolean;
  showRibbonIcon: boolean;
  loggingEnabled: boolean;
}

export interface MaterializeOperation {
  type: "write" | "delete";
  path: string;
  contentBase64?: string;
}

export interface PendingTransaction {
  transactionId: string;
  committedSha: string;
  materializeOperations: MaterializeOperation[];
  nextTrackedFiles: Record<string, TrackedFile>;
  acknowledgedDirtyPaths: string[];
  conflictPaths: string[];
  createdAt: number;
}

export interface LocalSyncState {
  schemaVersion: 1;
  initialized: boolean;
  lastSyncedCommitSha: string | null;
  trackedFiles: Record<string, TrackedFile>;
  dirtyEntries: Record<string, DirtyEntry>;
  pendingTransaction: PendingTransaction | null;
  lastSyncAt: number | null;
  lastSyncResult: "never" | "success" | "conflict" | "error";
}

export interface PluginData {
  settings: GitLabSyncSettings;
  state: LocalSyncState;
}
