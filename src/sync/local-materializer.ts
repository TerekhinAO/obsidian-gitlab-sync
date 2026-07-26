import { normalizePath } from "obsidian";
import type { StateStore } from "./state-store";
import type { MaterializeOperation } from "./types";

interface MaterializerVault {
  configDir: string;
  adapter: {
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    remove(path: string): Promise<void>;
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
    });
  }

  async recoverPendingTransaction(): Promise<boolean> {
    const data = await this.options.stateStore.load();
    const pending = data.state.pendingTransaction;
    if (pending === null) {
      return false;
    }

    await this.apply(pending.materializeOperations);
    await this.options.stateStore.update((nextData) => {
      const transaction = nextData.state.pendingTransaction;
      if (transaction === null) {
        return;
      }

      nextData.state.lastSyncedCommitSha = transaction.committedSha;
      nextData.state.trackedFiles = cloneTrackedFiles(transaction.nextTrackedFiles);
      for (const path of transaction.acknowledgedDirtyPaths) {
        delete nextData.state.dirtyEntries[normalizePath(path)];
      }
      nextData.state.pendingTransaction = null;
      nextData.state.lastSyncAt = this.now();
      nextData.state.lastSyncResult = transaction.conflictPaths.length > 0 ? "conflict" : "success";
    });

    return true;
  }

  private async write(operation: MaterializeOperation): Promise<void> {
    if (operation.contentBase64 === undefined) {
      throw new Error(`Write operation for ${operation.path} is missing contentBase64`);
    }

    const path = normalizePath(operation.path);
    const bytes = decodeBase64(operation.contentBase64);
    await this.ensureParentFolders(path);

    if (this.options.vault.adapter.rename === undefined) {
      await this.options.vault.adapter.writeBinary(path, bytes);
      return;
    }

    const tempPath = this.tempSiblingPath(path);
    await this.options.vault.adapter.writeBinary(tempPath, bytes);

    try {
      await this.options.vault.adapter.rename(tempPath, path);
    } catch (error) {
      await this.options.vault.adapter.writeBinary(path, bytes);
      await this.removeIfExists(tempPath);
    }
  }

  private async delete(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!(await this.options.vault.adapter.exists(normalized))) {
      return;
    }
    await this.options.vault.adapter.remove(normalized);
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
