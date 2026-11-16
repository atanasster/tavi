import { existsSync } from "node:fs";
import { join } from "node:path";

import { findExecutable, joinPath } from "@tavi/node-kit";

/** The srt host process's entry: built beside this module, or, run from source, in the package's `dist/`. */
export function hostProcessPath(): string {
  const beside = join(import.meta.dirname, "host-process.mjs");
  return existsSync(beside) ? beside : join(import.meta.dirname, "..", "dist", "host-process.mjs");
}

/** `value` as one POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `name` on `PATH`, if it is there: an executable file in an absolute folder (`rg` finds `rg.exe` on Windows). */
export const onPath = (name: string, path: string = process.env["PATH"] ?? ""): string | undefined => findExecutable(name, { path });

/** Where a Linux distribution installs a helper, looked in after `PATH`: a service unit's `PATH` can be narrow. */
const HELPER_DIRECTORIES = ["/usr/bin", "/bin", "/usr/local/bin"];

/** A helper srt runs (`socat`, `rg`), as an absolute path: on `PATH`, else where one is usually installed. */
export function helperPath(name: string, path: string = process.env["PATH"] ?? ""): string | undefined {
  return onPath(name, path) ?? onPath(name, joinPath(HELPER_DIRECTORIES));
}

/** srt's Linux helpers by absolute path, for its config: what a narrow `PATH` would not find. */
export function srtHelperConfig(locate: (name: string) => string | undefined = helperPath): {
  readonly socatPath?: string;
  readonly ripgrep?: { readonly command: string };
} {
  const socat = locate("socat");
  const rg = locate("rg");
  return { ...(socat === undefined ? {} : { socatPath: socat }), ...(rg === undefined ? {} : { ripgrep: { command: rg } }) };
}
