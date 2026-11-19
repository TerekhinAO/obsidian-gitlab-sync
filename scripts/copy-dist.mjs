import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.cwd();
const bundleFiles = ["main.js", "manifest.json", "styles.css"];
const bundleDir = resolve(root, "dist/obsidian-plugin/gitlab-gitless-sync");

rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });

for (const file of bundleFiles) {
  copyFileSync(join(root, file), join(bundleDir, file));
}

console.log(`Installable plugin bundle copied to ${bundleDir}`);
