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
        schemaVersion: 1,
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
        schemaVersion: 1,
      },
    };

    this.writeChain = this.writeChain.then(() => this.plugin.saveData(sanitized));
    return this.writeChain;
  }

  async update(mutator: (data: PluginData) => void | Promise<void>): Promise<PluginData> {
    let updated!: PluginData;
    this.writeChain = this.writeChain.then(async () => {
      updated = await this.load();
      await mutator(updated);
      await this.plugin.saveData(updated);
    });
    await this.writeChain;
    return updated;
  }
}
