import * as fs from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { machineIdentity } from "../src/persistence/machine-identity.js";
import { processStartTime } from "@tavi/node-kit";
import { assertPreviousOwnerStopped, liveOwnerProcess, OWNER_PROCESS_FILE, publishOwnerProcess } from "../src/persistence/owner-process.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const directories = temporaryDirectories();
afterEach(() => {
  vi.restoreAllMocks();
  directories.cleanup();
});

function directory(): string {
  return directories.create("tavi-process-record-");
}

describe("ownership process record failure paths", () => {
  it("refuses unknown process liveness without replacing the predecessor record", () => {
    const path = directory();
    const marker = join(path, OWNER_PROCESS_FILE);
    const record = JSON.stringify({ version: 2, pid: process.pid, machine: machineIdentity(), host: hostname(), sessionId: "previous" });
    fs.writeFileSync(marker, record);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });
    expect(() => assertPreviousOwnerStopped(path)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(fs.readFileSync(marker, "utf8")).toBe(record);
  });

  it("takes over a pid another account now holds, when its start time is not the owner's", () => {
    const path = directory();
    const record = { version: 3, pid: process.pid, machine: machineIdentity(), host: hostname(), sessionId: "previous" };
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });
    fs.writeFileSync(join(path, OWNER_PROCESS_FILE), JSON.stringify({ ...record, started: "an earlier process" }));
    expect(() => assertPreviousOwnerStopped(path)).not.toThrow();
    // The same start time: the owner itself, which this account cannot signal; that is no proof it stopped.
    fs.writeFileSync(join(path, OWNER_PROCESS_FILE), JSON.stringify({ ...record, started: processStartTime(process.pid) }));
    expect(() => assertPreviousOwnerStopped(path)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("recognises this machine after a hostname change", () => {
    const path = directory();
    fs.writeFileSync(
      join(path, OWNER_PROCESS_FILE),
      JSON.stringify({ version: 2, pid: 2_147_483_646, machine: machineIdentity(), host: "Mac.renamed", sessionId: "previous" }),
    );
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(() => assertPreviousOwnerStopped(path)).not.toThrow();
  });

  it("refuses another machine's record and names the file to remove", () => {
    const path = directory();
    const marker = join(path, OWNER_PROCESS_FILE);
    fs.writeFileSync(
      marker,
      JSON.stringify({ version: 2, pid: 42, machine: "machine:elsewhere", host: "other-box", sessionId: "previous" }),
    );
    expect(() => assertPreviousOwnerStopped(path)).toThrowError(
      expect.objectContaining({ code: "CONFLICT", message: expect.stringContaining(marker) }),
    );
  });

  it("refuses an unreadable or older-format record, naming the file to remove", () => {
    const path = directory();
    const marker = join(path, OWNER_PROCESS_FILE);
    for (const record of ["not-json", JSON.stringify({ version: 1, pid: 42, host: hostname(), sessionId: "previous" })]) {
      fs.writeFileSync(marker, record);
      expect(() => assertPreviousOwnerStopped(path)).toThrowError(
        expect.objectContaining({ code: "CONFLICT", message: expect.stringContaining(marker) }),
      );
      expect(fs.readFileSync(marker, "utf8")).toBe(record);
    }
  });

  it("records its process's start time, and takes a live pid that started later for a stopped owner", () => {
    const path = directory();
    const marker = join(path, OWNER_PROCESS_FILE);
    publishOwnerProcess(path, "current");
    const published = JSON.parse(fs.readFileSync(marker, "utf8"));
    expect(published).toMatchObject({ version: 3, pid: process.pid, started: processStartTime(process.pid) });
    // The same live process still holds the directory.
    expect(() => assertPreviousOwnerStopped(path)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(liveOwnerProcess(path)).toEqual({ pid: process.pid, sessionId: "current" });
    // A record whose pid now names a process started at another time: the owner it names has stopped.
    fs.writeFileSync(marker, JSON.stringify({ ...published, started: "a start long ago" }));
    expect(() => assertPreviousOwnerStopped(path)).not.toThrow();
    expect(liveOwnerProcess(path)).toBeUndefined();
  });

  it("reads an earlier owner's record without a start time as before: a live pid still holds the directory", () => {
    const path = directory();
    fs.writeFileSync(
      join(path, OWNER_PROCESS_FILE),
      JSON.stringify({ version: 2, pid: process.pid, machine: machineIdentity(), host: hostname(), sessionId: "previous" }),
    );
    expect(() => assertPreviousOwnerStopped(path)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("derives a stable, kind-prefixed machine identity", () => {
    expect(machineIdentity()).toMatch(/^(machine|hostname):.+/);
    expect(machineIdentity()).toBe(machineIdentity());
    if (process.platform === "darwin") expect(machineIdentity()).toMatch(/^machine:/);
  });

  it("cleans up a failed publication before any owner can become ready", () => {
    const path = directory();
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw new Error("flush failed");
    });
    expect(() => publishOwnerProcess(path, "failed")).toThrow("flush failed");
    expect(fs.readdirSync(path)).toEqual([]);
    publishOwnerProcess(path, "retry");
    expect(JSON.parse(fs.readFileSync(join(path, OWNER_PROCESS_FILE), "utf8"))).toMatchObject({ sessionId: "retry" });
  });
});
