import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(__dirname, "../../scripts/copy-dist.mjs");
const packagePath = resolve(__dirname, "../../package.json");

describe("copy-dist build script", () => {
  it("copies the installable plugin bundle into dist", () => {
    const root = mkdtempSync(join(tmpdir(), "copy-dist-"));
    const contents = {
      "main.js": "console.log('built main');",
      "manifest.json": "{\"id\":\"gitlab-gitless-sync\"}",
      "styles.css": ".plugin { color: red; }",
    };
    for (const [file, content] of Object.entries(contents)) {
      writeFileSync(join(root, file), content);
    }

    execFileSync(process.execPath, [scriptPath], { cwd: root });

    const bundleDir = join(root, "dist/obsidian-plugin/gitlab-gitless-sync");
    expect(readFileSync(join(bundleDir, "main.js"), "utf8")).toBe(contents["main.js"]);
    expect(readFileSync(join(bundleDir, "manifest.json"), "utf8")).toBe(contents["manifest.json"]);
    expect(readFileSync(join(bundleDir, "styles.css"), "utf8")).toBe(contents["styles.css"]);
  });

  it("is part of the production build", () => {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    expect(pkg.scripts.build).toContain("node scripts/copy-dist.mjs");
  });
});
