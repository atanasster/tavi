import { chmodSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { join } from "node:path";
import { AsyncDataDirectoryOwner } from "@tavi/runtime";
import { expect, it, afterEach } from "vitest";
import { temporaryDirectories } from "@tavi/test-support";
import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

it.each(["database", "ownership"])(
  "closes admissions and protects takeover when the %s worker fails during an invocation",
  async (failure) => {
    const directory = directories.create("tavi-runtime-db-failure-");
    chmodSync(directory, 0o700);
    const owner = await AsyncDataDirectoryOwner.acquire({ dataDirectory: directory, sessionId: "fixture", lockTimeoutMs: 0 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = false;
    let signal: AbortSignal | undefined;
    let effects = 0;
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directory, {
        shutdownDeadlineMs: 100,
        defaultModel: "fixture",
        approvalRequiredFor: [],
        scheduleSweepEnabled: false,
      }),
      {
        ownership: owner,
        modelOverride: {
          stream: async (request, options) => {
            signal = options.signal;
            active = true;
            entered.resolve();
            await release.promise;
            active = false;
            return {
              status: "completed",
              attemptId: request.attemptId,
              text: "",
              toolCalls: [{ id: "must-not-dispatch", name: "fixture.effect", input: {} }],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        },
      },
    );
    runtime.tools.register({
      id: "fixture.effect",
      sink: "none",
      version: "1",
      description: "Count an external effect",
      effect: "external",
      requiredPermissions: ["tools.invoke"],
      inputSchema: z.object({}),
      handler: async () => {
        effects++;
        return {};
      },
    });
    const workflow = runtime.workflow;
    if (workflow === undefined) throw new Error("missing workflow");
    const processRecord = readFileSync(join(directory, "owner.process.json"), "utf8");
    const context = { workspaceId: "default", principalId: "operator", runId: "initial", caller: "test" };
    const invocation = workflow.admit({ context, operationKey: "active", kind: "start", prompt: "hold" });
    // Attach immediately: worker termination may reject before the test awaits it.
    const settled = Promise.allSettled([invocation]);
    try {
      await entered.promise;
      if (failure === "database") {
        await runtime.store.abort();
        await runtime.store.failed;
      } else {
        await owner.abort();
        await owner.failed;
      }
      expect(active).toBe(true);
      expect(owner.released).toBe(failure === "ownership");
      expect(signal?.aborted).toBe(true);
      await expect(workflow.admit({ context, operationKey: "after-loss", kind: "start", prompt: "refuse" })).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      const contender = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      const {AsyncDataDirectoryOwner} = await import(process.argv[1]);
      try { const owner = await AsyncDataDirectoryOwner.acquire({dataDirectory:process.argv[2],sessionId:'contender',lockTimeoutMs:0});
        await owner.release(); console.log(JSON.stringify({acquired:true}));
      } catch (error) { console.log(JSON.stringify({code:error.code})); }
    `,
          new URL("../../../../packages/runtime/dist/index.mjs", import.meta.url).href,
          directory,
        ],
        { timeout: 5_000 },
      );
      expect(JSON.parse(contender.stdout)).toEqual({ code: "CONFLICT" });
      expect(readFileSync(join(directory, "owner.process.json"), "utf8")).toBe(processRecord);
      release.resolve();
      await settled;
      const report = await runtime.close();
      expect(report.clean).toBe(false);
      expect(report.failures.some((failure) => failure.pluginId === "tavi.persistence")).toBe(true);
      expect(owner.released).toBe(failure === "ownership");
      expect(effects).toBe(0);
      expect(readFileSync(join(directory, "owner.process.json"), "utf8")).toBe(processRecord);
    } finally {
      release.resolve();
      await settled;
      await runtime.close();
      // The test owns the failed runtime's lifetime and has now stopped all work.
      await owner.release();
    }
  },
  15_000,
);
