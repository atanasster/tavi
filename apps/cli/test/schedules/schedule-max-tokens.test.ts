import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";

/** A token ceiling below one model call: saved, and warned about, since a run passes it by the call that crossed it. */

const directories = temporaryDirectories({ prefix: "tavi-schedule-max-tokens-" });
afterEach(() => directories.cleanup());

const WARNING = /warning: a ceiling of 2,000 tokens is below one model call: a run can go past it by one call/;

async function schedules(directory: string, args: readonly string[]) {
  const out = capture();
  const code = await main(["schedules", ...args, "--data-dir", directory], { io: out.io });
  return { code, stderr: out.stderr() };
}

describe("tavi schedules --max-tokens", () => {
  it("warns about a ceiling below one model call, on add and update, and still saves it", async () => {
    const directory = directories.create();
    const added = await schedules(directory, [
      "add",
      "--name",
      "tight",
      "--at",
      "07:00",
      "--timezone",
      "UTC",
      "--prompt",
      "go",
      "--max-tokens",
      "2000",
    ]);
    expect(added.code).toBe(EXIT.ok);
    expect(added.stderr).toMatch(WARNING);
    const shown = capture();
    await main(["schedules", "show", "tight", "--data-dir", directory], { io: shown.io });
    expect(shown.stdout()).toMatch(/tokens {6}2,000 tokens a run/);
    const raised = await schedules(directory, ["update", "tight", "--max-tokens", "50000"]);
    expect(raised.code).toBe(EXIT.ok);
    expect(raised.stderr).not.toMatch(/below one model call/);
    const lowered = await schedules(directory, ["update", "tight", "--max-tokens", "2000"]);
    expect(lowered.stderr).toMatch(WARNING);
    // An update that does not set it says nothing of it.
    expect((await schedules(directory, ["update", "tight", "--prompt", "go on"])).stderr).not.toMatch(/below one model call/);
  });
});
