import { execFile } from "node:child_process";

/**
 * The command-line tools macOS ships as `xcrun` shims in /usr/bin (`python3`, `git`, `make`, …). A shim looks its tool
 * up in xcrun's cache, a file in the user's temporary folder (`getconf DARWIN_USER_TEMP_DIR`), and writes the entry
 * when it is missing. `sandbox.run` cannot write there, so on a host where the cache was never filled every run of
 * these printed `couldn't create cache file … xcrun_db-…` to stderr, which a model then had to explain away. Filled
 * once from the owner, outside the sandbox, the runs read it and print nothing.
 */
export const XCRUN_SHIMS: readonly string[] = ["python3", "pip3", "git", "make", "clang", "cc", "c++", "swift", "ld"];

/** Runs `file` with `args`; true when it exited 0. */
export type ExitsCleanly = (file: string, args: readonly string[]) => Promise<boolean>;

const exitsCleanly: ExitsCleanly = (file, args) =>
  new Promise((done) => {
    execFile(file, [...args], { timeout: 10_000 }, (error) => done(error === null));
  });

/**
 * Fills xcrun's cache for `XCRUN_SHIMS` on macOS, where the Command Line Tools are installed: without them a lookup
 * may open Apple's install dialog, so nothing is looked up. The shims found, in order; none elsewhere.
 */
export async function warmXcrunCache(
  options: { readonly platform?: NodeJS.Platform; readonly run?: ExitsCleanly } = {},
): Promise<readonly string[]> {
  if ((options.platform ?? process.platform) !== "darwin") return [];
  const run = options.run ?? exitsCleanly;
  if (!(await run("/usr/bin/xcode-select", ["-p"]))) return [];
  const found: string[] = [];
  for (const tool of XCRUN_SHIMS) if (await run("/usr/bin/xcrun", ["--find", tool])) found.push(tool);
  return found;
}
