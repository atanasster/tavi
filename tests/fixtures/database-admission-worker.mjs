import { parentPort, workerData } from "node:worker_threads";
import { DatabaseClient } from "../../packages/runtime/dist/index.mjs";

const store = await DatabaseClient.open({ databasePath: workerData.databasePath });
parentPort.postMessage({ type: "ready" });
parentPort.once("message", async () => {
  try {
    const result = await store.asPort().repositories.tasks.admit({
      workspaceId: "baseline",
      principalId: "operator",
      operationKey: "concurrent-admission",
      kind: "start",
      intent: { prompt: "baseline" },
      checkpointNamespace: "",
      newTaskId: `task-${workerData.id}`,
      newAdmissionId: `admission-${workerData.id}`,
      newThreadId: `thread-${workerData.id}`,
      now: "2026-09-28T00:00:00.000Z",
      prompt: { builtin: {text:"Baseline",version:"test"}, legacy: {text:"Legacy",version:"test"} },
    });
    await store.close();
    parentPort.postMessage({ type: "result", taskId: result.task.taskId, created: result.created });
  } finally {
    await store.close();
    parentPort.close();
  }
});
