export interface GitLabTreeItem {
  id: string;
  name: string;
  type: "tree" | "blob" | "commit";
  path: string;
  mode: string;
}

export interface GitLabBranch {
  name: string;
  can_push: boolean;
  commit: {
    id: string;
    parent_ids: string[];
  };
}

export interface GitLabDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  collapsed?: boolean;
  too_large?: boolean;
}

export interface GitLabCompareResult {
  diffs: GitLabDiff[];
  compare_timeout?: boolean;
}

export type GitLabCommitAction =
  | {
      action: "create";
      file_path: string;
      content: string;
      encoding: "base64";
    }
  | {
      action: "update";
      file_path: string;
      content: string;
      encoding: "base64";
      last_commit_id?: string;
    }
  | {
      action: "delete";
      file_path: string;
      last_commit_id?: string;
    };

export interface CreateCommitInput {
  message: string;
  actions: GitLabCommitAction[];
}

export interface CreatedGitLabCommit {
  id: string;
  parent_ids: string[];
}

export interface GitLabPayloadWarning {
  decodedBytes: number;
  jsonBytes: number;
  warningBytes: number;
  maxBytes: number;
}

export interface GitLabRequestDiagnostic {
  method: string;
  url: string;
  path: string;
  baseUrl: string;
  projectPath: string;
  branch: string;
}
