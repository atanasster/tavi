import { spawnSync } from "node:child_process";

import { cli, withDataDir } from "../../../scripts/docs/session.mjs";

/**
 * What the scripting guides' walks share: `tavi` run as a script runs it — no terminal, its exit code and both streams
 * kept — where `walk.tavi` throws on a non-zero exit and keeps only standard output.
 */

export interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** `tavi <args> --data-dir <dataDir>` with no terminal, as a hook or cron job runs it, in the session's environment. */
export function taviScript(dataDir: string, ...args: string[]): Ran {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("TAVI_")));
  const ran = spawnSync(process.execPath, [cli, ...withDataDir(args, dataDir)], {
    encoding: "utf8",
    env: { ...env, TAVI_CREDENTIAL_KEYCHAIN: "off", TZ: "Europe/London", LANG: "en_US.UTF-8" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 240_000,
  });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

/** The JSON lines of a `--format json` stream, parsed. */
export function events(stream: string): { readonly kind: string; readonly runId: string; readonly [field: string]: unknown }[] {
  return stream
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { kind: string; runId: string });
}

/** A notes folder with a three-item to-do list, as the scripting guides' `~/code/notes`. */
export const NOTES = { "notes/todo.txt": "- renew passport\n- book dentist\n- call the plumber\n" };
