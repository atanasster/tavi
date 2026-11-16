import { nextHeartbeatAt, type HeartbeatGetAnswer } from "@tavi/contracts";
import { until, delay } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EXCLUDED_MEMORY,
  HEARTBEAT_SWEEP_MS,
  OPERATOR,
  hhmm,
  hoursAroundNow,
  promptOf,
  seedHome,
  seedMemory,
  startHeartbeatOwner,
  type HeartbeatOwner,
} from "../support/heartbeat-owner.js";

/**
 * The heartbeat end to end over IPC (the companion of the browser test, in
 * the default suite): a real owner on a
 * 1 s interval floor, driven through the `heartbeat` command as the canvas
 * drives it. It turns on and ticks, changes its interval and ticks to the new
 * one, gives its turn exactly the person's own memory (and a corrected fact's
 * new revision), tells an item in Home and hears the person's feedback on the
 * next check, stays quiet outside its hours and while paused, and refuses
 * Check now while paused. Waits are bounded polls with room for a loaded
 * suite, so timing is held only from below; the two quiet stretches outlast a
 * whole interval, to show nothing ran when a check would have come due.
 */

let owner: HeartbeatOwner | undefined;
const the = (): HeartbeatOwner => {
  if (owner === undefined) throw new Error("no owner");
  return owner;
};

async function beat(payload: Record<string, unknown>): Promise<unknown> {
  const answer = await the().client.request(
    "heartbeat",
    { workspaceId: "default", ...payload },
    `hb-${Math.random().toString(36).slice(2)}`,
  );
  if (!answer.ok) throw Object.assign(new Error(answer.error?.message ?? "refused"), { code: answer.error?.code });
  return answer.result;
}

const pause = (ms: number) => delay(ms);

beforeAll(async () => {
  owner = await startHeartbeatOwner("tavi-heartbeat-flow-");
}, 60_000);

afterAll(async () => {
  await owner?.close();
});

describe("the heartbeat end to end over IPC", () => {
  it("turns on at every 2 s and ticks, then at every 4 s ticks 4 s apart", async () => {
    const { ticks } = the();
    const options = (await beat({ action: "options" })) as { every: number[]; deepCheckEvery: number[] };
    expect(options.every.slice(0, 2)).toEqual([2_000, 4_000]);
    const on = (await beat({
      action: "set",
      changes: {
        enabled: true,
        everyMs: 2_000,
        deepCheckEveryMs: 4_000,
        activeHours: hoursAroundNow(),
        model: { connectionId: "fixture", model: "fixture-model" },
      },
    })) as HeartbeatGetAnswer;
    expect(on.revision).toBe(1);
    await beat({ action: "set-instructions", text: "Tell me if an ACME invoice payment fails" });
    await until(ticks, (rows) => rows.some((row) => row.wakeReason === "interval"));
    // Every 4 s: the next tick is placed at once, and two ticks come at least 4 s apart.
    const before = Date.now();
    const four = (await beat({ action: "set", changes: { everyMs: 4_000 } })) as HeartbeatGetAnswer;
    const after = Date.now();
    const next = Date.parse(four.state?.nextTickAt ?? "");
    expect(next).toBeGreaterThan(before);
    expect(next).toBeLessThanOrEqual(after + 4_000);
    // On the new 4 s schedule (the owner seeds the jitter with the principal), not the 2 s one it replaced.
    expect(nextHeartbeatAt(four.config, "UTC", new Date(next - 1), "operator").getTime()).toBe(next);
    const intervals = (rows: Awaited<ReturnType<typeof ticks>>) => rows.filter((row) => row.wakeReason === "interval");
    const marked = intervals(await ticks()).length;
    const [second, first] = intervals(await until(ticks, (rows) => intervals(rows).length >= marked + 2));
    // A tick is written once it has run (`createdAt`, after `durationMs`): the schedule places starts, so starts are compared.
    const started = (tick: typeof first) => Date.parse(tick?.createdAt ?? "") - (tick?.durationMs ?? 0);
    expect(started(second) - started(first)).toBeGreaterThanOrEqual(4_000 - HEARTBEAT_SWEEP_MS);
  }, 60_000);

  it("gives its turn exactly the person's own memory, and a corrected fact's new revision and words", async () => {
    const { ticks, requests, handle } = the();
    const records = await seedMemory(the());
    const freshDeep = async (seen: ReadonlySet<string>) =>
      (await until(ticks, (rows) => rows.some((row) => !seen.has(row.tickId) && row.kind === "deep" && row.outcome !== "skipped"))).find(
        (row) => !seen.has(row.tickId) && row.kind === "deep" && row.outcome !== "skipped",
      );
    const deep = await freshDeep(new Set((await ticks()).map((row) => row.tickId)));
    const used = (deep?.inputs as { memory?: { recordId: string; revisionId: string }[] } | null)?.memory ?? [];
    expect(used.map((record) => record.recordId).sort()).toEqual([records.preference, records.fact].sort());
    const prompt = promptOf(requests.at(-1));
    expect(prompt).toContain('<untrusted source="memory">');
    // A record reaches a turn as memory search's excerpt, as in every turn: a body this short whole.
    expect(prompt).toContain("[fact] ACME pays invoices late but always pays");
    expect(prompt).toContain("tone: short");
    for (const excluded of EXCLUDED_MEMORY) expect(prompt).not.toContain(excluded);
    // Memory invariant 20: the host's block is its only automatic memory, never a manifest.
    expect(prompt).not.toContain("Known preferences");
    expect(prompt).not.toContain("Retrieved memory evidence");
    // Corrected, the next deep tick reads its new revision and its new words, under its title.
    const before = used.find((record) => record.recordId === records.fact)?.revisionId;
    await handle.runtime.memory.correct({
      actor: OPERATOR,
      recordId: records.fact,
      title: "ACME payments",
      body: "ACME now pays invoices on time",
    });
    const next = await freshDeep(new Set((await ticks()).map((row) => row.tickId)));
    const revised = (next?.inputs as { memory?: { recordId: string; revisionId: string }[] } | null)?.memory?.find(
      (record) => record.recordId === records.fact,
    )?.revisionId;
    expect(revised).toBeDefined();
    expect(revised).not.toBe(before);
    // A titled record reads as a turn reads it: `<title> — <excerpt>`.
    expect(promptOf(requests.at(-1))).toContain("[fact] ACME payments — ACME now pays invoices on time");
  }, 60_000);

  it("memory invariant 13: paused memory gives the next tick no memory block, and resuming restores it", async () => {
    const { ticks, requests, client } = the();
    const setMemory = async (section: Record<string, unknown>): Promise<void> => {
      const answer = await client.request(
        "workspace-settings",
        { action: "set", workspaceId: "default", key: "memory", value: JSON.stringify(section) },
        `ws-${Math.random().toString(36).slice(2)}`,
      );
      if (!answer.ok) throw new Error(answer.error?.message ?? "refused");
    };
    const freshDeep = async () => {
      const seen = new Set((await ticks()).map((row) => row.tickId));
      return (
        await until(ticks, (rows) => rows.some((row) => !seen.has(row.tickId) && row.kind === "deep" && row.outcome !== "skipped"))
      ).find((row) => !seen.has(row.tickId) && row.kind === "deep" && row.outcome !== "skipped");
    };
    const memoryOf = (row: Awaited<ReturnType<typeof freshDeep>>) =>
      ((row?.inputs as { memory?: { recordId: string }[] } | null)?.memory ?? []).map((record) => record.recordId).sort();
    // The person's memory from the earlier test reaches a tick while memory is on.
    const before = memoryOf(await freshDeep());
    expect(before.length).toBeGreaterThan(0);
    await setMemory({ enabled: false });
    try {
      expect(memoryOf(await freshDeep())).toEqual([]);
      expect(promptOf(requests.at(-1))).not.toContain('<untrusted source="memory">');
    } finally {
      await setMemory({});
    }
    // Resumed, the same records come back: pausing deleted nothing.
    expect(memoryOf(await freshDeep())).toEqual(before);
  }, 60_000);

  it("tells an item in Home, and the next check hears the person's Not useful; muted, it is not told again", async () => {
    const { repositories, requests, handle } = the();
    const home = await seedHome(the());
    expect(await repositories().tasks.homeOf("default", "operator")).toBe(home);
    the().report([
      {
        key: "billing:invoice:1042",
        urgency: "now",
        title: "ACME invoice 1042 failed",
        sources: [{ label: "Billing" }],
        instructionLine: 1,
      },
    ]);
    const item = await until(
      async () =>
        (
          await repositories().heartbeats.ledgerRows({ workspaceId: "default", principalId: "operator", keys: ["billing:invoice:1042"] })
        )[0],
      (row) => row !== undefined,
    );
    const notices = await until(
      async () => await repositories().transcripts.notices(home, { limit: 50 }),
      (rows) => rows.some((notice) => notice.heartbeatItemId === item?.itemId),
    );
    expect(notices.find((notice) => notice.heartbeatItemId === item?.itemId)).toMatchObject({
      kind: "heartbeat",
      title: "ACME invoice 1042 failed",
      summary: "Billing · instruction line 1",
    });
    await beat({ action: "items", itemId: item?.itemId, op: "feedback", feedback: "down" });
    const asked = requests.length;
    await until(
      async () => requests.slice(asked).map(promptOf),
      (prompts) => prompts.some((prompt) => prompt.includes('"feedback":"down"')),
    );
    await beat({ action: "items", itemId: item?.itemId, op: "mute" });
    the().report([
      { key: "billing:invoice:1042", urgency: "now", title: "ACME invoice 1042 failed again", sources: [{ label: "Billing" }] },
    ]);
    const told = (
      await repositories().heartbeats.ledgerRow({ workspaceId: "default", principalId: "operator", itemId: item?.itemId ?? "" })
    )?.lastToldAt;
    await until(
      async () => the().reportPending(),
      (pending) => !pending,
    );
    await handle.runtime.heartbeat.host()?.idle();
    const after = await repositories().heartbeats.ledgerRow({
      workspaceId: "default",
      principalId: "operator",
      itemId: item?.itemId ?? "",
    });
    expect(after).toMatchObject({ state: "muted", lastToldAt: told });
  }, 60_000);

  it("quiet outside its hours and while paused, Check now refused while paused, and a tick soon after Resume", async () => {
    const { ticks } = the();
    const now = Date.now();
    await beat({
      action: "set",
      changes: { activeHours: { start: hhmm(new Date(now + 2 * 60 * 60_000)), end: hhmm(new Date(now + 3 * 60 * 60_000)) } },
    });
    const marked = (await ticks()).length;
    // Past a whole interval (4 s) and then some: a check that came due would have run.
    await pause(4_000 + 3 * HEARTBEAT_SWEEP_MS);
    const excluded = await ticks();
    expect(excluded.slice(0, excluded.length - marked).filter((row) => row.kind === "signal" || row.kind === "deep")).toEqual([]);
    // Hours back around now: it ticks again. (The closed-window row comes when a later window opens — minutes away
    // at the hours' granularity, so heartbeat-host.test.ts holds it to an injected clock.)
    await beat({ action: "set", changes: { activeHours: hoursAroundNow() } });
    const restored = (await ticks()).length;
    await until(ticks, (rows) => rows.length > restored);
    // Paused: nothing runs, and Check now is refused with why.
    await beat({ action: "pause" });
    const paused = (await ticks()).length;
    await expect(beat({ action: "run-now" })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("paused") });
    await pause(4_000 + 3 * HEARTBEAT_SWEEP_MS);
    expect((await ticks()).length).toBe(paused);
    // Resumed: it ticks again, and Check now runs a manual deep look.
    await beat({ action: "resume" });
    await until(ticks, (rows) => rows.length > paused);
    expect(await beat({ action: "run-now" })).toMatchObject({ status: expect.stringMatching(/started|queued/) });
    await until(ticks, (rows) => rows.some((row) => row.wakeReason === "manual" && row.kind === "deep"));
  }, 60_000);
});
