import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Resolve packaged worker entries even when a consumer bundles this client.
 *
 * A module of its own so the ownership probe (`owner-attach`) can resolve its
 * worker without loading the database client and its repositories.
 */
export function persistenceWorkerUrl(name: "database-worker" | "ownership-worker"): URL {
  const require = createRequire(import.meta.url);
  return pathToFileURL(require.resolve(`@tavi/runtime/${name}`));
}
