import { describe, expect, it } from "vitest";
import * as manifest from "../manifest.json";

describe("GitLab fork identity", () => {
  it("uses a new plugin id and GitLab-only name", () => {
    expect(manifest.id).toBe("gitlab-gitless-sync");
    expect(manifest.name).toBe("GitLab Gitless Sync");
    expect(manifest.description).toContain("GitLab");
    expect(manifest.description).not.toContain("GitHub");
  });
});
