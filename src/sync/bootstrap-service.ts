import { normalizePath } from "obsidian";
import { BlobReader, type Entry, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { calculateGitBlobId } from "./conflict-resolver";
import type { GitLabClient } from "../gitlab/client";
import type { GitLabBranch, GitLabTreeItem } from "../gitlab/types";
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

export interface ConnectMergePreview {
  mode: "merge";
  remoteFileCount: number;
  // Includes both local-only files and conflicting files (files that differ from remote).
  localPushCount: number;
  localPushPaths: string[];
  conflictCount: number;
}

export interface ConnectSeedPreview {
  mode: "seed";
  branch: string;
  localPushCount: number;
  localPushPaths: string[];
}

export type ConnectPreview = ConnectMergePreview | ConnectSeedPreview;

export interface ConnectMergeResult {
  commitSha: string;
  conflictCopyPaths: string[];
}

interface BootstrapJournal {
  suppress<T>(operation: () => Promise<T>): Promise<T>;
}

export interface BootstrapServiceOptions {
  vault: BootstrapVault;
  client: Pick<GitLabClient, "getBranch" | "getTree" | "downloadArchive">;
  journal?: BootstrapJournal;
  pluginId?: string;
}

export class BootstrapService {
  private readonly pluginId: string;

  constructor(private options: BootstrapServiceOptions) {
    this.pluginId = options.pluginId ?? "gitlab-gitless-sync";
  }

  async merge(): Promise<ConnectMergeResult> {
    const branch = await this.options.client.getBranch();
    const commitSha = this.commitSha(branch);
    const archive = await this.options.client.downloadArchive(commitSha);
    const operations = await this.readArchive(archive);
    const conflictCopyPaths: string[] = [];

    await this.suppressJournal(async () => {
      for (const operation of operations) {
        if (operation.directory) {
          await this.ensureFolder(operation.path);
          continue;
        }
        if (!(await this.options.vault.adapter.exists(operation.path))) {
          await this.writeFile(operation.path, operation.data);
          continue;
        }
        const local = new Uint8Array(
          await this.options.vault.adapter.readBinary(operation.path),
        );
        if (sameBytes(local, operation.data)) {
          continue; // identical, adopt as-is
        }
        // differ: remote wins at the path, local preserved as a conflict copy
        const copyPath = await this.availableConflictCopyPath(operation.path);
        await this.writeFile(copyPath, local);
        await this.writeFile(operation.path, operation.data);
        conflictCopyPaths.push(copyPath);
      }
    });

    return { commitSha, conflictCopyPaths };
  }

  private async availableConflictCopyPath(path: string): Promise<string> {
    const base = conflictCopyPath(path);
    if (!(await this.options.vault.adapter.exists(base))) {
      return base;
    }
    const { dir, stem, ext } = splitName(base);
    let n = 2;
    while (await this.options.vault.adapter.exists(`${dir}${stem} ${n}${ext}`)) {
      n += 1;
    }
    return `${dir}${stem} ${n}${ext}`;
  }

  async preview(): Promise<ConnectPreview> {
    const branch = await this.options.client.getBranch();
    const commitSha = this.commitSha(branch);
    const remoteIndex = treeToTrackedFiles(
      await this.options.client.getTree(commitSha),
      (path) => this.isHardExcluded(path),
    );
    const localPaths = await this.listLocalFiles("");

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
      mode: "merge",
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
    if (this.isUnsafeArchivePath(rawPath)) {
      throw new Error(`Unsafe GitLab archive entry: ${rawPath}`);
    }

    const pathParts = rawPath.split("/");
    const relativePath = pathParts.length > 1 ? pathParts.slice(1).join("/") : "";
    if (relativePath === "") {
      return null;
    }
    const targetPath = normalizePath(relativePath);

    if (this.isUnsafeArchivePath(targetPath) || this.isSymlink(entry)) {
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

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function splitName(path: string): { dir: string; stem: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const hasExt = dot > 0; // leading-dot files (e.g. .gitignore) have no extension
  return {
    dir,
    stem: hasExt ? name.slice(0, dot) : name,
    ext: hasExt ? name.slice(dot) : "",
  };
}

function conflictCopyPath(path: string): string {
  const { dir, stem, ext } = splitName(path);
  return `${dir}${stem} (local conflict)${ext}`;
}

function isMetadataPath(path: string): boolean {
  return path.endsWith("github-sync-metadata.json") ||
    path.endsWith("gitlab-sync-metadata.json");
}
