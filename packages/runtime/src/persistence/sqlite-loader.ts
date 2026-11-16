import { createRequire } from "node:module";

import type BetterSqlite3 from "better-sqlite3";

type DatabaseConstructor = typeof BetterSqlite3;
type Database = BetterSqlite3.Database;

const require = createRequire(import.meta.url);

/**
 * Load `better-sqlite3` through `createRequire`.
 *
 * The package ships a CommonJS entry point with a native binding and is
 * externalized from the library bundles, so a static ESM
 * import would be rewritten by the bundler and break native resolution.
 */
export function loadBetterSqlite3(): DatabaseConstructor {
  return require("better-sqlite3") as DatabaseConstructor;
}

export type { Database };
