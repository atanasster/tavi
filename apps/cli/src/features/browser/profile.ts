import { join } from "node:path";

import { sha256Hex } from "@tavi/node-kit";
import type { BrowserDisplay } from "@tavi/contracts";

/**
 * Where a workspace's browser profile lives under the data directory:
 * `browser-profiles/<name>-<hash>`. A
 * workspace id may hold any character, so the readable part keeps only safe
 * ones and the hash of the whole id keeps two ids that clean up alike apart.
 */
export function browserProfileDirectory(dataDirectory: string, workspaceId: string): string {
  const readable = workspaceId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  const hash = sha256Hex(workspaceId).slice(0, 12);
  return join(dataDirectory, "browser-profiles", `${readable}-${hash}`);
}

/** The agent's browser display: headless, unless `TAVI_BROWSER_HEADED=1` asks for an off-screen window. */
export function browserDisplay(env: NodeJS.ProcessEnv = process.env): BrowserDisplay {
  return env["TAVI_BROWSER_HEADED"] === "1" ? "headed" : "headless";
}
