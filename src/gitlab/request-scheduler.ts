export interface GitLabRequestSchedulerOptions {
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Paces every GitLab request start through one shared slot so a single plugin
 * instance never bursts the API. Simultaneous callers are serialized onto one
 * promise chain, and a server-requested backoff can only extend (never shorten)
 * the next allowed start.
 */
export class GitLabRequestScheduler {
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private nextAllowedAt = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: GitLabRequestSchedulerOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 750;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async waitForTurn(): Promise<void> {
    // Serialize simultaneous callers onto one chain so no two acquire the same slot.
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      // Re-check nextAllowedAt after every wake so a blockUntil() that arrives
      // while we are already sleeping is honored instead of starting too early.
      for (;;) {
        const now = this.now();
        const waitUntil = this.nextAllowedAt;
        const delay = waitUntil - now;
        if (delay <= 0) {
          break;
        }
        await this.sleep(delay);
        // Guard against a frozen clock (test doubles): if the clock did not
        // advance and the deadline did not move, re-sleeping would spin forever.
        if (this.now() === now && this.nextAllowedAt === waitUntil) {
          break;
        }
      }
      // Use the current time, not a value captured before the (possibly delayed)
      // sleep, so an overshot timer never lets two requests start back-to-back.
      this.nextAllowedAt = Math.max(this.nextAllowedAt, this.now()) + this.minIntervalMs;
    } finally {
      release();
    }
  }

  blockUntil(timestamp: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, timestamp);
  }
}