import { describe, expect, it } from "vitest";

import { wslDenyRoots, wslVersion } from "../src/index.js";

describe("wslVersion", () => {
  it("reads WSL2, WSL1 and plain Linux from the kernel release", () => {
    const release = (osrelease: string | undefined, runWsl = false) =>
      wslVersion("linux", { osrelease: () => osrelease, runWsl: () => runWsl });
    expect(release("6.6.87.2-microsoft-standard-WSL2")).toBe(2);
    expect(release("4.4.0-22621-Microsoft")).toBe(1);
    // A custom WSL2 kernel need not say so in its release: /run/WSL does.
    expect(release("6.8.0-microsoft-custom", true)).toBe(2);
    expect(release("6.8.0-45-generic", true)).toBeUndefined();
    expect(release(undefined)).toBeUndefined();
  });

  it("is never WSL off Linux", () => {
    expect(wslVersion("darwin", { osrelease: () => "microsoft-standard-WSL2" })).toBeUndefined();
    expect(wslVersion("win32", { osrelease: () => "microsoft-standard-WSL2" })).toBeUndefined();
  });
});

describe("what a sandboxed child is denied on WSL", () => {
  it("is /mnt, the interop folder, and each Windows drive where wsl.conf mounted it", () => {
    const mounts = [
      "none /run/user tmpfs rw,nosuid 0 0",
      "C:\\134 /c 9p rw,noatime,dirsync,aname=drvfs;path=C:\\;uid=1000,trans=fd 0 0",
      "D:\\134 /mnt/d 9p rw,aname=drvfs;path=D:\\ 0 0",
      "E: /my\\040drives/e drvfs rw 0 0",
      "drivers /usr/lib/wsl/drivers 9p ro,aname=drivers;fmask=222 0 0",
    ].join("\n");
    expect(wslDenyRoots(mounts)).toEqual(["/mnt", "/run/WSL", "/c", "/my drives/e"]);
    expect(wslDenyRoots(undefined)).toEqual(["/mnt", "/run/WSL"]);
  });
});
