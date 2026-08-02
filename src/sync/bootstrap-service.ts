import { normalizePath } from "obsidian";
import { BlobReader, type Entry, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { calculateGitBlobId } from "./conflict-resolver";
import type { GitLabClient } from "../gitlab/client";
import type { GitLabBranch, GitLabTreeItem } from "../gitlab/types";
import type { StateStore } from "./state-store";
import type { TrackedFile } from "./types";

const EMPTY_REMOTE_ERROR =
  "The GitLab branch has no commit to import. Create an initial commit in GitLab, then try again.";

interface BootstrapVault {
  configDir: string;
  adapter: {
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    readBinary(path: string): Promise<ArrayBuffer>;
  };
}

export interface ConnectPreview {
  remoteFileCount: number;
  localPushCount: number;
  localPushPaths: string[];
  conflictCount: number;
}

interface BootstrapJournal {
  suppress<T>(operation: () => Promise<T>): Promise<T>;
}

export interface BootstrapServiceOptions {
  vault: BootstrapVault;
  client: Pick<GitLabClient, "getBranch" | "getTree" | "downloadArchive">;
  stateStore: Pick<StateStore, "load" | "update">;
  journal?: BootstrapJournal;
  pluginId?: string;
  now?: () => number;
}

export class BootstrapService {
  private readonly pluginId: string;
  private readonly now: () => number;

  constructor(private options: BootstrapServiceOptions) {
    this.pluginId = options.pluginId ?? "gitlab-gitless-sync";
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<{
    commitSha: string;
    trackedFiles: Record<string, TrackedFile>;
  }> {
    await this.assertVaultEmptyForBootstrap();

    const branch = await this.options.client.getBranch();
    const commitSha = this.commitSha(branch);
    const trackedFiles = treeToTrackedFiles(
      await this.options.client.getTree(commitSha),
      (path) => this.isHardExcluded(path),
    );
    const archive = await this.options.client.downloadArchive(commitSha);
    const operations = await this.readArchive(archive);

    await this.suppressJournal(async () => {
      for (const operation of operations) {
        if (operation.directory) {
          await this.ensureFolder(operation.path);
        } else {
          await this.writeFile(operation.path, operation.data);
        }
      }
    });

    await this.options.stateStore.update((data) => {
      data.state.initialized = true;
      data.state.lastSyncedCommitSha = commitSha;
      data.state.trackedFiles = cloneTrackedFiles(trackedFiles);
      data.state.dirtyEntries = {};
      data.state.pendingTransaction = null;
      data.state.lastSyncAt = this.now();
      data.state.lastSyncResult = "success";
    });

    return { commitSha, trackedFiles };
  }

  async preview(): Promise<ConnectPreview> {
    const branch = await this.options.client.getBranch();
    const commitSha = this.commitSha(branch);
    const remoteIndex = treeToTrackedFiles(
      await this.options.client.getTree(commitSha),
      (path) => this.isHardExcluded(path),
    );
    const localPaths = (await this.listLocalFiles("")).filter(
      (path) => !this.isHardExcluded(path),
    );

    const localPushPaths: string[] = [];
    let conflictCount = 0;
    for (const path of localPaths) {
      const remote = remoteIndex[path];
      if (!remote) {
        localPushPaths.push(path);
        continue;
      }
      const bytes = new Uint8Array(await this.options.vault.adapter.readBinary(path));
      if ((await calculateGitBlobId(bytes)) !== remote.blobId) {
        conflictCount += 1;
      }
    }

    localPushPaths.sort();
    return {
      remoteFileCount: Object.keys(remoteIndex).length,
      localPushCount: localPushPaths.length + conflictCount,
      localPushPaths,
      conflictCount,
    };
  }

  private async listLocalFiles(dir: string): Promise<string[]> {
    const { files, folders } = await this.options.vault.adapter.list(dir);
    const out: string[] = [];
    for (const file of files) {
      const normalized = normalizePath(file);
      if (!this.isHardExcluded(normalized)) out.push(normalized);
    }
    for (const folder of folders) {
      const normalized = normalizePath(folder);
      if (this.isHardExcluded(normalized)) continue;
      out.push(...(await this.listLocalFiles(normalized)));
    }
    return out;
  }

  private commitSha(branch: GitLabBranch): string {
    const commitSha = branch.commit?.id?.trim();
    if (!commitSha) {
      throw new Error(EMPTY_REMOTE_ERROR);
    }
    return commitSha;
  }

  private async assertVaultEmptyForBootstrap(): Promise<void> {
    const configDir = normalizePath(this.options.vault.configDir);
    const root = await this.options.vault.adapter.list("");

    if (root.files.length > 0 || root.folders.some((folder) => normalizePath(folder) !== configDir)) {
      throw new Error("The local vault must be empty before importing from GitLab");
    }

    if (!root.folders.some((folder) => normalizePath(folder) === configDir)) {
      return;
    }

    await this.assertConfigDirAllowed(configDir);
  }

  private async assertConfigDirAllowed(configDir: string): Promise<void> {
    const pluginsDir = `${configDir}/plugins`;
    const pluginDir = `${pluginsDir}/${this.pluginId}`;
    const config = await this.options.vault.adapter.list(configDir);

    if (config.folders.some((folder) => normalizePath(folder) !== pluginsDir)) {
      throw new Error("The local vault must be empty before importing from GitLab");
    }

    if (!config.folders.some((folder) => normalizePath(folder) === pluginsDir)) {
      return;
    }

    const plugins = await this.options.vault.adapter.list(pluginsDir);
    if (
      plugins.files.length > 0 ||
      plugins.folders.some((folder) => normalizePath(folder) !== pluginDir)
    ) {
      throw new Error("The local vault must be empty before importing from GitLab");
    }
  }

  private async readArchive(archive: ArrayBuffer): Promise<Array<ArchiveOperation>> {
    const reader = new ZipReader(new BlobReader(new Blob([archive])));
    try {
      const entries = await reader.getEntries();
      const operations = entries
        .map((entry) => this.describeEntry(entry))
        .filter((operation): operation is ArchiveOperation => operation !== null);

      this.assertNoUnsafeOperations(operations);

      for (const operation of operations) {
        if (operation.directory) {
          continue;
        }
        const writer = new Uint8ArrayWriter();
        await operation.entry.getData?.(writer);
        operation.data = await writer.getData();
      }

      return operations;
    } finally {
      await reader.close();
    }
  }

  private describeEntry(entry: Entry): ArchiveOperation | null {
    const rawPath = entry.filename;
    if (this.isUnsafeArchivePath(rawPath) || this.isSymlink(entry)) {
      throw new Error(`Unsafe GitLab archive entry: ${rawPath}`);
    }

    const pathParts = rawPath.split("/");
    const targetPath = normalizePath(pathParts.length > 1 ? pathParts.slice(1).join("/") : "");
    if (targetPath === "") {
      return null;
    }

    if (this.isUnsafeArchivePath(targetPath)) {
      throw new Error(`Unsafe GitLab archive entry: ${rawPath}`);
    }

    if (this.isHardExcluded(targetPath)) {
      return null;
    }

    return {
      entry,
      path: targetPath,
      directory: entry.directory,
      data: new Uint8Array(),
    };
  }

  private assertNoUnsafeOperations(operations: ArchiveOperation[]): void {
    for (const operation of operations) {
      if (this.isUnsafeArchivePath(operation.path)) {
        throw new Error(`Unsafe GitLab archive entry: ${operation.path}`);
      }
    }
  }

  private isUnsafeArchivePath(path: string): boolean {
    return (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((segment) => segment === "..")
    );
  }

  private isSymlink(entry: Entry): boolean {
    const candidate = entry as Entry & {
      unixMode?: number;
      externalFileAttribute?: number;
      externalFileAttributes?: number;
    };
    const unixMode = candidate.unixMode;
    if (typeof unixMode === "number" && (unixMode & 0o170000) === 0o120000) {
      return true;
    }

    const external = candidate.externalFileAttribute ?? candidate.externalFileAttributes;
    if (typeof external === "number" && ((external >>> 16) & 0o170000) === 0o120000) {
      return true;
    }

    return false;
  }

  private async writeFile(path: string, data: Uint8Array): Promise<void> {
    await this.ensureParentFolders(path);
    await this.options.vault.adapter.writeBinary(path, arrayBufferFromBytes(data));
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const slash = normalized.lastIndexOf("/");
    if (slash === -1) {
      return;
    }
    const parts = normalized.slice(0, slash).split("/");

    let current = "";
    for (const part of parts) {
      if (part === "") {
        continue;
      }
      current = current === "" ? part : `${current}/${part}`;
      await this.ensureFolder(current);
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === "" || (await this.options.vault.adapter.exists(normalized))) {
      return;
    }
    await this.options.vault.adapter.mkdir(normalized);
  }

  private async suppressJournal<T>(operation: () => Promise<T>): Promise<T> {
    if (this.options.journal === undefined) {
      return await operation();
    }
    return await this.options.journal.suppress(operation);
  }

  private isActivePluginPath(path: string): boolean {
    const configDir = normalizePath(this.options.vault.configDir);
    const pluginDir = `${configDir}/plugins/${this.pluginId}`;
    return path === pluginDir || path.startsWith(`${pluginDir}/`);
  }

  private isHardExcluded(path: string): boolean {
    const normalized = normalizePath(path);
    return normalized === ".git" ||
      normalized.startsWith(".git/") ||
      this.isActivePluginPath(normalized) ||
      isMetadataPath(normalized);
  }
}

interface ArchiveOperation {
  entry: Entry;
  path: string;
  directory: boolean;
  data: Uint8Array;
}

function treeToTrackedFiles(
  tree: GitLabTreeItem[],
  isHardExcluded: (path: string) => boolean,
): Record<string, TrackedFile> {
  return Object.fromEntries(
    tree
      .filter((item) => item.type === "blob" && !isHardExcluded(item.path))
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

function cloneTrackedFiles(
  trackedFiles: Record<string, TrackedFile>,
): Record<string, TrackedFile> {
  return Object.fromEntries(
    Object.entries(trackedFiles).map(([path, file]) => [path, { ...file }]),
  );
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function isMetadataPath(path: string): boolean {
  return path.endsWith("github-sync-metadata.json") ||
    path.endsWith("gitlab-sync-metadata.json");
}
