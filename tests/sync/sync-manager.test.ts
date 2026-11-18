import { describe, expect, it, vi } from "vitest";
import { SyncManager } from "../../src/sync/sync-manager";
import type {
  CreatedGitLabCommit,
  GitLabBranch,
  GitLabCommitAction,
  GitLabCommitSummary,
  GitLabRepositoryFile,
} from "../../src/gitlab/types";
import type { DirtyEntry, GitLabSyncSettings, LocalSyncState, PendingTransaction, PluginData, TrackedFile, UnconfirmedCommit } from "../../src/sync/types";
import type { RemoteChange } from "../../src/sync/remote-diff";
import type { SyncPlan } from "../../src/sync/sync-planner";
import type { StreamingRemoteApplier } from "../../src/sync/remote-only-stream";
import type { PlannerLike } from "../../src/sync/sync-manager";
import type { VersionState } from "../../src/sync/local-snapshot";
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
  allowSelfSignedCertificateForConnect: false,
};

describe("SyncManager", () => {
  it("updates one progress handle through a successful sync and hides it once", async () => {
    const messages: string[] = [];
    let created = 0;
    let hidden = 0;
    const fixture = managerFixture({
      data: initializedData(),
      createProgressNotice: (message) => {
        created += 1;
        messages.push(message);
        return {
          setMessage: (next) => messages.push(next),
          hide: () => {
            hidden += 1;
          },
        };
      },
    });
    fixture.planner.plan.mockResolvedValueOnce(remoteOnlyPlan("remote-a", []));

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({ status: "success" });

    expect(created).toBe(1);
    expect(messages).toEqual([
      "Checking GitLab…",
      "Checking GitLab…",
      "Finding remote changes…",
      "Saving local changes…",
      "Resolving conflicts…",
      "Updating local vault…",
      "Sync complete",
    ]);
    expect(hidden).toBe(1);
  });

  it("hides the progress handle once when sync fails", async () => {
    let created = 0;
    let hidden = 0;
    const fixture = managerFixture({
      data: initializedData(),
      createProgressNotice: () => {
        created += 1;
        return {
          setMessage: () => undefined,
          hide: () => {
            hidden += 1;
          },
        };
      },
    });
    fixture.gitlab.getBranch.mockRejectedValueOnce(new Error("network down"));

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({ status: "error" });

    expect(created).toBe(1);
    expect(hidden).toBe(1);
  });

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
      expect.objectContaining({
        message: expect.stringMatching(/^Sync vault from Mobile User \(Mac\) foreground \[sync-tx:[a-z0-9-]+\]$/),
      }),
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
      expect.objectContaining({
        message: expect.stringMatching(/^Sync vault from iPhone \[sync-tx:[a-z0-9-]+\]$/),
      }),
    );
  });

  it("persists a transaction intent before GitLab commit creation and clears it after confirmation", async () => {
    const fixture = managerFixture({
      data: initializedData({ dirtyEntries: { "note.md": dirty("note.md") } }),
    });
    fixture.planner.plan.mockResolvedValueOnce(localCommitPlan("remote-a", "note.md"));
    const observed: { state?: PluginData; message?: string } = {};
    fixture.gitlab.createCommit.mockImplementationOnce(async (...args: unknown[]) => {
      observed.state = await fixture.store.load();
      observed.message = (args[0] as { message: string }).message;
      expect(observed.message).toMatch(/\[sync-tx:[a-z0-9-]+\]$/);
      return commit("commit-a", ["remote-a"]);
    });

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({
      status: "success",
      commitSha: "commit-a",
    });

    const intent = observed.state?.state.unconfirmedCommit;
    expect(intent).not.toBeNull();
    const messageId = observed.message?.match(/\[sync-tx:([a-z0-9-]+)\]$/)?.[1];
    expect(intent?.transactionId).toBe(messageId);
    expect(intent?.basedOnRemoteSha).toBe("remote-a");
    expect(intent?.target).toEqual({
      baseUrl: settings.gitlabBaseUrl,
      projectPath: settings.projectPath,
      branch: settings.branch,
    });

    const finalState = await fixture.store.load();
    expect(finalState.state.unconfirmedCommit).toBeNull();
    expect(finalState.state.pendingTransaction).toBeNull();
    expect(finalState.state.lastSyncedCommitSha).toBe("commit-a");
  });

  it("uses the production planner to attach optimistic locks to tracked-file updates", async () => {
    const fixture = managerFixture({
      data: initializedData({
        dirtyEntries: { "note.md": dirty("note.md") },
        trackedFiles: { "note.md": tracked("old") },
      }),
      useProductionPlanner: true,
      remoteFiles: { "note.md": "old" },
      repositoryFiles: {
        "note.md": {
          file_name: "note.md",
          file_path: "note.md",
          size: 3,
          encoding: "base64",
          content: base64("old"),
          content_sha256: "blob-old",
          ref: "remote-a",
          blob_id: "blob-old",
          commit_id: "remote-a",
          last_commit_id: "remote-file-commit",
        },
      },
      snapshotBases: { "note.md": "old" },
    });

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({ status: "success" });

    const commitCalls = fixture.gitlab.createCommit.mock.calls as unknown as Array<
      [{ actions: GitLabCommitAction[] }]
    >;
    const action = commitCalls[0]?.[0].actions[0];
    expect(action).toMatchObject({
      action: "update",
      file_path: "note.md",
      last_commit_id: "remote-file-commit",
    });
    expect(fixture.gitlab.getFile).toHaveBeenCalledWith("note.md", "remote-a");
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

  it("holds the sync lock while startup recovery is running", async () => {
    const fixture = managerFixture({
      data: initializedData({ pendingTransaction: pendingTransaction("commit-sha") }),
    });
    const locking: boolean[] = [];
    fixture.materializer.recoverPendingTransaction.mockImplementationOnce(async () => {
      locking.push(fixture.manager.isSyncing());
      return true;
    });

    await expect(fixture.manager.recoverIfNeeded()).resolves.toBe(true);

    expect(locking).toEqual([true]);
    expect(fixture.manager.isSyncing()).toBe(false);
  });

  it("refuses state reset while a sync holds the manager lock", async () => {
    const fixture = managerFixture({ data: initializedData() });
    let releaseBranch!: (value: GitLabBranch) => void;
    fixture.gitlab.getBranch.mockImplementationOnce(
      () => new Promise<GitLabBranch>((resolve) => {
        releaseBranch = resolve;
      }),
    );
    const syncing = fixture.manager.sync("manual");
    await vi.waitFor(() => expect(fixture.manager.isSyncing()).toBe(true));
    await vi.waitFor(() => expect(fixture.gitlab.getBranch).toHaveBeenCalled());

    await expect(fixture.manager.resetState()).rejects.toThrow(
      "Cannot reset sync state while sync is running",
    );

    releaseBranch(branch("remote-a", true));
    await expect(syncing).resolves.toMatchObject({ status: "success" });
  });

  it("recovers an accepted mobile commit behind a newer remote commit", async () => {
    const fixture = managerFixture({
      data: initializedData({
        dirtyEntries: { "note.md": dirty("note.md") },
        unconfirmedCommit: unconfirmedCommit(settings, [dirty("note.md")]),
      }),
      branchHeads: ["remote-b"],
      remoteTree: [{
        id: "blob-mobile",
        name: "note.md",
        type: "blob",
        path: "note.md",
        mode: "100644",
      }],
    });
    fixture.remoteDiff.discover.mockResolvedValueOnce({
      changes: [{ type: "update", path: "note.md" }],
      remoteTree: { "note.md": tracked("mobile") },
      usedFallback: false,
    });
    fixture.gitlab.listCommits.mockResolvedValueOnce([
      commitSummary("remote-b", "Sync vault from desktop", ["mobile-commit"]),
      commitSummary("mobile-commit", `Sync vault from iPhone [sync-tx:sync-tx-1]`, ["remote-a"]),
      commitSummary("remote-a", "base", []),
    ]);

    await expect(fixture.manager.sync("foreground")).resolves.toMatchObject({
      status: "success",
      commitSha: "mobile-commit",
      recovered: true,
    });

    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
    expect(fixture.planner.plan).not.toHaveBeenCalled();
    expect(fixture.gitlab.listCommits).toHaveBeenCalledWith("remote-b", "1");
    const state = await fixture.store.load();
    expect(state.state.unconfirmedCommit).toBeNull();
    expect(state.state.lastSyncedCommitSha).toBe("mobile-commit");
    expect(state.state.trackedFiles).toEqual({
      "note.md": { blobId: "blob-mobile", mode: "100644", size: 0 },
    });
    expect(state.state.dirtyEntries).toEqual({});
  });

  it("materializes a found accepted commit without planning a second commit", async () => {
    const capturedEntry = dirty("note.md");
    const conflictPath = "note — conflict iPhone.md";
    const remoteTree = {
      "note.md": tracked("remote"),
      [conflictPath]: tracked("conflict"),
    };
    const fixture = managerFixture({
      data: initializedData({
        dirtyEntries: { "note.md": capturedEntry },
        unconfirmedCommit: unconfirmedCommit(settings, [capturedEntry]),
      }),
      branchHeads: ["mobile-commit"],
      remoteTree: [
        {
          id: "blob-remote",
          name: "note.md",
          type: "blob",
          path: "note.md",
          mode: "100644",
        },
        {
          id: "blob-conflict",
          name: conflictPath,
          type: "blob",
          path: conflictPath,
          mode: "100644",
        },
      ],
    });
    fixture.gitlab.listCommits.mockResolvedValueOnce([
      commitSummary(
        "mobile-commit",
        "Sync vault from iPhone [sync-tx:sync-tx-1]",
        ["remote-a"],
      ),
      commitSummary("remote-a", "base", []),
    ]);
    fixture.remoteDiff.discover.mockResolvedValueOnce({
      changes: [
        { type: "update", path: "note.md" },
        { type: "create", path: conflictPath },
      ],
      remoteTree,
      usedFallback: false,
    });

    const result = await fixture.manager.sync("foreground");

    expect(result).toMatchObject({
      status: "success",
      commitSha: "mobile-commit",
      recovered: true,
    });
    expect(fixture.planner.plan).not.toHaveBeenCalled();
    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
    expect(fixture.gitlab.getRawFile).toHaveBeenCalledWith("note.md", "mobile-commit");
    const state = await fixture.store.load();
    expect(state.state.unconfirmedCommit).toBeNull();
    expect(state.state.lastSyncedCommitSha).toBe("mobile-commit");
    expect(state.state.trackedFiles).toEqual({
      "note.md": { blobId: "blob-remote", mode: "100644", size: 0 },
      [conflictPath]: { blobId: "blob-conflict", mode: "100644", size: 0 },
    });
    expect(state.state.dirtyEntries).toEqual({});
  });

  it("skips found-commit materialization for a path edited after its captured dirty revision", async () => {
    const capturedEntry = dirty("note.md");
    const postSnapshotEntry = { ...capturedEntry, recordedAt: capturedEntry.recordedAt + 1 };
    const fixture = managerFixture({
      data: initializedData({
        dirtyEntries: { "note.md": postSnapshotEntry },
        unconfirmedCommit: unconfirmedCommit(settings, [capturedEntry]),
      }),
      branchHeads: ["mobile-commit"],
      remoteTree: [{
        id: "blob-remote",
        name: "note.md",
        type: "blob",
        path: "note.md",
        mode: "100644",
      }],
    });
    fixture.gitlab.listCommits.mockResolvedValueOnce([
      commitSummary("mobile-commit", "marker [sync-tx:sync-tx-1]", ["remote-a"]),
    ]);
    fixture.remoteDiff.discover.mockResolvedValueOnce({
      changes: [{ type: "update", path: "note.md" }],
      remoteTree: { "note.md": tracked("remote") },
      usedFallback: false,
    });

    await expect(fixture.manager.sync("foreground")).resolves.toMatchObject({
      status: "success",
      commitSha: "mobile-commit",
      recovered: true,
    });

    expect(fixture.materializer.applyBytes).not.toHaveBeenCalled();
    const state = await fixture.store.load();
    expect(state.state.dirtyEntries["note.md"]).toEqual(postSnapshotEntry);
    expect(state.state.lastSyncedCommitSha).toBe("mobile-commit");
    expect(state.state.trackedFiles).toEqual({
      "note.md": { blobId: "blob-remote", mode: "100644", size: 0 },
    });
  });

  it("clears an unconfirmed commit when history reaches the intended base without it", async () => {
    const fixture = managerFixture({
      data: initializedData({
        unconfirmedCommit: unconfirmedCommit(),
      }),
    });
    fixture.gitlab.listCommits.mockResolvedValueOnce([
      commitSummary("remote-a", "base", []),
    ]);
    fixture.planner.plan.mockResolvedValueOnce(remoteOnlyPlan("remote-a", []));

    await expect(fixture.manager.sync("foreground")).resolves.toMatchObject({
      status: "success",
      commitSha: "remote-a",
    });

    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
    expect((await fixture.store.load()).state.unconfirmedCommit).toBeNull();
  });

  it("does not retry a commit when unconfirmed transaction ancestry is unknown", async () => {
    const fixture = managerFixture({
      data: initializedData({
        unconfirmedCommit: unconfirmedCommit(),
      }),
      branchHeads: ["remote-b"],
    });
    fixture.gitlab.listCommits.mockResolvedValueOnce([
      commitSummary("remote-b", "unrelated history", ["remote-x"]),
    ]);

    const result = await fixture.manager.sync("foreground");

    expect(result).toMatchObject({
      status: "error",
      message: "Previous GitLab commit outcome is unknown; retry is blocked until history is available",
    });
    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
    expect((await fixture.store.load()).state.unconfirmedCommit).not.toBeNull();
  });

  it("blocks unconfirmed transaction recovery when the configured target changed", async () => {
    const fixture = managerFixture({
      data: initializedData({
        unconfirmedCommit: unconfirmedCommit({ ...settings, branch: "other-branch" }),
      }),
      settings: { ...settings, branch: "main" },
    });

    const result = await fixture.manager.sync("foreground");

    expect(result).toMatchObject({
      status: "error",
      message: "Previous GitLab commit belongs to a different target; retry is blocked",
    });
    expect(fixture.gitlab.listCommits).not.toHaveBeenCalled();
    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
  });

  it("treats commit history that misses the captured branch head as unknown", async () => {
    const fixture = managerFixture({
      data: initializedData({ unconfirmedCommit: unconfirmedCommit() }),
      branchHeads: ["remote-b"],
    });
    fixture.gitlab.listCommits.mockResolvedValueOnce([
      commitSummary("remote-x", "stale history", ["remote-a"]),
      commitSummary("remote-a", "base", []),
    ]);

    const result = await fixture.manager.sync("foreground");

    expect(result).toMatchObject({
      status: "error",
      message: "Previous GitLab commit outcome is unknown; retry is blocked until history is available",
    });
    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
  });

  it("defers sync without network calls while backoff is active", async () => {
    const fixture = managerFixture({
      data: initializedData({
        remoteBackoffUntil: 100_000,
        remoteBackoffReason: "rate-limit",
      }),
    });

    const result = await fixture.manager.sync("manual");

    expect(result).toMatchObject({ status: "deferred", retryAt: 100_000 });
    expect(fixture.gitlab.getBranch).not.toHaveBeenCalled();
    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
  });

  it("clears remote backoff after a successful sync", async () => {
    const fixture = managerFixture({
      data: initializedData({
        remoteBackoffUntil: 0,
        remoteBackoffReason: "rate-limit",
      }),
    });
    fixture.planner.plan.mockResolvedValueOnce(remoteOnlyPlan("remote-a", []));

    const result = await fixture.manager.sync("manual");

    expect(result.status).toBe("success");
    const state = (await fixture.store.load()).state;
    expect(state.remoteBackoffUntil).toBeNull();
    expect(state.remoteBackoffReason).toBeNull();
  });

  it("performs one initial branch read and no validateAccess before planning", async () => {
    const fixture = managerFixture({ data: initializedData() });
    fixture.planner.plan.mockResolvedValueOnce(remoteOnlyPlan("remote-a", []));

    await fixture.manager.sync("manual");

    expect(fixture.gitlab.getBranch).toHaveBeenCalledTimes(1);
    expect(fixture.gitlab.validateAccess).not.toHaveBeenCalled();
  });

  it("calls getRawFile once per ref/path within a plan attempt", async () => {
    let getRemoteVersion:
      | ((path: string, remoteSha: string) => Promise<VersionState>)
      | undefined;
    const fixture = managerFixture({
      data: initializedData({ dirtyEntries: { "note.md": dirty("note.md") } }),
      createPlanner: (_client, _settings, reader) => {
        getRemoteVersion = reader;
        return { plan: async () => remoteOnlyPlan("remote-a", []) };
      },
    });

    await fixture.manager.sync("manual");

    expect(getRemoteVersion).toBeDefined();
    // Conflict planning and optimistic locking both read the same ref/path.
    await getRemoteVersion!("note.md", "remote-a");
    await getRemoteVersion!("note.md", "remote-a");
    expect(fixture.gitlab.getRawFile).toHaveBeenCalledTimes(1);
  });

  it("materializes remote-only changes and advances state without creating a commit", async () => {
    const fixture = managerFixture({
      data: initializedData(),
      remoteChanges: [{ type: "update", path: "desktop.md" }],
    });
    fixture.planner.plan.mockResolvedValueOnce(remoteOnlyPlan("remote-a", [
      { type: "update", path: "desktop.md" },
    ]));

    await expect(fixture.manager.sync("startup")).resolves.toMatchObject({
      status: "success",
      commitSha: "remote-a",
    });

    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
    expect(fixture.streamingApplier.applyStream).toHaveBeenCalledTimes(1);
    const call = fixture.streamingApplier.applyStream.mock.calls[0][0];
    expect(call.changes).toEqual([{ type: "update", path: "desktop.md" }]);
    expect((await fixture.store.load()).state).toMatchObject({
      lastSyncedCommitSha: "remote-a",
      trackedFiles: { "desktop.md": tracked("stream") },
      pendingTransaction: null,
      unconfirmedCommit: null,
      lastSyncResult: "success",
    });
  });

  it("streams a remote-only plan and persists resume progress between chunks", async () => {
    const fixture = managerFixture({
      data: initializedData(),
      remoteChanges: [{ type: "update", path: "desktop.md" }],
    });
    fixture.planner.plan.mockResolvedValueOnce(
      remoteOnlyPlan("remote-a", [{ type: "update", path: "desktop.md" }]),
    );

    await expect(fixture.manager.sync("startup")).resolves.toMatchObject({
      status: "success",
      commitSha: "remote-a",
    });

    expect(fixture.gitlab.createCommit).not.toHaveBeenCalled();
    expect(fixture.streamingApplier.applyStream).toHaveBeenCalledTimes(1);
    const call = fixture.streamingApplier.applyStream.mock.calls[0][0];
    expect(call.changes).toEqual([{ type: "update", path: "desktop.md" }]);
    expect(call.remoteSha).toBe("remote-a");
    // Resume state was persisted and then cleared on finalize.
    const state = (await fixture.store.load()).state;
    expect(state.remoteApply).toBeNull();
    expect(state.lastSyncedCommitSha).toBe("remote-a");
    expect(state.trackedFiles).toEqual({ "desktop.md": tracked("stream") });
  });

  it("resumes an interrupted remote-only apply when the remote head matches", async () => {
    const fixture = managerFixture({
      data: initializedData({
        remoteApply: {
          remoteSha: "remote-a",
          remainingChanges: [{ type: "update", path: "resume.md" }],
          nextTrackedFiles: {},
        },
      }),
      branchHeads: ["remote-a"],
    });

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({
      status: "success",
      commitSha: "remote-a",
    });

    expect(fixture.planner.plan).not.toHaveBeenCalled();
    expect(fixture.streamingApplier.applyStream).toHaveBeenCalledTimes(1);
    const call = fixture.streamingApplier.applyStream.mock.calls[0][0];
    expect(call.changes).toEqual([{ type: "update", path: "resume.md" }]);
    expect(call.baseIndex).toEqual({});
    const state = (await fixture.store.load()).state;
    expect(state.remoteApply).toBeNull();
    expect(state.lastSyncedCommitSha).toBe("remote-a");
  });

  it("skips a dirty path when resuming a remote-only apply and keeps its dirty entry", async () => {
    const fixture = managerFixture({
      data: initializedData({
        dirtyEntries: { "resume.md": dirty("resume.md") },
        remoteApply: {
          remoteSha: "remote-a",
          remainingChanges: [
            { type: "update", path: "resume.md" },
            { type: "create", path: "other.md" },
          ],
          nextTrackedFiles: {},
        },
      }),
      branchHeads: ["remote-a"],
    });

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({
      status: "conflict",
    });

    expect(fixture.streamingApplier.applyStream).toHaveBeenCalledTimes(1);
    const call = fixture.streamingApplier.applyStream.mock.calls[0][0];
    // The dirty resume.md change is skipped; only other.md is materialized.
    expect(call.changes).toEqual([{ type: "create", path: "other.md" }]);
    const state = (await fixture.store.load()).state;
    expect(state.dirtyEntries).toEqual({ "resume.md": dirty("resume.md") });
    expect(state.remoteApply).toBeNull();
    expect(state.lastSyncedCommitSha).toBe("base-a");
    expect(state.lastSyncResult).toBe("conflict");
  });

  it("discards a stale resume point when the remote head moved", async () => {
    const fixture = managerFixture({
      data: initializedData({
        remoteApply: {
          remoteSha: "remote-a",
          remainingChanges: [{ type: "update", path: "resume.md" }],
          nextTrackedFiles: {},
        },
      }),
      branchHeads: ["remote-b"],
    });
    fixture.planner.plan.mockResolvedValueOnce(remoteOnlyPlan("remote-b", []));

    await fixture.manager.sync("manual");

    expect(fixture.planner.plan).toHaveBeenCalledTimes(1);
    const state = (await fixture.store.load()).state;
    expect(state.remoteApply).toBeNull();
    expect(state.lastSyncedCommitSha).toBe("remote-b");
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
    fixture.materializer.applyTransaction.mockRejectedValueOnce(new Error("disk full"));

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

  it("does not acknowledge a dirty entry edited after its snapshot", async () => {
    const snapshotEntry = { ...dirty("note.md"), recordedAt: 1 };
    const postSnapshotEntry = { ...dirty("note.md"), recordedAt: 2 };
    const plan: SyncPlan = {
      ...localCommitPlan("remote-a", "note.md"),
      acknowledgedDirtyEntries: [snapshotEntry],
    };
    const fixture = managerFixture({
      data: initializedData({
        dirtyEntries: { "note.md": snapshotEntry },
      }),
    });
    fixture.planner.plan.mockResolvedValueOnce(plan);
    fixture.gitlab.createCommit.mockImplementationOnce(async () => {
      await fixture.store.update((data) => {
        data.state.dirtyEntries["note.md"] = postSnapshotEntry;
      });
      return commit("commit-a", ["remote-a"]);
    });

    await expect(fixture.manager.sync("manual")).resolves.toMatchObject({ status: "success" });

    const state = await fixture.store.load();
    expect(state.state.dirtyEntries["note.md"]).toEqual(postSnapshotEntry);
    expect(state.state.lastSyncedCommitSha).toBe("commit-a");
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
  remoteDiffTree?: Record<string, TrackedFile>;
  localFiles?: Record<string, string>;
  remoteFiles?: Record<string, string>;
  repositoryFiles?: Record<string, GitLabRepositoryFile>;
  snapshotBases?: Record<string, string>;
  platform?: DevicePlatform;
  createPlanner?: (
    client: unknown,
    settings: unknown,
    getRemoteVersion: (path: string, remoteSha: string) => Promise<VersionState>,
  ) => PlannerLike;
  useProductionPlanner?: boolean;
  createProgressNotice?: (message: string) => {
    setMessage(message: string): void;
    hide(): void;
  };
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
    applyTransaction: vi.fn(async () => {
      events.push("apply");
    }),
    applyProtectedBytes: vi.fn(async (operations: Array<{ path: string }>) =>
      operations.map((operation) => ({
        path: operation.path,
        operation: "upsert" as const,
        applied: true,
      }))),
    applyBytes: vi.fn(async () => undefined),
  };
  const streamingApplier = {
    applyStream: vi.fn(async ({ changes, remoteSha, baseIndex }: {
      changes: RemoteChange[];
      remoteSha: string;
      baseIndex: Record<string, TrackedFile>;
      onProgress?: (p: unknown) => Promise<void>;
    }) => {
      const index = { ...baseIndex };
      for (const change of changes) {
        if (change.type === "rename") {
          delete index[change.oldPath];
          index[change.newPath] = tracked("stream");
        } else if (change.type === "delete") {
          delete index[change.path];
        } else {
          index[change.path] = tracked("stream");
        }
      }
      return index;
    }),
  };
  const branchHeads = [...(options.branchHeads ?? ["remote-a", "remote-a"])];
  const gitlab = {
    getBranch: vi.fn(async () => branch(branchHeads.shift() ?? "remote-a", options.canPush ?? true)),
    validateAccess: vi.fn(async () => undefined),
    getRawBlob: vi.fn(async () => null),
    getRawFile: vi.fn(async (path: string) => {
      const content = options.remoteFiles?.[path];
      return content === undefined ? null : new TextEncoder().encode(content).buffer;
    }),
    getFile: vi.fn(async (path: string) => options.repositoryFiles?.[path] ?? null),
    getTree: vi.fn(async () => options.remoteTree ?? []),
    listCommits: vi.fn(async (): Promise<GitLabCommitSummary[]> => []),
    createCommit: vi.fn(async () => commit("commit-a", ["remote-a"])),
  };
  const remoteDiff = {
    discover: vi.fn(async (): Promise<{
      changes: RemoteChange[];
      remoteTree?: Record<string, TrackedFile>;
      usedFallback: boolean;
    }> => ({
      changes: options.remoteChanges ?? [],
      remoteTree: options.remoteDiffTree,
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
        base: options.snapshotBases?.[entry.path] === undefined
          ? { exists: false, bytes: null }
          : { exists: true, bytes: new TextEncoder().encode(options.snapshotBases[entry.path]) },
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
    streamingApplier,
    manager: new SyncManager({
      stateStore: store,
      getToken: async () => options.token ?? "secret-token",
      createGitLabClient: () => gitlab,
      createRemoteDiffService: () => remoteDiff,
      createIgnoreMatcher: () => ignoreMatcher,
      createLocalSnapshotService: () => localSnapshot,
      createPlanner: options.useProductionPlanner
        ? undefined
        : options.createPlanner ?? (() => planner),
      createStreamingApplier: () => streamingApplier as unknown as StreamingRemoteApplier,
      materializer,
      journal,
      vault: fakeVault(options.localFiles ?? {}),
      now: () => 1234,
      nowDate: () => new Date("2026-07-26T20:15:00+03:00"),
      notice: (message) => notices.push(message),
      createProgressNotice: options.createProgressNotice,
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
      exists: async (path: string) => Object.prototype.hasOwnProperty.call(files, path),
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
      schemaVersion: 3,
      initialized: false,
      lastSyncedCommitSha: null,
      trackedFiles: {},
      dirtyEntries: {},
      pendingTransaction: null,
      lastSyncAt: null,
      lastSyncResult: "never",
      remoteBackoffUntil: null,
      remoteBackoffReason: null,
      remoteApply: null,
      ...state,
      unconfirmedCommit: state.unconfirmedCommit ?? null,
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
    streamChanges: [],
    nextTrackedFiles: { [path]: tracked("local") },
    acknowledgedDirtyPaths: [path],
    conflictPaths: [],
  };
}

function remoteOnlyPlan(remoteSha: string, streamChanges: RemoteChange[]): SyncPlan {
  return {
    basedOnRemoteSha: remoteSha,
    actions: [],
    materializeAfterCommit: [],
    materializeWithoutCommit: [],
    streamChanges,
    nextTrackedFiles: Object.fromEntries(
      streamChanges
        .filter((change) => change.type === "create" || change.type === "update")
        .map((change) => [change.path, tracked("desktop")]),
    ),
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

function unconfirmedCommit(
  target: GitLabSyncSettings = settings,
  capturedDirtyEntries: DirtyEntry[] = [],
): UnconfirmedCommit {
  return {
    transactionId: "sync-tx-1",
    basedOnRemoteSha: "remote-a",
    target: {
      baseUrl: target.gitlabBaseUrl,
      projectPath: target.projectPath,
      branch: target.branch,
    },
    capturedDirtyEntries,
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

function commitSummary(id: string, message: string, parentIds: string[]): GitLabCommitSummary {
  return { id, title: message, message, parent_ids: parentIds };
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
