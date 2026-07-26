import { requestUrl } from "obsidian";
import type { GitLabSyncSettings } from "../sync/types";
import {
  GitLabApiError,
  GitLabAuthenticationError,
  GitLabConflictError,
  GitLabForbiddenError,
  GitLabNotFoundError,
  GitLabPayloadTooLargeError,
  GitLabRateLimitError,
} from "./errors";
import type {
  CreateCommitInput,
  CreatedGitLabCommit,
  GitLabBranch,
  GitLabCompareResult,
  GitLabPayloadWarning,
  GitLabRequestDiagnostic,
  GitLabTreeItem,
} from "./types";

const DEFAULT_MAX_PAYLOAD_BYTES = 250 * 1024 * 1024;
const DEFAULT_PAYLOAD_WARNING_BYTES = 20 * 1024 * 1024;

interface RequestUrlResponse {
  status: number;
  json?: unknown;
  arrayBuffer?: ArrayBuffer;
  headers?: Record<string, string>;
  text?: string;
}

interface RequestUrlOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string;
  throw?: boolean;
}

export interface GitLabClientOptions {
  maxTransientRetries?: number;
  initialRetryDelayMs?: number;
  maxPayloadBytes?: number;
  payloadWarningBytes?: number;
  onPayloadWarning?: (warning: GitLabPayloadWarning) => void;
  onRequest?: (diagnostic: GitLabRequestDiagnostic) => void | Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class GitLabClient {
  private readonly apiBase: string;
  private readonly maxTransientRetries: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxPayloadBytes: number;
  private readonly payloadWarningBytes: number;
  private readonly onPayloadWarning?: (warning: GitLabPayloadWarning) => void;
  private readonly onRequest?: (diagnostic: GitLabRequestDiagnostic) => void | Promise<void>;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly projectPath: string;

  constructor(
    private readonly settings: GitLabSyncSettings,
    private readonly token: string,
    options: GitLabClientOptions = {},
  ) {
    this.baseUrl = settings.gitlabBaseUrl.trim().replace(/\/+$/, "");
    this.projectPath = settings.projectPath.trim();
    const projectId = encodeURIComponent(this.projectPath);
    this.apiBase = `${this.baseUrl}/api/v4/projects/${projectId}`;
    this.maxTransientRetries = options.maxTransientRetries ?? 2;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 250;
    this.maxPayloadBytes =
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.payloadWarningBytes =
      options.payloadWarningBytes ?? DEFAULT_PAYLOAD_WARNING_BYTES;
    this.onPayloadWarning = options.onPayloadWarning;
    this.onRequest = options.onRequest;
    this.sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
  }

  async validateAccess(): Promise<void> {
    await this.getBranch();
  }

  async getBranch(): Promise<GitLabBranch> {
    return await this.requestJson<GitLabBranch>(
      `/repository/branches/${encodeURIComponent(this.settings.branch)}`,
    );
  }

  async getTree(ref: string): Promise<GitLabTreeItem[]> {
    const tree: GitLabTreeItem[] = [];
    let page = "1";

    while (page) {
      const response = await this.requestJsonResponse<GitLabTreeItem[]>(
        `/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&page=${page}`,
      );
      tree.push(...response.json);
      page = this.header(response.headers, "X-Next-Page") ?? "";
    }

    return tree;
  }

  async compare(from: string, to: string): Promise<GitLabCompareResult> {
    return await this.requestJson<GitLabCompareResult>(
      `/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=true`,
    );
  }

  async getRawFile(path: string, ref: string): Promise<ArrayBuffer | null> {
    try {
      return await this.requestArrayBuffer(
        `/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      );
    } catch (error) {
      if (error instanceof GitLabNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async getRawBlob(blobId: string): Promise<ArrayBuffer | null> {
    try {
      return await this.requestArrayBuffer(
        `/repository/blobs/${encodeURIComponent(blobId)}/raw`,
      );
    } catch (error) {
      if (error instanceof GitLabNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async downloadArchive(ref: string): Promise<ArrayBuffer> {
    return await this.requestArrayBuffer(
      `/repository/archive.zip?sha=${encodeURIComponent(ref)}&include_lfs_blobs=false`,
    );
  }

  async createCommit(input: CreateCommitInput): Promise<CreatedGitLabCommit> {
    const payload = {
      branch: this.settings.branch,
      commit_message: input.message,
      author_name: this.settings.authorName,
      author_email: this.settings.authorEmail,
      actions: input.actions,
    };
    const body = JSON.stringify(payload);
    this.assertPayloadSafe(input, body);

    return await this.requestJson<CreatedGitLabCommit>("/repository/commits", {
      method: "POST",
      contentType: "application/json",
      body,
    });
  }

  private async requestJson<T>(
    path: string,
    options: Pick<RequestUrlOptions, "method" | "body" | "contentType"> = {},
  ): Promise<T> {
    const response = await this.requestJsonResponse<T>(path, options);
    return response.json;
  }

  private async requestArrayBuffer(path: string): Promise<ArrayBuffer> {
    const response = await this.requestArrayBufferResponse(path);
    return response.arrayBuffer;
  }

  private async requestJsonResponse<T>(
    path: string,
    options: Pick<RequestUrlOptions, "method" | "body" | "contentType"> = {},
  ): Promise<{ json: T; arrayBuffer: ArrayBuffer; headers?: Record<string, string> }> {
    return await this.request(path, options, "json");
  }

  private async requestArrayBufferResponse(
    path: string,
    options: Pick<RequestUrlOptions, "method" | "body" | "contentType"> = {},
  ): Promise<{ json: never; arrayBuffer: ArrayBuffer; headers?: Record<string, string> }> {
    return await this.request(path, options, "arrayBuffer");
  }

  private async request<T>(
    path: string,
    options: Pick<RequestUrlOptions, "method" | "body" | "contentType">,
    responseType: "json" | "arrayBuffer",
  ): Promise<{ json: T; arrayBuffer: ArrayBuffer; headers?: Record<string, string> }> {
    let attempt = 0;

    while (true) {
      const method = options.method ?? "GET";
      const url = await this.requestUrl(path, method);
      let response: RequestUrlResponse;
      try {
        response = (await requestUrl({
          url,
          method,
          headers: this.headers(),
          contentType: options.contentType,
          body: options.body,
          throw: false,
        })) as RequestUrlResponse;
      } catch (error) {
        throw new GitLabApiError(
          0,
          `GitLab request failed before response for ${method} ${url}: ${errorMessage(error)}`,
        );
      }

      if (response.status >= 200 && response.status < 300) {
        return {
          json: responseType === "json"
            ? this.safeJson<T>(response, method, url)
            : undefined as T,
          arrayBuffer: response.arrayBuffer as ArrayBuffer,
          headers: response.headers,
        };
      }

      if (
        response.status >= 500 &&
        response.status < 600 &&
        attempt < this.maxTransientRetries
      ) {
        await this.sleep(this.initialRetryDelayMs * 2 ** attempt);
        attempt += 1;
        continue;
      }

      throw this.toError(response, method, url);
    }
  }

  private async requestUrl(path: string, method: string): Promise<string> {
    const url = `${this.apiBase}${path}`;
    await this.onRequest?.({
      method,
      url,
      path,
      baseUrl: this.baseUrl,
      projectPath: this.projectPath,
      branch: this.settings.branch.trim(),
    });
    return url;
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "PRIVATE-TOKEN": this.token,
    };
  }

  private toError(response: RequestUrlResponse, method: string, url: string): Error {
    const message = this.errorMessage(response, method, url);

    switch (response.status) {
      case 401:
        return new GitLabAuthenticationError(message);
      case 403:
        return new GitLabForbiddenError(message);
      case 404:
        return new GitLabNotFoundError(message);
      case 409:
        return new GitLabConflictError(message);
      case 429:
        return new GitLabRateLimitError(
          message,
          this.parseRetryAfter(response.headers),
        );
      default:
        return new GitLabApiError(response.status, message);
    }
  }

  private safeJson<T>(
    response: RequestUrlResponse,
    method: string,
    url: string,
  ): T {
    try {
      return response.json as T;
    } catch (error) {
      throw new GitLabApiError(
        response.status,
        `GitLab returned non-JSON success response for ${method} ${url}: ${errorMessage(error)}`,
      );
    }
  }

  private errorMessage(response: RequestUrlResponse, method: string, url: string): string {
    let bodyMessage: string | null = null;
    try {
      const json = response.json;
      bodyMessage =
        json &&
        typeof json === "object" &&
        "message" in json
          ? String((json as { message: unknown }).message)
          : null;
    } catch {
      bodyMessage = null;
    }

    const preview = responsePreview(response);
    const suffix = preview ? ` Body preview: ${preview}` : "";
    return bodyMessage ??
      `GitLab request failed with status ${response.status} for ${method} ${url}.${suffix}`;
  }

  private header(
    headers: Record<string, string> | undefined,
    name: string,
  ): string | null {
    if (!headers) {
      return null;
    }

    const entry = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    );
    return entry?.[1] ?? null;
  }

  private parseRetryAfter(headers: Record<string, string> | undefined): number | null {
    const raw = this.header(headers, "Retry-After");
    if (!raw) {
      return null;
    }

    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds : null;
  }

  private assertPayloadSafe(input: CreateCommitInput, body: string): void {
    const decodedBytes = input.actions.reduce((total, action) => {
      if (action.action === "delete") {
        return total;
      }
      return total + decodedBase64Bytes(action.content);
    }, 0);
    const jsonBytes = new TextEncoder().encode(body).byteLength;

    if (
      decodedBytes > this.maxPayloadBytes ||
      jsonBytes > this.maxPayloadBytes
    ) {
      throw new GitLabPayloadTooLargeError(
        `GitLab commit payload exceeds ${this.maxPayloadBytes} bytes`,
      );
    }

    if (
      decodedBytes > this.payloadWarningBytes ||
      jsonBytes > this.payloadWarningBytes
    ) {
      this.onPayloadWarning?.({
        decodedBytes,
        jsonBytes,
        warningBytes: this.payloadWarningBytes,
        maxBytes: this.maxPayloadBytes,
      });
    }
  }
}

function decodedBase64Bytes(value: string): number {
  const normalized = value.replace(/\s/g, "");
  const padding = normalized.endsWith("==")
    ? 2
    : normalized.endsWith("=")
      ? 1
      : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
}

function responsePreview(response: RequestUrlResponse): string {
  if (typeof response.text === "string") {
    return trimPreview(response.text);
  }
  if (response.arrayBuffer) {
    try {
      return trimPreview(new TextDecoder().decode(response.arrayBuffer));
    } catch {
      return "";
    }
  }
  return "";
}

function trimPreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
