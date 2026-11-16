import { describe, expect, it } from "vitest";

import { serialLock } from "../src/serial-lock.js";

describe("serialLock", () => {
  it("runs each task after the one before it has settled, in the order they came", async () => {
    const lock = serialLock();
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    const first = lock(async () => {
      order.push("first started");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first ended");
      return 1;
    });
    const second = lock(async () => {
      order.push("second started");
      return 2;
    });
    await Promise.resolve();
    expect(order).toEqual(["first started"]);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(["first started", "first ended", "second started"]);
  });

  it("hands a task's failure to its own caller and still runs the next task", async () => {
    const lock = serialLock();
    const failed = lock(async () => {
      throw new Error("boom");
    });
    const next = lock(async () => "ran");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ran");
  });
});
