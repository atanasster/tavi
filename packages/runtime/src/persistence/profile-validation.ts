import { existsSync } from "node:fs";
import { TaviError } from "@tavi/contracts";
import { loadBetterSqlite3 } from "./sqlite-loader.js";

import { PROFILE_FORMAT, PROFILE_FORMAT_KEY } from "./profile-format.js";

/** Inspect existing data read-only before opening a writer or running migrations. */
export function assertProfileFormat(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  const Database = loadBetterSqlite3();
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
    ).map(({ name }) => name);
    // No migration committed (a first run stopped early, or an empty file): still a new profile.
    if (
      tables.every((name) => name === "tavi_schema_migrations") &&
      (tables.length === 0 || db.prepare("SELECT 1 FROM tavi_schema_migrations LIMIT 1").get() === undefined)
    )
      return;
    const row = tables.includes("tavi_meta") ? db.prepare("SELECT value FROM tavi_meta WHERE key = ?").get(PROFILE_FORMAT_KEY) : undefined;
    if (typeof row !== "object" || row === null || !("value" in row) || row.value !== PROFILE_FORMAT) {
      throw new TaviError(
        "CONFLICT",
        "Unsupported data profile format. Use a separate data directory (--data-dir); original data is unchanged.",
      );
    }
  } finally {
    db.close();
  }
}
