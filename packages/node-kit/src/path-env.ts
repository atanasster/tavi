import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * `PATH` and a child's environment, per platform: `;` and `PATHEXT` on
 * Windows, `:` and the execute bit elsewhere. Every helper takes the platform
 * and the environment it reads, so a test can ask for Windows on any host.
 */

/** The separator between `PATH` entries. */
export const pathDelimiter = (platform: NodeJS.Platform = process.platform): string => (platform === "win32" ? ";" : ":");

const pathModule = (platform: NodeJS.Platform): typeof posix => (platform === "win32" ? win32 : posix);

/** `PATH`'s absolute entries, in order (a relative one would name a different file per working directory). */
export function pathEntries(value: string | undefined, platform: NodeJS.Platform = process.platform): readonly string[] {
  const { isAbsolute } = pathModule(platform);
  return (value ?? "").split(pathDelimiter(platform)).filter((entry) => entry !== "" && isAbsolute(entry));
}

/** `entries` as one `PATH` value, each entry once. */
export const joinPath = (entries: readonly string[], platform: NodeJS.Platform = process.platform): string =>
  [...new Set(entries)].join(pathDelimiter(platform));

/**
 * The system's own folders, for a child whose `PATH` is built from scratch:
 * `/usr/bin` and `/bin` (after `/usr/local/bin` when `local`), or Windows's
 * `System32` (where `cmd.exe`, `where` and `tar` are) and its root.
 */
export function systemPathEntries(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  local = false,
): readonly string[] {
  if (platform !== "win32") return local ? ["/usr/local/bin", "/usr/bin", "/bin"] : ["/usr/bin", "/bin"];
  const root = env["SystemRoot"] ?? env["SYSTEMROOT"] ?? env["windir"] ?? env["WINDIR"] ?? "C:\\Windows";
  return [win32.join(root, "System32"), root, win32.join(root, "System32", "Wbem")];
}

/** The extensions Windows runs a bare name with, lower-cased: `PATHEXT`, else its default. */
export function executableExtensions(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const value = env["PATHEXT"] ?? env["Pathext"] ?? ".COM;.EXE;.BAT;.CMD";
  return value
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."));
}

export interface FindExecutableOptions {
  /** The `PATH` value to search (default: `env`'s). */
  readonly path?: string;
  readonly platform?: NodeJS.Platform;
  /** Where `PATH` and `PATHEXT` are read (default: `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Whether `file` is one to run (default: a file, with the execute bit off Windows). */
  readonly runnable?: (file: string) => boolean;
}

const runnableFile = (candidate: string, platform: NodeJS.Platform): boolean => {
  try {
    if (!statSync(candidate).isFile()) return false;
    // Windows has no execute bit: the extension says what runs.
    if (platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * `name` on `PATH`, as an absolute path: an executable file in an absolute
 * folder. On Windows a bare name is tried with each `PATHEXT` extension
 * (`rg` finds `rg.exe`), and a name that already has one of them as it is.
 */
export function findExecutable(name: string, options: FindExecutableOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const { join, extname } = pathModule(platform);
  const runnable = options.runnable ?? ((file: string) => runnableFile(file, platform));
  const extensions = platform === "win32" ? executableExtensions(env) : [];
  const named = extensions.includes(extname(name).toLowerCase());
  const names = platform !== "win32" || named ? [name] : extensions.map((extension) => `${name}${extension}`);
  for (const directory of pathEntries(options.path ?? env["PATH"] ?? env["Path"], platform)) {
    for (const candidate of names) {
      const file = join(directory, candidate);
      if (runnable(file)) return file;
    }
  }
  return undefined;
}

/** What Windows itself needs in any process's environment: without them `cmd.exe` and Winsock fail. */
const WINDOWS_SYSTEM = ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"] as const;
/** Windows's home and temporary folders. */
const WINDOWS_FOLDERS = ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] as const;
/** The POSIX equivalents, kept on every platform when the owner has them. */
const POSIX_BASE = ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"] as const;

/** `names` copied from `source` where set; on Windows matched whatever their case (`SystemRoot` may arrive as `SYSTEMROOT`). */
function copied(source: NodeJS.ProcessEnv, platform: NodeJS.Platform, names: readonly string[]): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of names) {
    const key =
      source[name] !== undefined || platform !== "win32"
        ? name
        : Object.keys(source).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    const value = key === undefined ? undefined : source[key];
    if (value !== undefined && value !== "") base[name] = value;
  }
  return base;
}

/**
 * What a child built from nothing still needs: on Windows the system
 * variables no process runs without; elsewhere nothing. For a child whose
 * home and temporary folders are its own.
 */
export const systemEnv = (source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> =>
  platform === "win32" ? copied(source, platform, WINDOWS_SYSTEM) : {};

/**
 * A child's base environment, copied from `source`: the home and temporary
 * folders, and on Windows the system variables a process cannot run without.
 * Nothing else: a caller adds `PATH`, the locale and its own variables, and
 * may replace any of these (a confined child's `HOME`, say).
 */
export function childBaseEnv(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return copied(source, platform, platform === "win32" ? [...WINDOWS_SYSTEM, ...WINDOWS_FOLDERS, ...POSIX_BASE] : POSIX_BASE);
}

/**
 * A child's environment built from nothing but the system's: `systemEnv`, and
 * a `PATH` of `first` then the system's own folders (`/usr/local/bin` too when
 * `local`). A caller adds its locale, home and own variables.
 */
export const systemChildEnv = (first: readonly string[] = [], local = false): Record<string, string> => ({
  ...systemEnv(),
  PATH: joinPath([...first, ...systemPathEntries(process.platform, process.env, local)]),
});
