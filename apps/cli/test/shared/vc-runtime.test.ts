import { describe, expect, it } from "vitest";

import { VC_RUNTIME_FILES, vcRuntimeReport } from "../../src/shared/vc-runtime.js";

describe("the Visual C++ runtime check", () => {
  it("is Windows-only", () => {
    expect(vcRuntimeReport("linux", "C:\\Windows", () => false)).toBeUndefined();
    expect(vcRuntimeReport("darwin", undefined, () => false)).toBeUndefined();
  });

  it("looks in the system folder and names the files missing, with the fix", () => {
    const looked: string[] = [];
    expect(
      vcRuntimeReport("win32", "D:\\Win", (path) => {
        looked.push(path);
        return true;
      }),
    ).toEqual({ ok: true, missing: [] });
    expect(looked).toEqual(VC_RUNTIME_FILES.map((file) => `D:\\Win\\System32\\${file}`));
    expect(vcRuntimeReport("win32", undefined, (path) => !path.endsWith("msvcp140.dll"), "x64")).toEqual({
      ok: false,
      missing: ["msvcp140.dll"],
      fix: "winget install Microsoft.VCRedist.2015+.x64 (or install the Visual C++ Redistributable for x64 from Microsoft)",
    });
  });

  it("names the arm64 build on Windows on Arm", () => {
    expect(vcRuntimeReport("win32", undefined, () => false, "arm64")?.fix).toMatch(/^winget install Microsoft\.VCRedist\.2015\+\.arm64 /);
  });
});
