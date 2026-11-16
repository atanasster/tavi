import { createRequire } from "node:module";

/**
 * This build's id: the CLI package's version, read at startup — what `tavi
 * --version` prints, what `doctor` and a backup's manifest record, and the id
 * the plugin host runs under. A build whose package cannot be read (an odd
 * install) is `unknown` rather than a stale literal.
 */
export const BUILD_ID: string = ((): string => {
  try {
    const manifest = createRequire(import.meta.url)("../package.json") as { readonly version?: unknown };
    return typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
})();
