import { describe, expect, it, vi } from "vitest";
import { ConnectConfirmModal } from "../../src/views/connect-confirm-modal";

function makeApp() {
  return {} as any;
}

describe("ConnectConfirmModal", () => {
  it("summarizes counts and caps the name list at 10", () => {
    const preview = {
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
    const preview = { remoteFileCount: 5, localPushCount: 0, conflictCount: 0, localPushPaths: [] };
    const modal = new ConnectConfirmModal(makeApp(), "g/p", "main", preview, vi.fn());
    modal.onOpen();
    expect(modal.contentEl.textContent ?? "").toContain("0 files to push");
  });

  it("invokes the callback when Connect is clicked", () => {
    const onConfirm = vi.fn();
    const preview = { remoteFileCount: 1, localPushCount: 0, conflictCount: 0, localPushPaths: [] };
    const modal = new ConnectConfirmModal(makeApp(), "g/p", "main", preview, onConfirm);
    modal.onOpen();
    modal.confirm();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
