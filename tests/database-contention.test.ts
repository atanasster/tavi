import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { databaseBaseline } from "./fixtures/database-baseline.js";
import { DatabaseClient } from "../packages/runtime/src/persistence/client.js";
import { databaseWorkerEvents } from "../packages/runtime/src/persistence/worker-channel.js";
import { DATABASE_LIMITS } from "../packages/runtime/src/persistence/protocol.js";

it.each([1, 4, 8])(
  "compares synchronous and worker persistence under %i contended writes",
  async (count) => {
    const measurements: Record<string, unknown>[] = [];
    for (const mode of ["synchronous", "worker"] as const) {
      const baseline = databaseBaseline();
      const store = mode === "synchronous" ? baseline.application() : undefined;
      const client = mode === "worker" ? await DatabaseClient.open({ databasePath: baseline.databasePath }) : undefined;
      if (store === undefined && client === undefined) throw new Error("missing persistence fixture");
      const holder = new Worker(
        `const {parentPort, workerData} = require('node:worker_threads');
      const Database = require(workerData.driver); const db = new Database(workerData.path);
      db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
      parentPort.once('message', () => setTimeout(() => { db.exec('ROLLBACK'); db.close(); parentPort.close(); }, workerData.holdMs));`,
        {
          eval: true,
          workerData: { driver: createRequire(import.meta.url).resolve("better-sqlite3"), path: baseline.databasePath, holdMs: 150 },
        },
      );
      const waits: number[] = [];
      const observe = (value: unknown) => {
        if (
          value !== null &&
          typeof value === "object" &&
          "phase" in value &&
          value.phase === "settled" &&
          "queueWaitMs" in value &&
          typeof value.queueWaitMs === "number"
        )
          waits.push(value.queueWaitMs);
      };
      try {
        await new Promise<void>((resolve, reject) => {
          holder.once("message", () => resolve());
          holder.once("error", reject);
        });
        const started = performance.now();
        const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 10));
        databaseWorkerEvents.subscribe(observe);
        holder.postMessage("release after 150 ms");
        await Promise.all(
          Array.from({ length: count }, (_, index) => {
            const input = { key: `write-${index}`, value: "durable", now: "2026-09-28T00:00:00.000Z" };
            if (client !== undefined) return client.call("meta.set", input);
            if (store === undefined) throw new Error("missing native fixture");
            return store.setMeta(input.key, input.value, input.now);
          }),
        );
        const elapsedMs = performance.now() - started;
        const timerMs = await timer;
        databaseWorkerEvents.unsubscribe(observe);
        for (let index = 0; index < count; index++)
          expect(client === undefined ? store?.getMeta(`write-${index}`) : await client.call("meta.get", { key: `write-${index}` })).toBe(
            "durable",
          );
        measurements.push({
          mode,
          writes: count,
          heldMs: 150,
          timerTargetMs: 10,
          timerMs: Number(timerMs.toFixed(2)),
          elapsedMs: Number(elapsedMs.toFixed(2)),
          queueWaitMaxMs: mode === "synchronous" ? null : Number(Math.max(...waits).toFixed(2)),
        });
      } finally {
        databaseWorkerEvents.unsubscribe(observe);
        await holder.terminate();
        await client?.close();
        baseline.close();
      }
    }
    console.log("DATABASE_CONTENTION", JSON.stringify({ measurements, limits: DATABASE_LIMITS }));
  },
  15_000,
);
