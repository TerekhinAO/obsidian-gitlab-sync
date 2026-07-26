import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import type {
  CreatedGitLabCommit,
  GitLabCommitAction,
  GitLabCompareResult,
  GitLabDiff,
  GitLabTreeItem,
} from "../../src/gitlab/types";
import { calculateGitBlobId } from "../../src/sync/conflict-resolver";

export interface GitLabTestRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface GitLabTestResponse {
  status: number;
  json?: unknown;
  arrayBuffer?: ArrayBuffer;
  headers?: Record<string, string>;
}

type FileContent = string | Uint8Array | ArrayBuffer;
type FileMutation = FileContent | null;

interface CommitRecord {
  id: string;
  parentIds: string[];
  files: Map<string, Uint8Array>;
  diffs?: GitLabDiff[];
}

export class GitLabTestServer {
  readonly baseUrl = "https://gitlab.test";
  readonly projectPath = "group/project";
  readonly branch = "main";
  readonly token = "test-token";
  readonly requests: GitLabTestRequest[] = [];
  readonly commitActions: GitLabCommitAction[][] = [];

  private commits = new Map<string, CommitRecord>();
  private headSha = "";
  private nextCommitNumber = 1;
  private branchReadCount = 0;
  private branchReadHooks = new Map<number, () => void | Promise<void>>();
  private compareTimeouts = new Set<string>();

  static async create(files: Record<string, FileContent>): Promise<GitLabTestServer> {
    const server = new GitLabTestServer();
    await server.seed(files);
    return server;
  }

  async seed(files: Record<string, FileContent>): Promise<string> {
    this.commits.clear();
    this.commitActions.length = 0;
    this.nextCommitNumber = 1;
    this.branchReadCount = 0;
    this.branchReadHooks.clear();
    this.compareTimeouts.clear();
    this.headSha = await this.createRecord([], await normalizeFiles(files));
    return this.headSha;
  }

  get head(): string {
    return this.headSha;
  }

  get branchReads(): number {
    return this.branchReadCount;
  }

  mutateBranchOnRead(readNumber: number, mutate: () => void | Promise<void>): void {
    this.branchReadHooks.set(readNumber, mutate);
  }

  forceCompareTimeout(from: string, to: string): void {
    this.compareTimeouts.add(compareKey(from, to));
  }

  async desktopCommit(mutations: Record<string, FileMutation>): Promise<string> {
    const parent = this.current();
    const files = cloneFiles(parent.files);
    for (const [path, content] of Object.entries(mutations)) {
      if (content === null) {
        files.delete(path);
      } else {
        files.set(path, bytes(content));
      }
    }
    this.headSha = await this.createRecord([parent.id], files);
    return this.headSha;
  }

  async requestUrl(options: GitLabTestRequest): Promise<GitLabTestResponse> {
    this.requests.push(options);
    if (options.headers?.["PRIVATE-TOKEN"] !== this.token) {
      return { status: 401, json: { message: "invalid token" } };
    }

    const url = new URL(options.url);
    const apiPrefix = `/api/v4/projects/${encodeURIComponent(this.projectPath)}`;
    if (!url.pathname.startsWith(apiPrefix)) {
      return { status: 404, json: { message: "unknown project" } };
    }

    const path = url.pathname.slice(apiPrefix.length);
    const method = options.method ?? "GET";

    if (method === "GET" && path.startsWith("/repository/branches/")) {
      this.branchReadCount += 1;
      await this.branchReadHooks.get(this.branchReadCount)?.();
      const head = this.current();
      return {
        status: 200,
        json: {
          name: this.branch,
          can_push: true,
          commit: { id: head.id, parent_ids: head.parentIds },
        },
      };
    }

    if (method === "GET" && path === "/repository/tree") {
      const ref = required(url.searchParams.get("ref"), "ref");
      return {
        status: 200,
        headers: { "X-Next-Page": "" },
        json: await this.tree(ref),
      };
    }

    if (method === "GET" && path === "/repository/compare") {
      const from = required(url.searchParams.get("from"), "from");
      const to = required(url.searchParams.get("to"), "to");
      return { status: 200, json: this.compare(from, to) };
    }

    if (method === "GET" && path.startsWith("/repository/files/") && path.endsWith("/raw")) {
      const encodedPath = path.slice("/repository/files/".length, -"/raw".length);
      const filePath = decodeURIComponent(encodedPath);
      const ref = required(url.searchParams.get("ref"), "ref");
      const content = this.commit(ref).files.get(filePath);
      return content
        ? { status: 200, arrayBuffer: arrayBuffer(content) }
        : { status: 404, json: { message: "404 File Not Found" } };
    }

    if (method === "GET" && path.startsWith("/repository/blobs/") && path.endsWith("/raw")) {
      const blobId = decodeURIComponent(
        path.slice("/repository/blobs/".length, -"/raw".length),
      );
      const content = await this.findBlob(blobId);
      return content
        ? { status: 200, arrayBuffer: arrayBuffer(content) }
        : { status: 404, json: { message: "404 Blob Not Found" } };
    }

    if (method === "GET" && path === "/repository/archive.zip") {
      const ref = required(url.searchParams.get("sha"), "sha");
      return { status: 200, arrayBuffer: await this.archive(ref) };
    }

    if (method === "POST" && path === "/repository/commits") {
      return await this.createCommitFromRequest(options.body);
    }

    return { status: 404, json: { message: `unhandled ${method} ${path}` } };
  }

  async tree(ref = this.headSha): Promise<GitLabTreeItem[]> {
    const items: GitLabTreeItem[] = [];
    const commit = this.commit(ref);
    for (const [path, content] of [...commit.files.entries()].sort()) {
      items.push({
        id: await calculateGitBlobId(content),
        name: path.split("/").pop() ?? path,
        type: "blob",
        path,
        mode: "100644",
      });
    }
    return items;
  }

  fileText(path: string, ref = this.headSha): string | null {
    const content = this.commit(ref).files.get(path);
    return content ? new TextDecoder().decode(content) : null;
  }

  hasPathEndingWithMetadata(): boolean {
    return this.allPaths().some(isMetadataPath) ||
      this.commitActions.flat().some((action) => isMetadataPath(action.file_path));
  }

  paths(ref = this.headSha): string[] {
    return [...this.commit(ref).files.keys()].sort();
  }

  private async createCommitFromRequest(body: string | ArrayBuffer | undefined): Promise<GitLabTestResponse> {
    const payload = JSON.parse(String(body ?? "{}")) as {
      branch: string;
      actions: GitLabCommitAction[];
    };
    if (payload.branch !== this.branch) {
      return { status: 400, json: { message: "wrong branch" } };
    }

    const parent = this.current();
    const files = cloneFiles(parent.files);
    for (const action of payload.actions) {
      if (action.action === "delete") {
        files.delete(action.file_path);
      } else {
        files.set(action.file_path, Buffer.from(action.content, "base64"));
      }
    }

    this.commitActions.push(payload.actions.map((action) => ({ ...action })));
    this.headSha = await this.createRecord([parent.id], files);
    return {
      status: 201,
      json: { id: this.headSha, parent_ids: [parent.id] } satisfies CreatedGitLabCommit,
    };
  }

  private compare(from: string, to: string): GitLabCompareResult {
    if (this.compareTimeouts.has(compareKey(from, to))) {
      return { compare_timeout: true, diffs: [] };
    }

    const target = this.commit(to);
    if (target.parentIds[0] === from && target.diffs) {
      return { diffs: target.diffs };
    }

    const before = this.commit(from).files;
    const after = target.files;
    const diffs: GitLabDiff[] = [];
    const paths = new Set([...before.keys(), ...after.keys()]);
    for (const path of [...paths].sort()) {
      const oldContent = before.get(path);
      const newContent = after.get(path);
      if (!oldContent && newContent) {
        diffs.push(diff(path, path, true, false, false));
      } else if (oldContent && !newContent) {
        diffs.push(diff(path, path, false, false, true));
      } else if (oldContent && newContent && !sameBytes(oldContent, newContent)) {
        diffs.push(diff(path, path, false, false, false));
      }
    }
    return { diffs };
  }

  private async archive(ref: string): Promise<ArrayBuffer> {
    const writer = new ZipWriter(new BlobWriter("application/zip"));
    const root = `${this.projectPath.replace("/", "-")}-${ref}/`;
    await writer.add(root, undefined, { directory: true });
    for (const [path, content] of this.commit(ref).files) {
      await writer.add(`${root}${path}`, new Uint8ArrayReader(content));
    }
    const blob = await writer.close();
    return await blob.arrayBuffer();
  }

  private async findBlob(blobId: string): Promise<Uint8Array | null> {
    for (const commit of this.commits.values()) {
      for (const content of commit.files.values()) {
        if ((await calculateGitBlobId(content)) === blobId) {
          return content;
        }
      }
    }
    return null;
  }

  private async createRecord(
    parentIds: string[],
    files: Map<string, Uint8Array>,
    diffs?: GitLabDiff[],
  ): Promise<string> {
    const id = `commit-${String(this.nextCommitNumber).padStart(4, "0")}`;
    this.nextCommitNumber += 1;
    this.commits.set(id, { id, parentIds, files: cloneFiles(files), diffs });
    return id;
  }

  private current(): CommitRecord {
    return this.commit(this.headSha);
  }

  private commit(ref: string): CommitRecord {
    const commit = this.commits.get(ref);
    if (!commit) {
      throw new Error(`Unknown GitLab test commit: ${ref}`);
    }
    return commit;
  }

  private allPaths(): string[] {
    return [...this.commits.values()].flatMap((commit) => [...commit.files.keys()]);
  }
}

async function normalizeFiles(files: Record<string, FileContent>): Promise<Map<string, Uint8Array>> {
  return new Map(Object.entries(files).map(([path, content]) => [path, bytes(content)]));
}

function diff(
  oldPath: string,
  newPath: string,
  newFile: boolean,
  renamedFile: boolean,
  deletedFile: boolean,
): GitLabDiff {
  return {
    old_path: oldPath,
    new_path: newPath,
    new_file: newFile,
    renamed_file: renamedFile,
    deleted_file: deletedFile,
  };
}

function bytes(content: FileContent): Uint8Array {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  return new Uint8Array(content);
}

function arrayBuffer(content: Uint8Array): ArrayBuffer {
  return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
}

function cloneFiles(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files.entries()].map(([path, content]) => [path, new Uint8Array(content)]));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return left.every((byte, index) => byte === right[index]);
}

function required(value: string | null, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function compareKey(from: string, to: string): string {
  return `${from}..${to}`;
}

function isMetadataPath(path: string): boolean {
  return path.endsWith("github-sync-metadata.json") ||
    path.endsWith("gitlab-sync-metadata.json");
}
