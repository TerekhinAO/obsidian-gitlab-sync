import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitLabSyncSettings } from "../../src/sync/types";
import {
  GitLabAuthenticationError,
  GitLabConflictError,
  GitLabForbiddenError,
  GitLabNotFoundError,
  GitLabPayloadTooLargeError,
  GitLabRateLimitError,
} from "../../src/gitlab/errors";
import { GitLabClient } from "../../src/gitlab/client";
import {
  arrayBufferFromText,
  FakeRequestUrl,
} from "../helpers/fake-request-url";

const requestUrlMock = vi.hoisted(() => vi.fn());

vi.mock("obsidian", () => ({
  requestUrl: requestUrlMock,
}));

const settings: GitLabSyncSettings = {
  gitlabBaseUrl: "https://gitlab.com",
  projectPath: "developing1382536/obsidian-vault",
  branch: "main",
  tokenSecretName: "gitlab-gitless-sync-token",
  authorName: "Mobile User",
  authorEmail: "mobile@example.com",
  syncOnStartup: true,
  syncOnForeground: true,
  syncOnBackground: false,
  syncAfterEdit: false,
  syncAfterEditDebounceSeconds: 8,
  syncOnInterval: false,
  syncIntervalMinutes: 10,
  showRibbonIcon: true,
  loggingLevel: "off",
  loggingEnabled: false,
  conflictStrategy: "remote",
};

describe("GitLabClient", () => {
  let fake: FakeRequestUrl;

  beforeEach(() => {
    fake = new FakeRequestUrl();
    requestUrlMock.mockReset();
    requestUrlMock.mockImplementation(fake.requestUrl);
  });

  it("encodes project paths exactly and authenticates with PRIVATE-TOKEN", async () => {
    fake.queue({
      status: 200,
      json: { name: "main", can_push: true, commit: { id: "abc", parent_ids: [] } },
    });

    await new GitLabClient(settings, "glpat-test").validateAccess();

    expect(fake.calls[0].url).toBe(
      "https://gitlab.com/api/v4/projects/developing1382536%2Fobsidian-vault/repository/branches/main",
    );
    expect(fake.calls[0].headers).toMatchObject({
      "PRIVATE-TOKEN": "glpat-test",
    });
    expect(fake.calls[0].url).not.toContain("glpat-test");
  });

  it("emits safe request diagnostics without token data", async () => {
    const diagnostics: unknown[] = [];
    fake.queue({
      status: 200,
      json: { name: "main", can_push: true, commit: { id: "abc", parent_ids: [] } },
    });

    await new GitLabClient(
      { ...settings, gitlabBaseUrl: "https://gitlab.com///", projectPath: "group/project" },
      "glpat-test",
      {
        onRequest: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      },
    ).validateAccess();

    expect(diagnostics).toEqual([
      {
        method: "GET",
        url: "https://gitlab.com/api/v4/projects/group%2Fproject/repository/branches/main",
        path: "/repository/branches/main",
        baseUrl: "https://gitlab.com",
        projectPath: "group/project",
        branch: "main",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("glpat-test");
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE-TOKEN");
  });

  it("follows repository tree pagination using X-Next-Page", async () => {
    fake.queue({
      status: 200,
      headers: { "X-Next-Page": "2" },
      json: [
        { id: "blob-1", name: "a.md", type: "blob", path: "a.md", mode: "100644" },
      ],
    });
    fake.queue({
      status: 200,
      headers: { "X-Next-Page": "" },
      json: [
        {
          id: "blob-2",
          name: "b.md",
          type: "blob",
          path: "folder/b.md",
          mode: "100644",
        },
      ],
    });

    const tree = await new GitLabClient(settings, "token").getTree("feature/mobile");

    expect(tree.map((item) => item.path)).toEqual(["a.md", "folder/b.md"]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].url).toBe(
      "https://gitlab.com/api/v4/projects/developing1382536%2Fobsidian-vault/repository/tree?ref=feature%2Fmobile&recursive=true&per_page=100&page=1",
    );
    expect(fake.calls[1].url).toBe(
      "https://gitlab.com/api/v4/projects/developing1382536%2Fobsidian-vault/repository/tree?ref=feature%2Fmobile&recursive=true&per_page=100&page=2",
    );
  });

  it("fetches the project and reports empty_repo", async () => {
    fake.queue({ status: 200, json: { empty_repo: true, default_branch: null } });
    const project = await new GitLabClient(settings, "glpat-test").getProject();
    expect(fake.calls[0].url).toBe(
      "https://gitlab.com/api/v4/projects/developing1382536%2Fobsidian-vault",
    );
    expect(project.empty_repo).toBe(true);
    expect(project.default_branch).toBeNull();
  });

  it("lists branch names across pages", async () => {
    fake.queue({ status: 200, json: [{ name: "main" }, { name: "dev" }], headers: { "X-Next-Page": "2" } });
    fake.queue({ status: 200, json: [{ name: "release" }], headers: { "X-Next-Page": "" } });
    const names = await new GitLabClient(settings, "glpat-test").listBranches();
    expect(names).toEqual(["main", "dev", "release"]);
    expect(fake.calls[0].url).toBe(
      "https://gitlab.com/api/v4/projects/developing1382536%2Fobsidian-vault/repository/branches?per_page=100&page=1",
    );
    expect(fake.calls[1].url).toContain("page=2");
  });

  it("returns typed branch, compare, raw file, blob, archive, and commit responses", async () => {
    fake.queue({
      status: 200,
      json: {
        name: "main",
        can_push: true,
        commit: { id: "head-sha", parent_ids: ["parent-sha"] },
      },
    });
    fake.queue({
      status: 200,
      json: {
        compare_timeout: true,
        diffs: [
          {
            old_path: "old.md",
            new_path: "new.md",
            new_file: false,
            renamed_file: true,
            deleted_file: false,
            collapsed: true,
            too_large: true,
          },
        ],
      },
    });
    fake.queue({ status: 200, arrayBuffer: arrayBufferFromText("hello") });
    fake.queue({ status: 404, json: { message: "404 File Not Found" } });
    fake.queue({ status: 200, arrayBuffer: arrayBufferFromText("blob") });
    fake.queue({ status: 200, arrayBuffer: arrayBufferFromText("zip") });
    fake.queue({
      status: 201,
      json: { id: "new-commit", parent_ids: ["head-sha"] },
    });

    const client = new GitLabClient(settings, "token");

    await expect(client.getBranch()).resolves.toEqual({
      name: "main",
      can_push: true,
      commit: { id: "head-sha", parent_ids: ["parent-sha"] },
    });
    await expect(client.compare("base", "head")).resolves.toMatchObject({
      compare_timeout: true,
      diffs: [{ renamed_file: true, collapsed: true, too_large: true }],
    });
    await expect(client.getRawFile("folder/note.md", "main")).resolves.toEqual(
      arrayBufferFromText("hello"),
    );
    await expect(client.getRawFile("missing.md", "main")).resolves.toBeNull();
    await expect(client.getRawBlob("blob-sha")).resolves.toEqual(
      arrayBufferFromText("blob"),
    );
    await expect(client.downloadArchive("head")).resolves.toEqual(
      arrayBufferFromText("zip"),
    );
    await expect(
      client.createCommit({
        message: "sync",
        actions: [
          {
            action: "create",
            file_path: "new.md",
            content: "bmV3",
            encoding: "base64",
          },
          {
            action: "update",
            file_path: "update.md",
            content: "dXBkYXRl",
            encoding: "base64",
            last_commit_id: "old",
          },
          { action: "delete", file_path: "delete.md", last_commit_id: "old" },
        ],
      }),
    ).resolves.toEqual({ id: "new-commit", parent_ids: ["head-sha"] });

    expect(fake.calls[2].url).toBe(
      "https://gitlab.com/api/v4/projects/developing1382536%2Fobsidian-vault/repository/files/folder%2Fnote.md/raw?ref=main",
    );
    expect(fake.calls[6].contentType).toBe("application/json");
    expect(JSON.parse(fake.calls[6].body as string)).toEqual({
      branch: "main",
      commit_message: "sync",
      author_name: "Mobile User",
      author_email: "mobile@example.com",
      actions: [
        {
          action: "create",
          file_path: "new.md",
          content: "bmV3",
          encoding: "base64",
        },
        {
          action: "update",
          file_path: "update.md",
          content: "dXBkYXRl",
          encoding: "base64",
          last_commit_id: "old",
        },
        { action: "delete", file_path: "delete.md", last_commit_id: "old" },
      ],
    });
  });

  it("does not parse JSON for successful raw blob responses", async () => {
    const response: any = {
      status: 200,
      arrayBuffer: arrayBufferFromText("Test note body"),
    };
    Object.defineProperty(response, "json", {
      get: () => {
        throw new SyntaxError('JSON Parse error: Unexpected identifier "Test"');
      },
    });
    fake.queue(response);

    await expect(new GitLabClient(settings, "token").getRawBlob("blob-sha")).resolves.toEqual(
      arrayBufferFromText("Test note body"),
    );
  });

  it.each([
    [401, GitLabAuthenticationError],
    [403, GitLabForbiddenError],
    [404, GitLabNotFoundError],
    [409, GitLabConflictError],
    [429, GitLabRateLimitError],
  ])("maps %s responses to typed errors", async (status, ErrorClass) => {
    fake.queue({
      status,
      headers: { "Retry-After": "7" },
      json: { message: "GitLab says no" },
    });

    const error = await new GitLabClient(settings, "token")
      .getBranch()
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.status).toBe(status);
    if (status === 429) {
      expect(error.retryAfterSeconds).toBe(7);
    }
  });

  it("reports URL and body preview when GitLab returns non-JSON error content", async () => {
    const response: any = {
      status: 403,
      headers: { "Content-Type": "text/plain" },
      text: "Test access denied page",
    };
    Object.defineProperty(response, "json", {
      get: () => {
        throw new SyntaxError('JSON Parse error: Unexpected identifier "Test"');
      },
    });
    fake.queue(response);

    const error = await new GitLabClient(settings, "token")
      .getBranch()
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(GitLabForbiddenError);
    expect(error.message).toContain("GitLab request failed with status 403");
    expect(error.message).toContain(
      "https://gitlab.com/api/v4/projects/developing1382536%2Fobsidian-vault/repository/branches/main",
    );
    expect(error.message).toContain("Test access denied page");
    expect(error.message).not.toContain("PRIVATE-TOKEN");
    expect(error.message).not.toContain("token");
  });

  it("retries transient 5xx responses with bounded exponential backoff", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    fake.queue({ status: 502, json: { message: "bad gateway" } });
    fake.queue({ status: 503, json: { message: "unavailable" } });
    fake.queue({
      status: 200,
      json: { name: "main", can_push: true, commit: { id: "abc", parent_ids: [] } },
    });

    await expect(
      new GitLabClient(settings, "token", { sleep }).getBranch(),
    ).resolves.toMatchObject({ name: "main" });

    expect(fake.calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("warns for large commit payloads without splitting the commit", async () => {
    const onPayloadWarning = vi.fn();
    fake.queue({ status: 201, json: { id: "sha", parent_ids: [] } });

    await new GitLabClient(settings, "token", {
      maxPayloadBytes: 1_000,
      payloadWarningBytes: 4,
      onPayloadWarning,
    }).createCommit({
      message: "sync",
      actions: [
        {
          action: "create",
          file_path: "big.md",
          content: "MTIzNDU=",
          encoding: "base64",
        },
      ],
    });

    expect(onPayloadWarning).toHaveBeenCalledWith(
      expect.objectContaining({ decodedBytes: 5 }),
    );
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects decoded or JSON commit payloads over the safety limit", async () => {
    const client = new GitLabClient(settings, "token", {
      maxPayloadBytes: 4,
      payloadWarningBytes: 2,
    });

    await expect(
      client.createCommit({
        message: "sync",
        actions: [
          {
            action: "create",
            file_path: "too-big.md",
            content: "MTIzNDU=",
            encoding: "base64",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(GitLabPayloadTooLargeError);
    expect(fake.calls).toHaveLength(0);
  });
});
