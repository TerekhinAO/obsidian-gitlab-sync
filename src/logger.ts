import { Vault, normalizePath } from "obsidian";

export const LOG_FILE_NAME = "gitlab-gitless-sync.log" as const;
const REDACTED = "[REDACTED]";
const SECRET_FIELD_PATTERN = /^(private-token|authorization|token|password)$/i;

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_FIELD_PATTERN.test(key) ? REDACTED : redactSecrets(entry),
    ]),
  );
}

export default class Logger {
  private logFile: string;

  constructor(
    private vault: Vault,
    private enabled: boolean,
  ) {
    this.logFile = normalizePath(`${vault.configDir}/${LOG_FILE_NAME}`);
  }

  async init() {
    // Create the log file in case it doesn't exist
    if (await this.vault.adapter.exists(this.logFile)) {
      return;
    }
    this.vault.adapter.write(this.logFile, "");
  }

  private async write(
    level: string,
    message: string,
    data?: any,
  ): Promise<void> {
    if (!this.enabled) return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      additional_data: redactSecrets(data),
    };

    await this.vault.adapter.append(
      this.logFile,
      JSON.stringify(logEntry) + "\n",
    );
  }

  async read(): Promise<string> {
    return await this.vault.adapter.read(this.logFile);
  }

  async clean(): Promise<void> {
    return await this.vault.adapter.write(this.logFile, "");
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  async info(message: string, data?: any): Promise<void> {
    await this.write("INFO", message, data);
  }

  async warn(message: string, data?: any): Promise<void> {
    await this.write("WARN", message, data);
  }

  async error(message: string, data?: any): Promise<void> {
    await this.write("ERROR", message, data);
  }
}
