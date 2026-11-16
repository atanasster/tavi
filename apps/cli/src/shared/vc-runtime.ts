import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * The Microsoft Visual C++ runtime on Windows, which the native modules Tavi
 * loads there need (`onnxruntime-node`, and the sandbox's `srt-win.exe`):
 * without it they fail to load with an unhelpful "module not found".
 */
export const VC_RUNTIME_FILES = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"] as const;

/** How to install the runtime for the processor Node runs on: Windows on Arm needs the arm64 build. */
function vcRuntimeFix(arch: string = process.arch): string {
  const build = arch === "arm64" ? "arm64" : "x64";
  return `winget install Microsoft.VCRedist.2015+.${build} (or install the Visual C++ Redistributable for ${build} from Microsoft)`;
}

/** `doctor`'s `vcRuntime` section, on Windows only. */
export interface VcRuntimeReport {
  readonly ok: boolean;
  /** The runtime's files not in the system folder. */
  readonly missing: readonly string[];
  readonly fix?: string;
}

/** Whether the runtime's files are in Windows's system folder; undefined off Windows, where there is nothing to check. */
export function vcRuntimeReport(
  platform: NodeJS.Platform = process.platform,
  systemRoot: string | undefined = process.env["SystemRoot"],
  exists: (path: string) => boolean = existsSync,
  arch: string = process.arch,
): VcRuntimeReport | undefined {
  if (platform !== "win32") return undefined;
  const system32 = win32.join(systemRoot ?? "C:\\Windows", "System32");
  const missing = VC_RUNTIME_FILES.filter((file) => !exists(win32.join(system32, file)));
  return missing.length === 0 ? { ok: true, missing } : { ok: false, missing, fix: vcRuntimeFix(arch) };
}
