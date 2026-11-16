import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { processCreationTime } from "./win32.js";

/**
 * When process `pid` started, as text that is the same for as long as that
 * process lives and differs for a later process given the same pid: a pid
 * alone is reused, so a record of "pid 4120" can name a stranger after a
 * reboot. Undefined when the process is gone or its start cannot be read.
 */
export function processStartTime(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    if (platform === "linux") return startTimeFromStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (platform === "win32") return processCreationTime(pid);
    // macOS and the BSDs have no /proc: `ps` prints the start to the second.
    const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // The same text whatever the caller's time zone and language: a start read under another must not differ.
      env: { ...process.env, TZ: "UTC0", LC_ALL: "C" },
    }).trim();
    return started === "" ? undefined : started;
  } catch {
    return undefined;
  }
}

/**
 * The start field (the 22nd: clock ticks after boot) of a `/proc/<pid>/stat`
 * line. Read after the command's closing parenthesis, since a command name
 * may hold spaces and parentheses itself.
 */
export function startTimeFromStat(stat: string): string | undefined {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // The fields after the command start at the third (state), so the 22nd is the 20th here.
  const started = fields[19];
  return started === undefined || !/^\d+$/.test(started) ? undefined : started;
}
