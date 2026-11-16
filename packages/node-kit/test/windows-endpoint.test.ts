import { spawn } from "node:child_process";
import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import {
  assertPipeOwnedHere,
  currentUserSid,
  isPipeEndpoint,
  namedSecurity,
  newPipeEndpoint,
  ownerOnlySddl,
  parseSddl,
  privateAccessProblem,
  privateDirectorySddl,
  processStartTime,
  protectPipe,
  startTimeFromStat,
  trustedOwner,
} from "../src/index.js";

const SELF = "S-1-5-21-1111-2222-3333-1001";
const OTHER = "S-1-5-21-1111-2222-3333-1002";

describe("a security descriptor read as SDDL", () => {
  it("names its owner and access entries by SID, aliases resolved", () => {
    const descriptor = parseSddl(`O:${SELF}G:SYD:P(D;;FA;;;NU)(A;;FA;;;${SELF})(A;;FA;;;SY)(A;;FA;;;BA)`);
    expect(descriptor.owner).toBe(SELF);
    expect(descriptor.daclFlags).toBe("P");
    expect(descriptor.dacl).toEqual([
      { kind: "D", flags: "", rights: "FA", trustee: "S-1-5-2" },
      { kind: "A", flags: "", rights: "FA", trustee: SELF },
      { kind: "A", flags: "", rights: "FA", trustee: "S-1-5-18" },
      { kind: "A", flags: "", rights: "FA", trustee: "S-1-5-32-544" },
    ]);
    expect(parseSddl("O:BA").owner).toBe("S-1-5-32-544");
    expect(parseSddl("O:BA").dacl).toBeUndefined();
  });

  it("is private only when protected, open to the owner, SYSTEM and Administrators alone, and closed to the network", () => {
    const own = parseSddl(ownerOnlySddl(SELF));
    expect(privateAccessProblem(own, SELF, { denyNetwork: true })).toBeUndefined();
    expect(privateAccessProblem(parseSddl(`D:(A;;FA;;;${SELF})`), SELF)).toMatch(/inherits/);
    expect(privateAccessProblem(parseSddl(`D:P(A;;FA;;;${SELF})(A;;FR;;;WD)`), SELF)).toMatch(/S-1-1-0/);
    expect(privateAccessProblem(parseSddl(`D:P(A;;FA;;;${SELF})(A;;FR;;;${OTHER})`), SELF)).toMatch(OTHER);
    expect(privateAccessProblem(parseSddl(`D:P(A;;FA;;;${SELF})`), SELF, { denyNetwork: true })).toMatch(/network/);
    expect(privateAccessProblem(parseSddl(`O:${SELF}`), SELF)).toMatch(/no access list/);
    // A deny entry for anyone takes nothing away from privacy.
    expect(privateAccessProblem(parseSddl(`D:P(D;;FA;;;WD)(A;;FA;;;${SELF})`), SELF)).toBeUndefined();
  });

  it("trusts as owner this account, SYSTEM and Administrators, and no one else", () => {
    expect(trustedOwner(SELF, SELF)).toBe(true);
    expect(trustedOwner("SY", SELF)).toBe(true);
    expect(trustedOwner("S-1-5-32-544", SELF)).toBe(true);
    expect(trustedOwner(OTHER, SELF)).toBe(false);
    expect(trustedOwner(undefined, SELF)).toBe(false);
  });

  it("knows the built-in Administrator by the alias Windows writes for it, LA, and no other account by it", () => {
    const administrator = "S-1-5-21-1111-2222-3333-500";
    expect(trustedOwner("LA", administrator)).toBe(true);
    expect(privateAccessProblem(parseSddl("O:LAD:P(A;;FA;;;LA)(A;;FA;;;SY)"), administrator)).toBeUndefined();
    expect(trustedOwner("LA", SELF)).toBe(false);
    expect(privateAccessProblem(parseSddl("D:P(A;;FA;;;LA)"), SELF)).toMatch(/LA/);
  });
});

describe("the owner's pipe name", () => {
  it("is fresh each time and told apart from a socket path", () => {
    const first = newPipeEndpoint();
    expect(first).toMatch(/^\\\\\.\\pipe\\tavi-[0-9a-f]{32}$/);
    expect(newPipeEndpoint()).not.toBe(first);
    expect(isPipeEndpoint(first)).toBe(true);
    expect(isPipeEndpoint("\\\\?\\PIPE\\x")).toBe(true);
    expect(isPipeEndpoint("/home/a/.tavi/runtime/ipc.sock")).toBe(false);
    expect(isPipeEndpoint("C:\\Users\\a\\.tavi\\runtime\\ipc.sock")).toBe(false);
  });

  it("needs no check off Windows, nor for a socket file", () => {
    expect(() => assertPipeOwnedHere("/tmp/ipc.sock")).not.toThrow();
    if (process.platform !== "win32") expect(() => assertPipeOwnedHere(newPipeEndpoint())).not.toThrow();
  });
});

describe("a process's start time", () => {
  it("is the same for one process and absent once it has gone", async () => {
    const own = processStartTime(process.pid);
    expect(own).toBeDefined();
    expect(processStartTime(process.pid)).toBe(own);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid ?? 0;
    await new Promise((resolve) => child.once("exit", resolve));
    expect(processStartTime(pid)).toBeUndefined();
  });

  it("reads the 22nd field of /proc/<pid>/stat, past a command name with spaces and parentheses", () => {
    const rest = "S 1 1 1 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10";
    expect(startTimeFromStat(`4120 (node) ${rest}`)).toBe("987654");
    expect(startTimeFromStat(`4120 (my (odd) name) ${rest}`)).toBe("987654");
    expect(startTimeFromStat("4120 (node) S 1")).toBeUndefined();
  });
});

// Windows itself: the calls `koffi` makes, on a pipe this process binds.
describe.runIf(process.platform === "win32")("the owner's pipe on Windows", () => {
  it("is given the private access list, reads back as this account's, and passes the client's check", async () => {
    const endpoint = newPipeEndpoint();
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    try {
      protectPipe(endpoint);
      const descriptor = parseSddl(namedSecurity(endpoint));
      expect(privateAccessProblem(descriptor, currentUserSid(), { denyNetwork: true })).toBeUndefined();
      expect(trustedOwner(descriptor.owner, currentUserSid())).toBe(true);
      expect(() => assertPipeOwnedHere(endpoint)).not.toThrow();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("whether a path is private", () => {
  it("is read from the mode bits off Windows, with the remedy to name", async () => {
    const { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { makePrivateDirectory, ownedHere, privacyProblem } = await import("../src/index.js");
    if (process.platform === "win32") return; // Windows itself is checked by "the owner's pipe on Windows".
    const base = mkdtempSync(join(tmpdir(), "tavi-private-"));
    try {
      const directory = join(base, "made", "inside");
      makePrivateDirectory(directory);
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      expect(privacyProblem(directory, lstatSync(directory))).toBeUndefined();
      expect(ownedHere(directory, lstatSync(directory))).toBe(true);
      const file = join(directory, "secret");
      writeFileSync(file, "x", { mode: 0o600 });
      expect(privacyProblem(file, lstatSync(file))).toBeUndefined();
      chmodSync(file, 0o640);
      expect(privacyProblem(file, lstatSync(file))).toBe("mode 640");
      expect(ownedHere(file, { uid: (process.getuid?.() ?? 0) + 1 })).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("names the remedy and what was expected, in the platform's own terms", async () => {
    const { privateExpectation, privateRemedy } = await import("../src/index.js");
    expect(privateRemedy("/d", "directory", "linux")).toBe("chmod 700 /d");
    expect(privateRemedy("/f", "file", "darwin")).toBe("chmod 600 /f");
    // By SID, so the line works in PowerShell as in cmd, and on a Windows in any language.
    expect(privateRemedy("C:\\d", "directory", "win32", SELF)).toBe(
      `icacls "C:\\d" /inheritance:r /grant:r "*${SELF}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"`,
    );
    expect(privateRemedy("C:\\f", "file", "win32", SELF)).toBe(
      `icacls "C:\\f" /inheritance:r /grant:r "*${SELF}:F" "*S-1-5-18:F" "*S-1-5-32-544:F"`,
    );
    expect(privateExpectation("600", "linux")).toBe("expected 600");
    expect(privateExpectation("600", "win32")).toMatch(/this account, SYSTEM and Administrators only/);
  });

  it("gives a directory Tavi makes an access list that inherits nothing and passes only the three to what is inside", () => {
    const descriptor = parseSddl(privateDirectorySddl(SELF));
    expect(privateAccessProblem(descriptor, SELF)).toBeUndefined();
    expect(descriptor.dacl?.every((entry) => entry.flags === "OICI")).toBe(true);
  });

  it("holds a file's inherited entries to the rule without asking it to be protected", () => {
    const inherited = parseSddl(`O:${SELF}D:AI(A;ID;FA;;;${SELF})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`);
    expect(privateAccessProblem(inherited, SELF, { protectedOnly: false })).toBeUndefined();
    expect(privateAccessProblem(inherited, SELF)).toMatch(/inherits/);
    const leaky = parseSddl(`O:${SELF}D:AI(A;ID;FA;;;${SELF})(A;ID;FR;;;BU)`);
    expect(privateAccessProblem(leaky, SELF, { protectedOnly: false })).toMatch(/S-1-5-32-545/);
  });
});
