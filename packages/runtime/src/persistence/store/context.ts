import type { MemoryVectorCache } from "../../memory/vectors.js";
import type { Database } from "../sqlite-loader.js";

/**
 * What a store module works through: the open database, its transactions,
 * the artifacts directory and the worker's memory vectors. `SqliteStore`
 * is one; each aggregate's functions and repositories take it.
 */
export interface StoreContext {
  readonly handle: Database;
  readonly artifactsDirectory: string;
  readonly memoryVectors: MemoryVectorCache;
  transaction<T>(fn: () => T): T;
  transactionImmediate<T>(fn: () => T): T;
}
