import { calculateGitBlobId } from "./conflict-resolver";
import type {
  ByteMaterializeOperation,
  RemoteChange,
  TrackedFile,
} from "./types";

export interface StreamApplyProgress {
  remainingChanges: RemoteChange[];
  nextTrackedFiles: Record<string, TrackedFile>;
}

export interface StreamingRemoteApplierOptions {
  client: { getRawFile(path: string, ref: string): Promise<ArrayBuffer | null> };
  materializer: { applyBytes(operations: ByteMaterializeOperation[]): Promise<void> };
  /** Optional local-file reader used to skip re-downloading files whose content already matches. */
  vault?: {
    exists(path: string): Promise<boolean>;
    readBinary(path: string): Promise<ArrayBuffer>;
  };
  chunkSize?: number;
}

export class StreamingRemoteApplier {
  private readonly chunkSize: number;

  constructor(private readonly options: StreamingRemoteApplierOptions) {
    this.chunkSize = options.chunkSize ?? 32;
  }

  async applyStream(input: {
    changes: RemoteChange[];
    remoteSha: string;
    baseIndex: Record<string, TrackedFile>;
    onProgress?: (progress: StreamApplyProgress) => Promise<void>;
  }): Promise<Record<string, TrackedFile>> {
    const index = cloneIndex(input.baseIndex);
    let start = 0;

    while (start < input.changes.length) {
      const end = Math.min(start + this.chunkSize, input.changes.length);
      const chunk = input.changes.slice(start, end);
      const operations: ByteMaterializeOperation[] = [];

      for (const change of chunk) {
        await this.collectOperation(change, input.remoteSha, index, operations);
      }

      if (operations.length > 0) {
        await this.options.materializer.applyBytes(operations);
      }

      if (input.onProgress) {
        await input.onProgress({
          remainingChanges: input.changes.slice(end),
          nextTrackedFiles: cloneIndex(index),
        });
      }

      start = end;
    }

    return index;
  }

  private async collectOperation(
    change: RemoteChange,
    remoteSha: string,
    index: Record<string, TrackedFile>,
    operations: ByteMaterializeOperation[],
  ): Promise<void> {
    switch (change.type) {
      case "create":
      case "update":
        await this.materializeWrite(change.path, remoteSha, index, operations, change.blobId);
        return;
      case "delete":
        operations.push({ type: "delete", path: change.path });
        delete index[change.path];
        return;
      case "rename":
        operations.push({ type: "delete", path: change.oldPath });
        delete index[change.oldPath];
        await this.materializeWrite(change.newPath, remoteSha, index, operations);
        return;
    }
  }

  private async materializeWrite(
    path: string,
    remoteSha: string,
    index: Record<string, TrackedFile>,
    operations: ByteMaterializeOperation[],
    remoteBlobId?: string,
  ): Promise<void> {
    if (remoteBlobId !== undefined && this.options.vault) {
      const local = await this.localContentIfMatches(path, remoteBlobId);
      if (local !== null) {
        // The file on disk already holds the exact remote content; keep it and
        // record the blob in the index without downloading or rewriting it.
        index[path] = {
          blobId: remoteBlobId,
          mode: "100644",
          size: local.byteLength,
        };
        return;
      }
    }

    const buffer = await this.options.client.getRawFile(path, remoteSha);
    if (buffer === null) {
      operations.push({ type: "delete", path });
      delete index[path];
      return;
    }

    const bytes = new Uint8Array(buffer);
    operations.push({ type: "write", path, bytes });
    index[path] = {
      blobId: await calculateGitBlobId(bytes),
      mode: "100644",
      size: bytes.byteLength,
    };
  }

  private async localContentIfMatches(
    path: string,
    remoteBlobId: string,
  ): Promise<Uint8Array | null> {
    const vault = this.options.vault;
    if (!vault || !(await vault.exists(path))) {
      return null;
    }
    const local = new Uint8Array(await vault.readBinary(path));
    const localBlobId = await calculateGitBlobId(local);
    return localBlobId === remoteBlobId ? local : null;
  }
}

function cloneIndex(index: Record<string, TrackedFile>): Record<string, TrackedFile> {
  return Object.fromEntries(Object.entries(index).map(([path, file]) => [path, { ...file }]));
}
