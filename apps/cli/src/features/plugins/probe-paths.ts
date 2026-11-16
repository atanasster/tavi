import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * What a Node child needs to start on Linux: the
 * dynamic loader's libraries and cache, the shell srt's wrapper runs, TLS
 * roots, time zones, name-service files and locales. A test fails when one
 * is dropped.
 */
export const LINUX_PROBE_READ_PATHS = [
  "/lib",
  "/lib64",
  "/usr/lib",
  "/usr/lib64",
  "/etc/ld.so.cache",
  "/bin",
  "/usr/bin",
  "/etc/ssl",
  "/usr/lib/ssl",
  "/usr/share/zoneinfo",
  "/etc/localtime",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/usr/lib/locale",
  "/usr/share/locale",
] as const;

/**
 * What a sandboxed Node child (`plugins.validate`) may read: `stagingDir`,
 * the node binary and its prefix's lib, and the system files Node needs.
 */
export function probeReadPaths(stagingDir: string, execPath = process.execPath, platform: NodeJS.Platform = process.platform): string[] {
  const paths = new Set<string>([stagingDir]);
  let nodeBinary = execPath;
  try {
    nodeBinary = realpathSync(execPath);
  } catch {
    // Keep the spelled path.
  }
  paths.add(nodeBinary);
  const prefixLib = join(dirname(dirname(nodeBinary)), "lib");
  if (existsSync(prefixLib) && !prefixLib.startsWith("/usr/lib")) paths.add(prefixLib);
  if (nodeBinary.startsWith("/opt/homebrew/")) paths.add("/opt/homebrew");
  if (nodeBinary.startsWith("/usr/local/Cellar/")) {
    paths.add("/usr/local/Cellar");
    paths.add("/usr/local/opt");
  }
  const system =
    platform === "linux"
      ? LINUX_PROBE_READ_PATHS
      : [
          "/System/Library/OpenSSL",
          "/private/etc/ssl",
          "/usr/share/zoneinfo",
          "/private/var/db/timezone",
          "/Library/Apple/usr/libexec/oah",
        ];
  for (const path of system) {
    if (existsSync(path)) paths.add(path);
  }
  return [...paths];
}
