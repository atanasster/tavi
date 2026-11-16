import { execFileSync } from "node:child_process";

import { TaviError } from "@tavi/contracts";
import { launchChromium } from "@tavi/plugin-browser/chromium";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { browserProfileDirectory } from "../../src/features/browser/profile.js";
import { forgetInjectionDescriptors, startInjectionOwner, type InjectionOwner } from "./owner-harness.js";
import { delay } from "@tavi/test-support";

/**
 * A live injection owner keeps the real browser (Tier 1): closing the owner
 * closes its Chromium. The live runs left a Chromium per owner running for
 * hours, at a load that made unrelated suites fifty times slower. Without
 * Chromium, the test skips.
 */

let skip: string | undefined;

beforeAll(async () => {
  try {
    await (await launchChromium({ headless: true })).close();
  } catch (error) {
    if (error instanceof TaviError && error.code === "CAPABILITY_MISSING") skip = error.message;
    else throw error;
  }
});

afterAll(() => {
  forgetInjectionDescriptors();
});

/** The pids of every process whose command line names `profile` (`ps`, a system binary: nothing written at test time is run). */
const processesOf = (profile: string): number[] =>
  execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter((line) => line.includes(profile))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]));

/** Waits up to `ms` for `profile`'s processes to be gone; answers those left. */
const gone = async (profile: string, ms: number): Promise<number[]> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = processesOf(profile);
    if (left.length === 0 || Date.now() > deadline) return left;
    await delay(200);
  }
};

/** Starts a live owner, opens a browser session on it, runs `before` and closes the owner; answers the profile's processes left after `ms`. */
async function leftAfterClose(before: (io: InjectionOwner) => void, ms: number): Promise<number[]> {
  const io = await startInjectionOwner({ liveModel: true, runtime: { shutdownDeadlineMs: 1_000 } });
  const profile = browserProfileDirectory(io.owner.directory, "default");
  let left: number[] = [];
  try {
    await io.owner.handle.runtime.browser.createSession({ workspaceId: "default" });
    expect(processesOf(profile).length).toBeGreaterThan(0);
    before(io);
  } finally {
    await io.close();
    left = await gone(profile, ms);
    // Never leave one behind for the next suite, whatever the assertion says.
    for (const pid of left) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  return left;
}

describe("a live injection owner's browser", () => {
  it("is closed when the owner closes", async (context) => {
    if (skip !== undefined) context.skip(skip);
    expect(await leftAfterClose(() => undefined, 5_000)).toEqual([]);
  }, 60_000);

  it("is closed when a run outlives the drain and the owner keeps its database", async (context) => {
    if (skip !== undefined) context.skip(skip);
    // A run that ignores its abort, as a live run stuck past the drain is: the store is retained, the browser is not.
    expect(await leftAfterClose((io) => (io.owner.handle.runtime.admissions as unknown as { begin(): void }).begin(), 20_000)).toEqual([]);
  }, 60_000);
});
