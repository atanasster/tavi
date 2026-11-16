import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generateCa } from "@anthropic-ai/sandbox-runtime";

/**
 * The CA a proxy terminates credential hosts' TLS with: one per owner
 * session and folder, valid 30 days, minted at first use and again with
 * under a week left. A child loads it once, when it starts, so one running
 * with credentials is started again before its CA runs out (`renewBy`). A
 * CA's folder is removed only once it has expired, never one another process
 * (a second owner, `tavi mcp probe`) or a running child may still hold, and
 * one removed meanwhile is minted again. srt's own ephemeral CA is never
 * used, since it writes its key into `TMPDIR`. The folder must be one no
 * confined command reads (the data directory).
 */
export interface ProxyCa {
  readonly certPath: string;
  readonly keyPath: string;
  /** When it runs out (epoch ms). */
  readonly expires: number;
}

const DAY_MS = 86_400_000;
/** How long a CA is valid. */
const CA_DAYS = 30;
/** How long before it runs out it is replaced for new children. */
const RENEW_BEFORE_MS = 7 * DAY_MS;

const minted = new Map<string, ProxyCa>();

export function proxyCa(directory: string, now: number = Date.now()): ProxyCa {
  const current = minted.get(directory);
  if (current !== undefined && current.expires - now > RENEW_BEFORE_MS && existsSync(current.certPath) && existsSync(current.keyPath))
    return current;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Only what has run out (a CA's folder is named by when it was minted), and what is no CA's folder at all.
  for (const entry of readdirSync(directory)) {
    const mintedAt = /^(\d+)-[0-9a-f]+$/.exec(entry)?.[1];
    if (mintedAt === undefined || now - Number(mintedAt) > (CA_DAYS + 1) * DAY_MS)
      rmSync(join(directory, entry), { recursive: true, force: true });
  }
  const ca = generateCa({ cn: "Tavi sandbox proxy CA", validityDays: CA_DAYS });
  const folder = join(directory, `${String(now)}-${randomBytes(4).toString("hex")}`);
  mkdirSync(folder, { mode: 0o700 });
  writeFileSync(join(folder, "ca.crt"), ca.certPem, { mode: 0o600 });
  writeFileSync(join(folder, "ca.key"), ca.keyPem, { mode: 0o600 });
  const fresh = { certPath: join(folder, "ca.crt"), keyPath: join(folder, "ca.key"), expires: ca.cert.validity.notAfter.getTime() };
  minted.set(directory, fresh);
  return fresh;
}
