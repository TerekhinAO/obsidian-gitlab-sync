import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  promises as fs,
} from "fs";
import * as path from "path";

// Mock Obsidian's Vault class
export class Vault {
  configDir: string;
  private rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.configDir = ".obsidian";

    // Ensure vault directory exists
    if (!existsSync(this.rootPath)) {
      mkdirSync(this.rootPath, { recursive: true });
    }

    // Ensure config directory exists
    if (!existsSync(path.join(this.rootPath, this.configDir))) {
      mkdirSync(path.join(this.rootPath, this.configDir), { recursive: true });
    }
  }

  getRoot() {
    return { path: this.rootPath };
  }

  get adapter() {
    return {
      read: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        return readFileSync(fullPath, "utf8");
      },

      write: async (filePath: string, data: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        const dir = path.dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, data);
      },

      readBinary: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        return readFileSync(fullPath);
      },

      writeBinary: async (filePath: string, data: ArrayBuffer) => {
        const fullPath = path.join(this.rootPath, filePath);
        const dir = path.dirname(fullPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, Buffer.from(data));
      },

      exists: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        return existsSync(fullPath);
      },

      mkdir: async (dirPath: string) => {
        const fullPath = path.join(this.rootPath, dirPath);
        if (!existsSync(fullPath)) {
          mkdirSync(fullPath, { recursive: true });
        }
      },

      remove: async (filePath: string) => {
        const fullPath = path.join(this.rootPath, filePath);
        if (existsSync(fullPath)) {
          await fs.unlink(fullPath);
        }
      },

      list: async (dirPath: string) => {
        const fullPath = path.join(this.rootPath, dirPath);
        if (!existsSync(fullPath)) {
          return { files: [], folders: [] };
        }

        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        const files = entries
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(dirPath, entry.name));

        const folders = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(dirPath, entry.name));

        return { files, folders };
      },
    };
  }
}

// Mock Notice
export class Notice {
  constructor(message: string, timeout?: number) {
    const spy = (globalThis as any).__noticeSpy;
    if (typeof spy === "function") {
      spy(message);
    } else {
      console.log(`NOTICE: ${message}`);
    }
  }

  hide() {
    // Do nothing in mock
  }
}

export class Plugin {
  app: any;
  manifest: any;

  constructor(app?: any, manifest?: any) {
    this.app = app;
    this.manifest = manifest;
  }

  async loadData(): Promise<unknown> {
    return null;
  }

  async saveData(_data: unknown): Promise<void> {}

  addSettingTab(_tab: unknown): void {}

  addCommand(_command: unknown): void {}

  addRibbonIcon(_icon: string, _title: string, _callback: () => void): HTMLElement {
    return { remove() {} } as HTMLElement;
  }

  registerInterval(_interval: unknown): void {}

  registerEvent(_eventRef: EventRef): void {}
}

// Minimal general-purpose HTMLElement stub for view/modal tests.
// Supports createEl(tag, { text }) returning a child element (which itself
// supports createEl), empty(), setText(), and a recursive textContent
// accumulated from its own text plus all descendants.
export class MockElement {
  tag: string;
  ownText = "";
  children: MockElement[] = [];
  // Rows are used by Setting to record name/desc entries (see SyncStatusModal).
  rows: Array<{ name?: string; desc?: string }> = [];

  constructor(tag = "div") {
    this.tag = tag;
  }

  // Buttons record MockButtonComponents created by Setting.addButton, so tests
  // can assert on rendered button labels and invoke their click handlers.
  buttons: MockButtonComponent[] = [];

  createEl(tag: string, options?: { text?: string }): MockElement {
    const child = new MockElement(tag);
    if (options?.text !== undefined) {
      child.ownText = options.text;
    }
    this.children.push(child);
    return child;
  }

  setText(text: string): void {
    this.ownText = text;
    this.children = [];
  }

  empty(): void {
    this.children = [];
    this.ownText = "";
    this.rows = [];
    this.buttons = [];
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }
}

export class MockButtonComponent {
  buttonText = "";
  cta = false;
  disabled = false;
  clickHandler: (() => void) | null = null;

  setButtonText(text: string): this {
    this.buttonText = text;
    return this;
  }

  setCta(): this {
    this.cta = true;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }

  onClick(handler: () => void): this {
    this.clickHandler = handler;
    return this;
  }

  setIcon(): this {
    return this;
  }

  setWarning(): this {
    return this;
  }

  setTooltip(): this {
    return this;
  }
}

export class Modal {
  titleEl = { setText: (_text: string) => undefined };
  contentEl: any = new MockElement("div");

  constructor(public app: any) {}

  open(): void {
    this.onOpen();
  }

  close(): void {}

  onOpen(): void {}

  setTitle(text: string): void {
    this.titleEl.setText(text);
  }

  setContent(text: string): void {
    this.contentEl.text = text;
  }
}

export class Setting {
  private row: { name?: string; desc?: string };

  constructor(private containerEl: any) {
    this.row = {};
    containerEl.rows?.push(this.row);
  }

  setName(name: string): this {
    this.row.name = name;
    return this;
  }

  setDesc(desc: string): this {
    this.row.desc = desc;
    return this;
  }

  setHeading(): this {
    return this;
  }

  addText(_callback: (component: any) => void): this {
    return this;
  }

  addToggle(_callback: (component: any) => void): this {
    return this;
  }

  addDropdown(callback: (component: any) => void): this {
    const dropdown = {
      addOption() {
        return dropdown;
      },
      setValue() {
        return dropdown;
      },
      onChange() {
        return dropdown;
      },
    };
    callback(dropdown);
    return this;
  }

  addButton(callback: (component: any) => void): this {
    const button = new MockButtonComponent();
    this.containerEl.buttons?.push(button);
    callback(button);
    return this;
  }
}

export class PluginSettingTab {
  containerEl: any = { empty() {} };

  constructor(
    public app: any,
    public plugin: Plugin,
  ) {}

  display(): void {}
}

export class TextComponent {
  inputEl = { type: "text" };
}

export class WorkspaceLeaf {}

export type TAbstractFile = { path: string };

interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export async function requestUrl(options: RequestUrlParam) {
  const response = await fetch(options.url, {
    method: options.method || "GET",
    headers: options.headers,
    body: options.body,
  });

  const isJsonResponse = response.headers
    .get("content-type")
    ?.includes("application/json");

  // Convert to expected Obsidian response format
  if (isJsonResponse) {
    return {
      status: response.status,
      json: await response.json(),
    };
  } else {
    return {
      status: response.status,
      arrayBuffer: await response.arrayBuffer(),
    };
  }
}

// Mock utility functions
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return Buffer.from(base64, "base64");
}

// Mock Event reference
export type EventRef = string;
