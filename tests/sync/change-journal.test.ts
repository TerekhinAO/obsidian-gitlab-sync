import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/sync/state-store";
import { ChangeJournal } from "../../src/sync/change-journal";

function fakeStore(initialData: any = null) {
  let savedData = initialData;
  return {
    store: new StateStore({
      loadData: async () => savedData,
      saveData: async (data: unknown) => {
        savedData = data;
      },
    }),
    get data() {
      return savedData;
    },
  };
}

function fakeVault() {
  type Handler = (...args: any[]) => void;
  const handlers: Record<string, Handler[]> = {};
  return {
    vault: {
      configDir: ".obsidian",
      on: vi.fn((name: string, callback: Handler) => {
        handlers[name] = [...(handlers[name] ?? []), callback];
        return `${name}-${handlers[name].length}`;
      }),
    },
    emit(name: string, ...args: unknown[]) {
      for (const callback of handlers[name] ?? []) {
        callback(...args);
      }
    },
  };
}

describe("ChangeJournal", () => {
  it("records create, modify, delete, and rename events", async () => {
    const { store } = fakeStore();
    const { vault, emit } = fakeVault();
    const journal = new ChangeJournal({ vault: vault as any, stateStore: store, now: () => 1 });

    journal.start();
    emit("create", { path: "a.md" });
    emit("modify", { path: "b.md" });
    emit("delete", { path: "c.md" });
    emit("rename", { path: "new.md" }, "old.md");
    await journal.stop();

    expect(journal.list()).toEqual([
      { path: "a.md", operation: "upsert", recordedAt: 1 },
      { path: "b.md", operation: "upsert", recordedAt: 1 },
      { path: "c.md", operation: "delete", recordedAt: 1 },
      { path: "new.md", operation: "upsert", recordedAt: 1 },
      { path: "old.md", operation: "delete", recordedAt: 1 },
    ]);
  });

  it("ignores folder events so directories never enter the journal", async () => {
    const { store } = fakeStore();
    const { vault, emit } = fakeVault();
    const journal = new ChangeJournal({ vault: vault as any, stateStore: store, now: () => 1 });

    journal.start();
    emit("create", { path: "People/Sergey", children: [] });
    emit("rename", { path: "People/Renamed", children: [] }, "People/Old");
    emit("delete", { path: "People/Removed", children: [] });
    emit("modify", { path: "People/Sergey/note.md" });
    await journal.stop();

    expect(journal.list()).toEqual([
      { path: "People/Sergey/note.md", operation: "upsert", recordedAt: 1 },
    ]);
  });

  it("collapses repeated events by path", async () => {
    const { store } = fakeStore();
    const { vault } = fakeVault();
    const journal = new ChangeJournal({ vault: vault as any, stateStore: store, now: () => 2 });

    await journal.recordUpsert("note.md");
    await journal.recordUpsert("note.md");

    expect(journal.list()).toEqual([
      { path: "note.md", operation: "upsert", recordedAt: 2 },
    ]);
  });

  it("removes create followed by delete for never-tracked paths", async () => {
    const { store } = fakeStore();
    const { vault } = fakeVault();
    const journal = new ChangeJournal({ vault: vault as any, stateStore: store });

    await journal.recordUpsert("draft.md");
    await journal.recordDelete("draft.md");

    expect(journal.list()).toEqual([]);
  });

  it("keeps delete for tracked paths and delete followed by create becomes upsert", async () => {
    const { store } = fakeStore({
      state: {
        trackedFiles: { "tracked.md": { blobId: "a", mode: "100644", size: 1 } },
      },
    });
    const { vault } = fakeVault();
    const journal = new ChangeJournal({ vault: vault as any, stateStore: store, now: () => 3 });

    await journal.recordDelete("tracked.md");
    await journal.recordUpsert("tracked.md");

    expect(journal.list()).toEqual([
      { path: "tracked.md", operation: "upsert", recordedAt: 3 },
    ]);
  });

  it("persists entries across reload and acknowledges paths", async () => {
    const fixture = fakeStore();
    const { vault } = fakeVault();
    const journal = new ChangeJournal({ vault: vault as any, stateStore: fixture.store });

    await journal.recordUpsert("a.md");
    const reloaded = new ChangeJournal({ vault: vault as any, stateStore: fixture.store });
    await reloaded.stop();
    expect(reloaded.list().map((entry) => entry.path)).toEqual(["a.md"]);

    await reloaded.acknowledge(["a.md"]);
    expect(reloaded.list()).toEqual([]);
  });

  it("suppresses plugin-generated writes", async () => {
    const { store } = fakeStore();
    const { vault } = fakeVault();
    const journal = new ChangeJournal({ vault: vault as any, stateStore: store });

    await journal.suppress(() => journal.recordUpsert("remote.md"));

    expect(journal.list()).toEqual([]);
  });

  it("hard-excludes plugin runtime paths", async () => {
    const { store } = fakeStore();
    const { vault } = fakeVault();
    const journal = new ChangeJournal({ vault: vault as any, stateStore: store });

    await journal.recordUpsert(".obsidian/plugins/gitlab-gitless-sync/main.js");
    await journal.recordUpsert(".obsidian/gitlab-gitless-sync.log");
    await journal.recordUpsert(".obsidian/github-sync-metadata.json");
    await journal.recordUpsert(".git/config");

    expect(journal.list()).toEqual([]);
  });
});
