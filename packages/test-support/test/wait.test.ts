import { describe, expect, it, vi } from "vitest";

import { DEFAULT_WAIT_TIMEOUT_MS, delay, until, waitFor, waitForValue } from "../src/wait.js";

describe("waitFor", () => {
  it("returns once the predicate holds, sync or async", async () => {
    let checks = 0;
    await waitFor(() => (checks += 1) >= 3, 1_000, { intervalMs: 1 });
    expect(checks).toBe(3);
    await waitFor(async () => true);
  });

  it("checks at least once even with no time to wait", async () => {
    let checked = false;
    await waitFor(() => (checked = true), 0);
    expect(checked).toBe(true);
  });

  it("fails naming the limit, or what was awaited", async () => {
    await expect(waitFor(() => false, 20)).rejects.toThrow("condition was still false after 20ms");
    await expect(waitFor(() => false, 20, { what: "the reply" })).rejects.toThrow("timed out waiting for the reply after 20ms");
  });

  it("defaults to a limit well inside the test timeout", () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(20_000);
  });
});

describe("until", () => {
  it("answers the first value the predicate accepts", async () => {
    let value = 0;
    await expect(
      until(
        () => (value += 1),
        (seen) => seen === 4,
        1_000,
        { intervalMs: 1 },
      ),
    ).resolves.toBe(4);
  });

  it("fails with the last value it read", async () => {
    await expect(
      until(
        async () => ({ state: "pending" }),
        () => false,
        20,
      ),
    ).rejects.toThrow('still not so after 20ms: {"state":"pending"}');
  });
});

describe("waitForValue", () => {
  it("answers the first value that is not undefined", async () => {
    const values = [undefined, undefined, 0];
    await expect(waitForValue(() => values.shift(), 1_000, { intervalMs: 1 })).resolves.toBe(0);
  });

  it("fails when nothing comes", async () => {
    await expect(waitForValue(async () => undefined, 20)).rejects.toThrow("condition was still false after 20ms");
  });
});

describe("delay", () => {
  it("resolves after the time given, on the timers installed when it is called", async () => {
    vi.useFakeTimers();
    try {
      let resolved = false;
      const waiting = delay(50).then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(49);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
