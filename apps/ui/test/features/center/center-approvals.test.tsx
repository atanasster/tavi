// @vitest-environment jsdom
import type { ApprovalHistoryItem, CenterSummaryAnswer, NeedRow, PendingQuestionRow, PendingReviewRow } from "@tavi/contracts";
import axe from "axe-core";
import { act } from "react";
import { describe, expect, it } from "vitest";

import type { PendingListRow } from "../../../src/features/center/approvals-api.js";
import { CenterPage } from "../../../src/features/center/Center.js";
import { CenterRail } from "../../../src/features/center/CenterRail.js";
import { ApprovalsInbox, WAITING_ANCHOR } from "../../../src/features/center/Inbox.js";
import { expiryLabel, groupRounds, historyFilters, verdictFilters, whenLabel } from "../../../src/features/center/inbox-model.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { ConnectCardContext } from "../../../src/features/apps/ConnectCard.js";
import { WorkspaceProvider } from "../../../src/features/shell/Workspace.js";
import { InWorkspace } from "../../support/workspace.js";
import { mount, rerender, settle, unmountAll } from "../../support/dom.js";

/**
 * The Center's Approvals section: a card per
 * pending round offering only the scopes its risk allows, critical risk's
 * second step, a round settled elsewhere collapsing to where and by whom, the
 * history of all three kinds a page at a time, and the feed's refresh.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (overrides: Partial<CenterSummaryAnswer> = {}): CenterSummaryAnswer => ({
  workspaceId: "default",
  timezone: "Europe/Berlin",
  today: "2026-09-29",
  counts: { approvals: 1, reviews: 0, questions: 0, runningTasks: 0, memoryProposals: 0, activeRoutines: 0, schedules: 0 },
  perDay: [{ date: "2026-09-29", tasks: 1 }],
  next: [],
  people: {},
  cursor: "c1",
  ...overrides,
});

const pending = (
  approvalId: string,
  extra: Partial<PendingListRow> & { readonly taskId?: string; readonly steps?: number; readonly toolId?: string } = {},
): PendingListRow => {
  const { taskId = "t1", steps = 2, toolId = "http.request", ...rest } = extra;
  return {
    record: { approvalId, taskId, toolId, callId: `call-${approvalId}`, steps, createdAt: "2026-09-29T10:00:00.000Z" },
    task: { principalId: "operator" },
    taskTitle: "Book train tickets",
    principalId: "operator",
    summary: "https://bahn.de",
    risk: "low",
    allowedScopes: ["once"],
    ...rest,
  };
};

const questionRow = (waitId: string, extra: Partial<PendingQuestionRow> = {}): PendingQuestionRow => ({
  taskId: `task-${waitId}`,
  workspaceId: "default",
  principalId: "operator",
  taskTitle: `Task ${waitId}`,
  origin: "ipc",
  waitId,
  question: "Which day?",
  choices: { options: [{ label: "Monday" }, { label: "Tuesday" }], multiSelect: false, allowOther: false },
  deadlineAt: "2099-01-01T10:00:00.000Z",
  askedAt: "2026-09-29T09:00:00.000Z",
  deliveries: [],
  ...extra,
});
const reviewRow = (taskId: string, extra: Partial<PendingReviewRow> = {}): PendingReviewRow => ({
  taskId,
  workspaceId: "default",
  principalId: "operator",
  taskTitle: `Task ${taskId}`,
  origin: "ipc",
  artifactCount: 1,
  askedAt: "2026-09-29T08:00:00.000Z",
  ...extra,
});
const needs = (questions: readonly PendingQuestionRow[], reviews: readonly PendingReviewRow[] = []): NeedRow[] => [
  ...questions.map(
    (question): NeedRow => ({
      kind: "question",
      needId: `question:${question.waitId}`,
      taskId: question.taskId,
      askedAt: question.askedAt,
      deadlineAt: question.deadlineAt,
      question,
    }),
  ),
  ...reviews.map(
    (review): NeedRow => ({ kind: "review", needId: `review:${review.taskId}`, taskId: review.taskId, askedAt: review.askedAt, review }),
  ),
];

type Answer = {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: Record<string, unknown> };
};

/**
 * An owner answering the inbox's reads from what the test holds (so a test
 * changes an answer between reads) and `approve` with `decision`. It records
 * what it was asked.
 */
function owner(state: {
  rows: readonly PendingListRow[];
  needs?: readonly NeedRow[];
  answer?: Answer | undefined;
  show?: { readonly calls: readonly unknown[] };
  history?: (payload: Record<string, unknown>) => { items: readonly ApprovalHistoryItem[]; nextCursor?: string };
  decision?: Answer;
}) {
  const asked: { readonly command: string; readonly payload: Record<string, unknown> }[] = [];
  const client: SettingsClient = {
    request: (command, payload) => {
      const body = payload as Record<string, unknown>;
      asked.push({ command, payload: body });
      const answer = (value: Answer) => Promise.resolve(value as never);
      if (command === "approvals" && body["action"] === "list") return answer({ ok: true, result: { rows: state.rows, truncated: false } });
      if (command === "approvals" && body["action"] === "history")
        return answer({ ok: true, result: state.history?.(body) ?? { items: [] } });
      if (command === "approvals" && body["action"] === "show") return answer({ ok: true, result: state.show ?? { calls: [] } });
      if (command === "approvals" && body["action"] === "needs")
        return answer({ ok: true, result: { needs: state.needs ?? [], truncated: false } });
      if (command === "approvals" && body["action"] === "answer") return answer(state.answer ?? { ok: true, result: {} });
      if (command === "approve") return answer(state.decision ?? { ok: true, result: {} });
      return new Promise<never>(() => undefined);
    },
  };
  return {
    client,
    asked,
    of: (command: string, action?: string) =>
      asked.filter((item) => item.command === command && (action === undefined || item.payload["action"] === action)),
  };
}

const buttons = (page: HTMLElement, within = ".center-card"): string[] =>
  [...page.querySelectorAll(`${within} button`)].map((button) => button.textContent ?? "");
const button = (page: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...page.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
};

function inbox(
  client: SettingsClient,
  options: {
    readonly revision?: number;
    readonly answer?: CenterSummaryAnswer;
    readonly opened?: string[];
    readonly permissions?: (ruleId?: string) => void;
  } = {},
) {
  return (
    <InWorkspace client={client} workspaceId="default">
      <ApprovalsInbox
        summary={options.answer ?? summary()}
        revision={options.revision ?? 0}
        principal="operator"
        onOpenTask={async (taskId) => void options.opened?.push(taskId)}
        onPermissions={options.permissions ?? (() => undefined)}
      />
    </InWorkspace>
  );
}

describe("apps to connect", () => {
  it("lists a chat waiting for an app with the card to connect it, counts it, and shows how one was decided", async () => {
    const connect = {
      taskId: "task-9",
      workspaceId: "default",
      principalId: "operator",
      taskTitle: "Plan the week",
      waitId: "w9",
      appName: "Calendar",
      accountId: "mcp.cal",
      reason: "its sign-in expired",
      health: "needs-sign-in" as const,
      askedAt: "2026-09-29T10:00:00.000Z",
      deadlineAt: "2026-09-29T10:30:00.000Z",
    };
    const decided: ApprovalHistoryItem = {
      kind: "connect",
      waitId: "w8",
      taskId: "task-8",
      principalId: "operator",
      state: "declined",
      appName: "Calendar",
      decidedAt: "2026-09-29T09:00:00.000Z",
      decidedBy: "operator",
    };
    const { client } = owner({
      rows: [],
      needs: [
        { kind: "connect", needId: "connect:w9", taskId: "task-9", askedAt: connect.askedAt, deadlineAt: connect.deadlineAt, connect },
      ],
      history: () => ({ items: [decided] }),
    });
    const page = await mount(
      <ConnectCardContext.Provider value={{ client, workspaceId: "default", onContinue: () => undefined, onDiscover: () => undefined }}>
        {inbox(client)}
      </ConnectCardContext.Provider>,
    );
    const list = page.querySelector('[aria-label="Apps to connect"]') as HTMLElement;
    expect(list.querySelector("a")?.textContent).toBe("Plan the week");
    expect(list.querySelector('[aria-label="Connect Calendar"]')).not.toBeNull();
    expect(page.querySelector(`#${WAITING_ANCHOR}`)?.textContent).toContain("1 app to connect");
    expect(page.textContent).not.toContain("Nothing needs you.");
    expect(page.textContent).toContain("Sign in to Calendar again");
    expect(page.textContent).toContain("Not now");
  });
});

describe("waiting approvals", () => {
  it("names the chat a round was asked in as the owner names it", async () => {
    const { client } = owner({
      rows: [pending("a1", { announcedIn: { connectionId: "telegram-default", conversationId: "c-2", channel: "Telegram" } })],
    });
    const page = await mount(inbox(client));
    await settle();
    const card = page.querySelector(".center-cards > .center-card");
    expect(card?.querySelector(".center-card-note")?.textContent).toBe("Asked in Telegram");
    expect(card?.textContent).not.toContain("telegram-default");
  });

  it("titles a call in words, as the chat's card does, and never by its tool id twice", async () => {
    const { client } = owner({
      rows: [
        pending("a1", { toolId: "fs.write", summary: "notes.txt" }),
        pending("a2", { taskId: "t2", toolId: "agents.list", summary: undefined }),
      ],
    });
    const page = await mount(inbox(client));
    await settle();
    const headings = [...page.querySelectorAll(".center-cards > .center-card h3")].map((heading) => heading.textContent);
    expect(headings).toEqual(["Write notes.txt", "agents.list"]);
  });

  it("shows one card per round, offering only the scopes the round allows", async () => {
    const { client } = owner({
      rows: [
        pending("a1", { risk: "high", allowedScopes: ["once", "session"] }),
        pending("a2", {
          risk: "medium",
          toolId: "web_search",
          summary: "trains to Frankfurt",
          allowedScopes: ["once", "session", "always"],
        }),
        pending("a3", {
          taskId: "t2",
          steps: 0,
          risk: "low",
          allowedScopes: ["once", "session", "always"],
          expiresAt: new Date(Date.now() + (2 * 60 + 14) * 60_000 - 1000).toISOString(),
          announcedIn: { connectionId: "telegram-main", conversationId: "c-1" },
        }),
        pending("a4", { taskId: "t3", steps: 1, risk: undefined, allowedScopes: ["once"] }),
      ],
    });
    const page = await mount(inbox(client));
    await settle();
    const cards = [...page.querySelectorAll<HTMLElement>(".center-cards > .center-card")];
    expect(cards).toHaveLength(3);
    // The round that expires comes first: the queue is taken soonest deadline first.
    // One round, two calls: decided together, so its scopes are what both allow, and its risk the higher.
    const [second, first, third] = cards as [HTMLElement, HTMLElement, HTMLElement];
    expect(first.querySelector("h3")?.textContent).toBe("2 tool calls wait together");
    expect([...first.querySelectorAll(".center-card-calls li")].map((item) => item.textContent)).toEqual([
      "http.request https://bahn.de",
      "web_search trains to Frankfurt",
    ]);
    expect(buttons(first, "")).toEqual(["Allow once", "Allow for this chat", "Deny…"]);
    expect(first.className).toContain("center-card-high");
    expect(first.querySelector(".center-risk-tag")?.textContent).toBe("high risk");
    expect(first.querySelector(".center-card-ctx a")?.getAttribute("href")).toBe("/tasks/t1");
    expect(buttons(second, "")).toEqual(["Allow once", "Allow for this chat", "Always allow", "Deny…"]);
    expect(second.querySelector(".center-expires")?.textContent).toBe("expires in 2 h 14 min");
    expect(second.textContent).toContain("Asked in telegram-main");
    // No risk recorded: no stripe and no tag.
    expect(third.className).toBe("center-card");
    expect(third.querySelector(".center-risk-tag")).toBeNull();
    expect(buttons(third, "")).toEqual(["Allow once", "Deny…"]);
    expect(page.querySelector(".center-subhead span")?.textContent).toBe("3 approvals");
  });

  it("names the person only when the workspace has more than one", async () => {
    const { client } = owner({ rows: [pending("a1", { principalId: "p-ana" })] });
    const page = await mount(inbox(client, { answer: summary({ people: { operator: "You", "p-ana": "Ana" } }) }));
    await settle();
    expect(page.querySelector(".center-card-ctx")?.textContent).toBe("In Book train tickets · Ana");
  });

  it("asks a second, explicit step before approving a critical round, and sends the task card's approve", async () => {
    const { client, of } = owner({ rows: [pending("a1", { risk: "critical", allowedScopes: ["once"] })] });
    const page = await mount(inbox(client));
    await settle();
    await act(async () => button(page, "Allow once").click());
    expect(of("approve")).toHaveLength(0);
    expect(page.querySelector(".center-card .confirmation")?.textContent).toContain("This call is rated critical risk.");
    await act(async () => button(page, "Go back").click());
    expect(page.querySelector(".center-card .confirmation")).toBeNull();
    await act(async () => button(page, "Allow once").click());
    // Focus goes to Go back, not Confirm: a repeated Enter must not run the call.
    expect(document.activeElement).toBe(button(page, "Go back"));
    await act(async () => button(page, "Confirm and run").click());
    await settle();
    expect(of("approve").map((item) => item.payload)).toEqual([
      { taskId: "t1", workspaceId: "default", expectedSteps: 2, verdict: "approve", scope: "once", decidedBy: "operator" },
    ]);
    expect(page.querySelector(".center-card-decided")?.textContent).toContain("Allowed once · just now");
    expect(buttons(page)).toEqual([]);
    // The button that had focus is gone: focus is on the line saying how it ended.
    expect(document.activeElement).toBe(page.querySelector(".center-decided"));
  });

  it("asks the same second step for a round with no risk recorded, in the task card's words", async () => {
    const { client, of } = owner({ rows: [pending("a1", { risk: undefined, allowedScopes: ["once"] })] });
    const page = await mount(inbox(client));
    await settle();
    await act(async () => button(page, "Allow once").click());
    expect(of("approve")).toHaveLength(0);
    expect(page.querySelector(".center-card .confirmation p")?.textContent).toBe(
      "Confirm these tool actions. Approved calls may change local data.",
    );
    await act(async () => button(page, "Confirm and run").click());
    await settle();
    expect(of("approve")[0]?.payload).toMatchObject({ verdict: "approve", expectedSteps: 2 });
  });

  it("approves at once below critical, carrying the scope picked", async () => {
    const { client, of } = owner({ rows: [pending("a1", { risk: "medium", allowedScopes: ["once", "session", "always"] })] });
    const page = await mount(inbox(client));
    await settle();
    await act(async () => button(page, "Allow for this chat").click());
    await settle();
    expect(of("approve")[0]?.payload).toMatchObject({ verdict: "approve", scope: "session", expectedSteps: 2 });
    expect(page.querySelector(".center-card-decided")?.textContent).toContain("Allowed for this chat · just now");
  });

  it("says a Home's chat grant lasts until tomorrow, and the s key still takes it", async () => {
    const { client, of } = owner({
      rows: [{ ...pending("a1", { risk: "medium", allowedScopes: ["once", "session"] }), lastingChat: true }],
    });
    const page = await mount(inbox(client));
    await settle();
    expect(buttons(page.querySelector<HTMLElement>(".center-card")!, "")).toEqual(["Allow once", "Allow until tomorrow", "Deny…"]);
    expect(button(page, "Allow until tomorrow").title).toBe("Runs without asking in this chat for a day, or until it rolls over");
    const card = page.querySelector<HTMLElement>(".center-cards > .center-card")!;
    card.focus();
    await act(async () => card.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true })));
    await settle();
    expect(of("approve")[0]?.payload).toMatchObject({ verdict: "approve", scope: "session" });
    expect(page.querySelector(".center-card-decided")?.textContent).toContain("Allowed until tomorrow · just now");
  });

  it("says where the round's chat read untrusted content, and why that matters, and nothing for a clean one", async () => {
    const { client } = owner({
      rows: [pending("a1", { provenance: "⚠ after reading news.example — once only" }), pending("a2", { taskId: "t2" })],
    });
    const page = await mount(inbox(client));
    await settle();
    const [tainted, clean] = [...page.querySelectorAll<HTMLElement>(".center-cards > .center-card")];
    expect(tainted?.querySelector(".center-card-provenance")?.textContent?.startsWith("after reading news.example — once only")).toBe(true);
    expect(tainted?.querySelector(".center-card-provenance")?.textContent).not.toContain("⚠");
    expect(tainted?.querySelector(".center-card-why")?.textContent).toContain("Tavi does not trust");
    expect(clean?.querySelector(".center-card-provenance")).toBeNull();
  });

  it("collapses a round settled elsewhere to where, by whom and when — not an error", async () => {
    const settled = {
      taskId: "t1",
      steps: 2,
      state: "granted",
      decidedBy: "p-ana",
      decidedAt: "2026-09-29T12:02:00.000Z",
      via: "telegram-main",
      channel: "Telegram",
    };
    const { client } = owner({
      rows: [pending("a1")],
      decision: { ok: false, error: { code: "CONFLICT", message: "round already decided", details: { settled } } },
    });
    const page = await mount(inbox(client, { answer: summary({ people: { operator: "You", "p-ana": "Ana" } }) }));
    await settle();
    await act(async () => button(page, "Deny…").click());
    await act(async () => button(page, "Deny").click());
    await settle();
    expect(page.querySelector(".center-card-decided")?.textContent).toContain("Already decided in Telegram by Ana, 14:02");
    expect(page.querySelector(".center-card .failure")).toBeNull();
  });

  it("rejects with a reason the task reads, decides a round per call, and shows a call's input on demand", async () => {
    const { client, of } = owner({
      rows: [
        pending("a1", { risk: "low" }),
        pending("a2", { risk: "low", toolId: "web_search", summary: "trains" }),
        pending("b1", { taskId: "t2", steps: 1, risk: "low" }),
      ],
      show: {
        calls: [
          { steps: 2, callId: "call-a1", toolId: "http.request", inputs: { url: "https://bahn.de", method: "GET" }, state: "pending" },
        ],
      },
    });
    const page = await mount(inbox(client));
    await settle();
    const cardOf = (taskId: string) =>
      [...page.querySelectorAll<HTMLElement>(".center-card")].find(
        (card) => card.querySelector(".center-card-ctx a")?.getAttribute("href") === `/tasks/${taskId}`,
      );
    // Reject with a reason: the reason box takes focus, and the note travels with the verdict.
    const single = cardOf("t2");
    await act(async () =>
      [...(single?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent === "Deny…")?.click(),
    );
    const reason = single?.querySelector("textarea");
    expect(document.activeElement).toBe(reason);
    await act(async () => {
      if (reason) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(reason, "Use the cached page");
        reason.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(async () =>
      [...(single?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent === "Deny")?.click(),
    );
    await settle();
    expect(of("approve").at(-1)?.payload).toMatchObject({ taskId: "t2", verdict: "reject", note: "Use the cached page" });

    // Untick one call: the rest is approved, that one rejected.
    const both = cardOf("t1");
    const boxes = [...(both?.querySelectorAll<HTMLInputElement>(".center-card-calls input") ?? [])];
    await act(async () => boxes[1]?.click());
    await act(async () =>
      [...(both?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
        .find((candidate) => candidate.textContent === "Allow ticked, deny the rest")
        ?.click(),
    );
    await settle();
    expect(of("approve").at(-1)?.payload).toMatchObject({
      taskId: "t1",
      decisions: [
        { callId: "call-a1", approved: true },
        { callId: "call-a2", approved: false },
      ],
    });
    expect([...page.querySelectorAll(".center-card-decided")].map((card) => card.textContent).join(" ")).toContain(
      "Allowed 1 of 2, denied the rest",
    );
  });

  it("takes a per-call decision on a critical round through its confirm, holds the ticks while it is open, and sends the unticked's reason", async () => {
    const { client, of } = owner({
      rows: [pending("a1", { risk: "critical" }), pending("a2", { risk: "critical", toolId: "web_search", summary: "trains" })],
    });
    const page = await mount(inbox(client));
    await settle();
    const boxes = () => [...page.querySelectorAll<HTMLInputElement>(".center-card-calls input")];
    await act(async () => boxes()[1]?.click());
    const reason = page.querySelector<HTMLTextAreaElement>(".center-reason textarea");
    await act(async () => {
      if (reason) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(reason, "Not that search");
        reason.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(async () => button(page, "Allow ticked, deny the rest").click());
    // Confirming: the ticks it was opened for cannot change under it.
    expect(boxes().every((box) => box.disabled)).toBe(true);
    expect(of("approve")).toHaveLength(0);
    await act(async () => button(page, "Confirm and run").click());
    await settle();
    expect(of("approve").at(-1)?.payload).toMatchObject({
      decisions: [
        { callId: "call-a1", approved: true },
        { callId: "call-a2", approved: false, note: "Not that search" },
      ],
    });
  });

  it("triages by keyboard: j/k move between cards, a approves, r starts a rejection, o opens the task", async () => {
    const opened: string[] = [];
    const { client, of } = owner({
      rows: [pending("a1", { risk: "low" }), pending("b1", { taskId: "t2", steps: 1, risk: "low", expiresAt: "2099-01-01T00:00:00.000Z" })],
      needs: needs([questionRow("w1", { deadlineAt: "2098-01-01T00:00:00.000Z" })]),
    });
    const page = await mount(inbox(client, { opened }));
    await settle();
    const list = page.querySelector<HTMLElement>(".center-cards")!;
    const key = async (name: string) =>
      act(async () => (document.activeElement ?? list).dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
    await act(async () => list.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
    // The soonest first: the question, focused on its question so its own keys work.
    expect(document.activeElement?.textContent).toBe("Which day?");
    await key("j");
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Approval/);
    expect(document.activeElement?.querySelector(".center-card-ctx a")?.getAttribute("href")).toBe("/tasks/t2");
    await key("r");
    expect(document.activeElement?.tagName).toBe("TEXTAREA");
    await act(async () => button(page, "Go back").click());
    const roundCard = page.querySelector<HTMLElement>(".center-card[aria-label^='Approval']")!;
    await act(async () => roundCard.focus());
    await key("o");
    expect(opened).toEqual(["t2"]);
    await act(async () => roundCard.focus());
    await key("a");
    await settle();
    expect(of("approve").at(-1)?.payload).toMatchObject({ taskId: "t2", verdict: "approve" });
  });

  it("moves past an answered question's receipt by keyboard", async () => {
    const { client } = owner({
      rows: [pending("a1", { risk: "low" })],
      needs: needs([questionRow("w1", { deadlineAt: "2098-01-01T00:00:00.000Z" })]),
    });
    const page = await mount(inbox(client));
    await settle();
    const tuesday = [...page.querySelectorAll<HTMLButtonElement>(".center-card-question button.need-option")].find((option) =>
      option.textContent?.includes("Tuesday"),
    );
    await act(async () => tuesday?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    const list = page.querySelector<HTMLElement>(".center-cards");
    await act(async () => list?.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
    expect(document.activeElement?.classList.contains("center-card-question")).toBe(true);
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })));
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Approval/);
  });

  it("shows a round's full input in Details, read only when opened", async () => {
    const { client, of } = owner({
      rows: [pending("a1", { risk: "low" })],
      show: {
        calls: [
          { steps: 2, callId: "call-a1", toolId: "http.request", inputs: { url: "https://bahn.de", method: "GET" }, state: "pending" },
        ],
      },
    });
    const page = await mount(inbox(client));
    await settle();
    expect(of("approvals", "show")).toHaveLength(0);
    const details = page.querySelector<HTMLDetailsElement>(".center-card-details");
    await act(async () => {
      if (details) {
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      }
    });
    await settle();
    expect(of("approvals", "show").at(-1)?.payload).toMatchObject({ taskId: "t1" });
    expect(page.querySelector(".center-card-call pre")?.textContent).toContain('"url": "https://bahn.de"');
  });

  it("shows any other refusal under the card, which stays decidable", async () => {
    const { client } = owner({
      rows: [pending("a1")],
      decision: { ok: false, error: { code: "UNAVAILABLE", message: "this owner has no model connection" } },
    });
    const page = await mount(inbox(client));
    await settle();
    await act(async () => button(page, "Allow once").click());
    await settle();
    expect(page.querySelector(".center-card .failure")?.textContent).toBe("this owner has no model connection");
    expect(button(page, "Allow once").disabled).toBe(false);
  });

  it("answers a question in place, opens a review's task, and says when nothing waits", async () => {
    const opened: string[] = [];
    const { client, of } = owner({
      rows: [],
      needs: needs(
        [
          questionRow("w5", {
            origin: "schedule",
            originLabel: "Daily release",
            deliveries: [{ connectionId: "telegram-main", channel: "Telegram" }],
          }),
        ],
        [reviewRow("t6")],
      ),
    });
    const page = await mount(inbox(client, { opened }));
    await settle();
    // The question, its options and where else it was asked — answered here, not in the task.
    const card = page.querySelector<HTMLElement>(".center-card-question")!;
    expect(card.querySelector("h3")?.textContent).toBe("Which day?");
    expect(card.textContent).toContain("Daily release");
    expect(card.textContent).toContain("Also asked in Telegram");
    expect(page.textContent).not.toContain("Answer it in the task's chat");
    const tuesday = [...card.querySelectorAll<HTMLButtonElement>("button.need-option")].find((option) =>
      option.textContent?.includes("Tuesday"),
    )!;
    await act(async () => tuesday.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(of("approvals", "answer").at(-1)?.payload).toEqual({
      action: "answer",
      workspaceId: "default",
      taskId: "task-w5",
      waitId: "w5",
      answer: "Tuesday",
    });
    expect(page.querySelector(".center-card-question .need-receipt")?.textContent).toContain("You answered Tuesday");
    // The review opens its task.
    await act(async () =>
      [...page.querySelectorAll<HTMLButtonElement>(".center-card .button-primary")].find((open) => open.textContent === "Open")!.click(),
    );
    expect(opened).toEqual(["t6"]);
    unmountAll();

    const empty = owner({ rows: [] });
    const nothing = await mount(inbox(empty.client));
    await settle();
    expect(nothing.textContent).toContain("Nothing needs you.");
    expect(nothing.textContent).toContain("Decisions you make appear here.");
  });

  it("keeps a failed answer's card open with Retry, and lists a schedule's round under From schedules", async () => {
    const state = {
      rows: [pending("a1", { taskId: "t-sched", task: { principalId: "operator", origin: "schedule" } })] as readonly PendingListRow[],
      needs: needs([questionRow("w1")]),
      answer: { ok: false, error: { code: "UNAVAILABLE", message: "The owner is busy." } } as Answer,
    };
    const { client, of } = owner(state);
    const page = await mount(inbox(client));
    await settle();
    const option = () => page.querySelector<HTMLElement>(".center-card-question button.need-option")!;
    await act(async () => option().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(page.querySelector(".center-card-question [role=alert]")?.textContent).toContain("The owner is busy.");
    state.answer = { ok: true, result: {} };
    await act(async () => page.querySelector<HTMLButtonElement>(".center-card-question [role=alert] button")!.click());
    await settle();
    expect(of("approvals", "answer")).toHaveLength(2);
    expect(page.querySelector(".center-card-question .need-receipt")?.textContent).toContain("You answered Monday");
    await act(async () => button(page, "From schedules").click());
    expect([...page.querySelectorAll(".center-card[aria-label^='Approval']")].filter((node) => !node.hasAttribute("hidden"))).toHaveLength(
      1,
    );
  });

  it("folds what left the queue elsewhere into Resolved just now, with who and how", async () => {
    const state: {
      rows: readonly PendingListRow[];
      needs: readonly NeedRow[];
      history: (payload: Record<string, unknown>) => { items: readonly ApprovalHistoryItem[] };
    } = {
      rows: [pending("a1")],
      needs: needs([questionRow("w1")]),
      history: () => ({ items: [] }),
    };
    const { client } = owner(state);
    const page = await mount(inbox(client, { revision: 1 }));
    await settle();
    expect(page.querySelector(".center-resolved")).toBeNull();
    // Answered in Telegram, and the round decided by an email link, while the page was open.
    state.rows = [];
    state.needs = [];
    state.history = () => ({
      items: [
        {
          kind: "question",
          waitId: "w1",
          taskId: "task-w1",
          principalId: "operator",
          state: "answered",
          question: "Which day?",
          answer: "Monday",
          decidedAt: "2026-09-29T12:02:00.000Z",
          decidedBy: "ana",
          via: "telegram-main",
          channel: "Telegram",
        },
        approval("a1", { via: "link", channel: "email link", decidedBy: "ana" }),
      ],
    });
    await rerender(inbox(client, { revision: 2 }));
    await settle();
    await settle();
    expect(page.querySelector(".center-resolved summary")?.textContent).toBe("Resolved just now (2)");
    expect([...page.querySelectorAll(".center-resolved li")].map((line) => line.textContent)).toEqual([
      "“Which day?” — answered “Monday” in Telegram by ana, 14:02",
      "Request https://bahn.de — approved in email link by ana, 14:02",
    ]);
  });

  it("says a need was resolved elsewhere when the history has no record, and leaves out what was decided here", async () => {
    const state: { rows: readonly PendingListRow[]; needs: readonly NeedRow[] } = {
      rows: [pending("a1"), pending("a2", { taskId: "t2" })],
      needs: needs([questionRow("w1")]),
    };
    const { client } = owner(state);
    const page = await mount(inbox(client, { revision: 1 }));
    await settle();
    // a2 decided here; a1 and the question resolved somewhere the history does not show yet.
    const cards = [...page.querySelectorAll<HTMLElement>(".center-cards > .center-card[aria-label^='Approval']")];
    const here = cards.find((card) => card.querySelector(".center-card-ctx a")?.getAttribute("href") === "/tasks/t2");
    const approve = [...(here?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (candidate) => candidate.textContent === "Allow once",
    );
    if (approve === undefined) throw new Error("t2's round offers no Approve");
    await act(async () => approve.click());
    await settle();
    state.rows = [];
    state.needs = [];
    await rerender(inbox(client, { revision: 2 }));
    await settle();
    await settle();
    expect([...page.querySelectorAll(".center-resolved li")].map((line) => line.textContent)).toEqual([
      "“Which day?” — resolved elsewhere",
      "Request https://bahn.de — resolved elsewhere",
    ]);
  });

  it("orders by deadline, keeps a task's needs together, filters by kind, and says when an answer came too late", async () => {
    const { client } = owner({
      rows: [pending("a1", { taskId: "task-late", expiresAt: "2099-01-01T12:00:00.000Z" })],
      needs: needs([
        questionRow("late", { deadlineAt: "2099-01-01T11:00:00.000Z" }),
        questionRow("soon", { deadlineAt: "2099-01-01T09:00:00.000Z", origin: "schedule" }),
      ]),
      answer: { ok: false, error: { code: "CONFLICT", message: "This question was already answered, or has closed." } },
    });
    const page = await mount(inbox(client));
    await settle();
    const order = () =>
      [...page.querySelectorAll(".center-cards > li")].map((item) =>
        item.classList.contains("center-group-head") ? `group:${item.textContent}` : item.getAttribute("aria-label"),
      );
    expect(order()).toEqual([
      "Question: Which day?",
      "group:Task late · 2 waiting",
      "Question: Which day?",
      expect.stringMatching(/^Approval/),
    ]);
    const visible = (selector: string) => [...page.querySelectorAll(selector)].filter((node) => !node.hasAttribute("hidden"));
    await act(async () => button(page, "Approvals").click());
    expect(visible(".center-card-question")).toHaveLength(0);
    expect(visible(".center-card[aria-label^='Approval']")).toHaveLength(1);
    await act(async () => button(page, "From schedules").click());
    expect(visible(".center-card-question")).toHaveLength(1);
    await act(async () => button(page, "All").click());
    const first = page.querySelector<HTMLElement>(".center-card-question button.need-option")!;
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(page.textContent).toContain("Answered elsewhere, or closed, before your answer reached it.");
  });
});

const approval = (approvalId: string, extra: Partial<Extract<ApprovalHistoryItem, { kind: "approval" }>> = {}): ApprovalHistoryItem => ({
  kind: "approval",
  approvalId,
  taskId: "t1",
  taskTitle: "Book train tickets",
  principalId: "operator",
  toolId: "browser.navigate",
  summary: "https://bahn.de",
  state: "granted",
  decidedBy: "operator",
  decidedAt: "2026-09-29T12:02:00.000Z",
  via: "bridge",
  channel: "web",
  scope: "once",
  note: null,
  ...extra,
});

describe("the history", () => {
  it("renders approvals, reviews and questions, links an always rule to revoke it, and pages on", async () => {
    const permissions: (string | undefined)[] = [];
    const { client, of } = owner({
      rows: [],
      history: (payload) =>
        payload["cursor"] === undefined
          ? {
              items: [
                approval("h1", { scope: "always", ruleId: "rule-1" }),
                // An "Always" row with no rule recorded has nothing to link to.
                approval("h0", { scope: "always", decidedAt: "2026-09-29T11:00:00.000Z" }),
                {
                  kind: "review",
                  artifactId: "art-1",
                  taskId: "t2",
                  taskTitle: "Draft report",
                  principalId: "operator",
                  state: "rejected",
                  decidedBy: "operator",
                  decidedAt: "2026-09-28T14:09:00.000Z",
                  note: "Wrong figures",
                  contentType: "application/pdf",
                },
                {
                  kind: "question",
                  waitId: "w1",
                  taskId: "t3",
                  taskTitle: "Plan trip",
                  principalId: "operator",
                  state: "answered",
                  question: "Which day?",
                  answer: "Monday",
                  decidedAt: "2026-09-01T08:00:00.000Z",
                },
                // Who answered and through what, once recorded.
                {
                  kind: "question",
                  waitId: "w2",
                  taskId: "t3",
                  taskTitle: "Plan trip",
                  principalId: "operator",
                  state: "answered",
                  question: "Which time?",
                  answer: "9:00",
                  decidedAt: "2026-09-01T08:00:00.000Z",
                  decidedBy: "operator",
                  via: "telegram-main",
                  channel: "Telegram",
                },
              ],
              nextCursor: "next-1",
            }
          : {
              items: [
                approval("h2", {
                  state: "expired",
                  decidedBy: "policy:expired",
                  via: "policy",
                  channel: "policy",
                  scope: undefined,
                  decidedAt: "2026-08-01T08:00:00.000Z",
                }),
              ],
            },
    });
    const page = await mount(inbox(client, { permissions: (ruleId) => void permissions.push(ruleId) }));
    await settle();
    const rows = () =>
      [...page.querySelectorAll(".center-history tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
    expect(rows()).toEqual([
      ["Approved", "https://bahn.debrowser.navigate", "Book train tickets", "operator · web", "AlwaysRevoke in Permissions", "14:02"],
      ["Approved", "https://bahn.debrowser.navigate", "Book train tickets", "operator · web", "Always", "13:00"],
      ["Rejected", "Review of a resultapplication/pdf“Wrong figures”", "Draft report", "operator", "—", "Mon 16:09"],
      ["Answered", "Which day?→ Monday", "Plan trip", "—", "—", "1 Sep"],
      ["Answered", "Which time?→ 9:00", "Plan trip", "operator · Telegram", "—", "1 Sep"],
    ]);
    expect(page.querySelector(".center-verdict-approved")).not.toBeNull();
    const revoke = [...page.querySelectorAll<HTMLAnchorElement>(".center-history a")].find(
      (link) => link.textContent === "Revoke in Permissions",
    );
    // The link names the rule, so Permissions can point it out.
    expect(revoke?.getAttribute("href")).toBe("/settings/permissions#rule-rule-1");
    await act(async () => revoke?.click());
    expect(permissions).toEqual(["rule-1"]);

    await act(async () => button(page, "Load more").click());
    await settle();
    expect(of("approvals", "history").at(-1)?.payload).toMatchObject({ cursor: "next-1", limit: 50 });
    expect(rows()).toHaveLength(6);
    expect(rows()[5]?.slice(0, 2)).toEqual(["Expired", "https://bahn.debrowser.navigate"]);
    expect(rows()[5]?.[3]).toBe("policy");
    expect(page.querySelector(".center-more")).toBeNull();
  });

  it("filters by a tool the history has shown, asking the owner for it, and drops it for a kind with no tools", async () => {
    const { client, of } = owner({
      rows: [],
      history: (payload) => ({
        items:
          payload["toolId"] === "web_search"
            ? [approval("h2", { toolId: "web_search" })]
            : [approval("h1"), approval("h2", { toolId: "web_search" }), approval("h3", { toolId: "browser.navigate" })],
      }),
    });
    const page = await mount(inbox(client));
    await settle();
    expect(buttons(page, '[aria-label="Filter by tool"]')).toEqual(["Any tool", "browser.navigate", "web_search"]);
    await act(async () => button(page, "web_search").click());
    await settle();
    expect(of("approvals", "history").at(-1)?.payload).toMatchObject({ toolId: "web_search" });
    // Every tool seen stays offered while one filters.
    expect(buttons(page, '[aria-label="Filter by tool"]')).toEqual(["Any tool", "browser.navigate", "web_search"]);
    // Questions have no tool: the tool filter is dropped with them.
    await act(async () => button(page, "Questions").click());
    await settle();
    expect(of("approvals", "history").at(-1)?.payload["toolId"]).toBeUndefined();
    expect(page.querySelector('[aria-label="Filter by tool"]')).toBeNull();
    await act(async () => button(page, "Approvals").click());
    await settle();
    expect(buttons(page, '[aria-label="Filter by tool"]')).toEqual(["Any tool", "browser.navigate", "web_search"]);
    expect(page.querySelector('[aria-label="Filter by tool"] [aria-pressed="true"]')?.textContent).toBe("Any tool");
  });

  it("asks the owner for the kind and verdict picked", async () => {
    const { client, of } = owner({ rows: [], history: () => ({ items: [] }) });
    const page = await mount(inbox(client));
    await settle();
    await act(async () => button(page, "Approvals").click());
    await settle();
    expect(of("approvals", "history").at(-1)?.payload).toMatchObject({ kinds: ["approval"] });
    expect(of("approvals", "history").at(-1)?.payload["states"]).toBeUndefined();
    // A kind offers only the verdicts it can have.
    expect(buttons(page, '[aria-label="Filter by decision"]')).toEqual(["Any decision", "Approved", "Rejected", "Expired", "Cancelled"]);
    await act(async () => button(page, "Approved").click());
    await settle();
    expect(of("approvals", "history").at(-1)?.payload).toMatchObject({ kinds: ["approval"], states: ["granted"] });
    expect(page.textContent).toContain("No decisions match these filters.");
    // No person filter while the workspace has one person.
    expect(page.querySelector('[aria-label="Filter by person"]')).toBeNull();
  });
});

describe("the feed's refresh", () => {
  it("reads both lists again when the feed reports an approval, review or question — and not for a task", async () => {
    const state = { rows: [pending("a1")] as readonly PendingListRow[] };
    const { client, of } = owner(state);
    const feed = (revisions: Record<string, number>) => ({ summary: summary(), error: undefined, revisions });
    const page = (revisions: Record<string, number>) => (
      <WorkspaceProvider client={client} workspaceId="default" timeZone={undefined}>
        <CenterPage
          section="approvals"
          feed={feed(revisions)}
          principal="operator"
          onSection={() => undefined}
          onOpenRoutine={() => undefined}
          onOpenTask={async () => undefined}
          onPermissions={() => undefined}
        />
      </WorkspaceProvider>
    );
    const shown = await mount(page({}));
    await settle();
    expect(shown.querySelectorAll(".center-cards > .center-card")).toHaveLength(1);
    expect(of("approvals", "list")).toHaveLength(1);
    expect(of("approvals", "history")).toHaveLength(1);

    await rerender(page({ task: 3 }));
    await settle();
    expect(of("approvals", "list")).toHaveLength(1);

    state.rows = [];
    await rerender(page({ task: 3, approval: 1 }));
    await settle();
    expect(of("approvals", "list")).toHaveLength(2);
    // The history's own page, and once more to say how the round that left was resolved.
    expect(of("approvals", "history")).toHaveLength(3);
    expect(of("approvals", "needs")).toHaveLength(2);
    expect(shown.textContent).toContain("Nothing needs you.");

    await rerender(page({ task: 3, approval: 1, question: 1 }));
    await settle();
    expect(of("approvals", "list")).toHaveLength(3);
  });

  it("keeps a card decided here, collapsed, after the refresh drops its round", async () => {
    const state = { rows: [pending("a1"), pending("a2", { taskId: "t2" })] as readonly PendingListRow[] };
    const { client } = owner(state);
    const page = await mount(inbox(client));
    await settle();
    await act(async () => (page.querySelectorAll<HTMLButtonElement>(".center-card .button-primary")[0] as HTMLButtonElement).click());
    await settle();
    state.rows = [pending("a2", { taskId: "t2" })];
    await rerender(inbox(client, { revision: 1 }));
    await settle();
    const cards = [...page.querySelectorAll(".center-cards > .center-card")];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("Allowed once · just now");
    expect(cards[1]?.querySelector("h3")).not.toBeNull();
  });
});

describe("the rail", () => {
  it("links what waits into Approvals and puts focus on the Waiting heading", async () => {
    const picked: string[] = [];
    const page = await mount(
      <>
        <h2 id={WAITING_ANCHOR} tabIndex={-1}>
          Waiting
        </h2>
        <CenterRail summary={summary()} onSection={(section) => void picked.push(section)} />
      </>,
    );
    const need = page.querySelector<HTMLAnchorElement>("a.center-need");
    expect(need?.getAttribute("href")).toBe("/center/approvals");
    await act(async () => {
      need?.click();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(picked).toEqual(["approvals"]);
    expect(document.activeElement?.id).toBe(WAITING_ANCHOR);
  });
});

describe("the rail's reconnects", () => {
  it("asks to reconnect a channel whose sign-in lapsed, by its name, into Settings → Channels", async () => {
    const page = await mount(
      <CenterRail
        summary={summary({
          reconnect: [
            { connectionId: "mail-1", providerId: "inbox", label: "Work mail", authState: "expired" },
            { connectionId: "mail-2", providerId: "inbox", authState: "needs-consent" },
          ],
        })}
        onSection={() => undefined}
      />,
    );
    const links = [...page.querySelectorAll<HTMLAnchorElement>('[aria-label="Channels to reconnect"] a')];
    expect(links.map((link) => link.querySelector(".center-need-title")?.textContent)).toEqual(["Reconnect Work mail", "Reconnect inbox"]);
    expect(links[0]?.getAttribute("href")).toBe("/settings/messaging");
    expect(links[1]?.textContent).toContain("asks for access it was not granted");
    expect(page.textContent).not.toContain("Nothing is waiting on you.");
  });

  it("shows the owner's app repairs in their place when it lists them, each opening its app", async () => {
    const apps = [
      {
        kind: "sign-in" as const,
        accountId: "mail-1",
        title: "Reconnect Work mail",
        detail: "Its sign-in expired or was revoked.",
        cli: "tavi channels connect mail-1",
        appId: "mail-app",
        appName: "Mail",
      },
    ];
    const page = await mount(
      <CenterRail
        summary={summary({
          apps,
          reconnect: [{ connectionId: "mail-1", providerId: "inbox", label: "Work mail", authState: "expired" }],
          servers: [{ pluginId: "mcp.cal", kind: "login", updatedAt: "2026-09-29T10:00:00.000Z" }],
        })}
        onSection={() => undefined}
      />,
    );
    const links = [...page.querySelectorAll<HTMLAnchorElement>('[aria-label="Connected apps"] a')];
    expect(links.map((link) => link.querySelector(".center-need-title")?.textContent)).toEqual(["Reconnect Work mail"]);
    expect(links[0]?.getAttribute("href")).toBe("/settings/apps/mail-app");
    expect(page.querySelector('[aria-label="Channels to reconnect"]')).toBeNull();
    expect(page.querySelector('[aria-label="Servers"]')).toBeNull();
  });

  it("opens an MCP server's review straight from its review repair, as its notice did", async () => {
    const apps = [
      {
        kind: "review-tools" as const,
        accountId: "mcp.kb",
        title: "Review kb's tools",
        detail: "1 of its tools changed.",
        cli: "tavi mcp show mcp.kb",
        appId: "mcp.kb",
        appName: "kb",
      },
      {
        kind: "review-tools" as const,
        accountId: "acme.notes",
        title: "Review Notes",
        detail: "It has no approved version yet.",
        cli: "tavi plugins show acme.notes",
        appId: "acme-notes",
        appName: "Notes",
      },
    ];
    const page = await mount(<CenterRail summary={summary({ apps })} onSection={() => undefined} />);
    const links = [...page.querySelectorAll<HTMLAnchorElement>('[aria-label="Connected apps"] a')];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/settings/apps?review=mcp.kb", "/settings/apps/acme-notes"]);
  });

  it("runs an MCP server's Try again and Turn on in place, and links every other repair (Center rail)", async () => {
    const apps = [
      {
        kind: "retry" as const,
        accountId: "mcp.kb",
        title: "kb stopped working",
        detail: "it failed repeatedly",
        cli: "tavi mcp probe mcp.kb",
        appId: "mcp.kb",
        appName: "kb",
      },
      {
        kind: "enable" as const,
        accountId: "mcp.cal",
        title: "Turn Calendar on",
        detail: "It is turned off; its tools aren't offered.",
        cli: "tavi plugins enable mcp.cal",
        appId: "cal",
        appName: "Calendar",
      },
      {
        kind: "enable" as const,
        accountId: "acme.notes",
        title: "Turn Notes on",
        detail: "It is turned off.",
        cli: "tavi plugins enable acme.notes",
        appId: "acme-notes",
        appName: "Notes",
      },
    ];
    const fixed: string[] = [];
    const page = await mount(
      <CenterRail
        summary={summary({ apps })}
        onSection={() => undefined}
        onFixApp={async (item) => {
          fixed.push(`${item.kind}:${item.accountId ?? ""}`);
          return item.kind === "retry" ? { ok: false, message: "It still fails." } : { ok: true, value: undefined };
        }}
      />,
    );
    const list = page.querySelector('[aria-label="Connected apps"]') as HTMLElement;
    expect([...list.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["/settings/apps/acme-notes"]);
    const [retry, enable] = [...list.querySelectorAll("button")];
    await act(async () => retry?.click());
    await act(async () => enable?.click());
    expect(fixed).toEqual(["retry:mcp.kb", "enable:mcp.cal"]);
    expect([...list.querySelectorAll("button .center-need-detail")].map((detail) => detail.textContent)).toEqual([
      "It still fails.",
      "Done.",
    ]);
  });

  it("keeps a tool budget's notice, and lists nothing when no app needs the reader", async () => {
    const page = await mount(
      <CenterRail
        summary={summary({
          apps: [],
          reconnect: [{ connectionId: "mail-1", providerId: "inbox", label: "Work mail", authState: "expired" }],
          servers: [
            { pluginId: "mcp.cal", kind: "budget", updatedAt: "2026-09-29T10:00:00.000Z" },
            { pluginId: "mcp.cal", kind: "login", updatedAt: "2026-09-29T10:00:00.000Z" },
          ],
        })}
        onSection={() => undefined}
      />,
    );
    expect([...page.querySelectorAll('[aria-label="Servers"] .center-need-title')].map((title) => title.textContent)).toEqual([
      "mcp.cal: its tools do not fit",
    ]);
    const empty = await mount(
      <CenterRail
        summary={summary({
          apps: [],
          reconnect: [{ connectionId: "mail-1", providerId: "inbox", label: "Work mail", authState: "expired" }],
        })}
        onSection={() => undefined}
      />,
    );
    expect(empty.querySelector('[aria-label="Channels to reconnect"]')).toBeNull();
    expect(empty.querySelector('[aria-label="Connected apps"]')).toBeNull();
  });
});

describe("the inbox's reads", () => {
  it("counts down in minutes", () => {
    const now = Date.parse("2026-09-29T10:00:00.000Z");
    expect(expiryLabel("2026-09-29T10:04:30.000Z", now)).toBe("expires in 5 min");
    expect(expiryLabel("2026-09-29T12:00:00.000Z", now)).toBe("expires in 2 h");
    expect(expiryLabel("2026-09-29T09:59:00.000Z", now)).toBe("expired");
  });

  it("says when in the workspace zone: the time today, the weekday this week, the date before", () => {
    expect(whenLabel("2026-09-29T12:02:00.000Z", "Europe/Berlin", "2026-09-29")).toBe("14:02");
    expect(whenLabel("2026-09-28T14:09:00.000Z", "Europe/Berlin", "2026-09-29")).toBe("Mon 16:09");
    expect(whenLabel("2026-09-22T14:09:00.000Z", "Europe/Berlin", "2026-09-29")).toBe("22 Sep");
    expect(whenLabel("2025-12-30T14:09:00.000Z", "Europe/Berlin", "2026-09-29")).toBe("30 Dec 2025");
  });

  it("offers a round only what every call allows, and once from an owner that sends no scopes", () => {
    const rows = [pending("a1", { allowedScopes: ["once", "session", "always"] }), pending("a2", { allowedScopes: undefined })];
    expect(groupRounds(rows)[0]?.allowedScopes).toEqual(["once"]);
  });

  it("maps verdicts onto the owner's states for the kind picked", () => {
    expect(historyFilters("all", "approved", "all")).toEqual({ states: ["granted", "approved"] });
    expect(historyFilters("review", "approved", "p1")).toEqual({ kinds: ["review"], states: ["approved"], principalId: "p1" });
    expect(verdictFilters("question")).toEqual(["answered", "expired", "cancelled"]);
  });
});

describe("resolvedText", () => {
  it("says how a need ended: answered, expired, closed, or decided", async () => {
    const { resolvedText } = await import("../../../src/features/center/inbox-model.js");
    const question = (extra: Partial<Extract<ApprovalHistoryItem, { kind: "question" }>>): ApprovalHistoryItem => ({
      kind: "question",
      waitId: "w",
      taskId: "t",
      principalId: "operator",
      state: "answered",
      question: "Q?",
      answer: null,
      decidedAt: "2026-09-29T12:02:00.000Z",
      ...extra,
    });
    expect(resolvedText("“Q?”", question({ state: "expired" }), "Europe/Berlin", "2026-09-29", {})).toBe(
      "“Q?” — no answer came in time, 14:02",
    );
    expect(resolvedText("“Q?”", question({ state: "cancelled" }), "Europe/Berlin", "2026-09-29", {})).toBe(
      "“Q?” — closed with its task, 14:02",
    );
    expect(resolvedText("x", approval("a", { state: "expired" }), "Europe/Berlin", "2026-09-29", {})).toBe(
      "x — expired without a decision, 14:02",
    );
    expect(resolvedText("x", approval("a", { state: "denied", decidedBy: "ana" }), "Europe/Berlin", "2026-09-29", { ana: "Ana" })).toBe(
      "x — rejected in web by Ana, 14:02",
    );
  });
});

describe("the inbox's accessibility", () => {
  it("has no WCAG 2.1 A/AA violations axe can find, with an approval, a question and a review waiting", async () => {
    const { client } = owner({
      rows: [pending("a1", { risk: "high", allowedScopes: ["once", "session"] })],
      needs: needs(
        [
          questionRow("w1", {
            context: "The venue asked.",
            choices: {
              options: [{ label: "Monday", description: "Free all day" }, { label: "Tuesday" }],
              multiSelect: false,
              allowOther: true,
              recommended: 1,
            },
          }),
        ],
        [reviewRow("t9")],
      ),
    });
    const page = await mount(inbox(client));
    await settle();
    expect(page.querySelectorAll(".center-card").length).toBeGreaterThanOrEqual(3);
    // Contrast needs layout jsdom does not have: the design tokens' test covers it.
    const result = await axe.run(page, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(
      result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`),
    ).toEqual([]);
  });
});
