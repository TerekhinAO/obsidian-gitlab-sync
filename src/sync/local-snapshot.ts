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

      snapshots.push({
        path: entry.path,
        operation: entry.operation,
        local: await this.readLocal(entry),
        base: await this.readBase(entry.path, tracked),
      });
    }

    return snapshots;
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
