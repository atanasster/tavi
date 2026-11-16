import { tmpdir } from "node:os";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { diskStatus, freeBytesAt } from "../../src/shared/disk.js";

/**
 * The free-space probe.
 *
 * It answers one question — is there still headroom? — and must never be the
 * reason a fire does not run, so an unreadable path is "unknown", not an error.
 */

const directories = temporaryDirectories();

afterEach(() => directories.cleanup());

describe("disk probe", () => {
  it("reports the free bytes of a directory's filesystem", () => {
    const directory = directories.create("tavi-disk-");
    const free = freeBytesAt(directory) ?? 0;
    expect(free).toBeGreaterThan(0);
    const status = diskStatus(directory);
    expect(status.dataDirectory).toBe(directory);
    // The same filesystem's figure — which other processes' writes move between
    // two reads, so not to the byte: within 64 MiB of this test's own read.
    expect(Math.abs((status.freeBytes ?? 0) - free)).toBeLessThanOrEqual(64 * 2 ** 20);
    // This machine is not 32 MiB from a full disk; if it is, the probe is right
    // and this assertion is the alarm.
    expect(status.belowFloor).toBe(false);
  });

  it("treats an unreadable path as unknown rather than failing", () => {
    expect(freeBytesAt(join(tmpdir(), "tavi-does-not-exist-9f3a1b2c"))).toBeUndefined();
    const status = diskStatus(join(tmpdir(), "tavi-does-not-exist-9f3a1b2c"));
    // `null`, not `false`: an unknown figure is not a clean bill of health.
    expect(status).toEqual({ dataDirectory: join(tmpdir(), "tavi-does-not-exist-9f3a1b2c"), freeBytes: null, belowFloor: null });
  });
});
