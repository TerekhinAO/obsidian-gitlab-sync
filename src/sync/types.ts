export type DirtyOperation = "upsert" | "delete";
export type LogLevel = "off" | "error" | "info" | "debug";
export type ConflictStrategy = "remote" | "local" | "auto-remote" | "auto-local";

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

export type RemoteChange =
  | { type: "create"; path: string; blobId?: string }
  | { type: "update"; path: string; blobId?: string }
  | { type: "delete"; path: string }
  | { type: "rename"; oldPath: string; newPath: string };

export interface RemoteApply {
  remoteSha: string;
  remainingChanges: RemoteChange[];
  nextTrackedFiles: Record<string, TrackedFile>;
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
  syncAfterEdit: boolean;
  syncAfterEditDebounceSeconds: number;
  syncOnInterval: boolean;
  syncIntervalMinutes: number;
  showRibbonIcon: boolean;
  loggingLevel: LogLevel;
  loggingEnabled: boolean;
  conflictStrategy: ConflictStrategy;
  allowSelfSignedCertificateForConnect: boolean;
}

export interface MaterializeOperation {
  type: "write" | "delete";
  path: string;
  contentBase64?: string;
}

export type ByteMaterializeOperation =
  | { type: "write"; path: string; bytes: Uint8Array }
  | { type: "delete"; path: string };

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
  schemaVersion: 3;
  initialized: boolean;
  lastSyncedCommitSha: string | null;
  trackedFiles: Record<string, TrackedFile>;
  dirtyEntries: Record<string, DirtyEntry>;
  pendingTransaction: PendingTransaction | null;
  lastSyncAt: number | null;
  lastSyncResult: "never" | "success" | "conflict" | "error";
  remoteBackoffUntil: number | null;
  remoteBackoffReason: "rate-limit" | "server" | "transport" | null;
  remoteApply: RemoteApply | null;
}

export interface PluginData {
  settings: GitLabSyncSettings;
  state: LocalSyncState;
}
