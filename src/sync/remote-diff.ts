import { GitLabApiError, GitLabConflictError, GitLabNotFoundError } from "../gitlab/errors";
import type { GitLabCompareResult, GitLabTreeItem } from "../gitlab/types";
import type { TrackedFile } from "./types";

export type RemoteChange =
  | { type: "create"; path: string }
  | { type: "update"; path: string }
  | { type: "delete"; path: string }
  | { type: "rename"; oldPath: string; newPath: string };

export interface RemoteDiffClient {
  compare(from: string, to: string): Promise<GitLabCompareResult>;
  getTree(ref: string): Promise<GitLabTreeItem[]>;
}

export class RemoteDiffService {
  constructor(
    private client: RemoteDiffClient,
    private isHardExcluded: (path: string) => boolean = () => false,
  ) {}

  async discover(input: {
    baseSha: string;
    remoteSha: string;
    baseIndex: Record<string, TrackedFile>;
  }): Promise<{
    changes: RemoteChange[];
    remoteTree?: Record<string, TrackedFile>;
    usedFallback: boolean;
  }> {
    try {
      const compare = await this.client.compare(input.baseSha, input.remoteSha);
      if (requiresFallback(compare, input.baseSha, input.remoteSha)) {
        return await this.fullTreeFallback(input.remoteSha, input.baseIndex);
      }
      return {
        changes: compare.diffs
          .filter((diff) => !this.isHardExcluded(diff.new_path) && !this.isHardExcluded(diff.old_path))
          .map((diff) => {
            if (diff.renamed_file) {
              return { type: "rename", oldPath: diff.old_path, newPath: diff.new_path };
            }
            if (diff.deleted_file) {
              return { type: "delete", path: diff.old_path };
            }
            if (diff.new_file) {
              return { type: "create", path: diff.new_path };
            }
            return { type: "update", path: diff.new_path };
          }),
        usedFallback: false,
      };
    } catch (error) {
      if (isFallbackError(error)) {
        return await this.fullTreeFallback(input.remoteSha, input.baseIndex);
      }
      throw error;
    }
  }

  private async fullTreeFallback(
    remoteSha: string,
    baseIndex: Record<string, TrackedFile>,
  ): Promise<{
    changes: RemoteChange[];
    remoteTree: Record<string, TrackedFile>;
    usedFallback: true;
  }> {
    const remoteTree = treeToIndex(await this.client.getTree(remoteSha), this.isHardExcluded);
    const changes: RemoteChange[] = [];
    const paths = new Set([...Object.keys(baseIndex), ...Object.keys(remoteTree)]);

    for (const path of [...paths].sort()) {
      if (this.isHardExcluded(path)) {
        continue;
      }
      const base = baseIndex[path];
      const remote = remoteTree[path];
      if (!base && remote) {
        changes.push({ type: "create", path });
      } else if (base && !remote) {
        changes.push({ type: "delete", path });
      } else if (
        base &&
        remote &&
        (base.blobId !== remote.blobId || base.mode !== remote.mode)
      ) {
        changes.push({ type: "update", path });
      }
    }

    return { changes, remoteTree, usedFallback: true };
  }
}

function requiresFallback(
  compare: GitLabCompareResult,
  baseSha: string,
  remoteSha: string,
): boolean {
  return (
    compare.compare_timeout === true ||
    compare.diffs.some((diff) => diff.collapsed || diff.too_large) ||
    (baseSha !== remoteSha && compare.diffs.length === 0)
  );
}

function isFallbackError(error: unknown): boolean {
  return (
    error instanceof GitLabNotFoundError ||
    error instanceof GitLabConflictError ||
    (error instanceof GitLabApiError && error.status === 400)
  );
}

function treeToIndex(
  tree: GitLabTreeItem[],
  isHardExcluded: (path: string) => boolean,
): Record<string, TrackedFile> {
  return Object.fromEntries(
    tree
      .filter((item) => item.type === "blob" && !isHardExcluded(item.path))
      .map((item) => [
        item.path,
        {
          blobId: item.id,
          mode: item.mode,
          size: 0,
        },
      ]),
  );
}
