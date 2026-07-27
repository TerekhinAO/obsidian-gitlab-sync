import { normalizePath, type App, type Plugin, type Vault } from "obsidian";
import { GitLabClient } from "../gitlab/client";
import type { CreatedGitLabCommit, GitLabBranch, GitLabTreeItem } from "../gitlab/types";
import type Logger from "../logger";
import { ChangeJournal } from "./change-journal";
import { IgnoreMatcher } from "./ignore-matcher";
import { LocalMaterializer } from "./local-materializer";
import { LocalSnapshotService, type VersionState } from "./local-snapshot";
import { calculateGitBlobId } from "./conflict-resolver";
import { RemoteDiffService, type RemoteChange } from "./remote-diff";
import { StateStore } from "./state-store";
import { SyncPlanner, type SyncPlan } from "./sync-planner";
import type {
  DirtyEntry,
  GitLabSyncSettings,
  MaterializeOperation,
  PendingTransaction,
  PluginData,
  TrackedFile,
} from "./types";

export interface SyncResult {
  status: "success" | "conflict" | "error" | "already-running";
  trigger: SyncTrigger;
  message: string;
  commitSha?: string;
  recovered?: boolean;
  attempts?: number;
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
  ): Promise<unknown[]>;
}

interface PlannerLike {
  plan(input: {
    baseSha: string;
    remoteSha: string;
    trackedFiles: Record<string, TrackedFile>;
    dirtyEntries: DirtyEntry[];
    remoteChanges: RemoteChange[];
    localSnapshots: any[];
    now: Date;
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
  createPlanner?: (client: GitLabClientLike, settings: GitLabSyncSettings) => PlannerLike;
  journal?: JournalLike;
  materializer?: MaterializerLike;
  now?: () => number;
  nowDate?: () => Date;
  notice?: (message: string) => void;
  createProgressNotice?: (message: string) => ProgressNotice;
}

const MAX_PLAN_ATTEMPTS = 2;

export class SyncManager {
  private syncing = false;
  private journal?: JournalLike;
  private materializer?: MaterializerLike;

  constructor(private readonly options: SyncManagerOptions) {}

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
      });
      await this.auditLocalChanges();
      const adopted = await this.options.stateStore.load();
      const dirtyPaths = Object.keys(adopted.state.dirtyEntries).length;
      this.options.notice?.(
        dirtyPaths === 0
          ? "Existing vault adopted"
          : `Existing vault adopted with ${dirtyPaths} local changes`,
      );
      return {
        status: "success",
        message: "Existing vault adopted",
        commitSha: branch.commit.id,
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
      const settings = this.validateSettings(this.options.settings ?? data.settings);
      await this.logGitLabTarget("Sync target", settings);
      const token = await this.readToken(settings);
      const client = this.createClient(settings, token);

      await client.validateAccess?.();
      const firstBranch = await client.getBranch();
      this.validateBranch(firstBranch);

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
      const planner = this.createPlanner(input.client, input.settings);
      const plan = await planner.plan({
        baseSha,
        remoteSha,
        trackedFiles,
        dirtyEntries,
        remoteChanges: remote.changes,
        localSnapshots: localSnapshots as any[],
        now: this.nowDate(),
      });

      if (plan.actions.length === 0) {
        return await this.applyRemoteOnlyPlan(input.trigger, remoteSha, plan, input.progress);
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
        message: this.commitMessage(input.trigger),
        actions: plan.actions,
      });
      const finalizedPlan = await this.planForActualCreatedCommit(
        input.client,
        input.settings,
        baseSha,
        createdCommit,
        plan,
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

    const planner = this.createPlanner(client, settings);
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
    progress?: ProgressNotice,
  ): Promise<SyncResult> {
    this.setProgress(progress, "Updating local vault…");
    await this.getJournal().suppress(async () => {
      await this.getMaterializer().apply(plan.materializeWithoutCommit);
    });
    await this.options.stateStore.update((data) => {
      data.state.lastSyncedCommitSha = remoteSha;
      data.state.trackedFiles = cloneTrackedFiles(plan.nextTrackedFiles);
      for (const path of plan.acknowledgedDirtyPaths) {
        delete data.state.dirtyEntries[normalizePath(path)];
      }
      data.state.pendingTransaction = null;
      data.state.lastSyncAt = this.now();
      data.state.lastSyncResult = plan.conflictPaths.length > 0 ? "conflict" : "success";
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
    const storage = (this.options.app as any)?.secretStorage;
    if (!storage?.getSecret) {
      return null;
    }
    return await storage.getSecret(settings.tokenSecretName);
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
    });
  }

  private createRemoteDiffService(client: GitLabClientLike): RemoteDiffLike {
    return this.options.createRemoteDiffService?.(client, this.isHardExcluded.bind(this)) ??
      new RemoteDiffService(client as any, this.isHardExcluded.bind(this));
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

  private createPlanner(client: GitLabClientLike, settings: GitLabSyncSettings): PlannerLike {
    return this.options.createPlanner?.(client, settings) ?? new SyncPlanner({
      getRemoteVersion: async (path, remoteSha) =>
        versionFromArrayBuffer(await client.getRawFile(path, remoteSha)),
      deviceName: "iPhone",
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
      });
    }
    return this.materializer;
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

  private commitMessage(trigger: SyncTrigger): string {
    if (trigger === "audit") {
      return "Sync vault from iPhone audit";
    }
    if (trigger === "foreground") {
      return "Sync vault from iPhone foreground";
    }
    if (trigger === "background") {
      return "Sync vault from iPhone background";
    }
    return "Sync vault from iPhone";
  }

  private setProgress(progress: ProgressNotice | undefined, message: string): void {
    progress?.setMessage?.(message);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
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
