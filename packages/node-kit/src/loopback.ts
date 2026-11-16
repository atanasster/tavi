import { isIP } from "node:net";

/** Bare address with any IPv6 brackets removed. */
function bareAddress(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Loopback may use plain `http`, so a local provider stub is reachable;
 * everything else must be TLS. Recognizes the IPv4-mapped IPv6 form and all of
 * `127.0.0.0/8`, not just the literal `127.0.0.1`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = bareAddress(hostname).toLowerCase();
  const version = isIP(bare);
  if (version === 4) return bare.startsWith("127.");
  if (version === 6) {
    if (bare === "::1") return true;
    if (bare.startsWith("::ffff:")) {
      const tail = bare.slice("::ffff:".length);
      if (isIP(tail) === 4) return tail.startsWith("127.");
      // `URL` normalizes an IPv4-mapped address to hex groups
      // (`[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`), so decode the low 32
      // bits rather than expecting the dotted spelling.
      const [high, low, ...rest] = tail.split(":");
      if (rest.length > 0 || high === undefined || low === undefined) return false;
      const highBits = Number.parseInt(high, 16);
      const lowBits = Number.parseInt(low, 16);
      if (!Number.isFinite(highBits) || !Number.isFinite(lowBits)) return false;
      return ((highBits >> 8) & 0xff) === 127;
    }
    return false;
  }
  return bare === "localhost";
}
