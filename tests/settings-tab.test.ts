import { describe, expect, it } from "vitest";
import { DEFAULT_STATE } from "../src/settings/settings";
import { vaultSetupViewState } from "../src/settings/settings-tab";

describe("settings setup view state", () => {
  it("shows setup choices before the vault is initialized", () => {
    const view = vaultSetupViewState({
      ...DEFAULT_STATE,
      initialized: false,
      lastSyncedCommitSha: null,
    });

    expect(view.title).toBe("Choose vault setup");
    expect(view.showSetupActions).toBe(true);
    expect(view.showResetAction).toBe(false);
  });

  it("hides setup choices after the vault is connected", () => {
    const view = vaultSetupViewState({
      ...DEFAULT_STATE,
      initialized: true,
      lastSyncedCommitSha: "abcdef123456",
      dirtyEntries: {
        "note.md": {
          path: "note.md",
          operation: "upsert",
          recordedAt: 1,
        },
      },
    });

    expect(view.title).toBe("Vault connected");
    expect(view.description).toContain("abcdef12");
    expect(view.description).toContain("Local pending changes: 1");
    expect(view.showSetupActions).toBe(false);
    expect(view.showResetAction).toBe(true);
  });
});
