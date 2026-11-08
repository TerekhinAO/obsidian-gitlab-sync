import { normalizePath, Platform, type App, type Plugin, type Vault } from "obsidian";
import { commitDeviceLabel, deviceLabel, type DevicePlatform } from "../device-label";
import { GitLabClient } from "../gitlab/client";
import { GitLabRequestScheduler } from "../gitlab/request-scheduler";
import type {
  CreatedGitLabCommit,
  GitLabBranch,
  GitLabCommitAction,
  GitLabTreeItem,
} from "../gitlab/types";
import type Logger from "../logger";
import { ChangeJournal } from "./change-journal";
import { IgnoreMatcher } from "./ignore-matcher";
import { LocalMaterializer } from "./local-materializer";
import { LocalSnapshotService, type LocalSnapshotEntry, type VersionState } from "./local-snapshot";
import { calculateGitBlobId, toBase64 } from "./conflict-resolver";
import { RemoteDiffService, type RemoteChange, type RemoteDiffClient } from "./remote-diff";
import { StateStore } from "./state-store";
import { SyncPlanner, type SyncPlan } from "./sync-planner";
import { StreamingRemoteApplier } from "./remote-only-stream";
import type {
  ByteMaterializeOperation,
  DirtyEntry,
  GitLabSyncSettings,
  LocalSyncState,
  MaterializeOperation,
  PendingTransaction,
  PluginData,
  RemoteApply,
  TrackedFile,
} from "./types";

export interface SyncResult {
  status: "success" | "conflict" | "error" | "already-running" | "deferred";
  trigger: SyncTrigger;
  message: string;
  commitSha?: string;
  recovered?: boolean;
  attempts?: number;
  retryAt?: number;
}

export type SyncTrigger =
  | "startup"
  | "manual"
  | "audit"
  | "foreground"
  | "background"
  | "edit"
  | "interval";

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
}

export interface ConflictResolution {
  filePath: string;
  content: string;
}

interface GitLabClientLike {
  getBranch(): Promise<GitLabBranch>;
  validateAccess?(): Promise<void>;
  getRawBlob(blobId: string): Promise<ArrayBuffer | null>;
  getRawFile(path: string, ref: string): Promise<ArrayBuffer | null>;
  getTree(ref: string): Promise<GitLabTreeItem[]>;
  createCommit(input: {
    message: string;
    actions: SyncPlan["actions"];
  }): Promise<CreatedGitLabCommit>;
}

interface RemoteDiffLike {
  discover(input: {
    baseSha: string;
    remoteSha: string;
    baseIndex: Record<string, TrackedFile>;
  }): Promise<{
    changes: RemoteChange[];
    remoteTree?: Record<string, TrackedFile>;
    usedFallback: boolean;
  }>;
}

interface IgnoreMatcherLike {
  reload(): Promise<void>;
  isIgnored(path: string, trackedFiles: Record<string, TrackedFile>): boolean;
  isDirIgnored?(path: string): boolean;
}

interface LocalSnapshotLike {
  snapshot(
    entries: DirtyEntry[],
    tracked: Record<string, TrackedFile>,
  ): Promise<LocalSnapshotEntry[]>;
}

export interface PlannerLike {
  plan(input: {
    baseSha: string;
    remoteSha: string;
    trackedFiles: Record<string, TrackedFile>;
    dirtyEntries: DirtyEntry[];
    remoteChanges: RemoteChange[];
    localSnapshots: LocalSnapshotEntry[];
    now: Date;
    streamRemoteOnly?: boolean;
  }): Promise<SyncPlan>;
}

interface JournalLike {
  start?(): void;
  stop?(): Promise<void>;
  list(): DirtyEntry[];
  recordUpsert?(path: string): Promise<void>;
  recordDelete?(path: string): Promise<void>;
  suppress<T>(operation: () => Promise<T>): Promise<T>;
}

interface MaterializerLike {
  apply(operations: MaterializeOperation[]): Promise<void>;
  applyBytes(operations: ByteMaterializeOperation[]): Promise<void>;
  recoverPendingTransaction(): Promise<boolean>;
}

interface ProgressNotice {
  setMessage?(message: string): void;
  hide?(): void;
}

export interface SyncManagerOptions {
  app?: App;
  vault?: Vault;
  plugin?: Plugin;
  stateStore: Pick<StateStore, "load" | "save" | "update">;
  settings?: GitLabSyncSettings;
  logger?: Pick<Logger, "debug" | "info" | "warn" | "error">;
  getToken?: (settings: GitLabSyncSettings) => Promise<string | null>;
  createGitLabClient?: (settings: GitLabSyncSettings, token: string) => GitLabClientLike;
  createRemoteDiffService?: (
    client: GitLabClientLike,
    isHardExcluded: (path: string) => boolean,
  ) => RemoteDiffLike;
  createIgnoreMatcher?: () => IgnoreMatcherLike;
  createLocalSnapshotService?: (
    client: GitLabClientLike,
    ignoreMatcher: IgnoreMatcherLike,
  ) => LocalSnapshotLike;
  createPlanner?: (
    client: GitLabClientLike,
    settings: GitLabSyncSettings,
    getRemoteVersion: (path: string, remoteSha: string) => Promise<VersionState>,
  ) => PlannerLike;
  journal?: JournalLike;
  materializer?: MaterializerLike;
  createStreamingApplier?: (
    client: GitLabClientLike,
    materializer: MaterializerLike,
  ) => StreamingRemoteApplier;
  now?: () => number;
  nowDate?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  createRequestScheduler?: () => GitLabRequestScheduler;
  notice?: (message: string) => void;
  createProgressNotice?: (message: string) => ProgressNotice;
  /** Overrides Obsidian's `Platform` so device naming can be exercised in tests. */
  platform?: DevicePlatform;
}

const MAX_PLAN_ATTEMPTS = 2;

export class SyncManager {
  private syncing = false;
  private journal?: JournalLike;
  private materializer?: MaterializerLike;
  private requestScheduler?: GitLabRequestScheduler;

  constructor(private readonly options: SyncManagerOptions) {}

  private getScheduler(): GitLabRequestScheduler {
    if (!this.requestScheduler) {
      this.requestScheduler =
        this.options.createRequestScheduler?.() ??
        new GitLabRequestScheduler({
          now: this.options.now,
          sleep: this.options.sleep,
        });
    }
    return this.requestScheduler;
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  startEventsListener(plugin?: Plugin): void {
    this.getJournal(plugin).start?.();
  }

  async stopEventsListener(): Promise<void> {
    await this.journal?.stop?.();
  }

  async recoverIfNeeded(): Promise<boolean> {
    return await this.getMaterializer().recoverPendingTransaction();
  }

  async adoptExistingVault(): Promise<{
    status: "success" | "error" | "already-running";
    message: string;
    commitSha?: string;
    dirtyPaths?: number;
  }> {
    if (this.syncing) {
      this.options.notice?.("Sync already running");
      return { status: "already-running", message: "Sync already running" };
    }

    this.syncing = true;
    const progress = this.options.createProgressNotice?.("Adopting existing vault…");
    try {
      const data = await this.options.stateStore.load();
      const settings = this.validateSettings(this.options.settings ?? data.settings);
      await this.logGitLabTarget("Adopt existing vault target", settings);
      const token = await this.readToken(settings);
      const client = this.createClient(settings, token);
      await client.validateAccess?.();
      const { commitSha, dirtyPaths } = await this.finalizeAdoption(client);
      this.options.notice?.(
        dirtyPaths === 0
          ? "Existing vault adopted"
          : `Existing vault adopted with ${dirtyPaths} local changes`,
      );
      return {
        status: "success",
        message: "Existing vault adopted",
        commitSha,
        dirtyPaths,
      };
    } catch (error) {
      const message = errorMessage(error);
      await this.options.logger?.error("Adopt existing vault failed", { message });
      this.options.notice?.(`Error adopting existing vault. ${message}`);
      return { status: "error", message };
    } finally {
      progress?.hide?.();
      this.syncing = false;
    }
  }

  private async finalizeAdoption(
    client: GitLabClientLike,
  ): Promise<{ commitSha: string; dirtyPaths: number }> {
    const branch = await client.getBranch();
    this.validateBranch(branch);
    const trackedFiles = treeToTrackedFiles(
      await client.getTree(branch.commit.id),
      this.isHardExcluded.bind(this),
    );
    await this.options.stateStore.update((next) => {
      next.state.initialized = true;
      next.state.lastSyncedCommitSha = branch.commit.id;
      next.state.trackedFiles = trackedFiles;
      next.state.dirtyEntries = {};
      next.state.pendingTransaction = null;
      next.state.lastSyncAt = this.now();
      next.state.lastSyncResult = "success";
      next.state.remoteBackoffUntil = null;
      next.state.remoteBackoffReason = null;
    });
    await this.auditLocalChanges();
    const adopted = await this.options.stateStore.load();
    return {
      commitSha: branch.commit.id,
      dirtyPaths: Object.keys(adopted.state.dirtyEntries).length,
    };
  }

  async initializeEmptyRemote(): Promise<{
    status: "success" | "error" | "already-running";
    message: string;
    commitSha?: string;
    dirtyPaths?: number;
  }> {
    if (this.syncing) {
      this.options.notice?.("Sync already running");
      return { status: "already-running", message: "Sync already running" };
    }

    this.syncing = true;
    const progress = this.options.createProgressNotice?.("Creating first commit…");
    try {
      const data = await this.options.stateStore.load();
      const settings = this.validateSettings(this.options.settings ?? data.settings);
      if (!settings.authorName.trim() || !settings.authorEmail.trim()) {
        throw new Error("Set a commit author name and email before creating the first commit.");
      }
      await this.logGitLabTarget("Initialize empty remote target", settings);
      const token = await this.readToken(settings);
      const client = this.createClient(settings, token);
      // Deliberately no client.validateAccess?.() here: on a truly empty remote there is no
      // branch yet, so validateAccess (which calls getBranch) would spuriously fail. createCommit
      // below is intentionally the first remote call and surfaces auth errors via the try/catch.

      const paths = await this.listSyncableLocalFiles();
      if (paths.length === 0) {
        throw new Error("The vault has no files to push.");
      }
      if (!this.options.vault) {
        throw new Error("Vault is required to initialize the repository.");
      }
      const vault = this.options.vault;
      const actions: GitLabCommitAction[] = [];
      for (const path of paths) {
        const bytes = new Uint8Array(await vault.adapter.readBinary(path));
        actions.push({
          action: "create",
          file_path: path,
          content: toBase64(bytes),
          encoding: "base64",
        });
      }
      // Non-atomic commit→finalize window: if createCommit succeeds but finalizeAdoption throws,
      // state.initialized stays false while the remote commit exists. This is recoverable: a
      // re-run/adopt re-fetches the remote as source of truth.
      const commit = await client.createCommit({ message: "Initialize vault", actions });
      const { dirtyPaths } = await this.finalizeAdoption(client);
      this.options.notice?.("Repository initialized from vault");
      return {
        status: "success",
        message: "Repository initialized",
        commitSha: commit.id,
        dirtyPaths,
      };
    } catch (error) {
      const message = errorMessage(error);
      await this.options.logger?.error("Initialize empty remote failed", { message });
      this.options.notice?.(`Error initializing repository. ${message}`);
      return { status: "error", message };
    } finally {
      progress?.hide?.();
      this.syncing = false;
    }
  }

  async sync(trigger: SyncTrigger): Promise<SyncResult> {
    if (this.syncing) {
      this.options.notice?.("Sync already running");
      return { status: "already-running", message: "Sync already running", trigger };
    }

    this.syncing = true;
    const progress = this.options.createProgressNotice?.("Checking GitLab…");
    try {
      return await this.syncLocked(trigger, progress);
    } finally {
      progress?.hide?.();
      this.syncing = false;
    }
  }

  private async syncLocked(
    trigger: SyncTrigger,
    progress?: ProgressNotice,
  ): Promise<SyncResult> {
    try {
      this.setProgress(progress, "Checking GitLab…");
      const recovered = await this.recoverIfNeeded();
      if (recovered) {
        this.setProgress(progress, "Sync complete");
        this.options.notice?.("Sync complete");
        return {
          status: "success",
          trigger,
          recovered: true,
          message: "Recovered pending sync",
        };
      }

      const data = await this.options.stateStore.load();
      this.validateInitialized(data);

      const deferredRetryAt = this.remoteBackoffRetryAt(data.state);
      if (deferredRetryAt !== null) {
        this.setProgress(progress, "Sync deferred");
        return {
          status: "deferred",
          trigger,
          retryAt: deferredRetryAt,
          message: "Sync deferred until GitLab backoff expires",
        };
      }

      const settings = this.validateSettings(this.options.settings ?? data.settings);
      await this.logGitLabTarget("Sync target", settings);
      const token = await this.readToken(settings);
      const client = this.createClient(settings, token);

      const firstBranch = await client.getBranch();
      this.validateBranch(firstBranch);

      if (trigger !== "audit") {
        const resumable = this.resumableRemoteApply(data.state, firstBranch.commit.id);
        if (resumable) {
          return await this.resumeRemoteApply(trigger, firstBranch.commit.id, resumable, client, progress);
        }
      }

      if (trigger === "audit") {
        await this.auditLocalChanges();
      }

      this.setProgress(progress, "Finding remote changes…");
      const result = await this.planAndApply({
        trigger,
        settings,
        client,
        firstRemoteSha: firstBranch.commit.id,
        progress,
      });
      this.options.notice?.("Sync complete");
      return result;
    } catch (error) {
      const message = errorMessage(error);
      await this.markError();
      await this.options.logger?.error("Sync failed", { message });
      this.options.notice?.(`Error syncing. ${message}`);
      return {
        status: "error",
        trigger,
        message,
        attempts: error instanceof BranchRaceError ? error.attempts : undefined,
      };
    }
  }

  private async planAndApply(input: {
    trigger: SyncTrigger;
    settings: GitLabSyncSettings;
    client: GitLabClientLike;
    firstRemoteSha: string;
    progress?: ProgressNotice;
  }): Promise<SyncResult> {
    let remoteSha = input.firstRemoteSha;
    let attempt = 1;

    while (attempt <= MAX_PLAN_ATTEMPTS) {
      const data = await this.options.stateStore.load();
      const baseSha = data.state.lastSyncedCommitSha;
      if (baseSha === null) {
        throw new Error("Sync is not initialized");
      }

      // One memoized remote reader per plan attempt so conflict planning and
      // optimistic locking never re-read the same ref/path twice.
      const getRemoteVersion = this.memoizedRemoteVersion(input.client);

      const ignoreMatcher = this.createIgnoreMatcher();
      await ignoreMatcher.reload();
      const remoteDiff = this.createRemoteDiffService(input.client);
      const remote = await remoteDiff.discover({
        baseSha,
        remoteSha,
        baseIndex: data.state.trackedFiles,
      });
      const trackedFiles = remote.remoteTree ?? data.state.trackedFiles;
      const dirtyEntries = this.filteredDirtyEntries(
        data.state.dirtyEntries,
        trackedFiles,
        ignoreMatcher,
        input.trigger,
      );
      const snapshotService = this.createLocalSnapshotService(input.client, ignoreMatcher);

      this.setProgress(input.progress, "Saving local changes…");
      const localSnapshots = await snapshotService.snapshot(dirtyEntries, trackedFiles);
      this.setProgress(input.progress, "Resolving conflicts…");
      const planner = this.createPlanner(input.client, input.settings, getRemoteVersion);
      const plan = await planner.plan({
        baseSha,
        remoteSha,
        trackedFiles,
        dirtyEntries,
        remoteChanges: remote.changes,
        localSnapshots,
        now: this.nowDate(),
        streamRemoteOnly: true,
      });

      if (plan.actions.length === 0) {
        return await this.applyRemoteOnlyPlan(input.trigger, remoteSha, plan, input.client, input.progress);
      }

      const branchBeforeCommit = await input.client.getBranch();
      this.validateBranch(branchBeforeCommit);
      if (branchBeforeCommit.commit.id !== remoteSha) {
        attempt += 1;
        if (attempt > MAX_PLAN_ATTEMPTS) {
          throw new BranchRaceError(MAX_PLAN_ATTEMPTS);
        }
        remoteSha = branchBeforeCommit.commit.id;
        continue;
      }

      this.setProgress(input.progress, "Creating GitLab commit…");
      const createdCommit = await input.client.createCommit({
        message: this.commitMessage(input.trigger, input.settings),
        actions: plan.actions,
      });
      const finalizedPlan = await this.planForActualCreatedCommit(
        input.client,
        input.settings,
        baseSha,
        createdCommit,
        plan,
        getRemoteVersion,
      );
      const transaction = this.pendingTransaction(createdCommit.id, finalizedPlan);
      await this.persistPendingTransaction(transaction);

      this.setProgress(input.progress, "Updating local vault…");
      await this.getMaterializer().apply(transaction.materializeOperations);
      await this.finalizeTransaction(transaction);
      this.setProgress(input.progress, "Sync complete");

      return {
        status: transaction.conflictPaths.length > 0 ? "conflict" : "success",
        trigger: input.trigger,
        message: "Sync complete",
        commitSha: createdCommit.id,
        attempts: attempt,
      };
    }

    throw new BranchRaceError(MAX_PLAN_ATTEMPTS);
  }

  private async planForActualCreatedCommit(
    client: GitLabClientLike,
    settings: GitLabSyncSettings,
    baseSha: string,
    createdCommit: CreatedGitLabCommit,
    plan: SyncPlan,
    getRemoteVersion: (path: string, remoteSha: string) => Promise<VersionState>,
  ): Promise<SyncPlan> {
    if (createdCommit.parent_ids.includes(plan.basedOnRemoteSha)) {
      return plan;
    }

    const actualParent = createdCommit.parent_ids[0];
    if (!actualParent) {
      return plan;
    }

    const remoteDiff = this.createRemoteDiffService(client);
    const actual = await remoteDiff.discover({
      baseSha: actualParent,
      remoteSha: createdCommit.id,
      baseIndex: plan.nextTrackedFiles,
    });
    if (actual.changes.length === 0) {
      return plan;
    }

    const planner = this.createPlanner(client, settings, getRemoteVersion);
    return await planner.plan({
      baseSha,
      remoteSha: createdCommit.id,
      trackedFiles: plan.nextTrackedFiles,
      dirtyEntries: [],
      remoteChanges: actual.changes,
      localSnapshots: [],
      now: this.nowDate(),
    });
  }

  private async applyRemoteOnlyPlan(
    trigger: SyncTrigger,
    remoteSha: string,
    plan: SyncPlan,
    client: GitLabClientLike,
    progress?: ProgressNotice,
  ): Promise<SyncResult> {
    this.setProgress(progress, "Updating local vault…");
    const finalIndex = await this.getJournal().suppress(async () => {
      const applier = this.getStreamingApplier(client);
      return await applier.applyStream({
        changes: plan.streamChanges,
        remoteSha,
        baseIndex: plan.nextTrackedFiles,
        onProgress: async ({ remainingChanges, nextTrackedFiles }) => {
          const applied = plan.streamChanges.length - remainingChanges.length;
          this.setProgress(progress, `Updating local vault… ${applied}/${plan.streamChanges.length}`);
          await this.options.stateStore.update((data) => {
            data.state.remoteApply = { remoteSha, remainingChanges, nextTrackedFiles };
          });
        },
      });
    });

    await this.options.stateStore.update((data) => {
      data.state.lastSyncedCommitSha = remoteSha;
      data.state.trackedFiles = cloneTrackedFiles(finalIndex);
      for (const path of plan.acknowledgedDirtyPaths) {
        delete data.state.dirtyEntries[normalizePath(path)];
      }
      data.state.pendingTransaction = null;
      data.state.lastSyncAt = this.now();
      data.state.lastSyncResult = plan.conflictPaths.length > 0 ? "conflict" : "success";
      data.state.remoteBackoffUntil = null;
      data.state.remoteBackoffReason = null;
      data.state.remoteApply = null;
    });

    this.setProgress(progress, "Sync complete");
    return {
      status: plan.conflictPaths.length > 0 ? "conflict" : "success",
      trigger,
      message: "Sync complete",
      commitSha: remoteSha,
      attempts: 1,
    };
  }

  private resumableRemoteApply(
    state: LocalSyncState,
    remoteSha: string,
  ): RemoteApply | null {
    const resume = state.remoteApply;
    if (resume === null) {
      return null;
    }
    return resume.remoteSha === remoteSha ? resume : null;
  }

  private async resumeRemoteApply(
    trigger: SyncTrigger,
    remoteSha: string,
    resume: RemoteApply,
    client: GitLabClientLike,
    progress?: ProgressNotice,
  ): Promise<SyncResult> {
    this.setProgress(progress, "Updating local vault…");
    // Build the dirty-path set once from the current persisted state. A user edit made after
    // the crash but still present in the resume tail must NOT be clobbered by materializing the
    // remote version over it; the dirty entry survives and the next normal sync re-plans it
    // (conflict resolution). For the pure crash case dirtyEntries is empty, so this is zero-cost.
    const loaded = await this.options.stateStore.load();
    const dirtyPaths = new Set<string>(
      Object.keys(loaded.state.dirtyEntries ?? {}).map((path) => normalizePath(path)),
    );
    const changes = this.excludeDirtyChanges(resume.remainingChanges, dirtyPaths);
    const finalIndex = await this.getJournal().suppress(async () => {
      const applier = this.getStreamingApplier(client);
      return await applier.applyStream({
        changes,
        remoteSha,
        baseIndex: resume.nextTrackedFiles,
        onProgress: async ({ remainingChanges, nextTrackedFiles }) => {
          const applied = changes.length - remainingChanges.length;
          this.setProgress(progress, `Updating local vault… ${applied}/${changes.length}`);
          await this.options.stateStore.update((data) => {
            data.state.remoteApply = { remoteSha, remainingChanges, nextTrackedFiles };
          });
        },
      });
    });

    await this.options.stateStore.update((data) => {
      data.state.lastSyncedCommitSha = remoteSha;
      data.state.trackedFiles = cloneTrackedFiles(finalIndex);
      data.state.pendingTransaction = null;
      data.state.lastSyncAt = this.now();
      data.state.lastSyncResult = "success";
      data.state.remoteBackoffUntil = null;
      data.state.remoteBackoffReason = null;
      data.state.remoteApply = null;
    });

    this.setProgress(progress, "Sync complete");
    return {
      status: "success",
      trigger,
      message: "Sync complete",
      commitSha: remoteSha,
      attempts: 1,
    };
  }

  /**
   * Drops any change whose path (or either rename path) is currently dirty locally. Such a
   * change is not materialized during resume so a user's edit made after a crash is preserved;
   * the surviving dirty entry is re-planned by the next normal sync instead of being silently
   * acknowledged away.
   */
  private excludeDirtyChanges(
    changes: RemoteChange[],
    dirtyPaths: Set<string>,
  ): RemoteChange[] {
    return changes.filter((change) => {
      const paths =
        change.type === "rename"
          ? [change.oldPath, change.newPath]
          : [change.path];
      return !paths.some((path) => dirtyPaths.has(normalizePath(path)));
    });
  }

  private pendingTransaction(
    committedSha: string,
    plan: SyncPlan,
  ): PendingTransaction {
    return {
      transactionId: `${committedSha}-${this.now().toString(36)}`,
      committedSha,
      materializeOperations: plan.materializeAfterCommit,
      nextTrackedFiles: cloneTrackedFiles(plan.nextTrackedFiles),
      acknowledgedDirtyPaths: [...plan.acknowledgedDirtyPaths],
      conflictPaths: [...plan.conflictPaths],
      createdAt: this.now(),
    };
  }

  private async persistPendingTransaction(transaction: PendingTransaction): Promise<void> {
    await this.options.stateStore.update((data) => {
      data.state.pendingTransaction = transaction;
    });
  }

  private async finalizeTransaction(transaction: PendingTransaction): Promise<void> {
    await this.options.stateStore.update((data) => {
      data.state.lastSyncedCommitSha = transaction.committedSha;
      data.state.trackedFiles = cloneTrackedFiles(transaction.nextTrackedFiles);
      for (const path of transaction.acknowledgedDirtyPaths) {
        delete data.state.dirtyEntries[normalizePath(path)];
      }
      data.state.pendingTransaction = null;
      data.state.lastSyncAt = this.now();
      data.state.lastSyncResult = transaction.conflictPaths.length > 0 ? "conflict" : "success";
      data.state.remoteBackoffUntil = null;
      data.state.remoteBackoffReason = null;
    });
  }

  private filteredDirtyEntries(
    dirtyEntries: Record<string, DirtyEntry>,
    trackedFiles: Record<string, TrackedFile>,
    ignoreMatcher: IgnoreMatcherLike,
    trigger: SyncTrigger,
  ): DirtyEntry[] {
    const entries = Object.values(dirtyEntries)
      .map((entry) => ({ ...entry, path: normalizePath(entry.path) }))
      .sort((left, right) => left.path.localeCompare(right.path));

    if (trigger === "audit") {
      return entries;
    }

    return entries.filter((entry) => {
      if (trackedFiles[entry.path]) {
        return true;
      }
      return !ignoreMatcher.isIgnored(entry.path, trackedFiles);
    });
  }

  private validateInitialized(data: PluginData): void {
    if (!data.state.initialized || data.state.lastSyncedCommitSha === null) {
      throw new Error("Sync is not initialized");
    }
  }

  private validateSettings(settings: GitLabSyncSettings): GitLabSyncSettings {
    if (!settings.gitlabBaseUrl.trim()) {
      throw new Error("GitLab base URL is missing");
    }
    if (!settings.gitlabBaseUrl.trim().startsWith("https://")) {
      throw new Error("GitLab base URL must use HTTPS");
    }
    if (!settings.projectPath.trim()) {
      throw new Error("GitLab project is missing");
    }
    if (!settings.branch.trim()) {
      throw new Error("GitLab branch is missing");
    }
    if (!settings.tokenSecretName.trim()) {
      throw new Error("GitLab token secret name is missing");
    }
    return {
      ...settings,
      gitlabBaseUrl: settings.gitlabBaseUrl.trim().replace(/\/+$/, ""),
      projectPath: settings.projectPath.trim(),
      branch: settings.branch.trim(),
      tokenSecretName: settings.tokenSecretName.trim(),
      conflictStrategy: normalizeConflictStrategy(settings.conflictStrategy),
    };
  }

  private async readToken(settings: GitLabSyncSettings): Promise<string> {
    const token = await (this.options.getToken ?? this.defaultGetToken.bind(this))(settings);
    if (!token?.trim()) {
      throw new Error("GitLab token is missing");
    }
    return token.trim();
  }

  private async logGitLabTarget(message: string, settings: GitLabSyncSettings): Promise<void> {
    await this.options.logger?.info(message, {
      gitlabBaseUrl: settings.gitlabBaseUrl,
      projectPath: settings.projectPath,
      branch: settings.branch,
      apiProjectUrl: `${settings.gitlabBaseUrl}/api/v4/projects/${encodeURIComponent(settings.projectPath)}`,
    });
  }

  private async defaultGetToken(settings: GitLabSyncSettings): Promise<string | null> {
    if (!this.options.app) {
      return null;
    }
    return await this.options.app.secretStorage.getSecret(settings.tokenSecretName);
  }

  private validateBranch(branch: GitLabBranch): void {
    if (!branch.can_push) {
      throw new Error("GitLab branch does not allow pushes");
    }
  }

  private createClient(settings: GitLabSyncSettings, token: string): GitLabClientLike {
    return this.options.createGitLabClient?.(settings, token) ?? new GitLabClient(settings, token, {
      onRequest: async (diagnostic) => {
        await this.options.logger?.debug("GitLab request", diagnostic);
      },
      onArchiveDiagnostic: async (diagnostic) => {
        await this.options.logger?.debug("GitLab archive transport", diagnostic);
      },
      sleep: this.options.sleep,
      now: this.options.now,
      requestScheduler: this.getScheduler(),
      onBackoff: async (diagnostic) => {
        await this.options.logger?.warn("GitLab backoff", diagnostic);
        await this.persistBackoff(diagnostic.reason, diagnostic.retryAt);
      },
    });
  }

  private createRemoteDiffService(client: GitLabClientLike): RemoteDiffLike {
    if (this.options.createRemoteDiffService) {
      return this.options.createRemoteDiffService(client, this.isHardExcluded.bind(this));
    }
    return new RemoteDiffService(this.requireRemoteDiffClient(client), this.isHardExcluded.bind(this));
  }

  private requireRemoteDiffClient(client: GitLabClientLike): RemoteDiffClient {
    if (!isRemoteDiffClient(client)) {
      throw new Error("GitLab client does not support remote diff discovery");
    }
    return client;
  }

  private createIgnoreMatcher(): IgnoreMatcherLike {
    if (this.options.createIgnoreMatcher) {
      return this.options.createIgnoreMatcher();
    }
    if (!this.options.vault) {
      throw new Error("Vault is required for ignore matching");
    }
    return new IgnoreMatcher(this.options.vault);
  }

  private createLocalSnapshotService(
    client: GitLabClientLike,
    ignoreMatcher: IgnoreMatcherLike,
  ): LocalSnapshotLike {
    if (this.options.createLocalSnapshotService) {
      return this.options.createLocalSnapshotService(client, ignoreMatcher);
    }
    if (!this.options.vault) {
      throw new Error("Vault is required for local snapshots");
    }
    return new LocalSnapshotService(
      this.options.vault,
      (blobId) => client.getRawBlob(blobId),
      (path, trackedFiles) => ignoreMatcher.isIgnored(path, trackedFiles),
    );
  }

  private createPlanner(
    client: GitLabClientLike,
    settings: GitLabSyncSettings,
    getRemoteVersion: (path: string, remoteSha: string) => Promise<VersionState>,
  ): PlannerLike {
    return this.options.createPlanner?.(client, settings, getRemoteVersion) ?? new SyncPlanner({
      getRemoteVersion,
      deviceName: deviceLabel(settings.authorName, this.platform()),
      conflictStrategy: settings.conflictStrategy,
    });
  }

  private getJournal(plugin?: Plugin): JournalLike {
    if (this.options.journal) {
      return this.options.journal;
    }
    if (!this.journal) {
      if (!this.options.vault) {
        throw new Error("Vault is required for change journal");
      }
      this.journal = new ChangeJournal({
        vault: this.options.vault,
        stateStore: this.options.stateStore as StateStore,
        plugin: plugin ?? this.options.plugin,
      });
    }
    return this.journal;
  }

  private getMaterializer(): MaterializerLike {
    if (this.options.materializer) {
      return this.options.materializer;
    }
    if (!this.materializer) {
      if (!this.options.vault) {
        throw new Error("Vault is required for local materialization");
      }
      this.materializer = new LocalMaterializer({
        vault: this.options.vault,
        stateStore: this.options.stateStore as StateStore,
        journal: this.getJournal(),
        logger: this.options.logger,
      });
    }
    return this.materializer;
  }

  private getStreamingApplier(
    client: GitLabClientLike,
  ): StreamingRemoteApplier {
    return this.options.createStreamingApplier?.(
      client,
      this.getMaterializer(),
    ) ?? new StreamingRemoteApplier({
      client,
      materializer: {
        applyBytes: (operations) => this.getMaterializer().applyBytes(operations),
      },
      vault: this.options.vault
        ? {
          exists: (path) => this.options.vault!.adapter.exists(path),
          readBinary: (path) => this.options.vault!.adapter.readBinary(path),
        }
        : undefined,
    });
  }

  private async markError(): Promise<void> {
    try {
      await this.options.stateStore.update((data) => {
        data.state.lastSyncAt = this.now();
        data.state.lastSyncResult = "error";
      });
    } catch (error) {
      await this.options.logger?.warn("Failed to persist sync error state", {
        message: errorMessage(error),
      });
    }
  }

  async listSyncableLocalFiles(): Promise<string[]> {
    if (!this.options.vault) {
      return [];
    }
    const ignoreMatcher = this.createIgnoreMatcher();
    await ignoreMatcher.reload();
    const localFiles = await this.listLocalFiles("", ignoreMatcher);
    // Empty tracked-files map: this lists what a fresh sync would push, so no file is yet tracked.
    return localFiles.filter((path) => !ignoreMatcher.isIgnored(path, {})).sort();
  }

  private async auditLocalChanges(): Promise<void> {
    if (!this.options.vault) {
      return;
    }
    const data = await this.options.stateStore.load();
    const ignoreMatcher = this.createIgnoreMatcher();
    await ignoreMatcher.reload();
    const localFiles = await this.listLocalFiles("", ignoreMatcher);
    const localSet = new Set(localFiles);
    const journal = this.getJournal();

    for (const [path, tracked] of Object.entries(data.state.trackedFiles)) {
      if (!localSet.has(path)) {
        await journal.recordDelete?.(path);
        continue;
      }
      const bytes = new Uint8Array(await this.options.vault.adapter.readBinary(path));
      if ((await calculateGitBlobId(bytes)) !== tracked.blobId) {
        await journal.recordUpsert?.(path);
      }
    }

    for (const path of localFiles) {
      if (data.state.trackedFiles[path] || ignoreMatcher.isIgnored(path, data.state.trackedFiles)) {
        continue;
      }
      await journal.recordUpsert?.(path);
    }
  }

  private async listLocalFiles(dir: string, ignoreMatcher?: IgnoreMatcherLike): Promise<string[]> {
    if (!this.options.vault) {
      return [];
    }
    const { files, folders } = await this.options.vault.adapter.list(dir);
    const visibleFiles = files.map((path) => normalizePath(path)).filter((path) => !this.isHardExcluded(path));
    for (const folder of folders.map((path) => normalizePath(path)).filter((path) => !this.isHardExcluded(path))) {
      // Prune ignored directories during descent so their contents are never
      // listed/stat-ed (avoids aborting on broken symlinks inside them).
      if (ignoreMatcher?.isDirIgnored?.(folder)) {
        continue;
      }
      visibleFiles.push(...(await this.listLocalFiles(folder, ignoreMatcher)));
    }
    return visibleFiles.sort();
  }

  private commitMessage(trigger: SyncTrigger, settings: GitLabSyncSettings): string {
    const label = commitDeviceLabel(settings.authorName, this.platform());
    if (trigger === "audit" || trigger === "foreground" || trigger === "background") {
      return `Sync vault from ${label} ${trigger}`;
    }
    return `Sync vault from ${label}`;
  }

  private platform(): DevicePlatform {
    return this.options.platform ?? Platform;
  }

  private setProgress(progress: ProgressNotice | undefined, message: string): void {
    progress?.setMessage?.(message);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private remoteBackoffRetryAt(state: LocalSyncState): number | null {
    if (state.remoteBackoffUntil === null) {
      return null;
    }
    return this.now() < state.remoteBackoffUntil ? state.remoteBackoffUntil : null;
  }

  private async persistBackoff(
    reason: NonNullable<LocalSyncState["remoteBackoffReason"]>,
    until: number,
  ): Promise<void> {
    await this.options.stateStore.update((data) => {
      data.state.remoteBackoffUntil = until;
      data.state.remoteBackoffReason = reason;
    });
  }

  private memoizedRemoteVersion(
    client: GitLabClientLike,
  ): (path: string, remoteSha: string) => Promise<VersionState> {
    const cache = new Map<string, Promise<VersionState>>();
    return (path, remoteSha) => {
      const key = `${remoteSha}\0${path}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = client
          .getRawFile(path, remoteSha)
          .then((buffer) => versionFromArrayBuffer(buffer));
        cache.set(key, pending);
      }
      return pending;
    };
  }

  private nowDate(): Date {
    return this.options.nowDate?.() ?? new Date();
  }

  private isHardExcluded(path: string): boolean {
    const vault = this.options.vault;
    if (!vault) {
      return false;
    }
    const normalized = normalizePath(path);
    const configDir = normalizePath(vault.configDir);
    const runtimeDir = `${configDir}/plugins/gitlab-gitless-sync/`;
    return (
      normalized === ".git" ||
      normalized.startsWith(".git/") ||
      normalized === `${configDir}/gitlab-gitless-sync.log` ||
      isMetadataPath(normalized) ||
      normalized === `${configDir}/plugins/gitlab-gitless-sync` ||
      normalized.startsWith(runtimeDir)
    );
  }
}

function isRemoteDiffClient(client: GitLabClientLike): client is GitLabClientLike & RemoteDiffClient {
  return typeof (client as Partial<RemoteDiffClient>).compare === "function";
}

export default SyncManager;

function versionFromArrayBuffer(buffer: ArrayBuffer | null): VersionState {
  if (buffer === null) {
    return { exists: false, bytes: null };
  }
  return { exists: true, bytes: new Uint8Array(buffer) };
}

function cloneTrackedFiles(
  trackedFiles: Record<string, TrackedFile>,
): Record<string, TrackedFile> {
  return Object.fromEntries(
    Object.entries(trackedFiles).map(([path, file]) => [path, { ...file }]),
  );
}

function treeToTrackedFiles(
  tree: GitLabTreeItem[],
  isHardExcluded: (path: string) => boolean,
): Record<string, TrackedFile> {
  return Object.fromEntries(
    tree
      .filter((item) => item.type === "blob" && !isHardExcluded(normalizePath(item.path)))
      .map((item) => [
        normalizePath(item.path),
        {
          blobId: item.id,
          mode: item.mode,
          size: 0,
        },
      ]),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeConflictStrategy(
  strategy: GitLabSyncSettings["conflictStrategy"],
): GitLabSyncSettings["conflictStrategy"] {
  if (
    strategy === "local" ||
    strategy === "auto-remote" ||
    strategy === "auto-local"
  ) {
    return strategy;
  }
  return "remote";
}

class BranchRaceError extends Error {
  constructor(readonly attempts: number) {
    super("GitLab branch changed during sync; retry later");
  }
}

function isMetadataPath(path: string): boolean {
  return path.endsWith("github-sync-metadata.json") ||
    path.endsWith("gitlab-sync-metadata.json");
}
