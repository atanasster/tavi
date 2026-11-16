import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** The `--data-dir` default, said the same way in every command's usage. */
export const DATA_DIR_DEFAULT_HELP = "default: $TAVI_DATA_DIR, else your user data directory";

/**
 * Where Tavi keeps its data when no directory is named: per user, not per
 * current directory, so every command finds the same database wherever it
 * runs. `$XDG_DATA_HOME/tavi` when that is set to an absolute path (on any
 * platform; a relative one is ignored, as the XDG spec says), else
 * `~/Library/Application Support/tavi` on macOS, `%LOCALAPPDATA%\tavi` on
 * Windows and `~/.local/share/tavi` elsewhere.
 */
export function defaultDataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const xdg = env["XDG_DATA_HOME"];
  if (xdg !== undefined && isAbsolute(xdg)) return join(xdg, "tavi");
  if (platform === "darwin") return join(home, "Library", "Application Support", "tavi");
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    return join(local !== undefined && local !== "" ? local : join(home, "AppData", "Local"), "tavi");
  }
  return join(home, ".local", "share", "tavi");
}

/**
 * The single data-directory resolution order: the flag, then `TAVI_DATA_DIR`,
 * then the per-user default. Every command uses it, because one that picked a
 * different directory would write to the wrong database. Absolute, because the
 * directory is published to clients as part of the IPC endpoint: a relative
 * path would be read against each client's working directory.
 */
export function resolveDataDirectory(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const named = explicit ?? env["TAVI_DATA_DIR"];
  const path = resolve(named !== undefined && named !== "" ? named : defaultDataDirectory(env));
  return platform === "win32" ? spelledAsOnDisk(path) : path;
}

/**
 * On Windows, `path` as the filesystem spells it: the drive letter's case, each
 * folder's own case and long names for short ones (`RUNNER~1`), as
 * `realpath` gives them. The checks that a folder "resolves to itself" compare
 * against `realpath`, and would otherwise refuse every folder under a path
 * typed in another case. Read from the nearest folder that exists; the rest,
 * not yet made, is kept as given.
 */
function spelledAsOnDisk(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  try {
    return join(realpathSync.native(existing), ...rest);
  } catch {
    return path;
  }
}
