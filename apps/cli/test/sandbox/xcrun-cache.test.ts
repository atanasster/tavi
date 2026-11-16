import { describe, expect, it } from "vitest";

import { XCRUN_SHIMS, warmXcrunCache } from "../../src/features/sandbox/xcrun.js";

describe("filling xcrun's cache before sandboxed runs", () => {
  it("looks up each shim on macOS with the Command Line Tools", async () => {
    const calls: string[] = [];
    const found = await warmXcrunCache({
      platform: "darwin",
      run: async (file, args) => {
        calls.push([file, ...args].join(" "));
        return !(file === "/usr/bin/xcrun" && args[1] === "swift");
      },
    });
    expect(calls[0]).toBe("/usr/bin/xcode-select -p");
    expect(calls.slice(1)).toEqual(XCRUN_SHIMS.map((tool) => `/usr/bin/xcrun --find ${tool}`));
    expect(found).toEqual(XCRUN_SHIMS.filter((tool) => tool !== "swift"));
  });

  it("looks up nothing without the Command Line Tools, so Apple's install dialog never opens", async () => {
    const calls: string[] = [];
    const found = await warmXcrunCache({
      platform: "darwin",
      run: async (file) => {
        calls.push(file);
        return false;
      },
    });
    expect(found).toEqual([]);
    expect(calls).toEqual(["/usr/bin/xcode-select"]);
  });

  it("does nothing off macOS", async () => {
    let ran = false;
    expect(
      await warmXcrunCache({
        platform: "linux",
        run: async () => {
          ran = true;
          return true;
        },
      }),
    ).toEqual([]);
    expect(ran).toBe(false);
  });
});
