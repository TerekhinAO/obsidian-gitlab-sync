import type { Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  type PluginData,
} from "../settings/settings";

function cloneDefaultState() {
  return {
    ...DEFAULT_STATE,
    trackedFiles: {},
    dirtyEntries: {},
  };
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed.startsWith("https://")) {
    throw new Error("GitLab base URL must use HTTPS");
  }
  return trimmed;
}

export class StateStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private plugin: Pick<Plugin, "loadData" | "saveData">) {}

  async load(): Promise<PluginData> {
    await this.writeChain;
    return await this.loadUnlocked();
  }

  private async loadUnlocked(): Promise<PluginData> {
    const raw = (await this.plugin.loadData()) as Partial<PluginData> | null;
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(raw?.settings ?? {}),
    };
    if (raw?.settings?.loggingLevel === undefined) {
      settings.loggingLevel = raw?.settings?.loggingEnabled ? "debug" : "off";
    }
    settings.gitlabBaseUrl = normalizeBaseUrl(settings.gitlabBaseUrl);

    return {
      settings,
      state: {
        ...cloneDefaultState(),
        ...(raw?.state ?? {}),
        trackedFiles: { ...(raw?.state?.trackedFiles ?? {}) },
        dirtyEntries: { ...(raw?.state?.dirtyEntries ?? {}) },
        // Schema 1 did not carry remote backoff; null keeps old data safe.
        remoteBackoffUntil: raw?.state?.remoteBackoffUntil ?? null,
        remoteBackoffReason: raw?.state?.remoteBackoffReason ?? null,
        // Schema 2 → 3 only adds the nullable `remoteApply` field; no data rewrite is needed.
        remoteApply: raw?.state?.remoteApply ?? null,
        unconfirmedCommit: raw?.state?.unconfirmedCommit ?? null,
        schemaVersion: 3,
      },
    };
  }

  async save(data: PluginData): Promise<void> {
    const sanitized: PluginData = {
      settings: {
        ...data.settings,
        gitlabBaseUrl: normalizeBaseUrl(data.settings.gitlabBaseUrl),
      },
      state: {
        ...cloneDefaultState(),
        ...data.state,
        trackedFiles: { ...data.state.trackedFiles },
        dirtyEntries: { ...data.state.dirtyEntries },
        remoteBackoffUntil: data.state.remoteBackoffUntil ?? null,
        remoteBackoffReason: data.state.remoteBackoffReason ?? null,
        remoteApply: data.state.remoteApply ?? null,
        unconfirmedCommit: data.state.unconfirmedCommit ?? null,
        schemaVersion: 3,
      },
    };

    const save = this.writeChain.then(() => this.plugin.saveData(sanitized));
    this.writeChain = save.catch(() => undefined);
    return save;
  }

  async update(mutator: (data: PluginData) => void | Promise<void>): Promise<PluginData> {
    let updated!: PluginData;
    const update = this.writeChain.then(async () => {
      updated = await this.loadUnlocked();
      await mutator(updated);
      await this.plugin.saveData(updated);
    });
    this.writeChain = update.catch(() => undefined);
    await update;
    return updated;
  }
}
