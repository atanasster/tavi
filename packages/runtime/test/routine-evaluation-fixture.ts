import { join } from "node:path";
import { afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { DatabaseClient } from "../src/persistence/client.js";
import { RoutineService } from "../src/persistence/routine-facades.js";
import { SqliteStore } from "../src/persistence/store.js";
import { RoutineEvaluationService } from "../src/routines/async-evaluation.js";

/**
 * The evaluator the owner runs, against a database a test also reads directly.
 *
 * The quality gate runs in the owner and reaches the database through the
 * worker, so a test evaluates the same way: the store it seeds and inspects is
 * file-backed, and the evaluator opens the database worker on that file.
 */
const cleanups: (() => void | Promise<void>)[] = [];
const directories = temporaryDirectories();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  directories.cleanup();
});

/** A file-backed store, closed and removed after the test. */
export function routineStore(options: { artifactsDirectory?: string } = {}): SqliteStore {
  const directory = directories.create("tavi-routine-evaluation-");
  const store = new SqliteStore({ databasePath: join(directory, "db.sqlite"), ...options });
  cleanups.push(() => {
    store.close();
  });
  return store;
}

/** The owner's evaluator over the database worker opened on `store`'s file. */
export async function routineEvaluation(
  store: SqliteStore,
  options: RoutineEvaluationService["options"],
): Promise<RoutineEvaluationService> {
  const client = await DatabaseClient.open({ databasePath: store.databasePath });
  cleanups.push(() => client.close());
  return new RoutineEvaluationService(new RoutineService(client, options.now === undefined ? {} : { now: options.now }), options);
}
