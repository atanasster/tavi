// @vitest-environment jsdom
import { initialRunState, type RecordedTask, type RunState } from "@tavi/client/browser";
import { CLIENT_PROTOCOL_VERSION, type AdmissionRecord, type ChatNotice } from "@tavi/contracts";
import { act, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  Activity,
  activityOf,
  foldDecisions,
  loadDecisions,
  revealTurn,
  revealWaiting,
  waitingOf,
  type RecordedDecision,
} from "../../../src/features/chat-panel/Activity.js";
import { firstTurnOf, matchTurns } from "../../../src/features/chat-panel/turns.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import type { Session } from "../../../src/features/shell/shell.js";
import type { CanvasRun, WorkerNeeds } from "../../../src/features/chat/store/types.js";
import { WorkerNeedCards } from "../../../src/features/workers/WorkerNeeds.js";
import { EpochDivider, NoticeCards, epochDividersByRun, noticesByRun } from "../../../src/features/chat/Notices.js";
import { InWorkspace } from "../../support/workspace.js";
import { flush, mountSettled, unmountAll } from "../../support/dom.js";

/** `node` mounted, and one microtask turn let run in an act: the view is drawn within it. */
const mount = (node: ReactNode) => mountSettled(node, () => flush(1, 0));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const admission = (
  id: string,
  kind: AdmissionRecord["kind"],
  at: string,
  prompt: string | undefined,
  state: AdmissionRecord["state"] = "committed",
  status: "completed" | "waiting" | "failed" = "completed",
): AdmissionRecord => ({
  admissionId: id,
  taskId: "task-1",
  operationKey: id,
  kind,
  intent: prompt === undefined ? {} : { prompt },
  intentHash: "h",
  state,
  result: state === "committed" ? { status, finalText: "" } : null,
  createdAt: at,
  updatedAt: at,
});

const canvasRun = (id: string, prompt: string, state: Partial<RunState> = {}, extra: Partial<CanvasRun> = {}): CanvasRun => ({
  id,
  prompt,
  run: { ...initialRunState(), taskId: "task-1", ...state },
  roundCalls: {},
  deciding: undefined,
  aborting: false,
  ...extra,
});
const session = (runs: readonly CanvasRun[]): Session => ({ key: "task-1", taskId: "task-1", title: "t", status: "completed", runs });

const spawned = (childRunId: string, at: string) =>
  ({
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "e",
    sequence: 1,
    runId: "task-1",
    attemptId: "a1",
    at,
    kind: "task.spawned",
    childRunId,
    workerAgentId: "researcher",
    depth: 1,
  }) as const;

describe("the chat panel's Activity tab", () => {
  it("lists the chat's latest accepted plan above the timeline; a refused one never was the plan", async () => {
    const plan = (
      callId: string,
      items: readonly { readonly content: string; readonly status: string }[],
      status: "completed" | "failed" = "completed",
    ) => ({ kind: "tool" as const, key: callId, attemptId: "a1", callId, toolName: "plan.update", input: { items }, status });
    const runs = [
      canvasRun("ui-1", "p", {
        transcript: [
          plan("c1", [
            { content: "Search", status: "done" },
            { content: "Compare", status: "in_progress" },
          ]),
        ],
      }),
      canvasRun("ui-2", "q", { transcript: [plan("c2", [{ content: "Refused", status: "pending" }], "failed")] }),
    ];
    const page = await mount(
      <InWorkspace client={{ request: async () => ({ ok: true }) }}>
        <Activity
          session={{ ...session(runs), taskId: undefined }}
          onTurn={() => undefined}
          onWaiting={() => undefined}
          onOpenTask={() => undefined}
        />
      </InWorkspace>,
    );
    const card = page.querySelector('[aria-label="plan"]');
    expect(card?.textContent).toContain("☑ Search");
    expect(card?.textContent).toContain("◐ Compare");
    expect(card?.textContent).not.toContain("Refused");
  });

  it("gives each recorded prompt the turn the transcript shows it at, newest first, with delegated tasks between", () => {
    const record: RecordedTask = {
      admissions: [
        admission("a1", "start", "2026-10-01T09:00:00.000Z", "Audit the site\nand more"),
        admission("a2", "reply", "2026-10-01T09:30:00.000Z", "Try again", "refused"),
        admission("a3", "approval", "2026-10-01T09:40:00.000Z", undefined),
        admission("a4", "reply", "2026-10-01T10:00:00.000Z", "Now the blog", "claimed"),
      ],
    };
    // A reload's recorded prompt, a prompt the owner never admitted (turn 2 on the page), then the live one.
    const runs = [
      canvasRun(
        "restored",
        "",
        { spawned: [spawned("child-1", "2026-10-01T09:45:00.000Z")] },
        { restored: true, recordedPrompts: ["Audit the site\nand more"] },
      ),
      canvasRun("ui-2", "never sent"),
      canvasRun("ui-3", "Now the blog"),
    ];
    const items = activityOf(record, session(runs));
    expect(items.map((item) => [item.title, item.turn, item.detail])).toEqual([
      ["Now the blog", 3, "Working"],
      ["Delegated to researcher", undefined, "Agent task child-1"],
      ["Try again", undefined, "Refused"],
      ["Audit the site", 1, "Started · completed"],
    ]);
  });

  it("says a turn that stopped for the reader was answered once a later message came, and waits only while it is the last", () => {
    const record: RecordedTask = {
      admissions: [
        admission("a1", "start", "2026-10-01T09:00:00.000Z", "Book a table", "committed", "waiting"),
        admission("a2", "reply", "2026-10-01T09:05:00.000Z", "For two", "committed", "waiting"),
      ],
    };
    expect(activityOf(record, session([])).map((item) => item.detail)).toEqual(["Waiting for you", "Started · answered by your next message"]);
  });

  it("lists the approvals decided in the chat, which the transcript no longer shows", () => {
    const request = {
      approvalId: "a1",
      callId: "c1",
      toolName: "web_search",
      summary: "Approve web_search?",
      input: { query: "flights SOF TPA" },
      effect: "external" as const,
    };
    const runs = [
      canvasRun(
        "ui-1",
        "Find flights",
        {
          settled: [
            { steps: 1, decisions: [{ callId: "c1", approved: true }], decidedBy: "operator", at: "2026-10-01T09:10:00.000Z" },
            { steps: 2, decisions: [{ callId: "c2", approved: false }], decidedBy: "auto:approve", at: "2026-10-01T09:20:00.000Z" },
          ],
        },
        { approvalHistory: { 1: { taskId: "task-1", steps: 1, requests: [request] } } },
      ),
    ];
    const items = activityOf({ admissions: [] }, session(runs));
    expect(items.map((item) => [item.verdict, item.title, item.detail])).toEqual([
      ["rejected", "c2", "Decided by automatic denial (--approval deny)"],
      ["approved", "web_search query: flights SOF TPA", "Decided by you"],
    ]);
  });

  it("folds a run of decisions on one tool with one verdict into one row, and leaves the rest", () => {
    const decision = (key: string, tool: string, verdict: "approved" | "rejected" = "approved") => ({
      key,
      at: `2026-10-01T09:${key.padStart(2, "0")}:00.000Z`,
      title: `${tool} q${key}`,
      detail: "Decided by you",
      verdict,
      tool,
    });
    const turn = { key: "t", at: "2026-10-01T08:00:00.000Z", title: "Find flights", detail: "Started · working" };
    const folded = foldDecisions([
      decision("5", "web_search"),
      decision("4", "web_search"),
      decision("3", "web_search"),
      decision("2", "web_search", "rejected"),
      decision("1", "sandbox.run"),
      turn,
    ]);
    expect(folded.map((entry) => ("kind" in entry ? `${entry.verdict} ${entry.tool} ×${entry.items.length}` : entry.title))).toEqual([
      "approved web_search ×3",
      "web_search q2",
      "sandbox.run q1",
      "Find flights",
    ]);
    expect(foldDecisions([decision("1", "web_search")])).toHaveLength(1);
    // A newer decision joining keeps the fold's key, so an open fold stays open.
    const key = (entries: ReturnType<typeof foldDecisions>) => entries[0]?.key;
    expect(key(foldDecisions([decision("6", "web_search"), decision("5", "web_search"), decision("4", "web_search")]))).toBe(
      key(foldDecisions([decision("5", "web_search"), decision("4", "web_search")])),
    );
  });

  it("lists the decisions the owner recorded, so they survive a reload, and the stream's once", () => {
    const recorded = (
      approvalId: string,
      callId: string,
      state: RecordedDecision["state"],
      decidedBy: string | null,
      decidedAt: string,
      extra: Partial<RecordedDecision> = {},
    ): RecordedDecision => ({
      kind: "approval",
      approvalId,
      taskId: "task-1",
      principalId: "operator",
      toolId: "web_search",
      callId,
      steps: 1,
      state,
      decidedBy,
      decidedAt,
      note: null,
      ...extra,
    });
    const history = [
      recorded("a1", "c1", "granted", "operator", "2026-10-01T09:10:00.000Z", { summary: "flights SOF TPA" }),
      recorded("a2", "c2", "denied", "ana", "2026-10-01T09:11:00.000Z", { channel: "Telegram" }),
      recorded("a3", "c3", "expired", "policy:expired", "2026-10-01T09:12:00.000Z"),
    ];
    // c1 the stream announced too; c4 was decided after the history was read.
    const runs = [
      canvasRun("ui-1", "Find flights", {
        settled: [
          { steps: 1, decisions: [{ callId: "c1", approved: true }], decidedBy: "operator", at: "2026-10-01T09:10:00.000Z" },
          { steps: 2, decisions: [{ callId: "c4", approved: true }], decidedBy: "operator", at: "2026-10-01T09:20:00.000Z" },
        ],
      }),
    ];
    expect(activityOf({ admissions: [] }, session(runs), history).map((item) => [item.verdict, item.title, item.detail])).toEqual([
      ["approved", "c4", "Decided by you"],
      ["expired", "web_search", "No decision before it expired"],
      ["rejected", "web_search", "Decided by ana in Telegram"],
      ["approved", "Search the web for flights SOF TPA", "Decided by you"],
    ]);
  });

  it("keeps only this chat's matchable rows from an owner that ignores the history's task filter", async () => {
    const items = [
      {
        kind: "approval",
        approvalId: "a1",
        taskId: "task-1",
        principalId: "operator",
        toolId: "web_search",
        callId: "c1",
        steps: 1,
        state: "granted",
        decidedBy: "operator",
        decidedAt: "2026-10-01T09:10:00.000Z",
        note: null,
      },
      {
        kind: "approval",
        approvalId: "a2",
        taskId: "task-2",
        principalId: "operator",
        toolId: "web_search",
        callId: "c1",
        steps: 1,
        state: "granted",
        decidedBy: "operator",
        decidedAt: "2026-10-01T09:10:00.000Z",
        note: null,
      },
      {
        kind: "approval",
        approvalId: "a3",
        taskId: "task-1",
        principalId: "operator",
        toolId: "web_search",
        state: "granted",
        decidedBy: "operator",
        decidedAt: "2026-10-01T09:10:00.000Z",
        note: null,
      },
    ];
    const sent: unknown[] = [];
    const client = {
      request: async (command: string, payload: unknown) => {
        sent.push({ command, payload });
        return { ok: true, result: { items, nextCursor: "more" } };
      },
    } as unknown as SettingsClient;
    const answer = await loadDecisions(client, "default", "task-1");
    expect(answer.ok && answer.value.items.map((item) => item.approvalId)).toEqual(["a1"]);
    // Its next page would walk the whole workspace: none is offered.
    expect(answer.ok && answer.value.nextCursor).toBeUndefined();
    expect(sent).toEqual([
      { command: "approvals", payload: { action: "history", workspaceId: "default", limit: 100, kinds: ["approval"], taskId: "task-1" } },
    ]);
  });

  it("says where the chat's instructions changed between turns, and not for a refused prompt", () => {
    const at = (minute: number) => `2026-10-01T09:${String(minute).padStart(2, "0")}:00.000Z`;
    const pinned = (
      id: string,
      kind: AdmissionRecord["kind"],
      minute: number,
      prompt: string,
      revision: number | undefined,
      state: AdmissionRecord["state"] = "committed",
    ): AdmissionRecord => ({
      ...admission(id, kind, at(minute), prompt, state),
      ...(revision === undefined ? {} : { instructionsRevision: revision }),
    });
    const record: RecordedTask = {
      admissions: [
        pinned("a1", "start", 1, "one", undefined),
        pinned("a2", "reply", 2, "two", 1),
        pinned("a3", "reply", 3, "refused", 2, "refused"),
        pinned("a4", "reply", 4, "three", 1),
        pinned("a5", "reply", 5, "four", 2),
      ],
    };
    const items = activityOf(
      record,
      session([canvasRun("ui-1", "one"), canvasRun("ui-2", "two"), canvasRun("ui-3", "three"), canvasRun("ui-4", "four")]),
    );
    expect(items.filter((item) => item.title.startsWith("Instructions changed")).map((item) => [item.title, item.turn])).toEqual([
      ["Instructions changed (revision 2)", 4],
      ["Instructions changed (revision 1)", 2],
    ]);
    // A refused first prompt ran under nothing: the first turn that runs changes nothing.
    const refusedFirst = activityOf(
      { admissions: [pinned("b1", "start", 1, "refused", 1, "refused"), pinned("b2", "reply", 2, "one", 1)] },
      session([canvasRun("ui-1", "one")]),
    );
    expect(refusedFirst.some((item) => item.title.startsWith("Instructions changed"))).toBe(false);
  });

  it("leaves a prompt the page has not drawn without a turn, and matches the rest in order", () => {
    expect(
      matchTurns(
        ["one", "two", "queued"],
        [
          { turn: 1, text: "one" },
          { turn: 2, text: " two " },
        ],
      ),
    ).toEqual([1, 2, undefined]);
    // The same text twice is matched to its own occurrence, not the first.
    expect(
      matchTurns(
        ["again", "again"],
        [
          { turn: 1, text: "again" },
          { turn: 2, text: "again" },
        ],
      ),
    ).toEqual([1, 2]);
  });

  it("numbers the transcript's prompts the same way: a reload's recorded ones first, then each run's own", () => {
    const runs = [
      canvasRun("restored", "", {}, { restored: true, recordedPrompts: ["one", "two"] }),
      canvasRun("ui-2", "three"),
      canvasRun("ui-3", "four"),
    ];
    expect(runs.map((_, index) => firstTurnOf(runs, index))).toEqual([1, 3, 4]);
  });

  it("gathers what waits on the reader from the stream: rounds, reviews and questions", () => {
    const waiting = waitingOf(
      session([
        canvasRun("ui-1", "p", {
          pending: [
            {
              taskId: "task-1",
              steps: 2,
              requests: [
                { toolName: "browser.click", callId: "c1", input: {} },
                { toolName: "browser.click", callId: "c2", input: {} },
              ],
            },
          ] as unknown as RunState["pending"],
          review: { steps: 3, requests: [{ artifactId: "art", toolName: "files.write", callId: "c3" }] },
          waiting: { on: "user", deadlineAt: "2026-10-02T00:00:00.000Z", question: "Which site?\nDetails" },
        }),
      ]),
    );
    expect(waiting.map((item) => item.title)).toEqual(["Approve browser.click", "Review 1 archived output", "Answer: Which site?"]);
  });

  it("shows what waits in a card whose Go to it brings the transcript to it", async () => {
    const onWaiting = vi.fn();
    const request = vi.fn(() => new Promise<never>(() => undefined));
    const page = await mount(
      <InWorkspace client={{ request }}>
        <Activity
          session={session([
            canvasRun("ui-1", "p", { waiting: { on: "user", deadlineAt: "2026-10-02T00:00:00.000Z", question: "Which site?" } }),
          ])}
          onTurn={() => undefined}
          onWaiting={onWaiting}
          onOpenTask={() => undefined}
        />
      </InWorkspace>,
    );
    const card = page.querySelector('[aria-label="waiting on you"]');
    expect(card?.textContent).toContain("Waiting on you (1)");
    expect(card?.textContent).toContain("Answer: Which site?");
    await act(async () => (card?.querySelector("button") as HTMLButtonElement).click());
    expect(onWaiting).toHaveBeenCalledOnce();
  });

  it("answers the chat's question in the panel, and says what to decide first when a round comes first", async () => {
    const answers: [string, string][] = [];
    const request = vi.fn(() => new Promise<never>(() => undefined));
    const waiting = {
      on: "user",
      deadlineAt: "2099-10-02T00:00:00.000Z",
      question: "Which site?",
      choices: { options: [{ label: "Bahn" }, { label: "Lufthansa" }], multiSelect: false, allowOther: false },
    };
    const page = await mount(
      <InWorkspace client={{ request }}>
        <Activity
          session={session([canvasRun("ui-1", "p", { waiting })])}
          onTurn={() => undefined}
          onWaiting={() => undefined}
          onOpenTask={() => undefined}
          onAnswer={(runId, text) => answers.push([runId, text])}
        />
      </InWorkspace>,
    );
    const option = [...page.querySelectorAll<HTMLButtonElement>('[aria-label="waiting on you"] button.need-option')].find((button) =>
      button.textContent?.includes("Lufthansa"),
    );
    await act(async () => option?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(answers).toEqual([["ui-1", "Lufthansa"]]);

    const onWaiting = vi.fn();
    const blocked = await mount(
      <InWorkspace client={{ request }}>
        <Activity
          session={session([
            canvasRun("ui-2", "p", { waiting, pending: [{ taskId: "task-1", steps: 2, requests: [] }] as unknown as RunState["pending"] }),
          ])}
          onTurn={() => undefined}
          onWaiting={onWaiting}
          onOpenTask={() => undefined}
          onAnswer={() => undefined}
        />
      </InWorkspace>,
    );
    const card = blocked.querySelectorAll('[aria-label="waiting on you"] .need-question')[0];
    expect(card?.textContent).toContain("Decide the approval in the chat first.");
    await act(async () => (card?.querySelector(".need-blocked button") as HTMLButtonElement).click());
    expect(onWaiting).toHaveBeenCalledOnce();
  });

  it("says so, rather than drop the answer, when the owner is out of reach", async () => {
    const request = vi.fn(() => new Promise<never>(() => undefined));
    const waiting = { on: "user", deadlineAt: "2099-10-02T00:00:00.000Z", question: "Which site?" };
    const page = await mount(
      <InWorkspace client={{ request }}>
        <Activity
          session={session([canvasRun("ui-1", "p", { waiting })])}
          onTurn={() => undefined}
          onWaiting={() => undefined}
          onOpenTask={() => undefined}
          onAnswer={() => undefined}
          connected={false}
        />
      </InWorkspace>,
    );
    expect(page.querySelector(".need-blocked")?.textContent).toContain("Reconnect to the owner to answer.");
    expect(page.querySelector<HTMLTextAreaElement>(".need-question textarea")?.disabled).toBe(true);
  });

  it("asks a worker's question in the root chat's panel and transcript, answers it at the worker's wait, and turns it into a receipt", async () => {
    const asked = {
      taskId: "worker-1",
      workspaceId: "default",
      principalId: "operator",
      workerLabel: "Researcher",
      waitId: "wait-1",
      question: "Which source?",
      choices: { options: [{ label: "Docs" }, { label: "Forum" }], multiSelect: false, allowOther: false },
      deadlineAt: "2099-10-02T00:00:00.000Z",
      askedAt: "2026-10-02T00:00:00.000Z",
      deliveries: [],
    };
    const workers: WorkerNeeds = {
      questions: [asked],
      handoffs: [
        {
          taskId: "worker-2",
          workspaceId: "default",
          principalId: "operator",
          workerLabel: "Browser",
          waitId: "wait-2",
          handoff: { sessionId: "s-1", reason: "sign-in", instructions: "Sign in" },
          deadlineAt: "2099-10-02T00:00:00.000Z",
          askedAt: "2026-10-02T00:00:00.000Z",
        },
      ],
      answers: {},
    };
    expect(waitingOf(session([]), true, workers).map((item) => item.title)).toEqual([
      "Answer Researcher: Which source?",
      "Act in the browser for Browser",
    ]);
    const answers: [string, string][] = [];
    const request = vi.fn(() => new Promise<never>(() => undefined));
    const panel = await mount(
      <InWorkspace client={{ request }}>
        <Activity
          session={session([])}
          onTurn={() => undefined}
          onWaiting={() => undefined}
          onOpenTask={() => undefined}
          workers={workers}
          onAnswerWorker={(waitId, text) => answers.push([waitId, text])}
        />
      </InWorkspace>,
    );
    const card = panel.querySelector('[aria-label="waiting on you"] .need-question');
    expect(card?.textContent).toContain("Researcher");
    const forum = [...(card?.querySelectorAll<HTMLButtonElement>("button.need-option") ?? [])].find((button) =>
      button.textContent?.includes("Forum"),
    );
    await act(async () => forum?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(answers).toEqual([["wait-1", "Forum"]]);
    unmountAll();

    // In the transcript: the card, where "Open the requesting child" used to send the reader, and the handoff with who asks.
    const transcript = await mount(
      <InWorkspace timeZone="UTC">
        <WorkerNeedCards needs={workers} connected onAnswer={(waitId, text) => answers.push([waitId, text])} />
      </InWorkspace>,
    );
    expect(transcript.querySelectorAll("[data-waiting]")).toHaveLength(2);
    expect(transcript.textContent).toContain("Which source?");
    expect(transcript.textContent).toContain("Browser asks:");
    expect(transcript.textContent).not.toContain("Open the requesting child");
    unmountAll();
    // Answered from here and closed since: a receipt naming whose question it was.
    const receipt = await mount(
      <InWorkspace timeZone="UTC">
        <WorkerNeedCards
          needs={{ questions: [], handoffs: [], answers: { "wait-1": { text: "2", status: "recorded", question: asked } } }}
          connected
          onAnswer={() => undefined}
        />
      </InWorkspace>,
    );
    expect(receipt.querySelector(".need-receipt")?.textContent).toContain("You answered Forum · Researcher's question");
    // An approval is decided where the chat is, at the worker's task.
    const decided: unknown[] = [];
    const approval = {
      approvalId: "approval-1",
      taskId: "worker-1",
      toolId: "sandbox.run",
      callId: "call-1",
      steps: 2,
      createdAt: "2026-10-04T00:00:00.000Z",
      workspaceId: "default",
      principalId: "operator",
      taskStatus: "waiting",
      taskTitle: "Write a story",
      rootTaskId: "root",
      risk: "medium" as const,
      allowedScopes: ["once" as const],
    };
    const rounds = await mount(
      <InWorkspace timeZone="UTC">
        <WorkerNeedCards
          needs={{ questions: [], handoffs: [], approvals: [approval], answers: {} }}
          connected
          onAnswer={() => undefined}
          onDecide={(round, decision) => void decided.push([round.taskId, round.steps, decision.approved])}
        />
      </InWorkspace>,
    );
    expect(rounds.querySelector(".worker-round .need-asker")?.textContent).toBe("Write a story asks:");
    const allow = [...rounds.querySelectorAll("button")].find((button) => button.textContent === "Allow once");
    await act(async () => (allow as HTMLButtonElement).click());
    expect(decided).toEqual([["worker-1", 2, true]]);
  });

  it("shows a worker's round as Center does, opens the worker, and moves focus to the box once it's decided", async () => {
    const approval = {
      approvalId: "approval-1",
      taskId: "worker-1",
      toolId: "sandbox.run",
      callId: "call-1",
      steps: 2,
      createdAt: "2026-10-04T00:00:00.000Z",
      workspaceId: "default",
      principalId: "operator",
      taskStatus: "waiting",
      taskTitle: "Write a story",
      rootTaskId: "root",
      risk: "medium" as const,
      allowedScopes: ["once" as const, "session" as const],
    };
    const needs = { questions: [], handoffs: [], approvals: [approval], answers: {} };
    let setNeeds: (held: typeof needs) => void = () => undefined;
    const Card = () => {
      const [held, set] = useState(needs);
      setNeeds = set;
      return (
        <InWorkspace timeZone="UTC">
          <WorkerNeedCards needs={held} connected lastingChat onAnswer={() => undefined} onDecide={() => undefined} />
        </InWorkspace>
      );
    };
    const box = document.body.appendChild(Object.assign(document.createElement("div"), { className: "composer-box" }));
    const field = box.appendChild(document.createElement("textarea"));
    const page = await mount(<Card />);
    expect(page.querySelector(".center-card-details summary")?.textContent).toBe("Details");
    expect(page.querySelector(".center-card-ctx a")?.getAttribute("href")).toContain("worker-1");
    expect([...page.querySelectorAll("button")].map((button) => button.textContent)).toContain("Allow until tomorrow");
    await act(async () => setNeeds({ ...needs, approvals: [] }));
    expect(document.activeElement).toBe(field);
    box.remove();
  });

  it("scrolls the transcript to the first thing waiting", () => {
    document.body.innerHTML = '<div class="runs"><div>plain</div><div data-waiting="">round</div></div>';
    const target = document.querySelector("[data-waiting]") as HTMLElement;
    target.scrollIntoView = vi.fn();
    expect(revealWaiting(document)).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalled();
    document.body.innerHTML = "";
    expect(revealWaiting(document)).toBe(false);
  });

  it("opens a delegated task from its row", async () => {
    const onOpenTask = vi.fn();
    const client: SettingsClient = { request: async () => ({ ok: true, result: { admissions: [] } }) };
    const page = await mount(
      <InWorkspace client={client}>
        <Activity
          session={session([canvasRun("ui-1", "", { spawned: [spawned("child-1", new Date().toISOString())] })])}
          onTurn={() => undefined}
          onWaiting={() => undefined}
          onOpenTask={onOpenTask}
        />
      </InWorkspace>,
    );
    await act(async () => (page.querySelector("button.chat-panel-item") as HTMLButtonElement).click());
    expect(onOpenTask).toHaveBeenCalledWith("child-1");
  });

  it("says when the owner has no record of the task, or could not answer", async () => {
    const missing = await mount(
      <InWorkspace client={{ request: async () => ({ ok: true, result: { found: false } }) }}>
        <Activity
          session={session([canvasRun("ui-1", "p")])}
          onTurn={() => undefined}
          onWaiting={() => undefined}
          onOpenTask={() => undefined}
        />
      </InWorkspace>,
    );
    expect(missing.textContent).toContain("no record of this chat");
    unmountAll();
    const failed = await mount(
      <InWorkspace client={{ request: async () => ({ ok: false, error: { code: "UNAVAILABLE", message: "tasks is unavailable" } }) }}>
        <Activity
          session={session([canvasRun("ui-1", "p")])}
          onTurn={() => undefined}
          onWaiting={() => undefined}
          onOpenTask={() => undefined}
        />
      </InWorkspace>,
    );
    expect(failed.textContent).toContain("tasks is unavailable");
  });

  it("scrolls the transcript to a turn, opening the recorded prompts that hide it", () => {
    document.body.innerHTML =
      '<div class="runs"><details><summary>Recorded</summary><p data-turn="1">one</p></details><div data-turn="2">two</div></div>';
    const target = document.querySelector('[data-turn="1"]') as HTMLElement;
    target.scrollIntoView = vi.fn();
    expect(revealTurn(document, 1)).toBe(true);
    expect((document.querySelector("details") as HTMLDetailsElement).open).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(revealTurn(document, 9)).toBe(false);
    document.body.innerHTML = "";
  });

  it("reads the task's record and sends a turn's click to the transcript", async () => {
    const sent: unknown[] = [];
    const client: SettingsClient = {
      request: async (command, payload) => {
        sent.push([command, payload]);
        return { ok: true, result: { admissions: [admission("a1", "start", new Date().toISOString(), "Audit the site")] } };
      },
    };
    const onTurn = vi.fn();
    const onCenter = vi.fn();
    const page = await mount(
      <InWorkspace client={client}>
        <Activity
          session={session([canvasRun("ui-1", "Audit the site")])}
          onTurn={onTurn}
          onWaiting={() => undefined}
          onOpenTask={() => undefined}
          onCenter={onCenter}
        />
      </InWorkspace>,
    );
    expect(sent).toEqual([["tasks", { taskId: "task-1" }]]);
    expect(page.querySelector(".chat-panel-day h4")?.textContent).toContain("Today");
    await act(async () => (page.querySelector("button.chat-panel-item") as HTMLButtonElement).click());
    expect(onTurn).toHaveBeenCalledWith(1);
    await act(async () => (page.querySelector(".chat-panel-center") as HTMLButtonElement).click());
    expect(onCenter).toHaveBeenCalledOnce();
  });

  it("pages the chat's recorded decisions past the first, keeping older pages over a fresh first one", async () => {
    const decision = (n: number) => ({
      kind: "approval",
      approvalId: `a${n}`,
      taskId: "task-1",
      principalId: "operator",
      toolId: "web_search",
      callId: `c${n}`,
      steps: n,
      state: "granted",
      decidedBy: "operator",
      decidedAt: new Date(Date.now() - n * 60_000).toISOString(),
      note: null,
      summary: `query ${n}`,
    });
    const sent: unknown[] = [];
    const client: SettingsClient = {
      request: async (command, payload) => {
        if (command === "tasks") return { ok: true, result: { admissions: [] } };
        sent.push(payload);
        const cursor = (payload as { cursor?: string }).cursor;
        return {
          ok: true,
          result: cursor === undefined ? { items: [decision(1), decision(2)], nextCursor: "page2" } : { items: [decision(3)] },
        };
      },
    };
    const page = await mount(
      <InWorkspace client={client}>
        <Activity
          session={session([canvasRun("ui-1", "p")])}
          workspaceId="default"
          onTurn={() => undefined}
          onWaiting={() => undefined}
          onOpenTask={() => undefined}
        />
      </InWorkspace>,
    );
    // Consecutive approvals of one tool fold into one row; each decision is inside it.
    const folds = () => [...page.querySelectorAll(".chat-panel-fold-title")].map((title) => title.textContent);
    const titles = () => [...page.querySelectorAll(".chat-panel-fold li .chat-panel-item-title")].map((title) => title.textContent);
    expect(folds()).toEqual(["Approved: web_search ×2"]);
    expect(titles()).toEqual(["Approved: Search the web for query 1", "Approved: Search the web for query 2"]);
    const more = [...page.querySelectorAll("button")].find((button) => button.textContent === "Load older decisions")!;
    await act(async () => more.click());
    expect(folds()).toEqual(["Approved: web_search ×3"]);
    expect(titles()).toEqual([
      "Approved: Search the web for query 1",
      "Approved: Search the web for query 2",
      "Approved: Search the web for query 3",
    ]);
    expect(sent).toEqual([
      { action: "history", workspaceId: "default", limit: 100, kinds: ["approval"], taskId: "task-1" },
      { action: "history", workspaceId: "default", limit: 100, kinds: ["approval"], taskId: "task-1", cursor: "page2" },
    ]);
    // The last page has no cursor: nothing more is offered.
    expect([...page.querySelectorAll("button")].some((button) => button.textContent === "Load older decisions")).toBe(false);
  });

  it("asks nothing before the chat has a task", async () => {
    const request = vi.fn();
    const page = await mount(
      <InWorkspace client={{ request }}>
        <Activity
          session={{ ...session([canvasRun("ui-1", "p")]), taskId: undefined }}
          onTurn={() => undefined}
          onWaiting={() => undefined}
          onOpenTask={() => undefined}
        />
      </InWorkspace>,
    );
    expect(page.textContent).toContain("has not started yet");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("notices in a chat", () => {
  const notice = (index: number, extra: Partial<ChatNotice> = {}): ChatNotice => ({
    noticeId: `notice-${index}`,
    taskId: "home-1",
    kind: "run-result" as const,
    sourceTaskId: `run-${index}`,
    title: `Scheduled run ${index}`,
    summary: "Completed",
    afterSeq: 0,
    createdAt: "2026-10-04T08:00:00.000Z",
    ...extra,
  });

  it("shows the newest notices as cards that open their run and reply in a side chat, the rest behind a toggle", async () => {
    const opened: string[] = [];
    const replied: string[] = [];
    const host = await mount(
      <NoticeCards
        notices={[1, 2, 3, 4].map((index) => notice(index))}
        connected
        onOpen={(taskId) => opened.push(taskId)}
        onReply={(row) => replied.push(row.noticeId)}
      />,
    );
    expect(host.querySelectorAll(".chat-notice")).toHaveLength(3);
    expect(host.textContent).toContain("Scheduled run 4");
    expect(host.textContent).not.toContain("Scheduled run 1");
    const buttons = [...host.querySelectorAll("button")];
    await act(async () => buttons.find((button) => button.textContent === "Open run")?.click());
    await act(async () => buttons.find((button) => button.textContent === "Reply in a side chat")?.click());
    expect(opened).toEqual(["run-2"]);
    expect(replied).toEqual(["notice-2"]);
    await act(async () => buttons.find((button) => button.textContent?.startsWith("Show 1 earlier"))?.click());
    expect(host.querySelectorAll(".chat-notice")).toHaveLength(4);
  });

  it("shows earlier chats without actions, and nothing for no notices", async () => {
    const host = await mount(
      <NoticeCards
        notices={[notice(1, { kind: "earlier-chats", sourceTaskId: undefined, title: "Earlier chats", summary: "Plan (chat-a)" } as never)]}
        connected
        onReply={() => undefined}
      />,
    );
    expect(host.textContent).toContain("Earlier chats");
    expect(host.querySelectorAll("button")).toHaveLength(0);
    // Folded to one line with its count: the list opens on a click.
    expect(host.querySelector("details.chat-notice-list:not([open]) > summary")?.textContent).toBe("Earlier chats (1)");
    const reminder = await mount(
      <NoticeCards
        notices={[
          notice(2, { kind: "reminder", sourceTaskId: undefined as never, title: "Reminder" }),
          notice(3, { kind: "side-chat-settled", title: "Side chat finished" }),
        ]}
        connected={false}
        onOpen={() => undefined}
        onReply={() => undefined}
      />,
    );
    // A reminder with no task offers nothing; a side chat opens as one, and is answered there, not in another side chat.
    const labels = [...reminder.querySelectorAll("button")].map((button) => [button.textContent, button.disabled]);
    expect(labels).toEqual([["Open side chat", false]]);
    const empty = await mount(<NoticeCards notices={[]} connected />);
    expect(empty.textContent).toBe("");
  });

  it("opens a conversation's notice as the conversation, with nothing to reply about", async () => {
    const host = await mount(
      <NoticeCards
        notices={[
          notice(1, {
            kind: "conversation",
            sourceTaskId: "conv-1",
            title: "Telegram group -100",
            summary: "3 new messages, the last at 14:05 UTC",
          }),
        ]}
        connected
        onOpen={() => undefined}
        onReply={() => undefined}
      />,
    );
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Open conversation"]);
  });
});

describe("notice placement", () => {
  const posted = (id: string, afterSeq: number, createdAt: string, kind: ChatNotice["kind"] = "side-chat-settled"): ChatNotice => ({
    noticeId: id,
    taskId: "home-1",
    kind,
    title: id,
    summary: "",
    afterSeq,
    createdAt,
  });
  const placedIds = (placed: ReadonlyMap<number, readonly ChatNotice[]>) =>
    [...placed.entries()].map(([index, notices]) => [index, notices.map((notice) => notice.noticeId)]);

  it("puts each card after the saved turn it followed, and a new Home's earlier chats before its first", () => {
    const runs = [1, 2, 3].map((seq) => ({ seq, startedAt: `2026-10-04T0${seq}:00:00.000Z`, run: { taskId: "home-1" } }));
    const placed = noticesByRun(runs, [
      posted("earlier", 0, "2026-10-04T00:30:00.000Z", "earlier-chats"),
      posted("side", 2, "2026-10-04T09:00:00.000Z"),
      posted("last", 3, "2026-10-04T09:30:00.000Z"),
      posted("epoch", 1, "2026-10-04T01:30:00.000Z", "epoch"),
    ]);
    expect(placedIds(placed)).toEqual([
      [0, ["earlier"]],
      [2, ["side"]],
      [3, ["last"]],
    ]);
  });

  it("places a turn this page ran, with no seq, by when it started", () => {
    const runs = [{ startedAt: "2026-10-04T08:00:00.000Z", run: { taskId: "home-1" } }, { run: { taskId: "home-1" } }];
    const placed = noticesByRun(runs, [
      posted("earlier", 0, "2026-10-04T07:59:59.000Z", "earlier-chats"),
      posted("side", 1, "2026-10-04T08:10:00.000Z"),
    ]);
    // The second turn has not started: a notice already posted goes before it.
    expect(placedIds(placed)).toEqual([
      [0, ["earlier"]],
      [1, ["side"]],
    ]);
  });
});

describe("epoch dividers", () => {
  const epoch = (index: number, createdAt: string, artifactId?: string): ChatNotice => ({
    noticeId: `epoch-${index}`,
    taskId: "home-1",
    kind: "epoch",
    title: `Epoch ${index} began`,
    summary: "Earlier turns were summarized",
    afterSeq: 0,
    createdAt,
    ...(artifactId === undefined ? {} : { artifactId }),
  });

  it("goes before the turn the chat rolled over in, after every turn ended before it, and never among the cards", async () => {
    const runs = [{ lastAt: "2026-10-04T08:00:00.000Z" }, { lastAt: "2026-10-04T09:00:00.000Z" }, {}];
    const placed = epochDividersByRun(runs, [
      epoch(1, "2026-10-04T08:30:00.000Z"),
      epoch(2, "2026-10-04T10:00:00.000Z"),
      { ...epoch(3, "2026-10-04T07:00:00.000Z"), kind: "run-result" },
    ]);
    expect([...placed.entries()].map(([index, notices]) => [index, notices.map((notice) => notice.noticeId)])).toEqual([
      [1, ["epoch-1"]],
      [2, ["epoch-2"]],
    ]);
    // Every turn ended before it: after them all.
    expect([...epochDividersByRun([{ lastAt: "2026-10-04T08:00:00.000Z" }], [epoch(1, "2026-10-04T09:00:00.000Z")]).keys()]).toEqual([1]);
    const cards = await mount(<NoticeCards notices={[epoch(1, "2026-10-04T08:30:00.000Z")]} connected />);
    expect(cards.textContent).toBe("");
  });

  it("links its archive and offers fresh context, saying what came of it", async () => {
    const opened: string[] = [];
    let answer: string | undefined;
    const host = await mount(
      <EpochDivider
        notice={epoch(2, "2026-10-04T08:30:00.000Z", "art-9")}
        connected
        onOpenArchive={(artifactId) => opened.push(artifactId)}
        onFreshContext={async () => answer}
      />,
    );
    expect(host.querySelector('.epoch-divider[role="group"]')?.getAttribute("aria-label")).toBe("Epoch 2 began");
    const buttons = () => [...host.querySelectorAll("button")];
    expect(buttons().map((button) => button.textContent)).toEqual(["Open archive", "Fresh context"]);
    await act(async () => buttons()[0]?.click());
    expect(opened).toEqual(["art-9"]);
    await act(async () => buttons()[1]?.click());
    await act(async () => undefined);
    expect(host.textContent).toContain("Your next message starts a new epoch.");
    answer = "This owner cannot start a fresh context";
    await act(async () => buttons()[1]?.click());
    await act(async () => undefined);
    expect(host.querySelector(".failure")?.textContent).toBe("This owner cannot start a fresh context");
    // A lossy fold has no archive to open; offline, fresh context waits for the connection.
    const lossy = await mount(
      <EpochDivider
        notice={epoch(3, "2026-10-04T08:30:00.000Z")}
        connected={false}
        onOpenArchive={() => undefined}
        onFreshContext={async () => undefined}
      />,
    );
    expect([...lossy.querySelectorAll("button")].map((button) => [button.textContent, button.disabled])).toEqual([["Fresh context", true]]);
    expect(lossy.textContent).toContain("Nothing was archived.");
  });
});
