import { fireSchedule, runScheduleNow } from "@tavi/agent-host/schedule-scheduler";
import type { ModelEvent, ModelOutcome, ModelPort, ModelRequest } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { temporaryDirectories, waitFor } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { composeTaviRuntime } from "../../src/runtime/composition.js";
import { fixtureRuntimeOptions, fixtureServeOptions } from "../support/serve-fixture.js";

/**
 * A schedule's run that spawns workers side by side and waits on them,
 * through the composed owner: the workers' gated calls are answered by the
 * schedule's tool list, the run is "waiting on a worker" rather than failed
 * while it waits, the schedule stays in flight meanwhile, and its real outcome
 * is recorded once the run carries on and ends.
 */

const directories = temporaryDirectories({ prefix: "tavi-schedule-workers-" });

afterEach(() => directories.cleanup());

const userTexts = (request: ModelRequest): string[] =>
  request.messages.filter((message) => message.role === "user").map((message) => message.text);

/** The ids of the tools whose results the request carries, in order. */
const resultsOf = (request: ModelRequest): string[] =>
  request.messages.filter((message) => message.role === "tool").map((message) => message.toolName ?? "");

const workerIdsIn = (request: ModelRequest): string[] =>
  [...JSON.stringify(request.messages).matchAll(/workerTaskId\\*":\\*"([^"\\]+)/g)].map((match) => match[1] ?? "");

/**
 * The root spawns two researchers at once, then waits on each; a researcher
 * notes its finding with a gated tool, held until `release` opens, and answers.
 */
function orchestratingModel(release: Promise<void>): ModelPort {
  const answer = (request: ModelRequest, options: { readonly onEvent: (event: ModelEvent) => void }, text: string): ModelOutcome => {
    options.onEvent({ type: "text.delta", attemptId: request.attemptId, blockId: "b", text });
    return { status: "completed", attemptId: request.attemptId, text, toolCalls: [], usage: {} };
  };
  const call = (request: ModelRequest, toolCalls: { id: string; name: string; input: unknown }[]): ModelOutcome => ({
    status: "completed",
    attemptId: request.attemptId,
    text: "",
    toolCalls: toolCalls.map((toolCall) => ({ ...toolCall, input: toolCall.input as Record<string, unknown> })),
    usage: {},
  });
  return {
    async stream(request, options) {
      const prompt = userTexts(request).join("\n");
      const results = resultsOf(request);
      const research = /research (alpha|beta)/.exec(prompt);
      if (research !== null) {
        if (!results.includes("fixture.note"))
          return call(request, [{ id: `note-${research[1]}`, name: "fixture.note", input: { text: research[1] } }]);
        await release;
        return answer(request, options, `${research[1]}-found`);
      }
      if (prompt.includes("orchestrate the brief")) {
        if (!results.includes("agents.spawn")) {
          return call(request, [
            {
              id: "spawn-alpha",
              name: "agents.spawn",
              input: { agentDefinitionId: "researcher", input: "research alpha", operationKey: "alpha" },
            },
            {
              id: "spawn-beta",
              name: "agents.spawn",
              input: { agentDefinitionId: "researcher", input: "research beta", operationKey: "beta" },
            },
          ]);
        }
        const waited = results.filter((result) => result === "agents.wait").length;
        const workers = [...new Set(workerIdsIn(request))];
        const next = workers[waited];
        if (waited < 2 && next !== undefined)
          return call(request, [
            {
              id: `wait-${waited}`,
              name: "agents.wait",
              input: { waitingOnWorkerTaskId: next, deadlineAt: new Date(Date.now() + 3_600_000).toISOString() },
            },
          ]);
        return answer(request, options, "brief: both found");
      }
      return answer(request, options, "ok");
    },
  };
}

/**
 * The root spawns one researcher and ends its turn without waiting on it; it
 * answers with the researcher's finding once it has read it. The researcher
 * answers once `release` opens.
 */
function unwaitingModel(release: Promise<void>): ModelPort {
  const reply = (request: ModelRequest, text: string, toolCalls: ModelOutcome["toolCalls"] = []): ModelOutcome => ({
    status: "completed",
    attemptId: request.attemptId,
    text,
    toolCalls,
    usage: {},
  });
  return {
    async stream(request) {
      const prompt = userTexts(request).join("\n");
      if (prompt.includes("research alpha")) {
        await release;
        return reply(request, "alpha-found");
      }
      if (!resultsOf(request).includes("agents.spawn"))
        return reply(request, "", [
          {
            id: "spawn-alpha",
            name: "agents.spawn",
            input: { agentDefinitionId: "researcher", input: "research alpha", operationKey: "alpha" },
          },
        ]);
      return reply(request, JSON.stringify(request.messages).includes("alpha-found") ? "brief: alpha-found" : "brief pending");
    },
  };
}

describe("a schedule whose run spawns workers and waits on them", () => {
  it("answers its workers' allowlisted gated calls, stays in flight while it waits, alerts only the fire it overlapped, and records its real outcome", async () => {
    let open: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      open = resolve;
    });
    const lines: string[] = [];
    const runtime = await composeTaviRuntime(
      fixtureRuntimeOptions(directories.create(), {
        logger: { level: "warn", sink: (line) => lines.push(line) },
        approvalRequiredFor: ["mutating"],
        agentWaitSweepIntervalMs: 60_000,
        // The test dispatches the due fire itself.
        scheduleSweepEnabled: false,
      }),
      { modelOverride: orchestratingModel(release) },
    );
    try {
      const noted: string[] = [];
      runtime.tools.register({
        id: "fixture.note",
        sink: "none",
        version: "1.0.0",
        description: "Note a finding",
        effect: "mutating",
        requiredPermissions: ["tools.invoke"],
        inputSchema: z.object({ text: z.string() }),
        handler: async ({ input }) => {
          noted.push((input as { text: string }).text);
          return { noted: true };
        },
      });
      const repositories = runtime.store.asPort().repositories;
      await repositories.agents.create({
        agentId: "researcher",
        workspaceId: "default",
        name: "researcher",
        systemPrompt: "Act as a researcher.",
        enabled: true,
        now: nowTimestamp(),
      });
      const schedule = await repositories.schedules.create({
        scheduleId: "sched-workers",
        workspaceId: "default",
        principalId: "operator",
        name: "Research brief",
        prompt: "orchestrate the brief",
        spec: { at: "07:00", timezone: "UTC" },
        missedRunPolicy: "skip",
        autoApproveTools: ["agents.*", "fixture.note"],
        enabled: true,
        // Due now, so a fire for it can be dispatched while the manual run waits.
        nextRunAt: new Date(Date.now() - 1_000).toISOString(),
        now: nowTimestamp(),
      });
      const scheduling = runtime.scheduleDependencies!;

      const fired = await runScheduleNow(schedule, scheduling);
      expect(fired).toMatchObject({ kind: "ran", status: "waiting" });
      const taskId = (fired as { readonly taskId: string }).taskId;
      expect((await repositories.schedules.get(schedule.scheduleId))?.lastOutcome).toBe(
        "manual run: waiting on a worker; goes on once it finishes",
      );
      // Both workers ran side by side, and each gated call was approved by the schedule's list.
      await waitFor(() => noted.length === 2, 10_000, { what: "both workers' gated calls to be approved" });
      expect(noted.sort()).toEqual(["alpha", "beta"]);

      // While it waits, the schedule is in flight: a fire due now is skipped as an overlap.
      expect(runtime.scheduleFires.hasSchedule(schedule.scheduleId)).toBe(true);
      expect(await fireSchedule(schedule, schedule.nextRunAt ?? "", scheduling)).toEqual({
        kind: "skipped",
        reason: "overlap",
      });

      open();
      await waitFor(async () => (await repositories.schedules.get(schedule.scheduleId))?.lastOutcome === "manual run: completed", 15_000, {
        what: "the run's real outcome",
      });
      const task = await repositories.tasks.get(taskId);
      expect(task).toMatchObject({ status: "completed", finalText: "brief: both found" });
      expect((await repositories.schedules.get(schedule.scheduleId))?.consecutiveFailures).toBe(0);
      await waitFor(() => !runtime.scheduleFires.hasSchedule(schedule.scheduleId), 5_000, { what: "the schedule to settle" });
      // Only the fire skipped while it waited is told, in a Home it starts; the run itself alerts nothing.
      expect(lines.filter((line) => line.includes("schedule alert") || line.includes("denied a tool call"))).toEqual([]);
      const home = await repositories.tasks.homeOf(schedule.workspaceId, schedule.principalId);
      const notices = await repositories.transcripts.notices(home ?? "", { limit: 10 });
      expect(notices.map((notice) => notice.summary)).toEqual([expect.stringContaining("did not start")]);
    } finally {
      await runtime.close();
    }
  });

  it("is not over when its turn ends before its worker answered: it is woken to read the result, and only then records its outcome", async () => {
    let open: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      open = resolve;
    });
    const runtime = await composeTaviRuntime(
      fixtureServeOptions(directories.create(), { approvalRequiredFor: ["mutating"], agentWaitSweepIntervalMs: 60_000 }),
      { modelOverride: unwaitingModel(release) },
    );
    try {
      const repositories = runtime.store.asPort().repositories;
      await repositories.agents.create({
        agentId: "researcher",
        workspaceId: "default",
        name: "researcher",
        systemPrompt: "Act as a researcher.",
        enabled: true,
        now: nowTimestamp(),
      });
      const schedule = await repositories.schedules.create({
        scheduleId: "sched-unwaiting",
        workspaceId: "default",
        principalId: "operator",
        name: "Unwaiting brief",
        prompt: "orchestrate without waiting",
        spec: { at: "07:00", timezone: "UTC" },
        missedRunPolicy: "skip",
        autoApproveTools: ["agents.*"],
        enabled: true,
        nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
        now: nowTimestamp(),
      });
      const fired = await runScheduleNow(schedule, runtime.scheduleDependencies!);
      expect(fired).toMatchObject({ kind: "ran", status: "completed", finalText: "brief pending" });
      expect((await repositories.schedules.get(schedule.scheduleId))?.lastOutcome).toBe(
        "manual run: waiting on a worker; goes on once it finishes",
      );
      expect(runtime.scheduleFires.hasSchedule(schedule.scheduleId)).toBe(true);

      open();
      await waitFor(async () => (await repositories.schedules.get(schedule.scheduleId))?.lastOutcome === "manual run: completed", 15_000, {
        what: "the run's outcome once it read its worker's result",
      });
      const taskId = (fired as { readonly taskId: string }).taskId;
      expect(await repositories.tasks.get(taskId)).toMatchObject({ status: "completed", finalText: "brief: alpha-found" });
      await waitFor(() => !runtime.scheduleFires.hasSchedule(schedule.scheduleId), 5_000, { what: "the schedule to settle" });
    } finally {
      await runtime.close();
    }
  });
});
