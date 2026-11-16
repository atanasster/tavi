import { WorkerChannel } from "./worker-channel.js";
import { persistenceWorkerUrl } from "./client.js";
import type * as Internal from "./administration.js";
export type { ExportResult, RestoreResult } from "./administration.js";
export type AdministrationOperations = {
  [K in "createSnapshot" | "exportTables" | "restoreSnapshot" | "readRecordedOwner"]: {
    input: Parameters<(typeof Internal)[K]>[0];
    output: ReturnType<(typeof Internal)[K]>;
  };
};
async function run<K extends keyof AdministrationOperations>(
  operation: K,
  input: AdministrationOperations[K]["input"],
): Promise<AdministrationOperations[K]["output"]> {
  const channel = new WorkerChannel(persistenceWorkerUrl("database-worker"), { workerData: { mode: "administration" }, execArgv: [] });
  await channel.ready;
  try {
    // Each named operation has a matching worker handler; no SQL is accepted.
    return (await channel.request(operation, input)) as AdministrationOperations[K]["output"];
  } finally {
    await channel.close();
  }
}
export const createSnapshot = (input: AdministrationOperations["createSnapshot"]["input"]) => run("createSnapshot", input);
export const exportTables = (input: AdministrationOperations["exportTables"]["input"]) => run("exportTables", input);
export const restoreSnapshot = (input: AdministrationOperations["restoreSnapshot"]["input"]) => run("restoreSnapshot", input);

export const readRecordedOwner = (dataDirectory: string) => run("readRecordedOwner", dataDirectory);
