import type { DirtyEntry, DirtyOperation, TrackedFile } from "./types";

export interface VersionState {
  exists: boolean;
  bytes: Uint8Array | null;
}

export interface LocalSnapshotEntry {
  path: string;
  operation: DirtyOperation;
  local: VersionState;
  base: VersionState | null;
}

interface SnapshotVault {
  adapter: {
    exists(path: string): Promise<boolean>;
    readBinary(path: string): Promise<ArrayBuffer>;
    stat?(path: string): Promise<{ type: "file" | "folder" } | null>;
  };
}

type RawBlobReader = (blobId: string) => Promise<ArrayBuffer | null>;
type IgnorePredicate = (path: string, tracked: Record<string, TrackedFile>) => boolean;

export class LocalSnapshotService {
  constructor(
    private vault: SnapshotVault,
    private getRawBlob: RawBlobReader,
    private isIgnored: IgnorePredicate = () => false,
  ) {}

  async snapshot(
    entries: DirtyEntry[],
    tracked: Record<string, TrackedFile>,
  ): Promise<LocalSnapshotEntry[]> {
    const snapshots: LocalSnapshotEntry[] = [];

    for (const entry of entries) {
      if (!tracked[entry.path] && this.isIgnored(entry.path, tracked)) {
        continue;
      }

      // A directory can never be read as a file; skip it so a stray folder
      // dirty entry does not abort the sync with EISDIR.
      if (entry.operation !== "delete" && (await this.isDirectory(entry.path))) {
        continue;
      }

      snapshots.push({
        path: entry.path,
        operation: entry.operation,
        local: await this.readLocal(entry),
        base: await this.readBase(entry.path, tracked),
      });
    }

    return snapshots;
  }

  private async isDirectory(path: string): Promise<boolean> {
    const stat = this.vault.adapter.stat;
    if (!stat) {
      return false;
    }
    const info = await stat.call(this.vault.adapter, path);
    return info?.type === "folder";
  }

  private async readLocal(entry: DirtyEntry): Promise<VersionState> {
    if (entry.operation === "delete" || !(await this.vault.adapter.exists(entry.path))) {
      return { exists: false, bytes: null };
    }

    return {
      exists: true,
      bytes: new Uint8Array(await this.vault.adapter.readBinary(entry.path)),
    };
  }

  private async readBase(
    path: string,
    tracked: Record<string, TrackedFile>,
  ): Promise<VersionState | null> {
    const trackedFile = tracked[path];
    if (!trackedFile) {
      return { exists: false, bytes: null };
    }

    const blob = await this.getRawBlob(trackedFile.blobId);
    if (blob === null) {
      return null;
    }

    return { exists: true, bytes: new Uint8Array(blob) };
  }
}
