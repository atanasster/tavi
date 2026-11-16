// @vitest-environment jsdom
import { initialRunState, type RunState, type TranscriptEntry } from "@tavi/client/browser";
import type { ChatNotice } from "@tavi/contracts";
import { describe, expect, it, vi } from "vitest";

import { Canvas, turnFacts } from "../../../src/features/chat/Canvas.js";
import { epochDividersByRun, noticesByRun } from "../../../src/features/chat/Notices.js";
import { earlierPlanSource } from "../../../src/features/chat/plan.js";
import { chatPluginStatus } from "../../../src/features/chat/store/runs.js";
import type { CanvasRun, CanvasState } from "../../../src/features/chat/store/types.js";
import { sessionsOf } from "../../../src/features/shell/shell.js";
import { mount, rerender } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

/**
 * The canvas's derived lists — where notices and epoch dividers fall among the
 * turns, the plugins' status lines — are worked out when the turns change,
 * never again on a repaint that left them as they were.
 */

vi.mock("../../../src/features/chat/Notices.js", async (original) => {
  const actual = await original<typeof import("../../../src/features/chat/Notices.js")>();
  return { ...actual, epochDividersByRun: vi.fn(actual.epochDividersByRun), noticesByRun: vi.fn(actual.noticesByRun) };
});
vi.mock("../../../src/features/chat/store/runs.js", async (original) => {
  const actual = await original<typeof import("../../../src/features/chat/store/runs.js")>();
  return { ...actual, chatPluginStatus: vi.fn(actual.chatPluginStatus) };
});

const noop = () => undefined;
const NO_NOTICES: readonly ChatNotice[] = [];
const run = (id: string, prompt: string, extra: Partial<CanvasRun> = {}): CanvasRun => ({
  id,
  prompt,
  run: { ...initialRunState({ taskId: "task-1" }), status: "completed" },
  roundCalls: {},
  deciding: undefined,
  aborting: false,
  ...extra,
});

describe("the canvas's derived lists", () => {
  it("are not worked out again on a repaint that leaves the turns as they were, and are when the turns change", async () => {
    const state: CanvasState = { connection: "ready", runs: [run("ui-1", "first"), run("ui-2", "second", { continues: "task-1" })] };
    const session = sessionsOf(state.runs).at(-1);
    const view = (modelNotice: string | undefined, shown = state, chat = session) => (
      <InWorkspace>
        <Canvas
          state={shown}
          session={chat}
          modelNotice={modelNotice}
          notices={NO_NOTICES}
          onSubmit={noop}
          onDecide={noop}
          onAbort={noop}
          onExpand={noop}
          onRewind={async () => ({ ok: false, message: "no" })}
        />
      </InWorkspace>
    );
    const calls = () => [epochDividersByRun, noticesByRun, chatPluginStatus].map((fn) => vi.mocked(fn).mock.calls.length);
    const host = await mount(view(undefined));
    const first = calls();
    expect(
      first.every((count) => count > 0),
      "the lists were never worked out",
    ).toBe(true);
    const html = host.querySelector(".runs")?.innerHTML;

    // An unrelated repaint: a notice under the chat, the turns untouched.
    await rerender(view("Restart to use the new model."));
    expect(calls()).toEqual(first);
    expect(host.querySelector(".runs")?.innerHTML).toBe(html);
    expect(host.textContent).toContain("Restart to use the new model.");

    // A turn more: worked out again, once.
    const grown: CanvasState = { ...state, runs: [...state.runs, run("ui-3", "third", { continues: "task-1" })] };
    await rerender(view("Restart to use the new model.", grown, sessionsOf(grown.runs).at(-1)));
    expect(calls()).toEqual(first.map((count) => count + 1));
    expect(host.querySelector(".runs")?.textContent).toContain("third");
  });
});

/** The per-turn scans `turnFacts` replaced, as they were: the answers it must give. */
const before = {
  steerable(turn: CanvasRun, runs: readonly CanvasRun[]): boolean {
    if (turn.queued !== true || turn.continues === undefined || turn.carriesFiles === true) return false;
    if (runs.some((other) => other.queued === true && other.steering === "sending")) return false;
    return runs.some(
      (other) =>
        other.queued !== true &&
        (other.run.taskId === turn.continues || other.continues === turn.continues) &&
        other.run.status === "running" &&
        !other.aborting,
    );
  },
  awaitsDecision(taskId: string | undefined, runs: readonly CanvasRun[]): boolean {
    if (taskId === undefined) return false;
    return runs.some(
      (other) =>
        other.queued !== true &&
        (other.run.taskId === taskId || other.continues === taskId) &&
        (other.run.status === "awaiting_approval" || other.run.status === "review_required"),
    );
  },
};

describe("what each turn is offered beside its own state", () => {
  it("is what the per-turn scans it replaced gave, for every mix of turns", () => {
    const planned: readonly TranscriptEntry[] = [
      {
        kind: "tool",
        key: "c1",
        attemptId: "a",
        callId: "c1",
        toolName: "plan.update",
        input: { items: [{ content: "a", status: "pending" }] },
        status: "completed",
      },
    ];
    const statuses: readonly RunState["status"][] = ["running", "awaiting_approval", "review_required", "waiting", "completed", "failed"];
    const chats = [undefined, "task-1", "task-2"] as const;
    // A fixed-seed generator, so a failure names a list that can be found again.
    let seed = 7;
    const pick = <T,>(choices: readonly T[]): T => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return choices[(seed >>> 16) % choices.length] as T;
    };
    for (let list = 0; list < 2_000; list += 1) {
      const runs: CanvasRun[] = Array.from({ length: pick([0, 1, 2, 3, 4, 5, 6]) }, (_, index) => {
        const taskId = pick(chats);
        const continues = pick(chats);
        const steering = pick([undefined, "sending", "sent"] as const);
        return {
          id: `ui-${index}`,
          prompt: pick(["", "words"]),
          run: { ...initialRunState(taskId === undefined ? {} : { taskId }), status: pick(statuses), transcript: pick([[], planned]) },
          roundCalls: {},
          deciding: undefined,
          aborting: pick([false, true]),
          ...(pick([false, true]) ? { queued: true } : {}),
          ...(continues === undefined ? {} : { continues }),
          ...(steering === undefined ? {} : { steering }),
          ...(pick([false, false, true]) ? { carriesFiles: true as const } : {}),
        };
      });
      const facts = turnFacts(runs);
      const label = `list ${list}: ${JSON.stringify(runs.map(({ id, prompt, queued, continues, steering, carriesFiles, aborting, run: { taskId, status, transcript } }) => ({ id, prompt, queued, continues, steering, carriesFiles, aborting, taskId, status, plan: transcript.length > 0 })))}`;
      expect(facts, label).toEqual({
        rewindLater: runs.map((_, index) => runs.slice(index + 1).filter((later) => later.prompt !== "").length),
        steerable: runs.map((turn) => before.steerable(turn, runs)),
        awaitsDecision: runs.map((turn) => turn.queued === true && before.awaitsDecision(turn.continues, runs)),
        earlierPlan: runs.map((turn, index) => (turn.run.status === "running" ? earlierPlanSource(runs, index) : undefined)),
      });
    }
  });
});
