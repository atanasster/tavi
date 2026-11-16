import type { OnboardingStatus, OnboardingVerifyAnswer } from "@tavi/contracts";
import { createFixtureBrowser } from "../../../../packages/builtin/browser/test/support/fixture.js";
import { createIpcClient, type IpcClient } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { startOpenAiStub } from "@tavi/test-support/openai-stub";
import { afterEach, describe, expect, it } from "vitest";

import type { OwnerModelTarget } from "../../src/features/run/owner.js";
import { findLiveOwner, serve } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * Onboarding verification on a running owner: the first model added over IPC is
 * verified through `onboarding verify` against an OpenAI-compatible stub on a
 * free port — `models test`'s one generation, the probe tool called — and
 * the model step turns done; a stub that refuses the key gives the advice and
 * leaves the default where it was.
 */

const directories = temporaryDirectories();
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  directories.cleanup();
});

/** An OpenAI-compatible stub: `tools` calls the probe tool, `refuse` answers 401. */
async function stub(mode: { current: "tools" | "refuse" }): Promise<string> {
  const started = await startOpenAiStub({
    reply: () =>
      mode.current === "refuse"
        ? {
            status: 401,
            body: { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } },
          }
        : { calls: [{ id: "call_1", name: "probe_noop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
  });
  cleanups.push(() => started.close());
  return started.baseUrl;
}

const PLACEHOLDER: OwnerModelTarget = { source: "placeholder", connectionId: "default", model: "default", workspaceId: "default" };

async function owner(): Promise<IpcClient> {
  const directory = directories.create("tavi-onboard-verify-");
  const handle = await serve(
    fixtureServeOptions(directory, {
      defaultConnectionId: "default",
      defaultModel: "default",
      modelTargetUnconfigured: true,
      liveModelTarget: {},
    }),
    { dataDirectory: directory, drainDeadlineMs: 5_000, modelTarget: PLACEHOLDER },
    { stdout: () => {}, stderr: () => {}, isTty: false },
    { browserOverride: createFixtureBrowser() },
  );
  cleanups.push(() => handle.shutdown("test cleanup"));
  const found = await findLiveOwner(directory);
  if (found === undefined) throw new Error("serve did not publish discovery");
  const client = await createIpcClient(found);
  cleanups.push(() => client.close());
  return client;
}

describe("onboarding verify on a running owner", () => {
  it("verifies the first model through models test, with its tool probe, and marks the model step done", async () => {
    const mode = { current: "tools" as "tools" | "refuse" };
    const baseUrl = await stub(mode);
    const client = await owner();
    const before = (await client.request("onboarding", { action: "status" }, "status-1")).result as OnboardingStatus;
    expect(before).toMatchObject({ firstRun: true, complete: false, providerId: "tavi.onboarding" });
    // The built-in flow answers, in the canvas's order and the terminal's.
    expect(before.open).toEqual(
      ["model", "about", "apps", "tasks", "channels", "search", "service", "ideas"].filter((kind) =>
        before.steps.some((step) => step.kind === kind && step.state !== "unavailable"),
      ),
    );
    const flow = await client.request("onboarding", { action: "flow", surface: "cli" }, "flow");
    expect(flow.result).toMatchObject({ providerId: "tavi.onboarding" });
    expect((flow.result as { fallback?: string }).fallback).toBeUndefined();
    expect(
      ((await client.request("onboarding", { action: "status", surface: "cli" }, "status-cli")).result as OnboardingStatus).steps.map(
        (step) => step.kind,
      ),
    ).toEqual(["model", "about", "apps", "tasks", "channels", "search", "service", "ideas"]);
    expect((await client.request("credentials", { action: "set", reference: "stub", value: "sk-test-not-real" }, "key")).ok).toBe(true);
    expect(
      (await client.request("models", { action: "add", connectionId: "stub", baseUrl, credentialRef: "stub", model: "m1" }, "add")).ok,
    ).toBe(true);
    expect((await client.request("models", { action: "set-default", connectionId: "stub", model: "m1" }, "default")).ok).toBe(true);

    const verified = await client.request("onboarding", { action: "verify" }, "verify-1");
    expect(verified.ok, JSON.stringify(verified.error)).toBe(true);
    const answer = verified.result as OnboardingVerifyAnswer;
    expect(answer.results).toEqual([{ role: "main", connectionId: "stub", model: "m1", ok: true, toolsOk: true }]);
    expect(answer.status.steps.find((step) => step.kind === "model")).toMatchObject({ state: "done", detail: "stub · m1 · verified" });
    expect(answer.status).toMatchObject({ complete: true, firstRun: false });
    // `tavi doctor` says it too, step by step.
    const doctor = (await client.request("doctor", {}, "doctor")).result as { readonly onboarding?: Record<string, unknown> };
    expect(doctor.onboarding).toMatchObject({
      providerId: "tavi.onboarding",
      complete: true,
      firstRun: false,
      steps: { model: { state: "done" } },
    });
    // Spent a real completion: a second one moments later is refused.
    expect((await client.request("onboarding", { action: "verify" }, "verify-2")).error?.code).toBe("RATE_LIMITED");
  });

  it("gives the advice for a refused key and leaves the default target where it was", async () => {
    const mode = { current: "refuse" as "tools" | "refuse" };
    const baseUrl = await stub(mode);
    const client = await owner();
    await client.request("credentials", { action: "set", reference: "stub", value: "sk-test-not-real" }, "key");
    await client.request("models", { action: "add", connectionId: "stub", baseUrl, credentialRef: "stub", model: "m1" }, "add");
    await client.request("models", { action: "set-default", connectionId: "stub", model: "m1" }, "default");
    const answer = (await client.request("onboarding", { action: "verify" }, "verify")).result as OnboardingVerifyAnswer;
    expect(answer.results[0]).toMatchObject({ ok: false, errorCode: "auth", advice: expect.stringContaining("The key was refused") });
    expect(answer.status.steps.find((step) => step.kind === "model")).toMatchObject({
      state: "todo",
      detail: expect.stringContaining("The key was refused"),
    });
    const roles = (await client.request("models", { action: "roles" }, "roles")).result as {
      readonly workspaceDefault: { readonly target: unknown };
    };
    expect(roles.workspaceDefault.target).toEqual({ connectionId: "stub", model: "m1" });
  });
});
