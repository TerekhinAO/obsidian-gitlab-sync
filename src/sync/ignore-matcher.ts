import ignore, { type Ignore } from "ignore";
import { normalizePath } from "obsidian";
import type { TrackedFile } from "./types";

interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

interface IgnoreVault {
  configDir: string;
  adapter: VaultAdapter;
}

interface IgnoreRuleSet {
  dir: string;
  matcher: Ignore;
}

export class IgnoreMatcher {
  private ruleSets: IgnoreRuleSet[] = [];

  constructor(
    private vault: IgnoreVault,
    private pluginId = "gitlab-gitless-sync",
  ) {}

  async reload(): Promise<void> {
    const ruleSets: IgnoreRuleSet[] = [];
    await this.loadDirectory("", ruleSets);
    this.ruleSets = ruleSets.sort((a, b) => depth(a.dir) - depth(b.dir));
  }

  isIgnored(path: string, trackedFiles: Record<string, TrackedFile>): boolean {
    const normalized = normalizePath(path);
    if (this.isHardExcluded(normalized)) {
      return true;
    }
    if (trackedFiles[normalized]) {
      return false;
    }

    let ignored = false;
    for (const ruleSet of this.ruleSets) {
      const relativePath = relativeToRuleSet(normalized, ruleSet.dir);
      if (relativePath === null || relativePath === "") {
        continue;
      }
      const result = ruleSet.matcher.test(relativePath);
      if (result.ignored) {
        ignored = true;
      }
      if (result.unignored) {
        ignored = false;
      }
    }
    return ignored;
  }

  isDirIgnored(path: string): boolean {
    const normalized = normalizePath(path);
    if (this.isHardExcluded(normalized)) {
      return true;
    }
    return dirIgnoredByRuleSets(normalized, this.ruleSets);
  }

  private async loadDirectory(dir: string, ruleSets: IgnoreRuleSet[]): Promise<void> {
    const gitignorePath = dir ? `${dir}/.gitignore` : ".gitignore";
    if (await this.vault.adapter.exists(gitignorePath)) {
      ruleSets.push({
        dir,
        matcher: ignore().add(await this.vault.adapter.read(gitignorePath)),
      });
    }

    const { folders } = await this.vault.adapter.list(dir);
    for (const folder of folders.map((path) => normalizePath(path)).sort()) {
      if (this.isHardExcluded(folder)) {
        continue;
      }
      // Prune ignored directories during descent so we never list (and stat)
      // their contents — a broken symlink inside an ignored dir must not abort
      // the whole traversal. Rules from ancestors are already loaded because we
      // recurse top-down after adding each directory's .gitignore.
      if (dirIgnoredByRuleSets(folder, ruleSets)) {
        continue;
      }
      await this.loadDirectory(folder, ruleSets);
    }
  }

  private isHardExcluded(path: string): boolean {
    const configDir = normalizePath(this.vault.configDir);
    const runtimeDir = `${configDir}/plugins/${this.pluginId}/`;
    return (
      path === ".git" ||
      path.startsWith(".git/") ||
      path === `${configDir}/gitlab-gitless-sync.log` ||
      isMetadataPath(path) ||
      path === `${configDir}/plugins/${this.pluginId}` ||
      path.startsWith(runtimeDir)
    );
  }
}

function dirIgnoredByRuleSets(dir: string, ruleSets: IgnoreRuleSet[]): boolean {
  const normalized = normalizePath(dir);
  let ignored = false;
  for (const ruleSet of ruleSets) {
    const relativePath = relativeToRuleSet(normalized, ruleSet.dir);
    if (relativePath === null || relativePath === "") {
      continue;
    }
    // Trailing slash makes directory-only rules (e.g. ".venv/") match the
    // directory path itself; without it the `ignore` lib reports not-ignored.
    const result = ruleSet.matcher.test(`${relativePath}/`);
    if (result.ignored) {
      ignored = true;
    }
    if (result.unignored) {
      ignored = false;
    }
  }
  return ignored;
}

function isMetadataPath(path: string): boolean {
  return path.endsWith("github-sync-metadata.json") ||
    path.endsWith("gitlab-sync-metadata.json");
}

function relativeToRuleSet(path: string, dir: string): string | null {
  if (!dir) {
    return path;
  }
  if (path === dir) {
    return "";
  }
  const prefix = `${dir}/`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  return path.slice(prefix.length);
}

function depth(path: string): number {
  return path ? path.split("/").length : 0;
}
