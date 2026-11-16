import { afterEach, describe, expect, it, vi } from "vitest";

import { ownerBrowserInstalled } from "../../src/features/browser/host.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("whether the owner offers the browser's tools", () => {
  it("reads Chromium's install at most once a period, so an install while it runs is offered soon after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let installed = false;
    let reads = 0;
    const offered = ownerBrowserInstalled(30_000, async () => {
      reads += 1;
      return installed;
    });
    expect(await offered()).toBe(false);
    installed = true;
    // Within the period: the answer it read stands.
    vi.advanceTimersByTime(29_000);
    expect(await offered()).toBe(false);
    expect(reads).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(await offered()).toBe(true);
    expect(reads).toBe(2);
  });

  it("does not offer them when the check fails", async () => {
    const offered = ownerBrowserInstalled(30_000, () => Promise.reject(new Error("broken install")));
    expect(await offered()).toBe(false);
  });
});
