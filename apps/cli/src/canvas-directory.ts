import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Where the built canvas ships: `apps/cli/ui-dist`, beside the CLI's `dist`.
 * Read by `tavi ui`, which serves it, and by the owner, which
 * hashes the UI built-ins it carries (`plugins/<id>/`).
 */
export function builtCanvasDirectory(): string | undefined {
  // From `src/` and from `dist/` alike, the directory beside them.
  const candidate = fileURLToPath(new URL("../ui-dist", import.meta.url));
  return existsSync(candidate) ? candidate : undefined;
}
