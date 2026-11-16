import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

/**
 * Where each platform keeps an identifier that survives network and hostname
 * changes. macOS in particular renames the host as networks come and go, so a
 * hostname cannot tell "another machine" from "this machine, renamed".
 */
function readPlatformMachineId(): string | undefined {
  switch (process.platform) {
    case "darwin": {
      const output = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5_000 });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output)?.[1];
    }
    case "win32": {
      const output = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(output)?.[1];
    }
    default:
      for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const value = readFileSync(path, "utf8").trim();
          if (value !== "") return value;
        } catch {
          /* try the next location */
        }
      }
      return undefined;
  }
}

let cached: string | undefined;

/**
 * A stable identity for this machine: the platform machine ID when one is
 * available, otherwise the hostname. The prefix keeps the two kinds from ever
 * comparing equal.
 */
export function machineIdentity(): string {
  if (cached !== undefined) return cached;
  let id: string | undefined;
  try {
    id = readPlatformMachineId();
  } catch {
    id = undefined;
  }
  cached = id === undefined ? `hostname:${hostname()}` : `machine:${id}`;
  return cached;
}
