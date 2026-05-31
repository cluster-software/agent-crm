import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "./run-with-concurrency.js";

describe("import CSV concurrency", () => {
  it("waits for already-running workers before surfacing the first failure", async () => {
    const events: string[] = [];
    let releaseSlow!: () => void;
    let slowStarted!: () => void;
    const slowCanFinish = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slowHasStarted = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });

    const run = runWithConcurrency(2, 2, async (index) => {
      if (index === 0) {
        events.push("slow-start");
        slowStarted();
        await slowCanFinish;
        events.push("slow-done");
        return;
      }
      await slowHasStarted;
      events.push("fail");
      throw new Error("boom");
    });

    let settled = false;
    run.catch(() => {
      settled = true;
    });
    await slowHasStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["slow-start", "fail"]);
    expect(settled).toBe(false);

    releaseSlow();
    await expect(run).rejects.toThrow("boom");
    expect(events).toEqual(["slow-start", "fail", "slow-done"]);
  });
});
