import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { delay } from "../../src/lib/delay.js";

describe("delay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after its time, and not before", async () => {
    let done = false;
    const waiting = delay(1_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the signal's reason on an abort, and clears its timer", async () => {
    const controller = new AbortController();
    const waiting = delay(1_000, controller.signal);
    controller.abort(new Error("left"));
    await expect(waiting).rejects.toThrow("left");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends early on an abort when asked to resolve", async () => {
    const controller = new AbortController();
    const waiting = delay(1_000, controller.signal, { onAbort: "resolve" });
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts a timer for a signal already aborted", async () => {
    const reason = new Error("gone");
    await expect(delay(1_000, AbortSignal.abort(reason))).rejects.toBe(reason);
    await expect(delay(1_000, AbortSignal.abort(), { onAbort: "resolve" })).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
