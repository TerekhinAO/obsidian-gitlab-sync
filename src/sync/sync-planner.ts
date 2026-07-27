import type { GitLabCommitAction } from "../gitlab/types";
import {
  ConflictResolver,
  calculateGitBlobId,
  type VersionState,
} from "./conflict-resolver";
import type { LocalSnapshotEntry } from "./local-snapshot";
import type { RemoteChange } from "./remote-diff";
import type { ConflictStrategy, DirtyEntry, MaterializeOperation, TrackedFile } from "./types";

export interface SyncPlan {
  basedOnRemoteSha: string;
  actions: GitLabCommitAction[];
  materializeAfterCommit: MaterializeOperation[];
  materializeWithoutCommit: MaterializeOperation[];
  nextTrackedFiles: Record<string, TrackedFile>;
  acknowledgedDirtyPaths: string[];
  conflictPaths: string[];
}

interface SyncPlannerOptions {
  conflictResolver?: ConflictResolver;
  getRemoteVersion?: (path: string, remoteSha: string) => Promise<VersionState>;
  getLastCommitId?: (path: string, remoteSha: string) => Promise<string | null>;
  deviceName?: string;
  conflictStrategy?: ConflictStrategy;
}

export class SyncPlanner {
  private readonly conflictResolver: ConflictResolver;
  private readonly getRemoteVersion: (path: string, remoteSha: string) => Promise<VersionState>;
  private readonly getLastCommitId: (path: string, remoteSha: string) => Promise<string | null>;
  private readonly deviceName?: string;

  constructor(options: SyncPlannerOptions = {}) {
    this.conflictResolver = options.conflictResolver ??
      new ConflictResolver({ strategy: options.conflictStrategy });
    this.getRemoteVersion = options.getRemoteVersion ?? (async () => missing());
    this.getLastCommitId = options.getLastCommitId ?? (async () => null);
    this.deviceName = options.deviceName;
  }

  async plan(input: {
    baseSha: string;
    remoteSha: string;
    trackedFiles: Record<string, TrackedFile>;
    dirtyEntries: DirtyEntry[];
    remoteChanges: RemoteChange[];
    localSnapshots: LocalSnapshotEntry[];
    now: Date;
  }): Promise<SyncPlan> {
    const nextTrackedFiles = cloneIndex(input.trackedFiles);
    const dirtyPaths = new Set(input.dirtyEntries.map((entry) => entry.path));
    const localSnapshotPaths = new Set(input.localSnapshots.map((snapshot) => snapshot.path));
    const remoteChangedPaths = remoteChangedPathSet(input.remoteChanges);
    const materializeWithoutCommit: MaterializeOperation[] = [];

    for (const change of input.remoteChanges) {
      if (isTouchedByLocalSnapshot(change, localSnapshotPaths)) {
        continue;
      }
      await materializeRemoteOnlyChange(
        change,
        input.remoteSha,
        nextTrackedFiles,
        materializeWithoutCommit,
        this.getRemoteVersion,
      );
    }

    const remoteVersions = await this.remoteVersionsForSnapshots(
      input.localSnapshots,
      input.remoteSha,
      remoteChangedPaths,
    );
    const conflictPlan = await this.conflictResolver.resolve({
      snapshots: input.localSnapshots,
      remote: remoteVersions,
      trackedFiles: nextTrackedFiles,
      now: input.now,
      deviceName: this.deviceName,
    });

    const actions = await this.withOptimisticLocks(
      conflictPlan.commitActions,
      input.remoteSha,
    );
    await applyRemoteVersionsForSnapshots(
      nextTrackedFiles,
      input.localSnapshots,
      remoteVersions,
      remoteChangedPaths,
    );
    applyIndexMutations(nextTrackedFiles, conflictPlan.nextIndexMutations);

    return {
      basedOnRemoteSha: input.remoteSha,
      actions,
      materializeAfterCommit: actions.length > 0
        ? [...materializeWithoutCommit, ...conflictPlan.materializeOperations]
        : [],
      materializeWithoutCommit: actions.length > 0
        ? []
        : [...materializeWithoutCommit, ...conflictPlan.materializeOperations],
      nextTrackedFiles,
      acknowledgedDirtyPaths: input.localSnapshots
        .map((snapshot) => snapshot.path)
        .filter((path) => dirtyPaths.has(path)),
      conflictPaths: conflictPlan.conflictPaths,
    };
  }

  private async remoteVersionsForSnapshots(
    snapshots: LocalSnapshotEntry[],
    remoteSha: string,
    remoteChangedPaths: Set<string>,
  ): Promise<Record<string, VersionState>> {
    const remote: Record<string, VersionState> = {};

    for (const snapshot of snapshots) {
      if (remoteChangedPaths.has(snapshot.path)) {
        remote[snapshot.path] = await this.getRemoteVersion(snapshot.path, remoteSha);
      } else {
        remote[snapshot.path] = snapshot.base ?? missing();
      }
    }

    return remote;
  }

  private async withOptimisticLocks(
    actions: GitLabCommitAction[],
    remoteSha: string,
  ): Promise<GitLabCommitAction[]> {
    const locked: GitLabCommitAction[] = [];

    for (const action of actions) {
      if (action.action === "create") {
        locked.push(action);
        continue;
      }

      // Reconcile update/delete against the actual remote head. A stale index
      // can emit a delete/update for a path that no longer exists remotely,
      // which makes GitLab reject the whole atomic commit with
      // "A file with this name doesn't exist". Drop such deletes and turn
      // orphaned updates into creates so the commit stays valid.
      const remote = await this.getRemoteVersion(action.file_path, remoteSha);
      const existsInHead = remote.exists && remote.bytes !== null;
      if (!existsInHead) {
        if (action.action === "delete") {
          continue;
        }
        const { last_commit_id: _drop, ...rest } = action;
        locked.push({ ...rest, action: "create" });
        continue;
      }

      const lastCommitId = await this.getLastCommitId(action.file_path, remoteSha);
      if (lastCommitId === null) {
        locked.push(action);
      } else {
        locked.push({ ...action, last_commit_id: lastCommitId });
      }
    }

    return locked;
  }
}

async function materializeRemoteOnlyChange(
  change: RemoteChange,
  remoteSha: string,
  nextTrackedFiles: Record<string, TrackedFile>,
  operations: MaterializeOperation[],
  getRemoteVersion: (path: string, remoteSha: string) => Promise<VersionState>,
): Promise<void> {
  switch (change.type) {
    case "create":
    case "update":
      await materializeRemotePath(change.path, remoteSha, nextTrackedFiles, operations, getRemoteVersion);
      return;
    case "delete":
      operations.push({ type: "delete", path: change.path });
      delete nextTrackedFiles[change.path];
      return;
    case "rename":
      operations.push({ type: "delete", path: change.oldPath });
      delete nextTrackedFiles[change.oldPath];
      await materializeRemotePath(change.newPath, remoteSha, nextTrackedFiles, operations, getRemoteVersion);
      return;
  }
}

async function materializeRemotePath(
  path: string,
  remoteSha: string,
  nextTrackedFiles: Record<string, TrackedFile>,
  operations: MaterializeOperation[],
  getRemoteVersion: (path: string, remoteSha: string) => Promise<VersionState>,
): Promise<void> {
  const remote = await getRemoteVersion(path, remoteSha);
  if (!remote.exists || remote.bytes === null) {
    operations.push({ type: "delete", path });
    delete nextTrackedFiles[path];
    return;
  }

  const contentBase64 = toBase64(remote.bytes);
  operations.push({ type: "write", path, contentBase64 });
  nextTrackedFiles[path] = await trackedFile(remote.bytes);
}

function applyIndexMutations(
  nextTrackedFiles: Record<string, TrackedFile>,
  mutations: Array<
    | { type: "set"; path: string; file: TrackedFile }
    | { type: "delete"; path: string }
  >,
): void {
  for (const mutation of mutations) {
    if (mutation.type === "set") {
      nextTrackedFiles[mutation.path] = mutation.file;
    } else {
      delete nextTrackedFiles[mutation.path];
    }
  }
}

async function applyRemoteVersionsForSnapshots(
  nextTrackedFiles: Record<string, TrackedFile>,
  snapshots: LocalSnapshotEntry[],
  remoteVersions: Record<string, VersionState>,
  remoteChangedPaths: Set<string>,
): Promise<void> {
  for (const snapshot of snapshots) {
    if (!remoteChangedPaths.has(snapshot.path)) {
      continue;
    }

    const remote = remoteVersions[snapshot.path] ?? missing();
    if (!remote.exists || remote.bytes === null) {
      delete nextTrackedFiles[snapshot.path];
    } else {
      nextTrackedFiles[snapshot.path] = await trackedFile(remote.bytes);
    }
  }
}

function remoteChangedPathSet(changes: RemoteChange[]): Set<string> {
  const paths = new Set<string>();
  for (const change of changes) {
    if (change.type === "rename") {
      paths.add(change.oldPath);
      paths.add(change.newPath);
    } else {
      paths.add(change.path);
    }
  }
  return paths;
}

function isTouchedByLocalSnapshot(
  change: RemoteChange,
  localSnapshotPaths: Set<string>,
): boolean {
  if (change.type === "rename") {
    return localSnapshotPaths.has(change.oldPath) || localSnapshotPaths.has(change.newPath);
  }
  return localSnapshotPaths.has(change.path);
}

async function trackedFile(bytes: Uint8Array): Promise<TrackedFile> {
  return {
    blobId: await calculateGitBlobId(bytes),
    mode: "100644",
    size: bytes.byteLength,
  };
}

function cloneIndex(
  trackedFiles: Record<string, TrackedFile>,
): Record<string, TrackedFile> {
  return Object.fromEntries(
    Object.entries(trackedFiles).map(([path, file]) => [path, { ...file }]),
  );
}

function missing(): VersionState {
  return { exists: false, bytes: null };
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  return encodeBase64(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";

  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const hasSecond = index + 1 < bytes.byteLength;
    const hasThird = index + 2 < bytes.byteLength;
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    encoded += alphabet[(triple >> 18) & 0x3f];
    encoded += alphabet[(triple >> 12) & 0x3f];
    encoded += hasSecond ? alphabet[(triple >> 6) & 0x3f] : "=";
    encoded += hasThird ? alphabet[triple & 0x3f] : "=";
  }

  return encoded;
}
