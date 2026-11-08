import { describe, expect, it } from "vitest";
import { GitLabRequestScheduler } from "../../src/gitlab/request-scheduler";

function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    get now() {
      return now;
    },
    sleeps,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  };
}

describe("GitLabRequestScheduler", () => {
  it("spaces request starts by 750 milliseconds", async () => {
    const clock = fakeClock();
    const scheduler = new GitLabRequestScheduler({
      now: () => clock.now,
      sleep: clock.sleep,
    });

    for (let index = 0; index < 5; index += 1) {
      await scheduler.waitForTurn();
    }

    // The first turn has no predecessor, every later turn waits one slot.
    expect(clock.sleeps).toEqual([750, 750, 750, 750]);
  });

  it("schedules at most 80 starts per minute", async () => {
    const clock = fakeClock();
    const scheduler = new GitLabRequestScheduler({
      now: () => clock.now,
      sleep: clock.sleep,
    });
    const startTimes: number[] = [];

    for (let index = 0; index < 200; index += 1) {
      await scheduler.waitForTurn();
      // After the turn the fake clock equals the slot it started on.
      startTimes.push(clock.now);
    }

    // 750ms spacing yields starts at 0, 750, ..., 59_250 — exactly 80 in a minute.
    const withinMinute = startTimes.filter((time) => time < 60_000).length;
    expect(withinMinute).toBe(80);
  });

  it("extends but never shortens a server backoff", async () => {
    const clock = fakeClock();
    const scheduler = new GitLabRequestScheduler({
      now: () => clock.now,
      sleep: clock.sleep,
    });

    scheduler.blockUntil(60_000);
    await scheduler.waitForTurn();
    expect(clock.sleeps).toEqual([60_000]);

    // An earlier backoff must not move the next allowed start backwards.
    scheduler.blockUntil(30_000);
    await scheduler.waitForTurn();
    expect(clock.sleeps).toEqual([60_000, 750]);
  });

  it("serializes simultaneous callers", async () => {
    const clock = fakeClock();
    const scheduler = new GitLabRequestScheduler({
      now: () => clock.now,
      sleep: clock.sleep,
    });
    const order: number[] = [];

    await Promise.all([
      scheduler.waitForTurn().then(() => order.push(1)),
      scheduler.waitForTurn().then(() => order.push(2)),
      scheduler.waitForTurn().then(() => order.push(3)),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("honors a backoff that arrives while a caller is already waiting", async () => {
    let now = 0;
    const pendingSleeps: Array<() => void> = [];
    const scheduler = new GitLabRequestScheduler({
      now: () => now,
      sleep: (milliseconds: number) =>
        new Promise<void>((resolve) => {
          pendingSleeps.push(() => {
            now += milliseconds;
            resolve();
          });
        }),
    });

    // Prime the first slot so the second caller actually has to wait.
    await scheduler.waitForTurn();
    const second = scheduler.waitForTurn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingSleeps.length).toBe(1);

    // A server backoff arrives while the second caller is mid-sleep.
    scheduler.blockUntil(60_000);

    // The first sleep resolves (the old 750ms deadline), but the caller must
    // re-wait for the backoff instead of starting early.
    pendingSleeps[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingSleeps.length).toBe(2);

    pendingSleeps[1]();
    await second;
    expect(now).toBe(60_000);
  });
});