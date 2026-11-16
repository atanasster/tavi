import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  childBaseEnv,
  executableExtensions,
  findExecutable,
  joinPath,
  launchCommand,
  LaunchRefusedError,
  pathDelimiter,
  pathEntries,
  systemEnv,
  systemPathEntries,
} from "../src/index.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("PATH per platform", () => {
  it("splits and joins on the platform's separator, keeping absolute entries only", () => {
    expect(pathDelimiter("win32")).toBe(";");
    expect(pathDelimiter("linux")).toBe(":");
    expect(pathEntries("C:\\Windows;relative;;D:\\tools", "win32")).toEqual(["C:\\Windows", "D:\\tools"]);
    expect(pathEntries("/usr/bin:bin::/opt/x", "darwin")).toEqual(["/usr/bin", "/opt/x"]);
    expect(pathEntries(undefined, "linux")).toEqual([]);
    expect(joinPath(["/a", "/b", "/a"], "linux")).toBe("/a:/b");
    expect(joinPath(["C:\\a", "C:\\b"], "win32")).toBe("C:\\a;C:\\b");
  });

  it("names the system's own folders", () => {
    expect(systemPathEntries("linux")).toEqual(["/usr/bin", "/bin"]);
    expect(systemPathEntries("win32", { SystemRoot: "D:\\Win" })).toEqual(["D:\\Win\\System32", "D:\\Win", "D:\\Win\\System32\\Wbem"]);
    expect(systemPathEntries("win32", {})[0]).toBe("C:\\Windows\\System32");
    expect(systemPathEntries("darwin", {}, true)).toEqual(["/usr/local/bin", "/usr/bin", "/bin"]);
    expect(systemPathEntries("win32", { SystemRoot: "D:\\Win" }, true)).toHaveLength(3);
  });
});

describe("findExecutable", () => {
  it("finds an executable file on PATH, not a plain one", () => {
    const folder = mkdtempSync(join(tmpdir(), "tavi-path-"));
    folders.push(folder);
    writeFileSync(join(folder, "plain"), "");
    writeFileSync(join(folder, "tool"), "");
    chmodSync(join(folder, "tool"), 0o755);
    const path = ["relative", folder].join(pathDelimiter());
    if (process.platform !== "win32") {
      expect(findExecutable("tool", { path })).toBe(join(folder, "tool"));
      expect(findExecutable("plain", { path })).toBeUndefined();
    }
    expect(findExecutable("missing", { path })).toBeUndefined();
  });

  it("tries PATHEXT's extensions on Windows, and a name that has one as it is", () => {
    const present = new Set(["C:\\tools\\rg.exe", "D:\\bin\\npm.cmd"]);
    const options = {
      platform: "win32" as const,
      path: "C:\\tools;D:\\bin",
      env: { PATHEXT: ".COM;.EXE;.CMD" },
      runnable: (file: string) => present.has(file),
    };
    expect(findExecutable("rg", options)).toBe("C:\\tools\\rg.exe");
    expect(findExecutable("npm", options)).toBe("D:\\bin\\npm.cmd");
    expect(findExecutable("rg.exe", options)).toBe("C:\\tools\\rg.exe");
    // A bare name is never run as it is on Windows: `rg` with no extension is not a program.
    expect(findExecutable("rg", { ...options, runnable: (file: string) => file === "C:\\tools\\rg" })).toBeUndefined();
    expect(executableExtensions({})).toEqual([".com", ".exe", ".bat", ".cmd"]);
  });
});

describe("childBaseEnv", () => {
  const source = {
    HOME: "/home/a",
    TMPDIR: "/tmp/a",
    XDG_CACHE_HOME: "/home/a/.cache",
    SYSTEMROOT: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    USERPROFILE: "C:\\Users\\a",
    TEMP: "C:\\Users\\a\\Temp",
    SECRET_TOKEN: "x",
    PATH: "/usr/bin",
  };

  it("keeps the home and temporary folders, nothing else", () => {
    expect(childBaseEnv(source, "linux")).toEqual({ HOME: "/home/a", TMPDIR: "/tmp/a", XDG_CACHE_HOME: "/home/a/.cache" });
  });

  it("adds what Windows needs, whatever the case of its names", () => {
    const base = childBaseEnv(source, "win32");
    expect(base).toMatchObject({
      SystemRoot: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      USERPROFILE: "C:\\Users\\a",
      TEMP: "C:\\Users\\a\\Temp",
    });
    expect(base).not.toHaveProperty("SECRET_TOKEN");
    expect(base).not.toHaveProperty("PATH");
  });

  it("gives a child built from nothing Windows's system variables only", () => {
    expect(systemEnv(source, "linux")).toEqual({});
    expect(systemEnv(source, "win32")).toEqual({ SystemRoot: "C:\\Windows", COMSPEC: "C:\\Windows\\System32\\cmd.exe" });
  });
});

describe("launchCommand", () => {
  it("leaves a program as it is off Windows, and an .exe on Windows", () => {
    expect(launchCommand("/usr/bin/npm", ["i"], { platform: "linux" })).toEqual({ command: "/usr/bin/npm", args: ["i"] });
    expect(launchCommand("C:\\bin\\rg.exe", ["x"], { platform: "win32" })).toEqual({ command: "C:\\bin\\rg.exe", args: ["x"] });
  });

  it("runs a known Node tool's shim as Node on its JavaScript entry", () => {
    const exists = (path: string) =>
      path === "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" || path === "C:\\repo\\node_modules\\turbo\\bin\\turbo";
    expect(launchCommand("C:\\nodejs\\npm.cmd", ["pack"], { platform: "win32", node: "C:\\nodejs\\node.exe", exists })).toEqual({
      command: "C:\\nodejs\\node.exe",
      args: ["C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "pack"],
    });
    expect(launchCommand("C:\\repo\\node_modules\\.bin\\turbo.CMD", ["run"], { platform: "win32", node: "node.exe", exists })).toEqual({
      command: "node.exe",
      args: ["C:\\repo\\node_modules\\turbo\\bin\\turbo", "run"],
    });
  });

  it("runs any other shim through cmd.exe with every argument escaped", () => {
    const launch = launchCommand("C:\\tools\\my tool.cmd", ['a "b"', "x&y", "50%", "back\\"], {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      exists: () => false,
    });
    expect(launch.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(launch.args[4]).toBe('"C:\\tools\\my^ tool.cmd ^^^"a^^^ \\^^^"b\\^^^"^^^" ^^^"x^^^&y^^^" ^^^"50^^^%^^^" ^^^"back\\\\^^^""');
  });

  it("escapes a `!` like any other metacharacter, with delayed expansion off", () => {
    const launch = launchCommand("C:\\tools\\x.cmd", ["!PATH!"], { platform: "win32", env: {}, exists: () => false });
    expect(launch.args).toEqual(["/d", "/v:off", "/s", "/c", '"C:\\tools\\x.cmd ^^^"^^^!PATH^^^!^^^""']);
  });

  it("refuses an argument cmd.exe cannot carry", () => {
    for (const bad of ["a\nb", "a\rb", "a\0b"]) {
      expect(() => launchCommand("C:\\tools\\x.bat", [bad], { platform: "win32", exists: () => false })).toThrow(LaunchRefusedError);
    }
  });
});
