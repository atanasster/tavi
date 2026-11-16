import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { baselineCheckpoint, databaseBaseline } from "./fixtures/database-baseline.js";

describe("database migration baseline", () => {
  it("retains the synchronous driver's event-loop blocking probe", async () => {
    const fixture = databaseBaseline();
    try {
      const holder = fixture.connect();
      const contender = fixture.connect();
      holder.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
      holder.exec("BEGIN IMMEDIATE");
      contender.pragma("busy_timeout = 100");
      let timerRan = false;
      const start = performance.now();
      const timer = new Promise<number>((resolve) =>
        setTimeout(() => {
          timerRan = true;
          resolve(performance.now() - start);
        }, 0),
      );
      expect(() => contender.prepare("INSERT INTO probe VALUES (1)").run()).toThrowError(expect.objectContaining({ code: "SQLITE_BUSY" }));
      const blockedMs = performance.now() - start;
      expect(blockedMs).toBeGreaterThanOrEqual(75);
      expect(timerRan).toBe(false);
      holder.exec("ROLLBACK");
      expect(await timer).toBeGreaterThanOrEqual(blockedMs);
    } finally {
      fixture.close();
    }
  });

  it("admits one task when independent workers submit the same operation key", async () => {
    const fixture = databaseBaseline();
    const workers: Worker[] = [];
    try {
      const store = fixture.application();
      store.asPort().repositories.systemPrompts.set({
        workspaceId: "baseline",
        text: "Pinned baseline prompt",
        expectedRevision: 0,
        actor: "operator",
        now: "2026-09-28T00:00:00.000Z",
      });
      const entrants = ["first", "second"].map((id) => {
        const worker = new Worker(new URL("./fixtures/database-admission-worker.mjs", import.meta.url), {
          execArgv: [],
          workerData: { databasePath: fixture.databasePath, id },
        });
        workers.push(worker);
        const ready = new Promise<void>((resolve, reject) => {
          worker.once("message", () => resolve());
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`Admission worker exited with ${code}`));
          });
        });
        const result = new Promise<unknown>((resolve, reject) => {
          worker.on("message", (message: { type: string }) => {
            if (message.type === "result") resolve(message);
          });
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`Admission worker exited with ${code}`));
          });
        });
        return { worker, ready, result };
      });
      await Promise.all(entrants.map((entry) => entry.ready));
      for (const entry of entrants) entry.worker.postMessage("admit");
      const results = await Promise.all(entrants.map((entry) => entry.result));
      const task = store.asPort().repositories.tasks.getByOperationKey("baseline", "operator", "concurrent-admission");
      expect(task).toBeDefined();
      expect(results).toEqual(
        expect.arrayContaining([
          { type: "result", taskId: task?.taskId, created: true },
          { type: "result", taskId: task?.taskId, created: false },
        ]),
      );
      expect(store.listTasks(10)).toHaveLength(1);
      expect(store.listTasks(10).map((row) => store.asPort().repositories.tasks.getPromptSnapshot(row.taskId))).toEqual([
        expect.objectContaining({ source: "workspace", text: "Pinned baseline prompt", revision: 1 }),
      ]);
      expect(store.migrationStatus().applied.length).toBeGreaterThan(0);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      fixture.close();
    }
  });

  it("keeps independent connections on one file and exposes real write contention", () => {
    const fixture = databaseBaseline();
    try {
      const writer = fixture.connect();
      const contender = fixture.connect();
      writer.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("INSERT INTO probe VALUES (?, ?)").run(1, "uncommitted");
      expect(contender.prepare("SELECT * FROM probe").all()).toEqual([]);
      expect(() => contender.prepare("INSERT INTO probe VALUES (?, ?)").run(2, "racer")).toThrowError(
        expect.objectContaining({ code: "SQLITE_BUSY" }),
      );
      writer.exec("ROLLBACK");
      contender.prepare("INSERT INTO probe VALUES (?, ?)").run(2, "committed");
      expect(writer.prepare("SELECT value FROM probe WHERE id = 2").get()).toEqual({ value: "committed" });
    } finally {
      fixture.close();
    }
  });

  it("preserves same-ID checkpoints across namespaces, pending writes and binary values", async () => {
    const fixture = databaseBaseline();
    try {
      const saver = fixture.saver();
      for (const namespace of ["parent", "child"]) {
        const config = await saver.put(
          { configurable: { thread_id: "task", checkpoint_ns: namespace } },
          baselineCheckpoint("checkpoint-1"),
          { source: "loop", step: 1, parents: {} },
        );
        await saver.putWrites(config, [["result", `result-${namespace}`]], "tool-call");
      }
      const reopened = fixture.saver();
      const rows = [];
      for await (const row of reopened.list({ configurable: { thread_id: "task" } })) rows.push(row);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.config.configurable?.["checkpoint_ns"]).sort()).toEqual(["child", "parent"]);
      for (const row of rows) {
        expect(row.checkpoint.channel_values["bytes"]).toEqual(new Uint8Array([0, 127, 255]));
        expect(row.pendingWrites).toEqual([["tool-call", "result", `result-${row.config.configurable?.["checkpoint_ns"]}`]]);
      }
      await reopened.deleteThread("task");
      expect(await saver.getTuple({ configurable: { thread_id: "task", checkpoint_ns: "parent" } })).toBeUndefined();
    } finally {
      fixture.close();
    }
  });
});
