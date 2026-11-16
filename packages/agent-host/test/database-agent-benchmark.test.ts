import Database from "better-sqlite3";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { sleep } from "@tavi/node-kit";
import { AsyncCheckpointSaver } from "../src/workflow/checkpoint.js";
import { DatabaseClient } from "../../runtime/src/persistence/client.js";
import { SqliteStore } from "../../runtime/src/persistence/store.js";
import { databaseWorkerEvents } from "../../runtime/src/persistence/worker-channel.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

it.each([1, 4, 8])(
  "compares the same deterministic agent graph before/after offloading SQL with %i tasks",
  async (count) => {
    for (const mode of ["native-main-thread", "worker"] as const) {
      const directory = directories.create("tavi-agent-benchmark-");
      const path = join(directory, "db.sqlite");
      const native = mode === "native-main-thread" ? new SqliteStore({ databasePath: path }) : undefined;
      const client = mode === "worker" ? await DatabaseClient.open({ databasePath: path }) : undefined;
      const connection = native === undefined ? undefined : new Database(path);
      let saver: SqliteSaver | AsyncCheckpointSaver;
      if (connection !== undefined) saver = new SqliteSaver(connection);
      else if (client !== undefined) saver = new AsyncCheckpointSaver(client.checkpoints);
      else throw new Error("missing saver");
      const state = Annotation.Root({ task: Annotation<number>(), prompt: Annotation<string>(), answer: Annotation<string>() });
      const graph = new StateGraph(state)
        .addNode("model", async (input) => {
          const key = `agent-${input.task}`;
          if (client !== undefined) await client.call("meta.set", { key, value: input.prompt, now: "2026-09-28T00:00:00.000Z" });
          else if (native !== undefined) native.setMeta(key, input.prompt, "2026-09-28T00:00:00.000Z");
          return { answer: `answer-${input.task}` };
        })
        .addEdge(START, "model")
        .addEdge("model", END)
        .compile({ checkpointer: saver });
      const holder = new Worker(
        `const {parentPort,workerData}=require('node:worker_threads');
      const Database=require(workerData.driver); const db=new Database(workerData.path);
      db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
      parentPort.once('message',()=>setTimeout(()=>{db.exec('ROLLBACK');db.close();parentPort.close();},150));`,
        { eval: true, workerData: { path, driver: createRequire(import.meta.url).resolve("better-sqlite3") } },
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
      const delay = monitorEventLoopDelay({ resolution: 5 });
      try {
        await new Promise<void>((resolve, reject) => {
          holder.once("message", () => resolve());
          holder.once("error", reject);
        });
        delay.enable();
        databaseWorkerEvents.subscribe(observe);
        await sleep(10);
        const started = performance.now();
        const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 10));
        holder.postMessage("release");
        const results = await Promise.all(
          Array.from({ length: count }, (_, index) =>
            graph.invoke({ task: index, prompt: `private-${index}` }, { configurable: { thread_id: `task-${index}` } }),
          ),
        );
        const elapsedMs = performance.now() - started;
        const timerMs = await timer;
        delay.disable();
        databaseWorkerEvents.unsubscribe(observe);
        for (const [index, result] of results.entries()) {
          expect(result.answer).toBe(`answer-${index}`);
          expect((await saver.getTuple({ configurable: { thread_id: `task-${index}` } }))?.checkpoint.channel_values["prompt"]).toBe(
            `private-${index}`,
          );
          expect(client === undefined ? native?.getMeta(`agent-${index}`) : await client.call("meta.get", { key: `agent-${index}` })).toBe(
            `private-${index}`,
          );
        }
        const size = (file: string) => {
          try {
            return statSync(file).size;
          } catch {
            return 0;
          }
        };
        console.log(
          "DATABASE_AGENT_COMPARISON",
          JSON.stringify({
            mode,
            tasks: count,
            heldMs: 150,
            timerTargetMs: 10,
            timerMs: Number(timerMs.toFixed(2)),
            elapsedMs: Number(elapsedMs.toFixed(2)),
            eventLoopP95Ms: Number((delay.percentile(95) / 1e6).toFixed(3)),
            eventLoopMaxMs: Number((delay.max / 1e6).toFixed(3)),
            queueWaitMaxMs: client === undefined ? null : Number(Math.max(...waits).toFixed(2)),
            databaseBytes: size(path),
            walBytes: size(`${path}-wal`),
          }),
        );
      } finally {
        databaseWorkerEvents.unsubscribe(observe);
        delay.disable();
        await holder.terminate();
        if (saver instanceof AsyncCheckpointSaver) await saver.close();
        await client?.close();
        connection?.close();
        native?.close();
      }
    }
  },
  20_000,
);
