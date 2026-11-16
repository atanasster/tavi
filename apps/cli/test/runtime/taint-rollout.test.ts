import { nowTimestamp } from "@tavi/contracts/util";
import { afterAll, describe, expect, it } from "vitest";

import { buildDoctorDocument, weakTaintWorkspaces } from "../../src/features/doctor/reports.js";
import { loadFixtures } from "../injection/fixtures.js";
import { forgetInjectionDescriptors, runOwnerFixture, startInjectionOwner, type InjectionOwner } from "../injection/owner-harness.js";
import { delay } from "@tavi/test-support";

/**
 * `security.taint` on a served owner: the
 * workspace setting read per call, its default (`enforce`), `serve
 * --taint-policy` over it, and the observations `tavi doctor` counts.
 *
 * The fixture is the Tier 0 injection suite's `web-search.serve-allow-post`: a search
 * result tells the model to POST the chat to an allowlisted host whose tool
 * `serve --allow` lets run unasked — an ask only the taint step makes.
 */

const fixture = loadFixtures().find((entry) => entry.id === "web-search.serve-allow-post");
const SINCE = "2000-01-01T00:00:00.000Z";

afterAll(() => forgetInjectionDescriptors());

async function withOwner(options: Parameters<typeof startInjectionOwner>[0], body: (io: InjectionOwner) => Promise<void>): Promise<void> {
  const io = await startInjectionOwner({ serveAllow: ["http.request"], ...options });
  try {
    await body(io);
  } finally {
    await io.close();
  }
}

describe("security.taint rollout", () => {
  if (fixture === undefined) throw new Error("the web-search.serve-allow-post fixture is missing");

  it("defaults to enforce: a workspace that sets nothing is asked, and nothing warns", async () => {
    await withOwner({ taint: "observe" }, async (io) => {
      // The harness sets a mode; a workspace that sets nothing gets the shipped default.
      const repositories = io.owner.repositories();
      const current = await repositories.workspaceSettings.get("default");
      const { securityTaint: _set, ...rest } = current.settings;
      await repositories.workspaceSettings.set({
        workspaceId: "default",
        settings: rest,
        expectedRevision: current.revision,
        actor: "operator:cli",
        now: nowTimestamp(),
      });

      const run = await runOwnerFixture(io, fixture, "obedient");
      expect(run.gate).toBe("ask");
      expect(run.round?.gateReason).toBe("tainted-payload");
      const doctor = await buildDoctorDocument(io.owner.handle.runtime, { integrity: "skip" });
      const taint = doctor["taint"] as { readonly mode: string; readonly warning?: string };
      expect(taint.mode).toBe("enforce");
      expect(taint.warning).toBeUndefined();
      expect(await weakTaintWorkspaces(io.owner.handle.runtime)).toEqual([]);
    });
  }, 60_000);

  it("observe, set explicitly: the call is decided as before, the would-be ask is recorded, and doctor and serve warn", async () => {
    await withOwner({ taint: "observe" }, async (io) => {
      const repositories = io.owner.repositories();
      const run = await runOwnerFixture(io, fixture, "obedient");
      expect(run.gate).toBe("allow");
      expect(run.round).toBeUndefined();
      const summary = await repositories.toolPolicy.summarizeGateObservations(SINCE, 5);
      expect(summary.topTools.map((tool) => tool.toolId)).toContain("http.request");
      expect(summary.unasked).toBeGreaterThanOrEqual(1);

      // Doctor counts them: "taint would have asked …" under observe, and warns.
      const doctor = await buildDoctorDocument(io.owner.handle.runtime, { integrity: "skip" });
      const taint = doctor["taint"] as { readonly mode: string; readonly calls: number; readonly line: string; readonly warning?: string };
      expect(taint.mode).toBe("observe");
      expect(taint.calls).toBe(summary.calls);
      expect(taint.line).toMatch(
        new RegExp(`^taint would have asked ${summary.calls} calls? in 7 days \\(top tools .*http\\.request \\d+`),
      );
      expect(taint.warning).toContain("tavi permissions taint enforce");
      // What serve logs at start.
      expect(await weakTaintWorkspaces(io.owner.handle.runtime)).toEqual([
        expect.objectContaining({ workspaceId: "default", mode: "observe", warning: expect.stringContaining("security.taint is observe") }),
      ]);
    });
  }, 60_000);

  it("enforce asks once, with the taint reason, and records the ask", async () => {
    await withOwner({ taint: "enforce" }, async (io) => {
      const run = await runOwnerFixture(io, fixture, "obedient");
      expect(run.gate).toBe("ask");
      expect(run.round?.gateReason).toBe("tainted-payload");
      expect(run.round?.allowedScopes).toEqual(["once"]);
      const summary = await io.owner.repositories().toolPolicy.summarizeGateObservations(SINCE, 5);
      expect(summary.topTools.map((tool) => tool.toolId)).toContain("http.request");
      const doctor = await buildDoctorDocument(io.owner.handle.runtime, { integrity: "skip" });
      expect((doctor["taint"] as { readonly line: string }).line).toMatch(/^taint asked \d+ calls? in 7 days/);
    });
  }, 60_000);

  it("off neither asks nor records", async () => {
    await withOwner({ taint: "off" }, async (io) => {
      const run = await runOwnerFixture(io, fixture, "obedient");
      expect(run.gate).toBe("allow");
      expect((await io.owner.repositories().toolPolicy.summarizeGateObservations(SINCE, 5)).calls).toBe(0);
      const doctor = await buildDoctorDocument(io.owner.handle.runtime, { integrity: "skip" });
      expect(doctor["taint"]).toMatchObject({ mode: "off", calls: 0, warning: expect.stringContaining("off is deprecated") });
    });
  }, 60_000);

  it("serve --taint-policy overrides the workspace's setting, both ways", async () => {
    await withOwner({ taint: "observe", runtime: { taintPolicy: "enforce" } }, async (io) => {
      const run = await runOwnerFixture(io, fixture, "obedient");
      expect(run.gate).toBe("ask");
      expect(run.round?.gateReason).toBe("tainted-payload");
      const doctor = await buildDoctorDocument(io.owner.handle.runtime, { integrity: "skip" });
      expect(doctor["taint"]).toMatchObject({ mode: "enforce", via: "serve --taint-policy" });
    });
    await withOwner({ taint: "enforce", runtime: { taintPolicy: "observe" } }, async (io) => {
      const run = await runOwnerFixture(io, fixture, "obedient");
      expect(run.gate).toBe("allow");
      expect((await io.owner.repositories().toolPolicy.summarizeGateObservations(SINCE, 5)).calls).toBeGreaterThanOrEqual(1);
    });
  }, 120_000);

  it("enforces when the taint mode's settings read fails", async () => {
    await withOwner({ taint: "observe" }, async (io) => {
      const settings = io.owner.repositories().workspaceSettings;
      const get = settings.get;
      // Only the gate's read fails: the rest of the turn reads the settings as usual.
      settings.get = async (...args) => {
        if (new Error().stack?.includes("taintMode") === true) throw new Error("settings unreadable");
        return await get.apply(settings, args);
      };
      try {
        const run = await runOwnerFixture(io, fixture, "obedient");
        expect(run.gate).toBe("ask");
        expect(run.round?.gateReason).toBe("tainted-payload");
      } finally {
        settings.get = get;
      }
    });
  }, 60_000);

  it("the owner's hourly sweep prunes observations past 30 days and keeps the rest", async () => {
    await withOwner({ runtime: { grantSweepEnabled: true, grantSweepIntervalMs: 50 } }, async (io) => {
      const policy = io.owner.repositories().toolPolicy;
      const base = {
        taskId: "task-old",
        toolId: "http.request",
        effect: "external",
        sink: "network",
        decisionEnforced: "allow",
        decisionObserved: "ask",
        gateReason: "tainted-payload",
      } as const;
      await policy.recordGateObservation({ ...base, callId: "old", createdAt: new Date(Date.now() - 31 * 86_400_000).toISOString() });
      await policy.recordGateObservation({ ...base, callId: "fresh", createdAt: nowTimestamp() });
      const deadline = Date.now() + 5_000;
      while ((await policy.summarizeGateObservations(SINCE, 5)).calls > 1 && Date.now() < deadline) await delay(50);
      expect(await policy.summarizeGateObservations(SINCE, 5)).toMatchObject({ calls: 1, tasks: 1 });
      expect(await policy.summarizeGateObservations(new Date(Date.now() - 86_400_000).toISOString(), 5)).toMatchObject({ calls: 1 });
    });
  }, 60_000);
});
