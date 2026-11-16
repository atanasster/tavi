import { existsSync, readFileSync } from "node:fs";

/** Which WSL a Linux process runs in: 1 has no Linux kernel of its own (no namespaces), 2 is a real kernel in a VM. */
export type WslVersion = 1 | 2;

/** Where the answer comes from; tests replace both. */
export interface WslProbe {
  /** `/proc/sys/kernel/osrelease`; undefined when it cannot be read. */
  readonly osrelease?: () => string | undefined;
  /** Whether `/run/WSL` exists: WSL2 creates it, and a custom WSL2 kernel's release may not say `wsl2`. */
  readonly runWsl?: () => boolean;
}

/**
 * The WSL version this process runs in, or undefined off WSL. Read from the
 * kernel release (`...-microsoft-standard-WSL2` on WSL2, `...-Microsoft` on
 * WSL1), not from `WSL_DISTRO_NAME`, which a service started by systemd does
 * not inherit.
 */
export function wslVersion(platform: NodeJS.Platform = process.platform, probe: WslProbe = {}): WslVersion | undefined {
  if (platform !== "linux") return undefined;
  const release = (probe.osrelease ?? readOsRelease)()?.toLowerCase() ?? "";
  if (!release.includes("microsoft")) return undefined;
  return release.includes("wsl2") || (probe.runWsl ?? (() => existsSync("/run/WSL")))() ? 2 : 1;
}

function readOsRelease(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/osrelease", "utf8");
  } catch {
    return undefined;
  }
}

/** WSL's interop folder: its socket runs a Windows program, as the Windows user, outside any Linux sandbox. */
export const WSL_INTEROP_DIRECTORY = "/run/WSL";

/** Where WSL mounts the Windows drives unless `/etc/wsl.conf` moves them (`[automount] root`). */
export const WSL_DEFAULT_DRIVES = "/mnt";

/**
 * What a sandboxed child is denied on WSL: the default drive folder, the
 * interop folder, and every Windows drive where it is actually mounted, read
 * from `mounts` (`/proc/self/mounts`): a drvfs mount (`9p` with
 * `aname=drvfs`, or `drvfs` itself), wherever `[automount] root` put it.
 */
export function wslDenyRoots(mounts: string | undefined = readMounts()): readonly string[] {
  const drives = (mounts ?? "")
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([, , type = "", options = ""]) => type === "drvfs" || (type === "9p" && /(?:^|[,;])aname=drvfs(?:[,;]|$)/.test(options)))
    .map(([, point = ""]) => point.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))))
    .filter((point) => point.startsWith("/") && point !== WSL_DEFAULT_DRIVES && !point.startsWith(`${WSL_DEFAULT_DRIVES}/`));
  return [...new Set([WSL_DEFAULT_DRIVES, WSL_INTEROP_DIRECTORY, ...drives])];
}

function readMounts(): string | undefined {
  try {
    return readFileSync("/proc/self/mounts", "utf8");
  } catch {
    return undefined;
  }
}

/** What keeps a WSL2 distribution, and a `tavi serve` in it, running after its last terminal closes. */
export const WSL_KEEP_RUNNING =
  "WSL stops this distribution, and tavi serve with it, soon after its last terminal closes. " +
  "In %USERPROFILE%\\.wslconfig on Windows set vmIdleTimeout=-1 under [wsl2] and instanceIdleTimeout=-1 under [general] (WSL 2.5 or later), then run wsl --shutdown once.";

/** Why WSL1 cannot run Tavi's confined tools, and the fix. */
export const WSL1_UNSUPPORTED =
  "WSL1 is not supported: it has no Linux kernel namespaces, so the sandbox cannot run. Move the distribution to WSL2 (wsl --set-version <distro> 2).";
