import { execFile } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NoFollowReadError,
  flushFile,
  readNoFollow,
  readNoFollowSync,
  retryWhileHeld,
  retryWhileHeldAsync,
  sha256Hex,
  writeFileAtomic,
  writeFileAtomicAsync,
  writeJsonAtomic,
} from "../src/index.js";

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tavi-node-kit-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("retryWhileHeld", () => {
  const held = (code: string): Error => Object.assign(new Error(code), { code });

  it("tries again while Windows says another process holds the file, then succeeds", async () => {
    let calls = 0;
    const action = (): string => {
      calls += 1;
      if (calls < 3) throw held("EPERM");
      return "renamed";
    };
    expect(retryWhileHeld(action, "win32")).toBe("renamed");
    expect(calls).toBe(3);
    calls = 0;
    expect(await retryWhileHeldAsync(async () => action(), "win32")).toBe("renamed");
    expect(calls).toBe(3);
  });

  it("throws at once elsewhere, for any other error, and after its last attempt", () => {
    let calls = 0;
    const always = (code: string) => (): never => {
      calls += 1;
      throw held(code);
    };
    expect(() => retryWhileHeld(always("EPERM"), "linux")).toThrow("EPERM");
    expect(calls).toBe(1);
    calls = 0;
    expect(() => retryWhileHeld(always("ENOENT"), "win32")).toThrow("ENOENT");
    expect(calls).toBe(1);
    calls = 0;
    expect(() => retryWhileHeld(always("EBUSY"), "win32")).toThrow("EBUSY");
    expect(calls).toBe(8);
  });
});

describe("writeFileAtomicAsync", () => {
  it("replaces the file whole, 0600 by default, durably, and leaves no temporary file", async () => {
    const path = join(directory, "secret");
    writeFileSync(path, "old");
    await writeFileAtomicAsync(path, "new", { durable: true });
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(["secret"]);
  });

  it("leaves the old contents and no temporary file when the rename fails", async () => {
    const path = join(directory, "taken");
    mkdirSync(path);
    writeFileSync(join(path, "inside"), "x");
    await expect(writeFileAtomicAsync(path, "new")).rejects.toThrow();
    expect(readdirSync(directory)).toEqual(["taken"]);
  });
});

describe("flushFile", () => {
  it("flushes an existing file and refuses a missing one", () => {
    const path = join(directory, "flushed");
    writeFileSync(path, "bytes");
    expect(() => flushFile(path)).not.toThrow();
    expect(() => flushFile(join(directory, "missing"))).toThrow(/ENOENT/);
  });
});

describe("sha256Hex", () => {
  it("hashes a string as its UTF-8 bytes, and bytes as given", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(new TextEncoder().encode("héllo"))).toBe(sha256Hex("héllo"));
  });
});

describe("writeFileAtomic", () => {
  it("replaces the file whole, 0600 by default, and leaves no temporary file", () => {
    const path = join(directory, "state.json");
    writeFileSync(path, "old");
    writeFileAtomic(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it("writes bytes, with the mode asked for, durably", () => {
    const path = join(directory, "cache.bin");
    writeFileAtomic(path, Uint8Array.of(1, 2, 3), { mode: 0o644, durable: true });
    expect([...readFileSync(path)]).toEqual([1, 2, 3]);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readdirSync(directory)).toEqual(["cache.bin"]);
  });

  it("leaves the old contents and no temporary file when the rename fails", () => {
    const path = join(directory, "taken");
    // A directory with an entry cannot be replaced by a file.
    mkdirSync(path);
    writeFileSync(join(path, "inside"), "x");
    expect(() => writeFileAtomic(path, "new")).toThrow();
    expect(readdirSync(directory)).toEqual(["taken"]);
    expect(readdirSync(path)).toEqual(["inside"]);
  });

  it("leaves the old contents and no temporary file when the write itself fails", () => {
    const path = join(directory, "kept");
    writeFileSync(path, "old");
    // Not a string or bytes: the write throws after the temporary file was created.
    expect(() => writeFileAtomic(path, 42 as never)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(readdirSync(directory)).toEqual(["kept"]);
  });

  it("leaves no temporary file when the directory is missing", () => {
    expect(() => writeFileAtomic(join(directory, "missing", "file"), "x")).toThrow(/ENOENT/);
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe("writeJsonAtomic", () => {
  it("writes compact JSON by default, indented with a trailing newline when asked", () => {
    const path = join(directory, "value.json");
    writeJsonAtomic(path, { a: 1, b: [true] });
    expect(readFileSync(path, "utf8")).toBe('{"a":1,"b":[true]}');
    writeJsonAtomic(path, { a: 1 }, { indent: 2, trailingNewline: true });
    expect(readFileSync(path, "utf8")).toBe('{\n  "a": 1\n}\n');
  });
});

describe.each([
  [
    "readNoFollowSync",
    (path: string, options?: Parameters<typeof readNoFollowSync>[1]) => Promise.resolve().then(() => readNoFollowSync(path, options)),
  ],
  ["readNoFollow", readNoFollow],
] as const)("%s", (_name, read) => {
  const refusal = async (promise: Promise<unknown>): Promise<string | undefined> => {
    try {
      await promise;
      return undefined;
    } catch (error) {
      expect(error).toBeInstanceOf(NoFollowReadError);
      return (error as NoFollowReadError).reason;
    }
  };

  it("reads a file, and answers undefined for one that does not exist", async () => {
    const path = join(directory, "plain");
    writeFileSync(path, "hello");
    expect((await read(path))?.toString("utf8")).toBe("hello");
    expect(await read(join(directory, "absent"))).toBeUndefined();
  });

  it("refuses a symlink, even to a readable file", async () => {
    const target = join(directory, "target");
    writeFileSync(target, "secret");
    const link = join(directory, "link");
    symlinkSync(target, link);
    expect(await refusal(read(link))).toBe("symlink");
  });

  it("refuses a directory", async () => {
    expect(await refusal(read(directory))).toBe("not-file");
  });

  it("refuses a file over the limit, and reads one at it", async () => {
    const path = join(directory, "sized");
    writeFileSync(path, "12345");
    expect((await read(path, { maxBytes: 5 }))?.toString("utf8")).toBe("12345");
    expect(await refusal(read(path, { maxBytes: 4 }))).toBe("too-large");
  });

  it("refuses a file others can read when it must be private", async () => {
    const path = join(directory, "secret");
    writeFileSync(path, "value", { mode: 0o600 });
    expect((await read(path, { privateOnly: true }))?.toString("utf8")).toBe("value");
    chmodSync(path, 0o644);
    expect(await refusal(read(path, { privateOnly: true }))).toBe("shared");
    expect((await read(path))?.toString("utf8")).toBe("value");
  });

  it("refuses a FIFO without blocking on it", async () => {
    const fifo = join(directory, "fifo");
    await promisify(execFile)("mkfifo", [fifo]);
    expect(await refusal(read(fifo))).toBe("not-file");
  });

  it("reads past a chunk, to the end, under the limit", async () => {
    const path = join(directory, "large");
    const body = Buffer.alloc(200_000, 7);
    writeFileSync(path, body);
    expect((await read(path, { maxBytes: 200_000 }))?.equals(body)).toBe(true);
    expect(await refusal(read(path, { maxBytes: 199_999 }))).toBe("too-large");
  });

  it("refuses a hard-linked file when it must have one name", async () => {
    const path = join(directory, "one");
    writeFileSync(path, "x");
    expect((await read(path, { singleLink: true }))?.toString("utf8")).toBe("x");
    linkSync(path, join(directory, "two"));
    expect(await refusal(read(path, { singleLink: true }))).toBe("linked");
  });
});
