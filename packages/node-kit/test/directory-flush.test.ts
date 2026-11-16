import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A filesystem whose directories cannot be flushed: `fsync` on a directory fails with the code set here. */
const refusal = { code: "" };
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (refusal.code !== "" && actual.fstatSync(fd).isDirectory())
        throw Object.assign(new Error(`fsync: ${refusal.code}`), { code: refusal.code });
      actual.fsyncSync(fd);
    },
  };
});

const { flushDirectory, writeFileAtomic } = await import("../src/index.js");

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tavi-node-kit-"));
});
afterEach(() => {
  refusal.code = "";
  rmSync(directory, { recursive: true, force: true });
});

describe("a directory the filesystem cannot flush", () => {
  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP"])("lets %s be, and the durable write still lands", (code) => {
    refusal.code = code;
    expect(() => flushDirectory(directory)).not.toThrow();
    const path = join(directory, "artifact");
    writeFileAtomic(path, "bytes", { durable: true });
    expect(readFileSync(path, "utf8")).toBe("bytes");
    expect(readdirSync(directory)).toEqual(["artifact"]);
  });

  it("still reports any other failure", () => {
    refusal.code = "EIO";
    expect(() => flushDirectory(directory)).toThrow(/EIO/);
    expect(statSync(directory).isDirectory()).toBe(true);
  });
});
