import { describe, expect, it, vi } from "vitest";
import { ConnectConfirmModal } from "../../src/views/connect-confirm-modal";

function makeApp() {
  return {} as any;
}

describe("ConnectConfirmModal", () => {
  it("summarizes counts and caps the name list at 10", () => {
    const preview = {
      mode: "merge" as const,
      remoteFileCount: 128,
      localPushCount: 12,
      conflictCount: 0,
      localPushPaths: Array.from({ length: 12 }, (_, i) => `note-${i}.md`),
    };
    const modal = new ConnectConfirmModal(makeApp(), "group/project", "main", preview, vi.fn());
    modal.onOpen();
    const text = modal.contentEl.textContent ?? "";
    expect(text).toContain("128 files will be downloaded");
    expect(text).toContain("12 local files will be pushed");
    expect(text).toContain("and 2 more");
  });

  it("renders the zero-push line", () => {
    const preview = { mode: "merge" as const, remoteFileCount: 5, localPushCount: 0, conflictCount: 0, localPushPaths: [] };
    const modal = new ConnectConfirmModal(makeApp(), "g/p", "main", preview, vi.fn());
    modal.onOpen();
    expect(modal.contentEl.textContent ?? "").toContain("0 files to push");
  });

  it("invokes the callback when Connect is clicked", () => {
    const onConfirm = vi.fn();
    const preview = { mode: "merge" as const, remoteFileCount: 1, localPushCount: 0, conflictCount: 0, localPushPaths: [] };
    const modal = new ConnectConfirmModal(makeApp(), "g/p", "main", preview, onConfirm);
    modal.onOpen();
    modal.confirm();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows loading and ignores repeated confirmation until connect finishes", async () => {
    let finishConnect!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => {
      finishConnect = resolve;
    }));
    const notices: string[] = [];
    (globalThis as any).__noticeSpy = (message: string) => notices.push(message);
    const preview = { mode: "merge" as const, remoteFileCount: 1, localPushCount: 0, conflictCount: 0, localPushPaths: [] };
    const modal = new ConnectConfirmModal(makeApp(), "g/p", "main", preview, onConfirm);
    modal.onOpen();

    const firstConfirm = modal.confirm();
    modal.confirm();
    const content = modal.contentEl as any;
    const connectButton = content.buttons.find(
      (button: any) => button.buttonText === "Connecting…",
    );

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(content.buttons.every((button: any) => button.disabled)).toBe(true);
    expect(connectButton).toBeDefined();
    expect(notices).toContain("Connecting to GitLab…");

    finishConnect();
    await firstConfirm;
    delete (globalThis as any).__noticeSpy;
  });

  it("renders the seed variant for an empty repository", () => {
    const preview = { mode: "seed" as const, branch: "main", localPushCount: 42,
      localPushPaths: Array.from({ length: 42 }, (_, i) => `n-${i}.md`) };
    const modal = new ConnectConfirmModal(makeApp(), "g/p", "main", preview, vi.fn());
    modal.onOpen();
    const text = modal.contentEl.textContent ?? "";
    expect(text).toContain("repository is empty");
    expect(text).toContain("42 files will be pushed");
    expect(text).toContain('first commit on branch "main"');
    expect(text).toContain("and 32 more");
    expect(text).not.toContain("will be downloaded");
  });
});
