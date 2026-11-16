import { nodeScheduler, openConnection, openSocket, readOwner } from "@tavi/client/node";
import type { OnboardingConnectAnswer, OnboardingFlowAnswer, OnboardingStatus, OnboardingVerifyAnswer } from "@tavi/contracts";
import { temporaryDirectories, until } from "@tavi/test-support";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OwnerModelTarget } from "../../src/features/run/owner.js";
import { serve, type ServeHandle } from "../../src/server/serve.js";
import { startOnboardingStub } from "../support/onboarding-stub.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * Welcome's acceptance: a fresh store goes from
 * Welcome to a first answered turn with no restart. Driving the React page
 * against a real owner would need a browser and `tavi ui`'s bridge, so this
 * sends the IPC sequence Welcome sends (`apps/ui/src/features/welcome/onboarding-api.ts`)
 * — status and flow, connect-key for the Custom preset with its endpoint,
 * verify, `models set-default` once it passed — then the canvas's new-chat
 * `run`, over a connection that says it is the bridge, as the page's is. The
 * model is an OpenAI-compatible stub on a free port.
 */

const directories = temporaryDirectories();
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  directories.cleanup();
});

/** The key the stub accepts: distinctive, so it is seen if it ever comes back in an answer. */
const KEY = "sk-test-welcome-e2e-4b1d";

/** Lists `m1`; calls the probe tool for verify and answers a turn in words; refuses any other key. */
async function stub(): Promise<string> {
  const started = await startOnboardingStub(KEY);
  cleanups.push(() => started.close());
  return started.baseUrl;
}

/** A fresh store's owner with no model: what `tavi serve` is before setup. */
async function freshOwner(): Promise<{ readonly directory: string; readonly handle: ServeHandle }> {
  const directory = directories.create("tavi-welcome-e2e-");
  const placeholder: OwnerModelTarget = { source: "placeholder", connectionId: "default", model: "default", workspaceId: "default" };
  const handle = await serve(
    fixtureServeOptions(directory, {
      defaultConnectionId: "default",
      defaultModel: "default",
      modelTargetUnconfigured: true,
      liveModelTarget: {},
    }),
    { dataDirectory: directory, drainDeadlineMs: 5_000, modelTarget: placeholder },
    { stdout: () => {}, stderr: () => {}, isTty: false },
    { browserOverride: createFixtureBrowser() },
  );
  cleanups.push(() => handle.shutdown("test cleanup"));
  return { directory, handle };
}

describe("Welcome to a first answered turn on a real owner", () => {
  it("connects a key, verifies it, makes it the default and answers a new chat, with no restart", async () => {
    const baseUrl = await stub();
    const { directory, handle } = await freshOwner();
    const address = readOwner(directory);
    if (address === undefined) throw new Error("no owner published");
    // The page's connection, as `tavi ui`'s bridge opens it for the canvas.
    const page = await openConnection(await openSocket(address.endpoint), address, { scheduler: nodeScheduler, client: "bridge" });
    cleanups.push(() => page.close());
    let sequence = 0;
    const ask = async <T>(command: string, payload: Record<string, unknown>): Promise<T> => {
      sequence += 1;
      const answer = await page.request(command, payload, `welcome-${String(sequence)}`);
      expect(answer.ok, `${command} ${String(payload["action"])}: ${JSON.stringify(answer.error)}`).toBe(true);
      return answer.result as T;
    };

    // Welcome opens: the flow and the status, a first run with the model to do.
    const flow = await ask<OnboardingFlowAnswer>("onboarding", { action: "flow", workspaceId: "default", surface: "web" });
    expect(flow.flow.steps[0]?.kind).toBe("model");
    const before = await ask<OnboardingStatus>("onboarding", { action: "status", workspaceId: "default", surface: "web" });
    expect(before).toMatchObject({ firstRun: true, complete: false });
    expect(before.open[0]).toBe("model");

    // The model step: Custom, its endpoint and a key, then the suggested model verified.
    // The owner reads its providers again once the call that wrote them is done, as a models or credentials write does.
    const refresh = vi.spyOn(handle.runtime, "refreshProviders");
    cleanups.push(() => refresh.mockRestore());
    await ask("onboarding", { action: "status", workspaceId: "default", surface: "web" });
    expect(refresh).not.toHaveBeenCalled();
    const connected = await ask<OnboardingConnectAnswer>("onboarding", {
      action: "connect-key",
      workspaceId: "default",
      preset: "custom",
      key: KEY,
      baseUrl,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(connected.models).toContain("m1");
    expect(JSON.stringify(connected)).not.toContain(KEY);
    const verified = await ask<OnboardingVerifyAnswer>("onboarding", {
      action: "verify",
      workspaceId: "default",
      role: "main",
      target: { connectionId: connected.connectionId, model: "m1" },
    });
    expect(verified.results[0]).toMatchObject({ role: "main", connectionId: connected.connectionId, model: "m1", ok: true, toolsOk: true });
    // Made the default only once it passed, as Welcome does.
    await ask("models", { action: "set-default", workspaceId: "default", connectionId: connected.connectionId, model: "m1" });
    const after = await ask<OnboardingStatus>("onboarding", { action: "status", workspaceId: "default", surface: "web" });
    expect(after.steps.find((step) => step.kind === "model")).toMatchObject({ state: "done" });
    expect(after).toMatchObject({ complete: true, firstRun: false });

    // A new chat on the same owner, never restarted: answered by the model just set up.
    const run = await ask<{ readonly taskId: string }>("run", {
      workspaceId: "default",
      principal: "operator",
      approval: "client",
      prompt: "hello",
      operationKey: "welcome-first-turn",
    });
    const tasks = handle.runtime.store.asPort().repositories.tasks;
    const finished = await until(
      async () => (await tasks.get(run.taskId))?.status,
      (status) => status === "completed" || status === "failed",
    );
    expect(finished).toBe("completed");
    const transcript = await until(
      async () =>
        await ask<{ readonly entries: readonly unknown[] }>("tasks", { action: "transcript", taskId: run.taskId, workspaceId: "default" }),
      (answer) => answer.entries.length === 1,
    );
    expect(JSON.stringify(transcript)).toContain("Hello from the stub.");
  }, 60_000);
});
