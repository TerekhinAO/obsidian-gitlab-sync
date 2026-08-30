import { describe, expect, it, vi } from "vitest";
import { SyncManager } from "../../src/sync/sync-manager";
import type { GitLabBranch, GitLabCommitAction, CreatedGitLabCommit } from "../../src/gitlab/types";
import type { DirtyEntry, GitLabSyncSettings, LocalSyncState, MaterializeOperation, PendingTransaction, PluginData, TrackedFile } from "../../src/sync/types";
import type { RemoteChange } from "../../src/sync/remote-diff";
import type { SyncPlan } from "../../src/sync/sync-planner";
import type { DevicePlatform } from "../../src/device-label";

const settings: GitLabSyncSettings = {
  gitlabBaseUrl: "https://gitlab.com",
  projectPath: "group/project",
  branch: "main",
  tokenSecretName: "gitlab-token",
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

describe("SyncManager", () => {
  it("returns a clear already-running result for concurrent sync calls", async () => {
    const fixture = managerFixture({
      data: initializedData({ dirtyEntries: { "note.md": dirty("note.md") } }),
    });
    fixture.planner.plan.mockResolvedValueOnce(localCommitPlan("remote-a", "note.md"));
    fixture.gitlab.createCommit.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(commit("commit-a", ["remote-a"])), 10)),
    );

    const first = fixture.manager.sync("manual");
    await vi.waitFor(() => expect(fixture.manager.isSyncing()).toBe(true));
    const second = await fixture.manager.sync("manual");
    const firstResult = await first;

    expect(second).toEqual({
      status: "already-running",
      message: "Sync already running",
      trigger: "manual",
    });
    expect(firstResult.status).toBe("success");
    expect(fixture.gitlab.createCommit).toHaveBeenCalledTimes(1);
  });

  it("labels the commit with the configured author and the detected device", async () => {
    const fixture = managerFixture({
      data: initializedData({ dirtyEntries: { "note.md": dirty("note.md") } }),
      platform: { isMacOS: true },
    });
    fixture.planner.plan.mockResolvedValueOnce(localCommitPlan("remote-a", "note.md"));

    await expect(fixture.manager.sync("foreground")).resolves.toMatchObject({ status: "success" });

    expect(fixture.gitlab.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Sync vault from Mobile User (Mac) foreground" }),
    );
  });

  it("labels the commit with the detected device alone when no author is configured", async () => {
    const fixture = managerFixture({
      data: initializedData({ dirtyEntries: { "note.md": dirty("note.md") } }),
      settings: { ...settings, authorName: "", authorEmail: "" },
      platform: { isIosApp: true },
    });
    fixture.planner.plan.mockResolvedValueOnce(localCommitPlan("remote-a", "note.md"));

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({ status: "success" });

    expect(fixture.gitlab.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Sync vault from iPhone" }),
    );
  });

  it("recovers a pending transaction before reading the GitLab branch", async () => {
    const fixture = managerFixture({
      data: initializedData({
        pendingTransaction: pendingTransaction("committed-before-restart"),
      }),
    });

    await expect(fixture.manager.sync("startup")).resolves.toMatchObject({
      status: "success",
      recovered: true,
    });

    expect(fixture.events[0]).toBe("recover");
    expect(fixture.gitlab.getBranch).not.toHaveBeenCalled();
    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
    expect((await fixture.store.load()).state.lastSyncedCommitSha).toBe("committed-before-restart");
  });

  it("materializes remote-only changes and advances state without creating a commit", async () => {
    const fixture = managerFixture({
      data: initializedData(),
      remoteChanges: [{ type: "update", path: "desktop.md" }],
    });
    fixture.planner.plan.mockResolvedValueOnce(remoteOnlyPlan("remote-a", [
      { type: "write", path: "desktop.md", contentBase64: base64("desktop") },
    ]));

    await expect(fixture.manager.sync("startup")).resolves.toMatchObject({
      status: "success",
      commitSha: "remote-a",
    });

    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
    expect(fixture.materializer.apply).toHaveBeenCalledWith([
      { type: "write", path: "desktop.md", contentBase64: base64("desktop") },
    ]);
    expect((await fixture.store.load()).state).toMatchObject({
      lastSyncedCommitSha: "remote-a",
      trackedFiles: { "desktop.md": tracked("desktop") },
      pendingTransaction: null,
      lastSyncResult: "success",
    });
  });

  it("recomputes once when the branch head changes before commit", async () => {
    const fixture = managerFixture({
      data: initializedData({ dirtyEntries: { "note.md": dirty("note.md") } }),
      branchHeads: ["remote-b", "remote-d", "remote-d"],
    });
    fixture.planner.plan
      .mockResolvedValueOnce(localCommitPlan("remote-b", "note.md"))
      .mockResolvedValueOnce(localCommitPlan("remote-d", "note.md"));
    fixture.gitlab.createCommit.mockResolvedValueOnce(commit("commit-c", ["remote-d"]));

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({
      status: "success",
      commitSha: "commit-c",
      attempts: 2,
    });

    expect(fixture.planner.plan).toHaveBeenCalledTimes(2);
    expect(fixture.remoteDiff.discover).toHaveBeenNthCalledWith(1, {
      baseSha: "base-a",
      remoteSha: "remote-b",
      baseIndex: {},
    });
    expect(fixture.remoteDiff.discover).toHaveBeenNthCalledWith(2, {
      baseSha: "base-a",
      remoteSha: "remote-d",
      baseIndex: {},
    });
    expect(fixture.gitlab.createCommit).toHaveBeenCalledTimes(1);
  });

  it("stops after a second branch race and keeps dirty entries unacknowledged", async () => {
    const fixture = managerFixture({
      data: initializedData({ dirtyEntries: { "note.md": dirty("note.md") } }),
      branchHeads: ["remote-b", "remote-d", "remote-e"],
    });
    fixture.planner.plan
      .mockResolvedValueOnce(localCommitPlan("remote-b", "note.md"))
      .mockResolvedValueOnce(localCommitPlan("remote-d", "note.md"));

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({
      status: "error",
      message: "GitLab branch changed during sync; retry later",
      attempts: 2,
    });

    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
    expect((await fixture.store.load()).state.dirtyEntries).toEqual({
      "note.md": dirty("note.md"),
    });
  });

  it("persists a pending transaction immediately after commit and finalizes only after local materialization", async () => {
    const fixture = managerFixture({
      data: initializedData({ dirtyEntries: { "note.md": dirty("note.md") } }),
    });
    fixture.planner.plan.mockResolvedValueOnce(localCommitPlan("remote-a", "note.md"));
    fixture.gitlab.createCommit.mockResolvedValueOnce(commit("commit-a", ["remote-a"]));

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({
      status: "success",
      commitSha: "commit-a",
    });

    expect(fixture.events).toContain("save:pending:commit-a");
    expect(fixture.events.indexOf("save:pending:commit-a")).toBeLessThan(
      fixture.events.indexOf("apply"),
    );
    const state = (await fixture.store.load()).state;
    expect(state.pendingTransaction).toBeNull();
    expect(state.lastSyncedCommitSha).toBe("commit-a");
    expect(state.dirtyEntries).toEqual({});
  });

  it("leaves the pending transaction and dirty entry intact when local materialization fails after commit", async () => {
    const fixture = managerFixture({
      data: initializedData({ dirtyEntries: { "note.md": dirty("note.md") } }),
    });
    fixture.planner.plan.mockResolvedValueOnce(localCommitPlan("remote-a", "note.md"));
    fixture.gitlab.createCommit.mockResolvedValueOnce(commit("commit-a", ["remote-a"]));
    fixture.materializer.apply.mockRejectedValueOnce(new Error("disk full"));

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({
      status: "error",
      message: "disk full",
    });

    const state = (await fixture.store.load()).state;
    expect(state.lastSyncedCommitSha).toBe("base-a");
    expect(state.dirtyEntries).toEqual({ "note.md": dirty("note.md") });
    expect(state.pendingTransaction).toMatchObject({
      committedSha: "commit-a",
      acknowledgedDirtyPaths: ["note.md"],
    });
  });

  it("validates initialization, settings, secret, and branch push access before planning", async () => {
    const uninitialized = managerFixture({ data: pluginData({ initialized: false }) });
    await expect(uninitialized.manager.sync("manual")).resolves.toMatchObject({
      status: "error",
      message: "Sync is not initialized",
    });

    const missingSecret = managerFixture({
      data: initializedData(),
      token: "",
    });
    await expect(missingSecret.manager.sync("manual")).resolves.toMatchObject({
      status: "error",
      message: "GitLab token is missing",
    });

    const cannotPush = managerFixture({
      data: initializedData(),
      branchHeads: ["remote-a"],
      canPush: false,
    });
    await expect(cannotPush.manager.sync("manual")).resolves.toMatchObject({
      status: "error",
      message: "GitLab branch does not allow pushes",
    });
    expect(cannotPush.remoteDiff.discover).not.toHaveBeenCalled();
  });

  it("adopts an existing vault by setting the GitLab head as base and auditing local differences", async () => {
    const fixture = managerFixture({
      data: pluginData({ initialized: false }),
      remoteTree: [
        { id: await gitBlobId("same"), name: "same.md", type: "blob", path: "same.md", mode: "100644" },
        { id: await gitBlobId("remote"), name: "changed.md", type: "blob", path: "changed.md", mode: "100644" },
        { id: await gitBlobId("missing"), name: "missing.md", type: "blob", path: "missing.md", mode: "100644" },
      ],
      localFiles: {
        "same.md": "same",
        "changed.md": "local",
        "new.md": "new",
        ".git/config": "ignored",
      },
    });

    await expect(fixture.manager.adoptExistingVault()).resolves.toMatchObject({
      status: "success",
      commitSha: "remote-a",
      dirtyPaths: 3,
    });

    const state = (await fixture.store.load()).state;
    expect(state.initialized).toBe(true);
    expect(state.lastSyncedCommitSha).toBe("remote-a");
    expect(Object.keys(state.trackedFiles).sort()).toEqual([
      "changed.md",
      "missing.md",
      "same.md",
    ]);
    expect(state.dirtyEntries).toMatchObject({
      "changed.md": { path: "changed.md", operation: "upsert" },
      "missing.md": { path: "missing.md", operation: "delete" },
      "new.md": { path: "new.md", operation: "upsert" },
    });
    expect(state.dirtyEntries[".git/config"]).toBeUndefined();
  });

  it("lists syncable local files excluding hard-excluded and ignored paths", async () => {
    const fixture = managerFixture({
      data: initializedData(),
      localFiles: {
        "note.md": "note",
        "Welcome.md": "welcome",
        ".obsidian/plugins/gitlab-gitless-sync/main.js": "runtime",
        "secret.md": "secret",
      },
    });
    fixture.ignoreMatcher.isIgnored.mockImplementation(
      (...args: unknown[]) => args[0] === "secret.md",
    );

    const files = await fixture.manager.listSyncableLocalFiles();

    expect(files).toEqual(["Welcome.md", "note.md"]);
  });

  it("seeds an empty remote from local files and finalizes adoption", async () => {
    const fixture = managerFixture({
      data: pluginData({ initialized: false }),
      branchHeads: ["seed-sha"],
      remoteTree: [
        { id: await gitBlobId("alpha"), name: "alpha.md", type: "blob", path: "alpha.md", mode: "100644" },
        { id: await gitBlobId("beta"), name: "beta.md", type: "blob", path: "beta.md", mode: "100644" },
      ],
      localFiles: {
        "beta.md": "beta",
        "alpha.md": "alpha",
      },
    });
    fixture.gitlab.createCommit.mockResolvedValueOnce(commit("seed-sha", []));

    const result = await fixture.manager.initializeEmptyRemote();

    expect(result).toMatchObject({
      status: "success",
      commitSha: "seed-sha",
    });
    expect(fixture.gitlab.createCommit).toHaveBeenCalledTimes(1);
    expect(fixture.gitlab.createCommit).toHaveBeenCalledWith({
      message: "Initialize vault",
      actions: [
        { action: "create", file_path: "alpha.md", content: base64("alpha"), encoding: "base64" },
        { action: "create", file_path: "beta.md", content: base64("beta"), encoding: "base64" },
      ],
    });

    const state = (await fixture.store.load()).state;
    expect(state.initialized).toBe(true);
    expect(state.lastSyncedCommitSha).toBe("seed-sha");
  });

  it("refuses to seed an empty remote without a commit author", async () => {
    const fixture = managerFixture({
      data: pluginData({ initialized: false }),
      settings: { ...settings, authorName: "", authorEmail: "" },
      localFiles: { "alpha.md": "alpha" },
    });

    const result = await fixture.manager.initializeEmptyRemote();

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/author/i);
    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
  });

  it("refuses to seed an empty remote when the vault has no files", async () => {
    const fixture = managerFixture({
      data: pluginData({ initialized: false }),
      localFiles: {},
    });

    const result = await fixture.manager.initializeEmptyRemote();

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/no files/i);
    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
  });
});

function managerFixture(options: {
  data: PluginData;
  settings?: GitLabSyncSettings;
  token?: string;
  branchHeads?: string[];
  canPush?: boolean;
  remoteChanges?: RemoteChange[];
  remoteTree?: any[];
  localFiles?: Record<string, string>;
  platform?: DevicePlatform;
}) {
  const data = options.settings
    ? { ...options.data, settings: options.settings }
    : options.data;
  const events: string[] = [];
  const store = fakeStore(data, events);
  const journal = {
    list: vi.fn(() => Object.values(options.data.state.dirtyEntries)),
    recordUpsert: vi.fn(async (path: string) => {
      await store.update((data) => {
        data.state.dirtyEntries[path] = { path, operation: "upsert", recordedAt: 1234 };
      });
    }),
    recordDelete: vi.fn(async (path: string) => {
      await store.update((data) => {
        data.state.dirtyEntries[path] = { path, operation: "delete", recordedAt: 1234 };
      });
    }),
    suppress: async <T>(operation: () => Promise<T>) => operation(),
  };
  const materializer = {
    recoverPendingTransaction: vi.fn(async () => {
      events.push("recover");
      const data = await store.load();
      const pending = data.state.pendingTransaction;
      if (!pending) {
        return false;
      }
      await store.update((next) => {
        next.state.lastSyncedCommitSha = pending.committedSha;
        next.state.trackedFiles = pending.nextTrackedFiles;
        for (const path of pending.acknowledgedDirtyPaths) {
          delete next.state.dirtyEntries[path];
        }
        next.state.pendingTransaction = null;
        next.state.lastSyncResult = pending.conflictPaths.length > 0 ? "conflict" : "success";
      });
      return true;
    }),
    apply: vi.fn(async () => {
      events.push("apply");
    }),
  };
  const branchHeads = [...(options.branchHeads ?? ["remote-a", "remote-a"])];
  const gitlab = {
    getBranch: vi.fn(async () => branch(branchHeads.shift() ?? "remote-a", options.canPush ?? true)),
    validateAccess: vi.fn(async () => undefined),
    getRawBlob: vi.fn(async () => null),
    getRawFile: vi.fn(async () => null),
    getTree: vi.fn(async () => options.remoteTree ?? []),
    createCommit: vi.fn(async () => commit("commit-a", ["remote-a"])),
  };
  const remoteDiff = {
    discover: vi.fn(async () => ({
      changes: options.remoteChanges ?? [],
      usedFallback: false,
    })),
  };
  const ignoreMatcher = {
    reload: vi.fn(async () => undefined),
    isIgnored: vi.fn(() => false),
  };
  const localSnapshot = {
    snapshot: vi.fn(async (entries: DirtyEntry[]) =>
      entries.map((entry) => ({
        path: entry.path,
        operation: entry.operation,
        local: { exists: true, bytes: new TextEncoder().encode("local") },
        base: { exists: false, bytes: null },
      })),
    ),
  };
  const planner = {
    plan: vi.fn(async () => remoteOnlyPlan("remote-a", [])),
  };
  const notices: string[] = [];

  return {
    events,
    store,
    journal,
    materializer,
    gitlab,
    remoteDiff,
    ignoreMatcher,
    localSnapshot,
    planner,
    manager: new SyncManager({
      stateStore: store,
      getToken: async () => options.token ?? "secret-token",
      createGitLabClient: () => gitlab,
      createRemoteDiffService: () => remoteDiff,
      createIgnoreMatcher: () => ignoreMatcher,
      createLocalSnapshotService: () => localSnapshot,
      createPlanner: () => planner,
      materializer,
      journal,
      vault: fakeVault(options.localFiles ?? {}),
      now: () => 1234,
      nowDate: () => new Date("2026-07-26T20:15:00+03:00"),
      notice: (message) => notices.push(message),
      platform: options.platform ?? { isMacOS: true },
    }),
    notices,
  };
}

function fakeVault(files: Record<string, string>) {
  return {
    configDir: ".obsidian",
    adapter: {
      list: async (dir: string) => {
        const prefix = dir ? `${dir}/` : "";
        const childFiles: string[] = [];
        const childFolders = new Set<string>();
        for (const path of Object.keys(files)) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const [first, ...remaining] = rest.split("/");
          if (!first) continue;
          if (remaining.length === 0) {
            childFiles.push(path);
          } else {
            childFolders.add(`${prefix}${first}`);
          }
        }
        return { files: childFiles.sort(), folders: [...childFolders].sort() };
      },
      readBinary: async (path: string) => new TextEncoder().encode(files[path]).buffer,
    },
  } as any;
}

function fakeStore(initial: PluginData, events: string[]) {
  let data = cloneData(initial);
  return {
    load: vi.fn(async () => cloneData(data)),
    save: vi.fn(async (next: PluginData) => {
      data = cloneData(next);
      events.push(`save:${next.state.pendingTransaction ? `pending:${next.state.pendingTransaction.committedSha}` : "state"}`);
    }),
    update: vi.fn(async (mutator: (data: PluginData) => void | Promise<void>) => {
      const next = cloneData(data);
      await mutator(next);
      data = cloneData(next);
      events.push(`save:${next.state.pendingTransaction ? `pending:${next.state.pendingTransaction.committedSha}` : "state"}`);
      return cloneData(data);
    }),
  };
}

function initializedData(overrides: Partial<LocalSyncState> = {}): PluginData {
  return pluginData({
    initialized: true,
    lastSyncedCommitSha: "base-a",
    ...overrides,
  });
}

function pluginData(state: Partial<LocalSyncState>): PluginData {
  return {
    settings,
    state: {
      schemaVersion: 1,
      initialized: false,
      lastSyncedCommitSha: null,
      trackedFiles: {},
      dirtyEntries: {},
      pendingTransaction: null,
      lastSyncAt: null,
      lastSyncResult: "never",
      ...state,
    },
  };
}

function localCommitPlan(remoteSha: string, path: string): SyncPlan {
  return {
    basedOnRemoteSha: remoteSha,
    actions: [
      {
        action: "create",
        file_path: path,
        content: base64("local"),
        encoding: "base64",
      } satisfies GitLabCommitAction,
    ],
    materializeAfterCommit: [],
    materializeWithoutCommit: [],
    nextTrackedFiles: { [path]: tracked("local") },
    acknowledgedDirtyPaths: [path],
    conflictPaths: [],
  };
}

function remoteOnlyPlan(remoteSha: string, operations: MaterializeOperation[]): SyncPlan {
  return {
    basedOnRemoteSha: remoteSha,
    actions: [],
    materializeAfterCommit: [],
    materializeWithoutCommit: operations,
    nextTrackedFiles: operations.some((operation) => operation.type === "write")
      ? Object.fromEntries(
        operations
          .filter((operation) => operation.type === "write")
          .map((operation) => [operation.path, tracked("desktop")]),
      )
      : {},
    acknowledgedDirtyPaths: [],
    conflictPaths: [],
  };
}

function pendingTransaction(committedSha: string): PendingTransaction {
  return {
    transactionId: "tx-1",
    committedSha,
    materializeOperations: [{ type: "write", path: "remote.md", contentBase64: base64("remote") }],
    nextTrackedFiles: { "remote.md": tracked("remote") },
    acknowledgedDirtyPaths: ["remote.md"],
    conflictPaths: [],
    createdAt: 1,
  };
}

function branch(sha: string, canPush: boolean): GitLabBranch {
  return {
    name: "main",
    can_push: canPush,
    commit: { id: sha, parent_ids: [] },
  };
}

function commit(id: string, parentIds: string[]): CreatedGitLabCommit {
  return { id, parent_ids: parentIds };
}

function dirty(path: string): DirtyEntry {
  return { path, operation: "upsert", recordedAt: 1 };
}

function tracked(text: string): TrackedFile {
  return { blobId: `blob-${text}`, mode: "100644", size: text.length };
}

function base64(text: string): string {
  return Buffer.from(text).toString("base64");
}

async function gitBlobId(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header, 0);
  payload.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", payload);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloneData(data: PluginData): PluginData {
  return JSON.parse(JSON.stringify(data));
}
