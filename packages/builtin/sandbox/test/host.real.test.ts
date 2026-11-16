import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, describe, expect, it } from "vitest";

import { createSandboxHost } from "../src/host.js";

/**
 * The live probe against the real srt: on macOS always;
 * on Linux when the sandbox matrix names the case (`TAVI_SANDBOX_MATRIX`):
 * `srt` and `nested` must confine, `refused` must say why with a fix.
 */

const MODE = process.env["TAVI_SANDBOX_MATRIX"] ?? (process.platform === "darwin" ? "srt" : undefined);
const temp = temporaryDirectories();
afterAll(() => temp.cleanup());

const data = (): string => {
  const directory = temp.create("tavi-host-real-");
  return directory;
};

describe.skipIf(MODE === undefined)(`the live probe (${MODE ?? "skipped"})`, () => {
  it("answers the tier this host should have", async () => {
    const status = await createSandboxHost({ dataDirectory: data() }).check({ nested: MODE === "nested" });
    if (MODE === "refused") {
      expect(status.tier).toBe("unavailable");
      expect(status.cause).toBeTruthy();
      expect(status.fix).toBeTruthy();
    } else {
      expect(status.checks.filter((check) => !check.ok && check.severity === "error")).toEqual([]);
      expect(status.tier).toBe(MODE === "nested" ? "nested" : "full");
    }
  }, 60_000);
});
