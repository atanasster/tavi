import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Starting a program without a shell on every platform. On Windows a `.cmd`
 * or `.bat` file (`npm.cmd`, a `node_modules/.bin` shim) is not something
 * Node will spawn by itself: a known Node tool runs as this Node on its
 * JavaScript entry instead, and any other one runs through `cmd.exe` with
 * every argument escaped for it.
 */

/** A spawn's command, arguments and the one option it needs (`windowsVerbatimArguments` for `cmd.exe`). */
export interface Launch {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: true;
}

export interface LaunchOptions {
  readonly platform?: NodeJS.Platform;
  /** Where `ComSpec` is read (default: `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** The Node that runs a known tool's entry (default: `process.execPath`). */
  readonly node?: string;
  readonly exists?: (path: string) => boolean;
}

/** A launch refused: an argument `cmd.exe` cannot carry (a NUL, CR or LF ends or splits its command line). */
export class LaunchRefusedError extends Error {
  override readonly name = "LaunchRefusedError";
}

/** Node tools whose `.cmd` shim is replaced by their JavaScript entry, relative to a `node_modules` folder. */
const NODE_TOOLS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  npm: [["npm", "bin", "npm-cli.js"]],
  npx: [["npm", "bin", "npx-cli.js"]],
  pnpm: [
    ["pnpm", "bin", "pnpm.cjs"],
    ["pnpm", "bin", "pnpm.mjs"],
  ],
  pnpx: [
    ["pnpm", "bin", "pnpx.cjs"],
    ["pnpm", "bin", "pnpx.mjs"],
  ],
  turbo: [["turbo", "bin", "turbo"]],
};

/**
 * A known tool's JavaScript entry beside its shim: under the shim's folder's
 * `node_modules` (npm beside node, a global install) or, for a
 * `node_modules/.bin` shim, in the `node_modules` above it.
 */
function nodeToolEntry(file: string, exists: (path: string) => boolean): string | undefined {
  const { basename, dirname, extname, join } = win32;
  const tool = basename(file, extname(file)).toLowerCase();
  const entries = NODE_TOOLS[tool];
  if (entries === undefined) return undefined;
  const folder = dirname(file);
  const roots = basename(folder).toLowerCase() === ".bin" ? [dirname(folder)] : [join(folder, "node_modules")];
  for (const root of roots) {
    for (const entry of entries) {
      const candidate = join(root, ...entry);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** `cmd.exe`'s metacharacters: each is escaped with `^`. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for a program `cmd.exe` starts: quoted by the C runtime's rules
 * (backslashes before a quote doubled, the quote escaped), then every
 * metacharacter escaped for `cmd.exe` — twice, since a `.cmd` file passes its
 * arguments through a second `cmd.exe` parse (`%*`).
 */
function escapeCmdArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/**
 * How to start `file` with `args`, with no shell of the caller's own. `cmd.exe`
 * runs with AutoRun off (`/d`) and delayed expansion off (`/v:off`), so a `!`
 * in an argument is never expanded nor eats an escape.
 */
export function launchCommand(file: string, args: readonly string[], options: LaunchOptions = {}): Launch {
  const platform = options.platform ?? process.platform;
  const extension = (platform === "win32" ? win32 : posix).extname(file).toLowerCase();
  if (platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) return { command: file, args };
  const entry = nodeToolEntry(file, options.exists ?? existsSync);
  if (entry !== undefined) return { command: options.node ?? process.execPath, args: [entry, ...args] };
  for (const value of [file, ...args]) {
    if (/[\0\r\n]/.test(value)) throw new LaunchRefusedError(`${win32.basename(file)} cannot be given a NUL, CR or LF through cmd.exe`);
  }
  const env = options.env ?? process.env;
  const comspec = env["ComSpec"] ?? env["COMSPEC"] ?? "cmd.exe";
  const line = [file.replace(CMD_META, "^$1"), ...args.map(escapeCmdArgument)].join(" ");
  return { command: comspec, args: ["/d", "/v:off", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
