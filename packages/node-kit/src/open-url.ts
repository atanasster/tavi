import { spawn, type SpawnOptions } from "node:child_process";

import { shellOpen } from "./win32.js";

/** What `openUrl` needs of a spawned opener. */
export interface OpenerProcess {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  /** Waited for only when the opener reads the URL on stdin: its exit code says whether it opened it. */
  once(event: "exit", listener: (code: number | null) => void): unknown;
  unref(): void;
  /** The opener's stdin, when it reads the URL there (`stdio[0]` is a pipe). */
  readonly stdin?: { on(event: "error", listener: (error: Error) => void): unknown; end(chunk: string): unknown } | null;
}

export type OpenerSpawn = (command: string, args: readonly string[], options: SpawnOptions) => OpenerProcess;

export interface OpenUrlOptions {
  readonly platform?: NodeJS.Platform;
  /** The spawn to run the opener with; `node:child_process`'s by default. */
  readonly spawn?: OpenerSpawn;
  /** The environment that says whether this is WSL; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** On Windows, how a URL is handed to its registered program; `ShellExecuteW` by default. */
  readonly shellOpen?: (url: string) => boolean;
}

const STDIN_OPENER_WAIT_MS = 5_000;

/** A platform's opener: its command and arguments, and what it reads on stdin, if anything. */
export interface Opener {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}

/**
 * The platform's opener, never through a shell. On macOS, `osascript` reads
 * an `open location` script on stdin, so the URL is on no command line;
 * elsewhere the URL is one argv entry, where other local users can read it
 * in the process list: `xdg-open` on Linux and other Unixes, and on Windows
 * the URL protocol handler (used only when `ShellExecuteW` cannot be called:
 * see `openUrl`).
 */
export function openerFor(url: string, platform: NodeJS.Platform): Opener {
  if (platform === "darwin") {
    // The URL becomes AppleScript source: only printable ASCII, so nothing but `\` and `"` needs escaping.
    if (/[^\x21-\x7e]/u.test(url)) throw new TypeError("A URL to open holds a character outside printable ASCII.");
    return { command: "osascript", args: [], stdin: `open location "${url.replace(/[\\"]/g, "\\$&")}"\n` };
  }
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

/** Whether `env` is a WSL distribution's: WSL sets one of these in every process it starts. */
function insideWsl(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["WSL_DISTRO_NAME"] !== undefined || env["WSL_INTEROP"] !== undefined;
}

/**
 * The openers to try, in order. On WSL a default Ubuntu has no `xdg-open`:
 * `wslview` (from `wslu`) comes next, then Windows' own URL protocol handler,
 * which WSL runs from the Windows `PATH`.
 */
export function openersFor(url: string, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>> = {}): Opener[] {
  const first = openerFor(url, platform);
  if (platform !== "linux" || !insideWsl(env)) return [first];
  return [first, { command: "wslview", args: [url] }, { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }];
}

/** Whether `platform`'s opener puts the URL on its command line, where other users of the computer can list it. */
export function openerShowsUrl(platform: NodeJS.Platform = process.platform): boolean {
  return openerFor("https://example.invalid/", platform).stdin === undefined;
}

/**
 * Opens an http(s) URL in the person's browser, detached. Answers whether the
 * opener started — `false` for any other scheme, a URL that does not parse,
 * or no opener that starts — so the caller can print the URL instead.
 * Openers are tried in turn while one is missing (`openersFor`).
 * An opener that reads the URL on stdin (macOS) is also waited for: `false`
 * when it exits with an error or has not finished within 5 s.
 * On Windows the URL goes to `ShellExecuteW` first, which starts no opener
 * process of its own; `rundll32` is the fallback when that cannot be called.
 * See `openerFor` for where the URL travels.
 */
export async function openUrl(url: string, options: OpenUrlOptions = {}): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    try {
      return (options.shellOpen ?? shellOpen)(parsed.href);
    } catch {
      // No Win32 call to make (its library would not load): the protocol handler, below.
    }
  }
  // The parsed form, not the string given: whitespace and quotes arrive percent-encoded.
  for (const opener of openersFor(parsed.href, platform, options.env ?? process.env)) {
    const outcome = await runOpener(opener, options.spawn ?? spawn);
    if (outcome !== "missing") return outcome === "opened";
  }
  return false;
}

/** Runs one opener: `"missing"` when it could not be started, so the next may be tried. */
function runOpener(opener: Opener, spawnOpener: OpenerSpawn): Promise<"opened" | "failed" | "missing"> {
  return new Promise((resolve) => {
    let child: OpenerProcess;
    try {
      child = spawnOpener(opener.command, opener.args, {
        stdio: [opener.stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"],
        detached: true,
      });
    } catch {
      resolve("missing");
      return;
    }
    child.once("error", () => resolve("missing"));
    child.once("spawn", () => {
      if (opener.stdin === undefined) {
        child.unref();
        resolve("opened");
        return;
      }
      const timer = setTimeout(() => {
        child.unref();
        resolve("failed");
      }, STDIN_OPENER_WAIT_MS);
      timer.unref();
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? "opened" : "failed");
      });
      // An opener that exits before reading closes the pipe: its exit code reports that, not a throw here.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opener.stdin);
    });
  });
}
