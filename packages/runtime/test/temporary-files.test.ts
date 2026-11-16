import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { TaviError } from "@tavi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { needsPosix, temporaryDirectories } from "@tavi/test-support";

import { ownerStagingDirectory, reclaimDeadSpools } from "../src/persistence/temporary-files.js";

/** Windows skips this file's POSIX cases (`POSIX_ONLY` says why). */
const posixOnly = needsPosix(import.meta.url);

/** The owner's private staging directory: the one path every sandbox denies. */

const bases = temporaryDirectories();
afterEach(() => {
  bases.cleanup();
});

function base(): string {
  return bases.create("tavi-staging-test-");
}

const name = `tavi-${String(process.getuid?.() ?? "")}`;

describe.skipIf(posixOnly)("the owner's staging directory", () => {
  it("is made private, and reused while it stays private", () => {
    const parent = base();
    const staging = ownerStagingDirectory(parent);
    expect(staging).toBe(join(parent, name));
    expect(statSync(staging).mode & 0o777).toBe(0o700);
    expect(ownerStagingDirectory(parent)).toBe(staging);
  });

  it("refuses a directory others can open, and a link in its place", () => {
    const open = base();
    mkdirSync(join(open, name), { mode: 0o755 });
    chmodSync(join(open, name), 0o755);
    expect(() => ownerStagingDirectory(open)).toThrow(TaviError);
    const linked = base();
    mkdirSync(join(linked, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(linked, "elsewhere"), join(linked, name));
    expect(() => ownerStagingDirectory(linked)).toThrow(/not a private directory/);
  });

  it("reclaims a dead process's spool and keeps a live one's", () => {
    const parent = base();
    // No process has pid 2^22 + 7 on Linux or macOS defaults (pid_max is lower).
    const dead = join(parent, "tavi-database-4194311-abc");
    const live = join(parent, `tavi-database-${String(process.pid)}-abc`);
    mkdirSync(dead);
    mkdirSync(live);
    reclaimDeadSpools(parent);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});
