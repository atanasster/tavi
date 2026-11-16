import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `fstat` answering size 0, as procfs does, or as it would for a file that grew after the check. */
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, fstatSync: (fd: number) => Object.assign(actual.fstatSync(fd), { size: 0 }) };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const stat = handle.stat.bind(handle);
      return Object.assign(handle, { stat: async () => Object.assign(await stat(), { size: 0 }) });
    },
  };
});

const { readNoFollow, readNoFollowSync } = await import("../src/index.js");
const { closeSync, fstatSync, openSync } = await import("node:fs");

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tavi-node-kit-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("a file larger than its fstat says", () => {
  it("is read whole, and refused past the limit, never cut", async () => {
    const path = join(directory, "grown");
    writeFileSync(path, "0123456789");
    const fd = openSync(path, "r");
    expect(fstatSync(fd).size, "the mock is in place").toBe(0);
    closeSync(fd);
    expect(readNoFollowSync(path)?.toString("utf8")).toBe("0123456789");
    expect((await readNoFollow(path))?.toString("utf8")).toBe("0123456789");
    expect(readNoFollowSync(path, { maxBytes: 10 })?.toString("utf8")).toBe("0123456789");
    expect((await readNoFollow(path, { maxBytes: 10 }))?.toString("utf8")).toBe("0123456789");
    expect(() => readNoFollowSync(path, { maxBytes: 9 })).toThrow(expect.objectContaining({ reason: "too-large" }));
    await expect(readNoFollow(path, { maxBytes: 9 })).rejects.toMatchObject({ reason: "too-large" });
  });
});
