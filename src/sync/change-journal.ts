import { normalizePath, type EventRef, type TAbstractFile } from "obsidian";
import type { StateStore } from "./state-store";
import type { DirtyEntry, LocalSyncState } from "./types";

interface ChangeJournalVault {
  configDir: string;
  on(name: "create" | "modify" | "delete", callback: (file: TAbstractFile) => void): EventRef;
  on(name: "rename", callback: (file: TAbstractFile, oldPath: string) => void): EventRef;
}

interface ChangeJournalPlugin {
  registerEvent(ref: EventRef): void;
}

export interface ChangeJournalOptions {
  vault: ChangeJournalVault;
  stateStore: Pick<StateStore, "update" | "load">;
  plugin?: ChangeJournalPlugin;
  pluginId?: string;
  now?: () => number;
}

export class ChangeJournal {
  private readonly pluginId: string;
  private readonly now: () => number;
  private suppressDepth = 0;
  private started = false;
  private pendingWrite: Promise<void> = Promise.resolve();
  private entries: Record<string, DirtyEntry> = {};

  constructor(private options: ChangeJournalOptions) {
    this.pluginId = options.pluginId ?? "gitlab-gitless-sync";
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const { vault, plugin } = this.options;
    const refs = [
      vault.on("create", (file) => void this.recordUpsert(file.path)),
      vault.on("modify", (file) => void this.recordUpsert(file.path)),
      vault.on("delete", (file) => void this.recordDelete(file.path)),
      vault.on("rename", (file, oldPath) => void this.recordRename(oldPath, file.path)),
    ];
    refs.forEach((ref) => plugin?.registerEvent(ref));
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.pendingWrite;
    await this.refreshEntries();
  }

  async suppress<T>(operation: () => Promise<T>): Promise<T> {
    this.suppressDepth += 1;
    try {
      return await operation();
    } finally {
      this.suppressDepth -= 1;
    }
  }

  async recordUpsert(path: string): Promise<void> {
    await this.record(path, "upsert");
  }

  async recordDelete(path: string): Promise<void> {
    await this.record(path, "delete");
  }

  async recordRename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    if (
      this.suppressDepth > 0 ||
      (this.isHardExcluded(normalizedOldPath) && this.isHardExcluded(normalizedNewPath))
    ) {
      return;
    }

    this.pendingWrite = this.pendingWrite
      .then(() =>
        this.options.stateStore.update((data) => {
          if (!this.isHardExcluded(normalizedOldPath)) {
            applyDirtyEntry(data.state, normalizedOldPath, "delete", this.now());
          }
          if (!this.isHardExcluded(normalizedNewPath)) {
            applyDirtyEntry(data.state, normalizedNewPath, "upsert", this.now());
          }
          this.entries = { ...data.state.dirtyEntries };
        }),
      )
      .then(() => undefined);
    await this.pendingWrite;
  }

  list(): DirtyEntry[] {
    return Object.values(this.entries).sort((a, b) => a.path.localeCompare(b.path));
  }

  async acknowledge(paths: string[]): Promise<void> {
    const normalized = new Set(paths.map((path) => normalizePath(path)));
    await this.options.stateStore.update((data) => {
      for (const path of normalized) {
        delete data.state.dirtyEntries[path];
      }
      this.entries = { ...data.state.dirtyEntries };
    });
  }

  private async record(path: string, operation: "upsert" | "delete"): Promise<void> {
    const normalized = normalizePath(path);
    if (this.suppressDepth > 0 || this.isHardExcluded(normalized)) {
      return;
    }

    this.pendingWrite = this.pendingWrite
      .then(() =>
        this.options.stateStore.update((data) => {
          applyDirtyEntry(data.state, normalized, operation, this.now());
          this.entries = { ...data.state.dirtyEntries };
        }),
      )
      .then(() => undefined);
    await this.pendingWrite;
  }

  private async refreshEntries(): Promise<void> {
    const data = await this.options.stateStore.load();
    this.entries = { ...data.state.dirtyEntries };
  }

  private isHardExcluded(path: string): boolean {
    const configDir = normalizePath(this.options.vault.configDir);
    const runtimeDir = `${configDir}/plugins/${this.pluginId}/`;
    return (
      path === ".git" ||
      path.startsWith(".git/") ||
      path === `${configDir}/gitlab-gitless-sync.log` ||
      isMetadataPath(path) ||
      path === `${configDir}/plugins/${this.pluginId}` ||
      path.startsWith(runtimeDir)
    );
  }
}

function isMetadataPath(path: string): boolean {
  return path.endsWith("github-sync-metadata.json") ||
    path.endsWith("gitlab-sync-metadata.json");
}

function applyDirtyEntry(
  state: LocalSyncState,
  path: string,
  operation: "upsert" | "delete",
  recordedAt: number,
): void {
  const existing = state.dirtyEntries[path];
  const tracked = Boolean(state.trackedFiles[path]);

  if (operation === "delete" && existing?.operation === "upsert" && !tracked) {
    delete state.dirtyEntries[path];
    return;
  }

  state.dirtyEntries[path] = {
    path,
    operation,
    recordedAt,
  };
}
