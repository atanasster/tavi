import { temporaryDirectories } from "@tavi/test-support";
import { createFixtureModel } from "@tavi/test-support/fakes";
import { afterEach, describe, expect, it } from "vitest";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import type { TaviRuntime } from "../../src/runtime/types.js";
import { buildDoctorDocument } from "../../src/features/doctor/reports.js";
import { fixtureRuntimeOptions } from "../support/serve-fixture.js";

/**
 * Ideas in a composed owner, as `tavi doctor` reports them: the provider and
 * the last run, the volume, the budget and hours, whether a fast model words
 * them, the weekly digest (and whether it can go anywhere), and the day's
 * prepared steps.
 */

const directories = temporaryDirectories();
const runtimes: TaviRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.close();
  directories.cleanup();
});

async function compose(): Promise<TaviRuntime> {
  const dataDirectory = directories.create("tavi-ideas-owner-");
  const runtime = await composeTaviRuntime(
    fixtureRuntimeOptions(dataDirectory, {
      workspaces: [{ workspaceId: "default", principalId: "alice", permissions: ["tools.invoke", "models.invoke", "runs.create"] }],
      providers: [{ connectionId: "fixture", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "fixture" }],
      approvalRequiredFor: ["mutating", "external"],
    }),
    { modelOverride: createFixtureModel({ turns: [] }) },
  );
  runtimes.push(runtime);
  return runtime;
}

describe("ideas in tavi doctor", () => {
  it("reports the volume, budget, hours, fast model, digest and the day's prepared steps, and warns of what will not work", async () => {
    const runtime = await compose();
    const ideas = runtime.store.asPort().repositories.ideas;
    await ideas.saveSettings({
      workspaceId: "default",
      patch: { digest: { channel: "tg-nowhere", weekday: 5 } },
      now: new Date(runtime.clock.now()).toISOString(),
    });
    const doctor = await buildDoctorDocument(runtime, { integrity: "skip" });
    expect(doctor["ideas"]).toMatchObject({
      enabled: true,
      providerId: "tavi.ideasagent",
      volume: 12,
      dailyTokens: 20_000,
      hours: { start: "08:00", end: "22:00" },
      fastModel: false,
      digest: { channel: "tg-nowhere", weekday: 5 },
      prepared: { count: 0, tokens: 0 },
    });
    const warning = String((doctor["ideas"] as { warning?: string }).warning);
    expect(warning).toContain("no fast model is set");
    expect(warning).toContain("no chat of yours on connection tg-nowhere");
  });
});
