import { initialRunState, type RunState } from "@tavi/client/browser";
import { describe, expect, it } from "vitest";

import { announcementOf } from "../../../src/features/shell/a11y.js";
import { shellState } from "../../../src/features/shell/shell.js";
import type { CanvasRun, CanvasState } from "../../../src/features/chat/store/types.js";

/**
 * What the page says out loud: discrete events only,
 * never tokens, and one sentence whose subject is the session the reader is
 * looking at — the same one the chords act on.
 */

const run = (state: Partial<RunState>, extra: Partial<CanvasRun> = {}): CanvasRun => ({
  id: "ui-1",
  prompt: "p",
  run: { ...initialRunState(), taskId: "task-1", ...state },
  roundCalls: {},
  deciding: undefined,
  aborting: false,
  ...extra,
});

/** What the page would say about `state`, with the newest session in front of the reader. */
const said = (state: CanvasState, selected?: string, notice?: string): string | undefined => {
  const shell = shellState(state, selected);
  return announcementOf({ state, current: shell.current, needs: shell.needs, notice });
};
const ready = (...runs: CanvasRun[]): CanvasState => ({ connection: "ready", runs });
/** The sentence opens with `head`: the status comes first, then the standing clauses. */
const opens = (sentence: string | undefined, head: string): boolean => sentence?.startsWith(head) === true;

describe("what the page announces", () => {
  it("says nothing before there is anything to say", () => {
    expect(said(ready())).toBeUndefined();
  });

  it("names each discrete event a reader acts on, and no token of the stream", () => {
    expect(
      opens(
        said(
          ready(run({ status: "running", transcript: [{ kind: "text", key: "t", attemptId: "a", blockId: "b", text: "half an answer" }] })),
        ),
        "Responding.",
      ),
    ).toBe(true);
    // The streamed text itself is never in the announcement.
    expect(
      said(
        ready(run({ status: "running", transcript: [{ kind: "text", key: "t", attemptId: "a", blockId: "b", text: "half an answer" }] })),
      ),
    ).not.toContain("half an answer");
    expect(opens(said(ready(run({ status: "idle" }))), "Sent; waiting for the owner.")).toBe(true);
    expect(opens(said(ready(run({ status: "completed", outcome: { kind: "completed", finalText: "done" } }))), "Complete.")).toBe(true);
    expect(said(ready(run({ status: "failed", outcome: { kind: "failed", errorCode: "PROVIDER", message: "the model is down" } })))).toBe(
      "Failed: the model is down",
    );

    expect(said(ready(run({ status: "failed", outcome: { kind: "failed", errorCode: "CANCELLED", message: "qa" } })))).toBe(
      "This was cancelled: qa.",
    );
    expect(said(ready(run({ status: "unknown" })))).toContain("not known here");
  });

  it("distinguishes the three things that need the reader", () => {
    expect(
      opens(
        said(
          ready(run({ status: "waiting", waiting: { on: "a reply", deadlineAt: "2026-09-20T00:00:00.000Z", question: "Which folder?" } })),
        ),
        "A question is waiting: Which folder?",
      ),
    ).toBe(true);
    // A worker or peer wait no attached operator can answer says what it is on.
    expect(
      opens(
        said(ready(run({ status: "waiting", waiting: { on: "worker task w-1 completing", deadlineAt: "2026-09-20T00:00:00.000Z" } }))),
        "Waiting on worker task w-1 completing.",
      ),
    ).toBe(true);
    expect(
      opens(
        said(
          ready(run({ status: "review_required", review: { steps: 2, requests: [{ artifactId: "a1", toolName: "t", callId: "c1" }] } })),
        ),
        "1 archived output waits for review.",
      ),
    ).toBe(true);
    expect(
      said(
        ready(
          run({
            status: "review_required",
            review: {
              steps: 2,
              requests: [
                { artifactId: "a1", toolName: "t", callId: "c1" },
                { artifactId: "a2", toolName: "t", callId: "c2" },
              ],
            },
          }),
        ),
      ),
    ).toContain("2 archived outputs wait for review.");
    expect(
      said(
        ready(
          run({
            status: "awaiting_approval",
            pending: [
              { taskId: "task-1", steps: 1, requests: [{ callId: "c1", toolName: "t", summary: "s", input: {}, approvalId: "a" }] },
            ],
          }),
        ),
      ),
    ).toContain("Permission required for 1 tool call.");
  });

  it("says the connection before anything about the task, since nothing else is actionable", () => {
    expect(opens(said({ connection: "reconnecting", runs: [run({ status: "running" })] }), "Reconnecting to the owner.")).toBe(true);
    expect(opens(said({ connection: "closed", runs: [] }), "Disconnected from the owner.")).toBe(true);
    expect(said({ connection: "closed", failure: "the bridge refused this page's session", runs: [] })).toContain("the bridge refused");
  });

  it("carries how many sessions are waiting, since the header's count is not a region of its own", () => {
    const waiting = (taskId: string) => ({
      ...run({ status: "waiting", waiting: { on: "a reply", deadlineAt: "2026-09-20T00:00:00.000Z" } }, { id: `ui-${taskId}` }),
      run: { ...run({ status: "waiting", waiting: { on: "a reply", deadlineAt: "2026-09-20T00:00:00.000Z" } }).run, taskId },
    });
    expect(said(ready(waiting("task-1")))).toContain("1 chat needs you.");
    expect(said(ready(waiting("task-1"), waiting("task-2")))).toContain("2 chats need you.");
    expect(said(ready(run({ status: "running" })))).not.toContain("needs you");
  });

  it("says where a prompt just sent went: queued behind the turn, or into Home", () => {
    const done = run({ status: "completed", outcome: { kind: "completed", finalText: "done" } });
    // Nothing about the next prompt: the composer's placeholder says who it goes to.
    expect(said({ connection: "ready", runs: [done], continuing: "task-1" })).toBe("Complete.");
    expect(said(ready(run({ status: "running" })))).toBe("Responding.");
    // Typed while the turn runs: queued behind it.
    const queued = run({ status: "idle" }, { id: "ui-q", continues: "task-1", queued: true });
    expect(said(ready(run({ status: "running" }), queued))).toBe("Queued after the current turn.");
    // Sent into Home: said until its turn speaks.
    const home = run({ status: "idle", taskId: undefined }, { id: "ui-h", toHome: true });
    expect(said(ready(home))).toBe("Sent to Home.");
    expect(said(ready({ ...home, run: { ...home.run, status: "running", taskId: "home-1" } }))).toBe("Responding.");
    for (const sentence of [said(ready(queued)), said(ready(home))]) expect(sentence).not.toMatch(/next prompt|new task|session/);
  });

  it("describes the session the reader is looking at, which is the one the chords act on", () => {
    const browsed = {
      ...run(
        {
          status: "awaiting_approval",
          pending: [{ taskId: "task-1", steps: 1, requests: [{ callId: "c1", toolName: "t", summary: "s", input: {}, approvalId: "a" }] }],
        },
        { id: "ui-1" },
      ),
    };
    const newest = { ...run({ status: "running" }, { id: "ui-2" }), run: { ...run({ status: "running" }).run, taskId: "task-2" } };
    // Not "Responding.": the card in front of the reader is the one waiting.
    expect(said({ connection: "ready", runs: [browsed, newest] }, "task-1")).toContain("Permission required for 1 tool call.");
  });
});

it("announces a capped inbox as a lower bound", () => {
  expect(
    announcementOf({
      state: { connection: "ready", runs: [], directory: { rows: [], needs: [], loading: false, needsTruncated: true } },
      current: undefined,
      needs: 128,
    }),
  ).toBe("At least 128 chats need you.");
});

it("says a page the address named and the page could not open, through the one region", () => {
  const notice = "Chat gone could not be opened: Chat not found in this workspace. Showing this page's chats instead.";
  // Nothing else to say: the failure is the sentence.
  expect(said(ready(), undefined, notice)).toBe(notice);
  // Said first, because it is why the page is not the one that was asked for.
  expect(said(ready(run({ status: "running" })), undefined, notice)).toBe(`${notice} Responding.`);
  // An empty notice is not a sentence, and an absent one changes nothing.
  expect(said(ready(), undefined, "")).toBeUndefined();
  expect(said(ready(run({ status: "idle" })))).toBe("Sent; waiting for the owner.");
});

it("says what waits in the Command Center in place of this page's sessions, and a reminder as it fires", () => {
  const state = ready(run({ status: "awaiting_approval" }));
  const shell = shellState(state, undefined);
  const withCenter = (waiting: number, reminders: readonly string[] = []) =>
    announcementOf({ state, current: undefined, needs: shell.needs, center: { waiting, reminders } });
  // The page's own session needs the reader, but the Center's count is what is said.
  expect(shell.needs).toBe(1);
  expect(withCenter(4)).toBe("4 things are waiting on you.");
  expect(withCenter(1)).toBe("1 thing is waiting on you.");
  expect(withCenter(0)).toBeUndefined();
  // A reminder fired is said by its text, before the count.
  expect(withCenter(2, ["Take your pills", "Stretch"])).toBe("Reminder: Take your pills. Reminder: Stretch. 2 things are waiting on you.");
});

it("says once more when a waiting question's last five minutes begin", () => {
  const deadline = Date.parse("2026-10-02T14:30:00.000Z");
  const state = ready(
    run({ status: "waiting", waiting: { on: "its deadline", deadlineAt: "2026-10-02T14:30:00.000Z", question: "Ship?" } }),
  );
  const shell = shellState(state, undefined);
  const at = (now: number) => announcementOf({ state, current: shell.current, needs: 0, now });
  expect(at(deadline - 20 * 60_000)).toMatch(/^A question is waiting: Ship\?/);
  expect(at(deadline - 4 * 60_000)).toMatch(/^Five minutes or less left to answer: Ship\?/);
});
