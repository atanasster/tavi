import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { temporaryDirectories } from "@tavi/test-support";

import { defaultDataDirectory, resolveDataDirectory } from "../../src/shared/data-directory.js";

const temp = temporaryDirectories();
afterEach(() => temp.cleanup());

describe("the data directory", () => {
  it("defaults per user, by platform, with XDG_DATA_HOME first", () => {
    expect(defaultDataDirectory({}, "darwin", "/Users/u")).toBe(join("/Users/u", "Library", "Application Support", "tavi"));
    expect(defaultDataDirectory({}, "linux", "/home/u")).toBe(join("/home/u", ".local", "share", "tavi"));
    expect(defaultDataDirectory({ XDG_DATA_HOME: "/data" }, "darwin", "/Users/u")).toBe(join("/data", "tavi"));
    expect(defaultDataDirectory({ XDG_DATA_HOME: "" }, "linux", "/home/u")).toBe(join("/home/u", ".local", "share", "tavi"));
    expect(defaultDataDirectory({ XDG_DATA_HOME: "relative/data" }, "linux", "/home/u")).toBe(join("/home/u", ".local", "share", "tavi"));
    expect(defaultDataDirectory({ LOCALAPPDATA: "" }, "win32", "C:\\Users\\u")).toBe(join("C:\\Users\\u", "AppData", "Local", "tavi"));
    expect(defaultDataDirectory({}, "win32", "C:\\Users\\u")).toBe(join("C:\\Users\\u", "AppData", "Local", "tavi"));
    expect(defaultDataDirectory({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(
      join("C:\\Users\\u\\AppData\\Local", "tavi"),
    );
  });

  it("takes the flag, then TAVI_DATA_DIR, then the default, always absolute", () => {
    const env = { TAVI_DATA_DIR: "env-dir", XDG_DATA_HOME: "/xdg" };
    expect(resolveDataDirectory("flag-dir", env, "linux")).toBe(resolve("flag-dir"));
    expect(resolveDataDirectory(undefined, env, "linux")).toBe(resolve("env-dir"));
    expect(resolveDataDirectory(undefined, { XDG_DATA_HOME: "/xdg" }, "linux")).toBe(resolve("/xdg", "tavi"));
    expect(resolveDataDirectory(undefined, { TAVI_DATA_DIR: "", XDG_DATA_HOME: "/xdg" }, "linux")).toBe(resolve("/xdg", "tavi"));
  });

  it("never resolves to the developer's own data under test", () => {
    // The shared vitest config blanks TAVI_DATA_DIR and points XDG_DATA_HOME at a scratch directory.
    expect(resolveDataDirectory(undefined)).toContain("tavi-test-data-home");
  });

  it("is spelled as on disk on Windows, from the nearest folder that exists, so a folder under it resolves to itself", () => {
    const base = temp.create("tavi-data-spelling-");
    expect(resolveDataDirectory(join(base, "missing", "tavi"), {}, "win32")).toBe(join(realpathSync.native(base), "missing", "tavi"));
    expect(resolveDataDirectory(join(base, "missing", "tavi"), {}, "linux")).toBe(join(base, "missing", "tavi"));
  });
});
