import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("replaces assets when retrying an existing release tag", () => {
    const workflow = readFileSync(
      join(__dirname, "../../.github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toContain("gh release view");
    expect(workflow).toContain("gh release edit");
    expect(workflow).toContain("gh release upload");
    expect(workflow).toContain("--clobber");
  });
});
