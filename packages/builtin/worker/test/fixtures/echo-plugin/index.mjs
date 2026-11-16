// A test plugin for the worker: tools that echo, read and write state, read files and the environment, answer too much, and crash.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeHeapSnapshot } from "node:v8";

export function register(ctx) {
  // Heartbeat signal sources, when the test asks for them: collected in the worker, answered as data.
  if (ctx.config.signals === true) provideSources(ctx);

  ctx.registerTool({
    name: "echo",
    inputSchema: ctx.z.object({ text: ctx.z.string() }),
    handler: async ({ text }) => ({ echoed: text, pluginId: ctx.pluginId }),
  });
  ctx.registerTool({
    name: "store",
    inputSchema: ctx.z.object({}),
    // A domain plugin's store (as places.open keeps one): node:sqlite on a file in its home, which is its cwd.
    handler: async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync("gate.db");
      try {
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("CREATE TABLE IF NOT EXISTS hits (n INTEGER)");
        db.prepare("INSERT INTO hits (n) VALUES (?)").run(1);
        return { rows: db.prepare("SELECT count(*) AS rows FROM hits").get().rows };
      } finally {
        db.close();
      }
    },
  });
  ctx.registerTool({
    name: "whom",
    inputSchema: ctx.z.object({}),
    handler: async (_input, _options, context) => ({ context: context ?? null }),
  });
  ctx.registerTool({
    name: "count",
    inputSchema: ctx.z.object({}),
    handler: async () => {
      const state = await ctx.state.load();
      const count = (state.counter?.n ?? 0) + 1;
      await ctx.state.put("counter", { n: count });
      return { count };
    },
  });
  ctx.registerTool({
    name: "read",
    inputSchema: ctx.z.object({ path: ctx.z.string() }),
    handler: async ({ path }) => {
      try {
        return { text: readFileSync(path, "utf8") };
      } catch (error) {
        return { refused: error.code };
      }
    },
  });
  ctx.registerTool({
    name: "write",
    inputSchema: ctx.z.object({ path: ctx.z.string() }),
    handler: async ({ path }) => {
      try {
        writeFileSync(path, "x");
        return { wrote: true };
      } catch (error) {
        return { refused: error.code };
      }
    },
  });
  ctx.registerTool({
    name: "env",
    inputSchema: ctx.z.object({}),
    handler: async () => ({ env: process.env, secret: await ctx.secret("token"), raw: await ctx.secret("raw").catch(() => null) }),
  });
  ctx.registerTool({
    name: "getenv",
    inputSchema: ctx.z.object({ name: ctx.z.string() }),
    handler: async ({ name }) => ({ value: process.env[name] ?? null }),
  });
  ctx.registerTool({
    name: "big",
    inputSchema: ctx.z.object({}),
    handler: async () => ({ text: "x".repeat(5 * 1024 * 1024) }),
  });
  ctx.registerTool({
    name: "fetch",
    inputSchema: ctx.z.object({ url: ctx.z.string() }),
    handler: async ({ url }) => {
      try {
        const response = await fetch(url, { headers: { authorization: `Bearer ${await ctx.secret("token")}` }, signal: AbortSignal.timeout(15_000) });
        return { status: response.status, body: (await response.text()).slice(0, 4_000) };
      } catch (error) {
        return { failed: String(error?.cause?.code ?? error?.message) };
      }
    },
  });
  ctx.registerTool({
    name: "heap",
    inputSchema: ctx.z.object({}),
    handler: async () => {
      await ctx.secret("token");
      return { file: writeHeapSnapshot(`${process.env.HOME}/heap.heapsnapshot`) };
    },
  });
  ctx.registerTool({
    name: "orphan-crash",
    inputSchema: ctx.z.object({ marker: ctx.z.string() }),
    // Leaves a process holding its stdout and stderr, then crashes: its pipes never close on their own.
    handler: async ({ marker }) => {
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", marker], { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref();
      setTimeout(() => process.exit(3), 100);
      return new Promise(() => {});
    },
  });
  ctx.registerTool({
    name: "crash",
    inputSchema: ctx.z.object({}),
    handler: async () => {
      setTimeout(() => process.exit(3), 10);
      return new Promise(() => {});
    },
  });
  ctx.registerTool({
    name: "slow",
    inputSchema: ctx.z.object({}),
    handler: (_input, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ aborted: true }))),
  });
  ctx.hooks.on("tool.check", async (input, next) => {
    console.log("checking", input.tool?.id);
    const after = await next();
    return { ...after, reason: `seen ${input.tool?.id}` };
  });
  ctx.commands.register({ name: "hello", run: async ({ args }) => ({ text: `hello ${args}` }) });
}

function provideSources(ctx) {
  ctx.provideSignals({
    id: "queue",
    retracts: false,
    collect: async ({ principalId, now }) => [{ key: "job-1", title: `New match for ${principalId}`, observedAt: now }],
  });
  // Crashes its worker on its first collection, then answers from the next one: a collection is retried once.
  ctx.provideSignals({
    id: "flaky",
    collect: async () => {
      if (!existsSync("flaky-crashed")) {
        writeFileSync("flaky-crashed", "1");
        process.exit(3);
      }
      return [{ key: "after-crash", title: "Answered after a restart" }];
    },
  });
}
