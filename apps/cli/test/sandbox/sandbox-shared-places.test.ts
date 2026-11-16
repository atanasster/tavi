import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { checkedSandboxRead, sandboxBase, sharedPlaceDenies } from "../../src/features/sandbox/sandbox-policy.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());
const temporary = (prefix: string): string => realpathSync(temp.create(prefix));

describe("places outside $HOME the shell does not read", () => {
  it("closes mounted drives and a per-user runtime folder, never /, /tmp, /run or a system folder, and /mnt on WSL too", () => {
    expect(sharedPlaceDenies({})).toEqual(["/Volumes", "/media", "/mnt", "/Users/Shared"]);
    expect(sharedPlaceDenies({ XDG_RUNTIME_DIR: "/run/user/1000" })).toContain("/run/user/1000");
    for (const runtime of ["/", "/tmp", "/run", "/var/run", "/usr", "/usr/local/run", "relative/dir"])
      expect(sharedPlaceDenies({ XDG_RUNTIME_DIR: runtime }), runtime).toEqual(["/Volumes", "/media", "/mnt", "/Users/Shared"]);
    expect(sharedPlaceDenies({ WSL_DISTRO_NAME: "Ubuntu", XDG_RUNTIME_DIR: "/mnt/wslg/runtime-dir" })).toEqual([
      "/Volumes",
      "/media",
      "/mnt",
      "/Users/Shared",
      "/mnt/wslg/runtime-dir",
    ]);
  });

  it("re-opens a toolchain on PATH that lies in a closed place", () => {
    const runtime = temporary("tavi-xdg-");
    const bin = join(runtime, "tools", "bin");
    mkdirSync(bin, { recursive: true });
    const home = temporary("tavi-home-");
    const base = sandboxBase({
      dataDirectory: join(home, ".tavi"),
      homeDirectory: home,
      ownerEnv: { PATH: `${bin}:/usr/bin`, XDG_RUNTIME_DIR: runtime },
      othersTemporary: () => [],
    });
    expect(base.reopened).toContain(bin);
  });

  it("opens a toolchain's folder that holds a credential file, never ~/.config or $HOME", () => {
    const home = temporary("tavi-home-");
    for (const folder of [".cargo/bin", ".m2", ".config/gh"]) mkdirSync(join(home, folder), { recursive: true });
    writeFileSync(join(home, ".cargo", "credentials.toml"), "token");
    const data = join(home, "data");
    expect(checkedSandboxRead(join(home, ".cargo"), data, home)).toBe(join(home, ".cargo"));
    expect(checkedSandboxRead(join(home, ".m2"), data, home)).toBe(join(home, ".m2"));
    expect(() => checkedSandboxRead(join(home, ".config"), data, home)).toThrow(/credential/);
    expect(() => checkedSandboxRead(home, data, home)).toThrow(/credential|data directory/);
  });

  it.skipIf(process.platform !== "darwin")("lists only other users' entries in /private/tmp", () => {
    const base = sandboxBase({ dataDirectory: temporary("tavi-data-"), ownerEnv: { PATH: "/usr/bin" } });
    const uid = process.getuid?.();
    const others = base.othersTemporary();
    expect(others.length).toBeLessThanOrEqual(512);
    for (const path of others) {
      expect(path.startsWith("/private/tmp/")).toBe(true);
      try {
        expect(lstatSync(path).uid).not.toBe(uid);
      } catch {
        // Gone since it was listed.
      }
    }
  });
});
