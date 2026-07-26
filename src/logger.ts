import { Vault, normalizePath } from "obsidian";

export const LOG_FILE_NAME = "gitlab-gitless-sync.log" as const;
export type LogLevel = "off" | "error" | "info" | "debug";

const REDACTED = "[REDACTED]";
const SECRET_FIELD_PATTERN = /^(private-token|authorization|token|password)$/i;
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  info: 2,
  debug: 3,
};
const ENTRY_LEVEL_PRIORITY: Record<"ERROR" | "WARN" | "INFO" | "DEBUG", number> = {
  ERROR: 1,
  WARN: 2,
  INFO: 2,
  DEBUG: 3,
};

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
    private level: LogLevel,
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
    level: "ERROR" | "WARN" | "INFO" | "DEBUG",
    message: string,
    data?: any,
  ): Promise<void> {
    if (LOG_LEVEL_PRIORITY[this.level] < ENTRY_LEVEL_PRIORITY[level]) return;

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
    this.level = "debug";
  }

  disable(): void {
    this.level = "off";
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  async debug(message: string, data?: any): Promise<void> {
    await this.write("DEBUG", message, data);
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
