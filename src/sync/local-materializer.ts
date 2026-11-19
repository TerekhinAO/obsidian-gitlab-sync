import { normalizePath } from "obsidian";
import type Logger from "../logger";
import { acknowledgeTransactionDirtyEntries, sameDirtyEntry } from "./dirty-ack";
import type { StateStore } from "./state-store";
import type {
  ByteMaterializeOperation,
  MaterializeOperation,
  PendingTransaction,
  ProtectedByteMaterializeOperation,
  ProtectedMaterializeOutcome,
} from "./types";

interface MaterializerVault {
  configDir: string;
  createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
  adapter: {
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    readBinary(path: string): Promise<ArrayBuffer>;
    remove(path: string): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    rmdir(path: string, recursive: boolean): Promise<void>;
    rename?(path: string, newPath: string): Promise<void>;
  };
}

interface MaterializerJournal {
  suppress<T>(operation: () => Promise<T>): Promise<T>;
}

export interface LocalMaterializerOptions {
  vault: MaterializerVault;
  stateStore: Pick<StateStore, "load" | "update">;
  journal: MaterializerJournal;
  pluginId?: string;
  now?: () => number;
  logger?: Pick<Logger, "warn">;
}

export class LocalMaterializer {
  private readonly pluginId: string;
  private readonly now: () => number;

  constructor(private options: LocalMaterializerOptions) {
    this.pluginId = options.pluginId ?? "gitlab-gitless-sync";
    this.now = options.now ?? Date.now;
  }

  async apply(operations: MaterializeOperation[]): Promise<void> {
    await this.options.journal.suppress(async () => {
      for (const operation of operations) {
        await this.assertMaterializable(operation.path);
        if (operation.type === "write") {
          await this.write(operation);
        } else {
          await this.delete(operation.path);
        }
      }
      await this.pruneEmptyParents(operations);
    });
  }

  async applyBytes(operations: ByteMaterializeOperation[]): Promise<void> {
    await this.options.journal.suppress(async () => {
      for (const operation of operations) {
        await this.assertMaterializable(operation.path);
        if (operation.type === "write") {
          await this.writeBytes(operation.path, arrayBufferFromBytes(operation.bytes));
        } else {
          await this.delete(operation.path);
        }
      }
      await this.pruneEmptyParents(operations);
    });
  }

  async applyProtectedBytes(
    operations: ProtectedByteMaterializeOperation[],
  ): Promise<ProtectedMaterializeOutcome[]> {
    const outcomes: ProtectedMaterializeOutcome[] = [];
    await this.options.journal.suppress(async () => {
      for (const operation of operations) {
        await this.recoverProtectedBackups(operation.path);
        await this.assertMaterializable(operation.path);
        const applied = operation.type === "write"
          ? await this.protectedWriteBytes(
              operation.path,
              arrayBufferFromBytes(operation.bytes),
              operation.expectedBytes,
            )
          : await this.protectedDeleteBytes(operation.path, operation.expectedBytes);
        outcomes.push({
          path: normalizePath(operation.path),
          operation: "upsert",
          applied,
        });
      }
      await this.pruneEmptyParents(
        operations
          .filter((operation, index) => operation.type === "delete" && outcomes[index]?.applied)
          .map((operation) => operation as { type: "delete"; path: string }),
      );
    });
    return outcomes;
  }

  async recoverPendingTransaction(): Promise<boolean> {
    const data = await this.options.stateStore.load();
    const pending = data.state.pendingTransaction;
    if (pending === null) {
      return false;
    }

    await this.applyTransaction(pending);
    await this.options.stateStore.update((nextData) => {
      const transaction = nextData.state.pendingTransaction;
      if (transaction === null) {
        return;
      }

      nextData.state.lastSyncedCommitSha = transaction.committedSha;
      nextData.state.trackedFiles = cloneTrackedFiles(transaction.nextTrackedFiles);
      acknowledgeTransactionDirtyEntries(nextData, transaction);
      nextData.state.pendingTransaction = null;
      nextData.state.lastSyncAt = this.now();
      nextData.state.lastSyncResult = transaction.conflictPaths.length > 0 ? "conflict" : "success";
    });

    return true;
  }

  async applyTransaction(transaction: PendingTransaction): Promise<void> {
    const data = await this.options.stateStore.load();
    await this.apply(transaction.materializeOperations.filter((operation) => {
      const acknowledged = transaction.acknowledgedDirtyEntries
        ?.find((entry) => entry.path === normalizePath(operation.path));
      if (acknowledged === undefined) {
        return true;
      }
      return sameDirtyEntry(data.state.dirtyEntries[acknowledged.path], acknowledged);
    }));
  }

  private async write(operation: MaterializeOperation): Promise<void> {
    if (operation.contentBase64 === undefined) {
      throw new Error(`Write operation for ${operation.path} is missing contentBase64`);
    }
    await this.writeBytes(operation.path, decodeBase64(operation.contentBase64));
  }

  private async writeBytes(path: string, data: ArrayBuffer): Promise<void> {
    const normalized = normalizePath(path);
    await this.ensureParentFolders(normalized);

    if (this.options.vault.adapter.rename === undefined) {
      await this.options.vault.adapter.writeBinary(normalized, data);
      return;
    }

    const tempPath = this.tempSiblingPath(normalized);
    await this.options.vault.adapter.writeBinary(tempPath, data);

    try {
      await this.options.vault.adapter.rename(tempPath, normalized);
    } catch (error) {
      await this.options.vault.adapter.writeBinary(normalized, data);
      await this.removeIfExists(tempPath);
    }
  }

  private async protectedWriteBytes(
    path: string,
    data: ArrayBuffer,
    expectedBytes: Uint8Array | null,
  ): Promise<boolean> {
    const normalized = normalizePath(path);
    if (this.options.vault.adapter.rename === undefined) {
      // Without rename there is no way to preserve the original for rollback.
      return false;
    }
    if (typeof this.options.vault.createBinary !== "function") {
      // writeBinary is not a no-overwrite installation primitive.
      return false;
    }

    await this.ensureParentFolders(normalized);

    const installBytes = new Uint8Array(data.slice(0));
    const tempPath = this.tempSiblingPath(normalized);
    const backupPath = this.protectedBackupPath(normalized);
    let movedOriginal = false;

    try {
      await this.options.vault.adapter.writeBinary(tempPath, data);
      const current = await this.readOptionalBytes(normalized);
      if (!sameOptionalBytes(current, expectedBytes)) {
        await this.removeIfExists(tempPath);
        return false;
      }

      if (current !== null) {
        // Do not rename the original: Obsidian follows renames and would repoint
        // bookmarks/links to the temporary backup, then lose them when it is deleted.
        await this.options.vault.adapter.writeBinary(
          backupPath,
          arrayBufferFromBytes(current),
        );
        await this.options.vault.adapter.remove(normalized);
        movedOriginal = true;
        const moved = await this.readOptionalBytes(backupPath);
        if (!sameOptionalBytes(moved, expectedBytes)) {
          await this.rollbackProtectedBackup(
            normalized,
            backupPath,
            true,
            undefined,
          );
          await this.removeIfExists(tempPath);
          return false;
        }
      }

      if (await this.options.vault.adapter.exists(normalized)) {
        if (movedOriginal) {
          await this.removeIfExists(backupPath);
        }
        await this.removeIfExists(tempPath);
        return false;
      }

      // createBinary fails when another writer recreated the destination. Unlike
      // rename/writeBinary, it cannot silently replace a user's newer file.
      try {
        await this.options.vault.createBinary(normalized, data);
      } catch (error) {
        await this.rollbackProtectedBackup(
          normalized,
          backupPath,
          movedOriginal,
          installBytes,
        );
        await this.removeIfExists(tempPath);
        return false;
      }
      await this.removeIfExists(tempPath);
    } catch {
      await this.rollbackProtectedBackup(normalized, backupPath, movedOriginal);
      await this.removeIfExists(tempPath);
      return false;
    }

    if (movedOriginal) {
      await this.removeIfExists(backupPath);
    }
    return true;
  }

  private async protectedDeleteBytes(
    path: string,
    expectedBytes: Uint8Array | null,
  ): Promise<boolean> {
    const normalized = normalizePath(path);
    if (this.options.vault.adapter.rename === undefined) {
      return false;
    }

    let movedOriginal = false;
    const backupPath = this.protectedBackupPath(normalized);

    try {
      const current = await this.readOptionalBytes(normalized);
      if (!sameOptionalBytes(current, expectedBytes)) {
        return false;
      }
      if (current === null) {
        return true;
      }

      await this.options.vault.adapter.rename(normalized, backupPath);
      movedOriginal = true;
      const moved = await this.readOptionalBytes(backupPath);
      if (!sameOptionalBytes(moved, expectedBytes)) {
        await this.rollbackProtectedBackup(normalized, backupPath);
        return false;
      }

      if (await this.options.vault.adapter.exists(normalized)) {
        await this.removeIfExists(backupPath);
        return false;
      }

      await this.removeIfExists(backupPath);
      return true;
    } catch {
      await this.rollbackProtectedBackup(normalized, backupPath, movedOriginal);
      return false;
    }
  }

  private async delete(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!(await this.options.vault.adapter.exists(normalized))) {
      return;
    }
    await this.options.vault.adapter.remove(normalized);
  }

  /**
   * Git cannot represent an empty directory, so a remote deletion that removes
   * the last file in a folder would otherwise leave that folder behind forever.
   * Only ancestors of just-deleted paths can have become empty, so the sweep
   * stays proportional to the number of deletions instead of the vault size.
   */
  private async pruneEmptyParents(
    operations: ReadonlyArray<{ type: "write" | "delete"; path: string }>,
  ): Promise<void> {
    const candidates = new Set<string>();
    for (const operation of operations) {
      if (operation.type !== "delete") {
        continue;
      }
      for (
        let directory = parentPath(normalizePath(operation.path));
        directory !== "";
        directory = parentPath(directory)
      ) {
        candidates.add(directory);
      }
    }

    // Deepest first, so `a/b/c` is gone by the time `a/b` is inspected.
    const ordered = [...candidates].sort((left, right) => depth(right) - depth(left));
    for (const directory of ordered) {
      if (this.isPruneProtected(directory)) {
        continue;
      }
      try {
        const listed = await this.options.vault.adapter.list(directory);
        if (listed.files.length > 0 || listed.folders.length > 0) {
          continue;
        }
        // Recursive, because the adapter forwards the flag to `fs.rm`, which
        // rejects every directory with EISDIR when it is false. The `list`
        // check above is what makes this safe, and it does report hidden
        // entries, so nothing can be sitting here unseen.
        await this.options.vault.adapter.rmdir(directory, true);
      } catch (error) {
        // Best effort. The commit already landed remotely, so a failed cleanup
        // must never abort materialization.
        await this.options.logger?.warn("Failed to prune empty folder", {
          path: directory,
          message: errorMessage(error),
        });
      }
    }
  }

  private isPruneProtected(path: string): boolean {
    if (this.isHardExcluded(path)) {
      return true;
    }
    const configDir = normalizePath(this.options.vault.configDir);
    return path === configDir || configDir.startsWith(`${path}/`);
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const parts = normalizePath(path).split("/");
    parts.pop();

    let current = "";
    for (const part of parts) {
      current = current === "" ? part : `${current}/${part}`;
      if (!(await this.options.vault.adapter.exists(current))) {
        await this.options.vault.adapter.mkdir(current);
      }
    }
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.options.vault.adapter.exists(path)) {
      await this.options.vault.adapter.remove(path);
    }
  }

  private async rollbackProtectedBackup(
    originalPath: string,
    backupPath: string,
    movedOriginal = true,
    failedInstallBytes?: Uint8Array,
  ): Promise<void> {
    if (!movedOriginal) {
      return;
    }
    const originalExists = await this.options.vault.adapter.exists(originalPath);
    const backupExists = await this.options.vault.adapter.exists(backupPath);
    if (originalExists) {
      if (failedInstallBytes !== undefined) {
        const current = await this.readOptionalBytes(originalPath);
        const partialInstall =
          current !== null &&
          failedInstallBytes.slice(0, current.byteLength).every(
            (byte, index) => byte === current[index],
          ) &&
          current.byteLength <= failedInstallBytes.byteLength;
        if (partialInstall) {
          // This is our own partial install, not a concurrent user edit.
          await this.removeIfExists(originalPath);
          if (backupExists) {
            await this.options.vault.adapter.rename?.(backupPath, originalPath);
          }
          return;
        }
      }
      // A file at the original path is newer user output. Never replace it, and
      // keep the intact backup so the previous content remains recoverable.
      return;
    }
    if (this.options.vault.adapter.rename === undefined) {
      return;
    }
    if (backupExists) {
      await this.options.vault.adapter.rename(backupPath, originalPath);
    }
  }

  async recoverProtectedBackups(path: string): Promise<void> {
    if (this.options.vault.adapter.rename === undefined) {
      return;
    }
    const normalized = normalizePath(path);
    const backups = await this.listProtectedBackups(normalized);
    if (backups.length === 0) {
      return;
    }

    if (!(await this.options.vault.adapter.exists(normalized))) {
      await this.options.vault.adapter.rename(backups[backups.length - 1]!, normalized);
    }

    for (const backup of backups) {
      // If the original already exists, it is either the completed protected
      // result or a newer user write; in both cases that file wins and the
      // rollback copy is no longer the authoritative version.
      await this.removeIfExists(backup);
    }
  }

  private async listProtectedBackups(path: string): Promise<string[]> {
    const slash = path.lastIndexOf("/");
    const directory = slash === -1 ? "" : path.slice(0, slash);
    const fileName = slash === -1 ? path : path.slice(slash + 1);
    const prefix = `${directory ? `${directory}/` : ""}.${fileName}.gitlab-gitless-sync-`;
    if (directory !== "" && !(await this.options.vault.adapter.exists(directory))) {
      return [];
    }
    const { files } = await this.options.vault.adapter.list(directory);
    return files
      .filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith(".tmp.backup"))
      .sort();
  }

  private async readOptionalBytes(path: string): Promise<Uint8Array | null> {
    if (!(await this.options.vault.adapter.exists(path))) {
      return null;
    }
    return new Uint8Array(await this.options.vault.adapter.readBinary(path));
  }

  private async assertMaterializable(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (this.isHardExcluded(normalized)) {
      throw new Error(`Cannot materialize hard-excluded path: ${normalized}`);
    }
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

  private tempSiblingPath(path: string): string {
    const normalized = normalizePath(path);
    const slash = normalized.lastIndexOf("/");
    const directory = slash === -1 ? "" : `${normalized.slice(0, slash + 1)}`;
    const fileName = slash === -1 ? normalized : normalized.slice(slash + 1);
    return `${directory}.${fileName}.gitlab-gitless-sync-${this.now().toString(36)}.tmp`;
  }

  private protectedBackupPath(path: string): string {
    return `${this.tempSiblingPath(path)}.backup`;
  }
}

function sameOptionalBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function depth(path: string): number {
  return path.split("/").length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeBase64(contentBase64: string): ArrayBuffer {
  if (typeof Buffer !== "undefined") {
    return arrayBufferFromBytes(Buffer.from(contentBase64, "base64"));
  }

  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function isMetadataPath(path: string): boolean {
  return path.endsWith("github-sync-metadata.json") ||
    path.endsWith("gitlab-sync-metadata.json");
}

function cloneTrackedFiles<T extends Record<string, { blobId: string; mode: string; size: number }>>(
  trackedFiles: T,
): T {
  return Object.fromEntries(
    Object.entries(trackedFiles).map(([path, file]) => [path, { ...file }]),
  ) as T;
}
