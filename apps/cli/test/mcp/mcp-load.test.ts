import { dirname, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterAll, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { EXIT, main } from "../../src/main.js";
import { capture } from "../support/attached-owner.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * The owner under MCP load: event-loop delay
 * (p99, max) and RSS while it calls a server's tools through the bridge —
 * as a chat does, results cleaned and labelled — reads its resources, and
 * takes structured results, images and progress. Opt in with
 * `TAVI_MCP_LOAD=1`; the figures are printed for the evidence files.
 */

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures/mcp/fake-server.mjs");
const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close().catch(() => undefined);
  directories.cleanup();
});

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

describe.skipIf(process.env["TAVI_MCP_LOAD"] !== "1")("the owner under MCP load", () => {
  for (const era of ["legacy", "modern"] as const) {
    it(`${era}: 200 calls through the bridge, 50 resource reads, structured results, images and progress`, async () => {
      const data = directories.create("tavi-mcp-load-");
      const at = ["--data-dir", data];
      expect(
        (
          await tavi([
            "mcp",
            "add",
            "load",
            "--command",
            process.execPath,
            "--unsandboxed",
            "--env",
            `FAKE_ERA=${era}`,
            "--env",
            "FAKE_FLAGS=content",
            ...at,
            "--",
            FAKE,
          ])
        ).code,
      ).toBe(EXIT.ok);
      expect(
        (
          await tavi([
            "mcp",
            "approve",
            "mcp.load",
            "1.0.0",
            "--unsandboxed",
            "--disable",
            "freeze",
            "--disable",
            "crash",
            "--disable",
            "hang",
            ...at,
          ])
        ).code,
      ).toBe(EXIT.ok);
      expect((await tavi(["plugins", "enable", "mcp.load", ...at])).code).toBe(EXIT.ok);
      const runtime = await composeTaviRuntime(
        fixtureRuntimeOptions(data, { workspaces: [{ workspaceId: "default", principalId: "operator", permissions: ["tools.invoke"] }] }),
        { modelOverride: createFixtureModel({ turns: [] }) },
      );
      runtimes.push(runtime);
      const context = { workspaceId: "default", principalId: "operator", runId: "load", caller: "test" };
      const call = (tool: string, input: Record<string, unknown> = {}) =>
        runtime.tools.get(`mcp.load.${tool}`)?.handler({ input, context, signal: new AbortController().signal, taskId: "load" });
      await call("echo", { text: "warm" });

      const delay = monitorEventLoopDelay({ resolution: 10 });
      const rssBefore = process.memoryUsage().rss;
      let rssPeak = rssBefore;
      const sample = setInterval(() => {
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      }, 20);
      delay.enable();
      const started = performance.now();
      for (let batch = 0; batch < 10; batch += 1)
        await Promise.all(Array.from({ length: 20 }, (_, index) => call("echo", { text: `call ${String(batch * 20 + index)}` })));
      const calls = performance.now() - started;
      for (let batch = 0; batch < 5; batch += 1)
        await Promise.all(Array.from({ length: 10 }, () => call("resource_read", { uri: "notes://a" })));
      await call("resource_read", { uri: "notes://big" });
      for (let index = 0; index < 20; index += 1) await Promise.all([call("structured"), call("structured_bad"), call("image")]);
      await call("progress", { steps: 10, ms: 10 });
      await call("big", { bytes: 900 * 1024 });
      delay.disable();
      clearInterval(sample);
      const ms = (nanoseconds: number): string => (nanoseconds / 1e6).toFixed(1);
      const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(0);
      process.stdout.write(
        `MCP load ${era}: 200 calls ${calls.toFixed(0)} ms; event-loop delay p99 ${ms(delay.percentile(99))} ms, max ${ms(delay.max)} ms; RSS ${mib(rssBefore)} → ${mib(rssPeak)} MiB\n`,
      );
      // The worker condition: more than 100 ms of owner event-loop delay caused by MCP moves the client.
      expect(delay.max / 1e6).toBeLessThan(100);
    }, 120_000);
  }
});
