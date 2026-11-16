import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { initialRunState } from "@tavi/client";
import { CLIENT_PROTOCOL_VERSION, ClientEventSchema, printable, type ClientEvent } from "@tavi/contracts";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

import { colored } from "../../src/tui/theme.js";
import {
  ChatStore,
  MAX_LIVE_ROWS,
  plainEmphasis,
  liveRowBudget,
  pendingRoundsOf,
  statusLine,
  wrapRows,
  type ChatView,
  unbrokenWidth,
} from "../../src/tui/store.js";
import { recordedLine } from "../../src/tui/index.js";

/**
 * The chat TUI's store: events reduced above the React
 * tree, finished lines committed in order to the scrollback, and a live region
 * that never reaches the viewport's height, so Ink never clears the terminal
 * and its scrollback.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/client/test/fixtures");
const fixture = (name: string): ClientEvent[] =>
  readFileSync(join(FIXTURES, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ClientEventSchema.parse(JSON.parse(line)));

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** A store flushed by hand: `schedule` never fires on its own. */
function manualStore(
  size = { rows: 12, columns: 40 },
  prompting = true,
): { store: ChatStore; view: () => ChatView; texts: () => string[] } {
  const store = new ChatStore({
    columns: () => size.columns,
    rows: () => size.rows,
    reservedRows: 2,
    schedule: () => () => undefined,
    prompting,
  });
  const view = (): ChatView => {
    store.flush();
    return store.view();
  };
  return {
    store,
    view,
    texts: () =>
      view()
        .committed.slice()
        .map((line) => line.text),
  };
}

let sequence = 0;
function event(kind: string, fields: Record<string, unknown>, attemptId = "attempt-1"): ClientEvent {
  return ClientEventSchema.parse({
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    epoch: "epoch-0",
    sequence: sequence++,
    runId: "task-1",
    attemptId,
    at: "2026-09-19T00:00:00.000Z",
    kind,
    ...fields,
  });
}
const started = (): ClientEvent => {
  sequence = 0;
  return event("run.started", { threadId: "thread-1", workspaceId: "default" });
};
const delta = (text: string, attemptId = "attempt-1", blockId = "b"): ClientEvent => event("text.delta", { blockId, text }, attemptId);

describe("the chat store", () => {
  it("commits whole lines as they complete and keeps the unfinished one live", () => {
    const { store, view, texts } = manualStore();
    store.begin();
    store.push(started());
    store.push(delta("first line\nsecond li"));
    expect(texts()).toEqual(["first line"]);
    expect(view().live).toEqual(["second li"]);
    store.push(delta("ne\nthird"));
    expect(texts()).toEqual(["first line", "second line"]);
    expect(view().live).toEqual(["third"]);
  });

  it("keeps blank lines: a paragraph break reaches the scrollback", () => {
    const { store, texts } = manualStore();
    store.begin();
    store.push(started());
    store.push(delta("one\n\nthree\n"));
    expect(texts()).toEqual(["one", "", "three"]);
  });

  it("names a question's header, and numbers its options", () => {
    const { store, texts } = manualStore({ rows: 12, columns: 80 });
    store.begin();
    store.push(started());
    const choices = { header: "Customer", options: [{ label: "Acme" }, { label: "Globex" }], multiSelect: false, allowOther: false };
    store.push(
      event("task.waiting", {
        on: "its deadline",
        deadlineAt: "2026-09-20T00:00:00.000Z",
        question: "Which one?",
        choices,
        waitId: "wait-1",
      }),
    );
    expect(texts()).toContain("⏸ The chat asks (Customer): Which one?");
    expect(texts()).toContain("  1. Acme");
  });

  it("prints only the latest plan: a superseded or unchanged plan is skipped, and one that does not parse is not printed raw", () => {
    const { store, texts } = manualStore({ rows: 12, columns: 80 });
    store.begin();
    store.push(started());
    let call = 0;
    const plan = (input: unknown) => {
      const callId = `plan-${++call}`;
      store.push(event("tool.started", { blockId: callId, callId, toolName: "plan.update", input }));
      store.push(event("tool.completed", { callId, toolName: "plan.update", output: {}, durationMs: 1 }));
    };
    const items = (...statuses: string[]) => ({ items: statuses.map((status, index) => ({ content: `step ${index + 1}`, status })) });
    // Two plans before a flush: only the later is printed.
    plan(items("in_progress", "pending"));
    plan(items("done", "in_progress"));
    expect(texts()).toEqual(["⏺ Plan", "  ☑ step 1", "  ◐ step 2"]);
    // The same plan again prints nothing; a capped input that does not parse is skipped.
    plan(items("done", "in_progress"));
    plan({ items: "…" });
    expect(texts()).toEqual(["⏺ Plan", "  ☑ step 1", "  ◐ step 2"]);
    plan(items("done", "done"));
    expect(texts().slice(3)).toEqual(["⏺ Plan (updated)", "  ☑ step 1", "  ☑ step 2"]);
  });

  it("prints a past-chat search as what it found and the chats' titles, not its JSON", () => {
    const { store, texts } = manualStore({ rows: 12, columns: 80 });
    store.begin();
    store.push(started());
    const matches = [
      { taskId: "t-apart", title: "ACME renewal and the Lisbon budget", at: "2026-09-01T00:00:01.000Z", excerpt: "…" },
      { taskId: "t-one", title: "ACME call notes", at: "2026-09-01T00:00:00.000Z", excerpt: "…" },
    ];
    store.push(event("tool.started", { blockId: "s1", callId: "s1", toolName: "sessions.search", input: { query: "ACME budget" } }));
    store.push(event("tool.completed", { callId: "s1", toolName: "sessions.search", output: { found: 2, matches }, durationMs: 1 }));
    expect(texts().slice(1)).toEqual([
      "  ⎿ Searched earlier chats · 2 found",
      "    • ACME renewal and the Lisbon budget",
      "    • ACME call notes",
    ]);
  });

  it("prints a proposed skill as the one line that says where it waits and how to review it", () => {
    const { store, texts } = manualStore({ rows: 12, columns: 100 });
    store.begin();
    store.push(started());
    store.push(event("tool.started", { blockId: "p1", callId: "p1", toolName: "skills.propose", input: { skillId: "weekly-report" } }));
    store.push(
      event("tool.completed", {
        callId: "p1",
        toolName: "skills.propose",
        output: { skillId: "weekly-report", version: "proposed-20261027120000", reviewState: "proposed", note: "…" },
        durationMs: 1,
      }),
    );
    expect(texts().slice(1)).toEqual([
      "  ⎿ A skill waits for your review: tavi skills show weekly-report --body --version proposed-20261027120000",
    ]);
  });

  it("commits in the stream's order: a running tool holds back what follows it", () => {
    const { store, view, texts } = manualStore();
    store.begin();
    store.push(started());
    store.push(delta("checking\n"));
    store.push(event("tool.started", { blockId: "call-1", callId: "call-1", toolName: "operator.ask_user", input: {} }));
    expect(view().live).toEqual(["⏺ operator.ask_user …"]);
    store.push(
      event("task.waiting", { on: "its deadline", deadlineAt: "2026-09-20T00:00:00.000Z", question: "Which one?", waitId: "wait-1" }),
    );
    // Suspended on the tool: it stays live, and nothing is committed past it.
    expect(view().live).toEqual(["⏺ operator.ask_user …"]);
    expect(view().status).toBe("⏸ waiting on your answer task-1: Which one? · /needs shows where to answer it");
    // The question is explained once, in full, where it scrolls with the transcript.
    expect(texts().filter((line) => line === "⏸ The chat asks: Which one?")).toHaveLength(1);
    expect(texts().filter((line) => line === "⏸ The chat asks: Which one?")).toHaveLength(1);
    store.push(event("attempt.replaced", { supersededAttemptId: "attempt-1", reason: "resuming after deadline" }, "attempt-2"));
    store.push(event("tool.completed", { callId: "call-1", toolName: "operator.ask_user", output: {}, durationMs: 1 }, "attempt-2"));
    expect(texts().filter((line) => !line.startsWith("⏸") && !line.startsWith("  "))).toEqual([
      "checking",
      // The resume ran the same call again: one row, finished where it was asked (QA 2101).
      "⏺ operator.ask_user ✓ 1 ms",
      "── resuming after deadline ──",
    ]);
  });

  it("drops a failed-over attempt's unfinished text, keeps what it committed, and says why", () => {
    const { store, texts } = manualStore();
    store.begin();
    store.push(started());
    store.push(delta("first line\nhalf a sec"));
    texts();
    store.push(
      event("attempt.replaced", { supersededAttemptId: "attempt-1", reason: "the model call failed over", discarded: true }, "attempt-2"),
    );
    store.push(delta("from the backup\n", "attempt-2"));
    expect(texts()).toEqual(["first line", "── the model call failed over ──", "from the backup"]);
  });

  it("commits text that grows after it was committed", () => {
    const { store, view, texts } = manualStore();
    store.begin();
    store.push(started());
    store.push(delta("first\n"));
    store.push(event("tool.started", { blockId: "call-1", callId: "call-1", toolName: "fs.read", input: {} }));
    // The block continues after the tool began: its new text is not lost.
    store.push(delta("more\n"));
    expect(texts()).toEqual(["first", "more"]);
    expect(view().live).toEqual(["⏺ fs.read …"]);
  });

  it("never lets the live region reach the viewport, however long the unfinished line", () => {
    for (const size of [
      { rows: 10, columns: 20 },
      { rows: 40, columns: 20 },
      { rows: 5, columns: 20 },
    ]) {
      const { store, view } = manualStore(size);
      store.begin();
      store.push(started());
      for (let index = 0; index < 500; index += 1) store.push(delta("word "));
      const live = view().live;
      expect(live.length).toBe(liveRowBudget(size.rows, 2));
      expect(live.length).toBeLessThanOrEqual(MAX_LIVE_ROWS);
      // The whole frame — live rows, status, prompt — stays under the viewport.
      expect(live.length + 2).toBeLessThan(size.rows);
      for (const row of live) expect([...row].length).toBeLessThanOrEqual(size.columns);
      // The tail is what shows: the newest text, a whole row of it.
      expect(live.at(-1)).toBe("word word word word ");
    }
  });

  it("commits what a run left live when it ends, and when the next one begins", () => {
    const { store, view, texts } = manualStore();
    store.begin();
    store.push(started());
    store.push(delta("no newline at the end"));
    store.push(event("task.completed", { finalText: "no newline at the end" }));
    expect(texts()).toEqual(["no newline at the end"]);
    expect(view().live).toEqual([]);
    expect(view().running).toBe(false);
    store.begin();
    store.note("❯ again", "prompt");
    expect(view().running).toBe(true);
    expect(texts().at(-1)).toBe("❯ again");
  });

  it("says when it joined late, and when a resync lost the stream's start", () => {
    const late = manualStore();
    late.store.begin();
    const events = fixture("two-call-round");
    for (const recorded of events.slice(7)) late.store.push(recorded);
    expect(late.texts()[0]).toContain("joined late");

    // Told by the owner (`SubscribeResult.truncated`), before any event arrived.
    const told = manualStore();
    told.store.begin();
    told.store.joinedLate();
    expect(told.texts()[0]).toContain("joined late");

    const resynced = manualStore();
    resynced.store.begin();
    for (const recorded of fixture("resync-after-restart")) resynced.store.push(recorded);
    const lines = resynced.texts();
    expect(lines.some((line) => line.includes("the owner restarted"))).toBe(true);
    expect(lines.filter((line) => line.includes("joined late"))).toEqual([]);
  });

  it("does not draw the resume boundary a continued turn opens with, but draws one later in it", () => {
    const { store, texts } = manualStore();
    store.begin({ taskId: "task-1" });
    for (const recorded of [started(), delta("blue"), event("task.completed", { finalText: "blue" })]) store.push(recorded);
    store.begin({ taskId: "task-1", continuing: true });
    store.push(event("attempt.replaced", { supersededAttemptId: "attempt-1", reason: "resuming after reply" }, "attempt-2"));
    store.push(delta("green", "attempt-2", "b2"));
    store.push(event("attempt.replaced", { supersededAttemptId: "attempt-2", reason: "resuming after approval" }, "attempt-3"));
    store.push(event("task.completed", { finalText: "green" }, "attempt-3"));
    const lines = texts();
    expect(lines.filter((line) => line.includes("resuming after reply"))).toEqual([]);
    expect(lines).toContain("── resuming after approval ──");
    expect(lines.some((line) => line.includes("green"))).toBe(true);
  });

  it("does not say a continued turn joined late, and does not carry that over to the next run", () => {
    const events = fixture("two-call-round");
    const continued = manualStore();
    continued.store.begin({ taskId: "task-0", continuing: true });
    for (const recorded of events.slice(7)) continued.store.push(recorded);
    expect(continued.texts().filter((line) => line.includes("joined late"))).toEqual([]);
    // The next run is not continued: joined mid-stream, it says so.
    continued.store.begin();
    for (const recorded of events.slice(7)) continued.store.push(recorded);
    expect(continued.texts().filter((line) => line.includes("joined late"))).toHaveLength(1);

    // A resync as a continued turn's first event is still a resync.
    const resynced = manualStore();
    resynced.store.begin({ continuing: true });
    for (const recorded of fixture("resync-after-restart")) resynced.store.push(recorded);
    expect(resynced.texts().some((line) => line.includes("the owner restarted"))).toBe(true);
  });

  it("names the question it waits on in the status row, so it is not lost when its lines scroll away", () => {
    const asking = {
      ...initialRunState({ taskId: "task-1" }),
      status: "waiting" as const,
      waiting: {
        on: "its deadline",
        deadlineAt: "2099-01-01T00:00:00.000Z",
        question: "Which folder should I use for the report?\nmore",
        waitId: "w",
      },
    };
    expect(statusLine(asking, false)).toBe(
      "⏸ waiting on your answer task-1: Which folder should I use for the report? · /needs shows where to answer it",
    );
    // Not prompting (a replay): no way to answer is offered.
    expect(statusLine(asking, false, false)).toBe("⏸ waiting on your answer task-1: Which folder should I use for the report?");
  });

  it("offers to continue a settled chat only when the next prompt will, and names Home when it goes there", () => {
    const completed = { ...initialRunState({ taskId: "task-1" }), status: "completed" as const };
    expect(statusLine(completed, false, true, "continue")).toContain("Type to continue it (/new for a new chat)");
    expect(statusLine(completed, false, true, "continue", true)).toContain("Type to continue it (/side for a side chat)");
    expect(statusLine(completed, false, true, "new")).toContain("Type a prompt for a new chat");
    expect(statusLine(completed, false, true, "new")).not.toContain("continue");
    expect(statusLine(completed, false, true, "home", true)).toContain("Type a message for Home");
    expect(statusLine(completed, false, true, "side", true)).toContain("Type a prompt for a side chat");
    expect(statusLine(initialRunState(), false, true, "home", true)).toContain("Type a message for Home and press Enter");
    const failed = { ...initialRunState({ taskId: "task-1" }), status: "failed" as const };
    // A failed turn is continued in the same chat: no new chat is offered as the remedy.
    expect(statusLine(failed, false, true, "continue")).toContain("· type to continue it");
    expect(statusLine(failed, false, true, "continue")).not.toContain("/new");
    expect(statusLine(failed, false, true, "new")).not.toContain("continue");
    // Not prompting (a replay): nothing to type.
    expect(statusLine(completed, false, false, "continue")).toBe("✓ Done.");

    const { store, view } = manualStore();
    store.begin({ taskId: "task-1" });
    for (const recorded of [started(), event("task.completed", { finalText: "done" })]) store.push(recorded);
    expect(view().status).toContain("Type a prompt for a new chat");
    store.next("continue");
    expect(view().status).toContain("Type to continue it");
    store.next("home", true);
    expect(view().status).toContain("Type a message for Home");
  });

  it("shows a file change's diff under its round, its first lines and where the rest is", () => {
    const { store, texts } = manualStore({ rows: 12, columns: 400 });
    store.begin({ taskId: "task-1" });
    store.push(started());
    const body = Array.from({ length: 30 }, (_, index) => `+line ${index}`);
    store.push(
      event("approval.required", {
        callId: "call-a",
        toolName: "fs.write",
        summary: "Write notes.txt",
        input: { path: "notes.txt" },
        steps: 1,
        approvalId: "approval-a",
        effect: "local_write",
        display: { title: "Write notes.txt", detail: ["--- notes.txt", "+++ notes.txt", "@@ -0,0 +1,30 @@", ...body].join("\n") },
        allowedScopes: ["once"],
      }),
    );
    const lines = texts();
    expect(lines).toContain("      @@ -0,0 +1,30 @@");
    expect(lines).toContain("      +line 0");
    expect(lines).not.toContain("      +line 29");
    expect(lines).toContain("      … 13 more lines in the canvas's Details (tavi ui)");
  });

  it("says why a round asks, and from where, and keeps a taint chip on the status line", () => {
    const AT = "2026-10-13T10:00:00.000Z";
    const hostile = `<b>Daily</b>${ESC}[31m\u202Eevil ${"A".repeat(200)}`.slice(0, 120);
    const label = {
      integrity: "untrusted",
      sources: ["web", "email"],
      principals: [],
      confidentiality: "public",
      refs: [
        { source: "web", ref: "call-1", host: "news.example", title: hostile, at: AT },
        { source: "email", ref: "m1", host: "x.example", at: AT },
      ],
    };
    const { store, view, texts } = manualStore({ rows: 12, columns: 400 });
    store.begin({ taskId: "task-1" });
    store.push(started());
    expect(view().status).not.toContain("/taint");
    store.push(
      event("approval.required", {
        callId: "call-a",
        toolName: "messaging.send_to",
        summary: "Send",
        input: { to: "bob@x.example" },
        steps: 1,
        approvalId: "approval-a",
        effect: "external",
        risk: { level: "high", reasons: ["the conversation contains untrusted content from the web or a document"], tainted: true, label },
        allowedScopes: ["once"],
        provenance: {
          gateReason: "tainted-message",
          sources: ["web", "email"],
          principals: [],
          refs: label.refs,
          argOrigins: [
            { path: "to", value: "bob@x.example", from: "content", source: "email", host: "x.example", toolId: "email.read", ref: "m1" },
          ],
        },
      }),
    );
    const lines = texts();
    expect(lines).toContain(
      "      ⚠ Why am I asked? This chat read content Tavi does not trust, and this call sends a message. A page can steer the model into writing to someone on your behalf.",
    );
    const read = lines.find((line) => line.startsWith("        read: ")) ?? "";
    // Tavi's words first; the page's claim after, neutralized: no markup, no escape, no bidi override.
    expect(read.startsWith("        read: news.example (the page calls itself “‹b›Daily‹/b›")).toBe(true);
    expect(read).toContain("; mail you forwarded or quoted (via x.example)");
    expect(read).not.toMatch(new RegExp(`[<>${ESC}\u202E]`));
    expect(lines).toContain("        “bob@x.example” appears in mail you forwarded or quoted (via x.example)");
    // The taint line is the card's own now, never repeated as a flag.
    expect(lines.some((line) => line.includes("Flagged"))).toBe(false);
    // The status line bounds the chip; `/taint` says all of it.
    expect(view().status).toContain("⚠ Read news.example and mail you forwarded or quoted (via x.e… (/taint)");
    expect(store.taintDetails().join("\n")).toMatch(/Fresh context \(\/compact\) does not clear it/);
    // Another chat starts without the chip; a clean label never sets one.
    store.begin({ taskId: "task-2" });
    expect(store.tainted).toBe(false);
    store.setTaint("task-2", { ...label, integrity: "trusted", sources: [], refs: [] } as never);
    expect(view().status).not.toContain("/taint");
    expect(store.taintDetails()[0]).toMatch(/has read nothing/);
  });

  it("keeps each chat's label by its task: the chip shows on an ended chat's line, and /taint names a chat not yet shown", () => {
    const label = {
      integrity: "untrusted",
      sources: ["search"],
      principals: [],
      confidentiality: "public",
      refs: [],
    } as never;
    const { store, view } = manualStore({ rows: 12, columns: 400 });
    // Read before the chat it belongs to is the one shown: kept for it, not dropped.
    store.setTaint("task-side", label);
    expect(store.taintDetails("task-side").join("\n")).toMatch(/search results/);
    store.begin({ taskId: "task-side" });
    expect(store.tainted).toBe(true);
    // The line a settled chat ends on carries the chip too.
    store.settleWith("✓ Done.");
    expect(view().status).toContain("✓ Done.");
    expect(view().status).toContain("⚠ Read search results (/taint)");
  });

  it("marks what a call's input would hide on its card, and names the host a browser round allows", () => {
    const rlo = String.fromCodePoint(0x202e);
    const { store, texts } = manualStore({ rows: 12, columns: 400 });
    store.begin({ taskId: "task-1" });
    store.push(started());
    store.push(
      event("approval.required", {
        callId: "call-a",
        toolName: "fixture.tool",
        summary: "Approve fixture.tool?",
        input: { path: `report${rlo}fdp.exe` },
        steps: 1,
        approvalId: "approval-a",
        effect: "external",
        allowedScopes: ["once"],
      }),
    );
    const card = texts().find((line) => line.startsWith("  • fixture.tool")) ?? "";
    expect(card).toContain("report⟨U+202E⟩fdp.exe");
    expect(card.includes(rlo)).toBe(false);

    const browsing = manualStore({ rows: 12, columns: 400 });
    browsing.store.begin({ taskId: "task-1" });
    browsing.store.push(started());
    browsing.store.push(
      event("approval.required", {
        callId: "call-b",
        toolName: "browser.navigate",
        summary: "Open example.com in the browser",
        input: { sessionId: "s", url: "https://example.com/" },
        steps: 1,
        approvalId: "approval-b",
        effect: "external",
        display: { title: "Open example.com in the browser", host: "example.com", command: "https://example.com/" },
        allowedScopes: ["once", "session", "always"],
        scopeGroup: "browser.*",
      }),
    );
    browsing.store.roundCalls(1, new Set(["call-b"]));
    expect(browsing.view().status).toContain("y allows the browser on example.com for this chat");
  });

  it("shows a round as one card, offers y/n for it whole, or says the owner answers it", async () => {
    const client = manualStore({ rows: 12, columns: 120 });
    client.store.begin();
    for (const recorded of fixture("two-call-round").slice(0, 4)) client.store.push(recorded);
    // Not offered until the owner has listed the round's calls, and all of them are shown.
    expect(client.view().decision).toBeUndefined();
    client.store.roundCalls(1, new Set(["call-a", "call-b"]));
    // One decision for the round, offered in the status row.
    expect(client.view().status).toBe(
      "⏸ round 1: y allows the browser for this chat, a always (the browser, in every chat), n refuses it, N refuses with a reason",
    );
    expect(client.view().decision).toEqual({ taskId: "task-0", steps: 1, scopes: ["once", "session", "always"], scopeGroup: "browser.*" });
    const lines = client.texts();
    expect(lines).toContain("⏸ Round 1 needs approval:");
    // Every gated call of the round, on the card.
    expect(lines.filter((line) => line.startsWith("  • browser.create_session"))).toHaveLength(2);
    expect(lines).toContain(
      "  y allows the browser for this chat, a always (the browser, in every chat), n refuses it, N refuses with a reason — or decide it in another terminal: tavi approvals approve|reject task-0",
    );
    expect(client.texts()).toEqual(lines);
    // Sent: not offered again until the owner answers.
    client.store.deciding(1);
    expect(client.view().decision).toBeUndefined();
    expect(client.view().status).toBe("… deciding round 1");
    client.store.decisionAnswered(1);
    expect(client.view().decision).toEqual({ taskId: "task-0", steps: 1, scopes: ["once", "session", "always"], scopeGroup: "browser.*" });
    // Settled on the stream: the card's round is recorded, and nothing more is offered.
    for (const recorded of fixture("two-call-round").slice(4, 6)) client.store.push(recorded);
    expect(client.view().decision).toBeUndefined();
    expect(client.texts()).toContain("✓ Round 1 approved by automatic approval (--approval approve)");
    // A blanket --approval deny is named for what it did, not as an approval.
    const denied = manualStore({ rows: 12, columns: 120 }, false);
    denied.store.begin();
    for (const recorded of fixture("denied-then-failed")) denied.store.push(recorded);
    expect(denied.texts()).toContain("✗ Round 1 rejected by automatic denial (--approval deny)");
    expect(denied.texts().join("\n")).not.toContain("--approval approve");

    const replay = manualStore({ rows: 12, columns: 120 }, false);
    replay.store.begin();
    for (const recorded of fixture("two-call-round").slice(0, 4)) replay.store.push(recorded);
    // A replay offers no keys: it names the command.
    replay.store.roundCalls(1, new Set(["call-a", "call-b"]));
    expect(replay.view().decision).toBeUndefined();
    expect(replay.texts()).toContain("⏸ Round 1 needs approval — decide it with tavi approvals approve|reject task-0:");

    const owner = manualStore({ rows: 12, columns: 80 });
    await owner.store.begin({ roundsAnsweredBy: "owner" });
    for (const recorded of fixture("two-call-round").slice(0, 4)) await owner.store.push(recorded);
    expect(owner.texts().some((line) => line.includes("the owner answers it"))).toBe(true);
    expect(owner.texts().some((line) => line.includes("tavi approvals approve"))).toBe(false);
    // Each call once: the header does not list them again.
    expect(owner.texts().filter((line) => line.includes("browser.create_session"))).toHaveLength(2);
    await owner.store.roundCalls(1, new Set(["call-a", "call-b"]));
    expect(owner.view().decision).toBeUndefined();
  });

  it("offers no key for a round until every call the owner listed has arrived, and the card grows as they do", () => {
    const { store, view, texts } = manualStore({ rows: 12, columns: 120 });
    const events = fixture("two-call-round");
    store.begin();
    // The round arrives a call at a time — two frames here.
    for (const recorded of events.slice(0, 3)) store.push(recorded);
    store.roundCalls(1, new Set(["call-a", "call-b"]));
    expect(view().decision).toBeUndefined();
    expect(texts().filter((line) => line.startsWith("  • "))).toHaveLength(1);
    expect(texts().some((line) => line.startsWith("  y allows"))).toBe(false);
    store.push(events[3] as ClientEvent);
    expect(view().decision).toEqual({ taskId: "task-0", steps: 1, scopes: ["once", "session", "always"], scopeGroup: "browser.*" });
    // Every call on the card, once, then what decides it.
    const lines = texts();
    expect(lines.filter((line) => line.startsWith("  • "))).toHaveLength(2);
    expect(lines.at(-1)).toContain("y allows the browser for this chat");
    // Listed as empty (decided before it was listed): never offered.
    const early = manualStore({ rows: 12, columns: 120 });
    early.store.begin();
    for (const recorded of events.slice(0, 4)) early.store.push(recorded);
    early.store.roundCalls(1, new Set());
    expect(early.view().decision).toBeUndefined();
  });

  it("lets a decision go when its round was answered without a settlement, so the next round is offered", () => {
    const { store, view } = manualStore({ rows: 12, columns: 120 });
    const events = fixture("two-call-round");
    store.begin();
    for (const recorded of events.slice(0, 4)) store.push(recorded);
    store.roundCalls(1, new Set(["call-a", "call-b"]));
    store.deciding(1);
    expect(view().status).toBe("… deciding round 1");
    // Resumed with no approval.settled (an announcement an older owner did not make).
    store.push(ClientEventSchema.parse({ ...events[5], sequence: 4 }));
    store.push(
      ClientEventSchema.parse({
        ...events[2],
        sequence: 5,
        attemptId: "attempt-2",
        callId: "call-c",
        steps: 2,
        approvalId: "approval:6:task-0:2:6:call-c",
      }),
    );
    store.roundCalls(2, new Set(["call-c"]));
    expect(view().status).not.toContain("deciding round 1");
    expect(view().decision).toEqual({ taskId: "task-0", steps: 2, scopes: ["once", "session", "always"], scopeGroup: "browser.*" });
  });

  it("draws a tool card: its input, duration and result, cut to fit; nothing for an empty input or result", () => {
    const { store, texts } = manualStore({ rows: 12, columns: 200 });
    store.begin();
    store.push(started());
    const card = (callId: string, input: unknown, output: unknown, durationMs: number): void => {
      store.push(event("tool.started", { blockId: callId, callId, toolName: "fs.read", input }));
      store.push(event("tool.completed", { callId, toolName: "fs.read", output, durationMs }));
    };
    card("call-1", { path: "a" }, "line1\nline2", 12);
    card("call-2", {}, null, 1_500);
    card("call-3", { path: "x".repeat(200) }, "", 3);
    store.push(event("tool.started", { blockId: "call-4", callId: "call-4", toolName: "fs.read", input: { path: "b" } }));
    store.push(
      event("tool.failed", { callId: "call-4", toolName: "fs.read", errorCode: "NOT_FOUND", message: "no such file", durationMs: 2 }),
    );
    const lines = texts();
    expect(lines).toContain('⏺ fs.read({"path":"a"}) ✓ 12 ms');
    expect(lines).toContain("  ⎿ line1");
    expect(lines).toContain("⏺ fs.read ✓ 1.5 s");
    const long = lines.find((line) => line.startsWith('⏺ fs.read({"path":"xxx')) ?? "";
    expect(long).toContain("…");
    expect(stringWidth(long)).toBeLessThan(100);
    expect(lines).toContain('⏺ fs.read({"path":"b"}) ✗ NOT_FOUND: no such file');
    // No result line for an empty result, and none for a failure.
    expect(lines.filter((line) => line.startsWith("  ⎿"))).toEqual(["  ⎿ line1"]);
  });

  it("commits a settlement once, in stream order, however the frames fall", () => {
    const { store, texts } = manualStore({ rows: 12, columns: 120 });
    const events = fixture("two-call-round");
    store.begin();
    // The round's calls and its settlement in the frame the text before them
    // arrived in: that text is the last entry, still able to grow, so the
    // settlement waits behind it rather than jump ahead of it.
    for (const recorded of events.slice(0, 5)) store.push(recorded);
    expect(texts().filter((line) => line.startsWith("✓ Round 1"))).toHaveLength(0);
    for (const recorded of events.slice(5)) store.push(recorded);
    const lines = texts();
    expect(lines.indexOf("working… ")).toBeLessThan(lines.indexOf("✓ Round 1 approved by automatic approval (--approval approve)"));
    expect(lines.filter((line) => line.startsWith("✓ Round 1"))).toHaveLength(1);
    expect(lines.indexOf("✓ Round 1 approved by automatic approval (--approval approve)")).toBeLessThan(
      lines.indexOf("── resuming after approval ──"),
    );
  });

  it("shows a review as one card with y/n for all of its artifacts, and a replay names the command", () => {
    const events = fixture("review-required");
    const suspended = events.findIndex((event) => event.kind === "task.review_required");
    const { store, view, texts } = manualStore({ rows: 12, columns: 200 });
    store.begin();
    for (const recorded of events.slice(0, suspended + 1)) store.push(recorded);
    const review = view().review;
    expect(review?.taskId).toBe("task-0");
    expect(review?.artifactIds).toHaveLength(1);
    expect(view().status).toBe("⏸ review: y releases the output and resumes, n rejects it");
    expect(texts().filter((line) => line.startsWith("  • artifact-"))).toHaveLength(1);
    expect(texts().some((line) => line.startsWith("  y releases all of it"))).toBe(true);
    store.reviewing(review?.steps ?? -1);
    expect(view().review).toBeUndefined();
    expect(view().status).toBe("… sending the review");
    // Refused: not offered again — the same keys would be refused again.
    store.reviewRefused(review?.steps ?? -1);
    expect(view().review).toBeUndefined();
    expect(view().status).not.toContain("sending the review");

    // A review a schedule's fire answers: named, and no keys.
    const fired = manualStore({ rows: 12, columns: 200 });
    fired.store.begin();
    fired.store.answeredBy("owner", { scheduleId: "sched-1", name: "nightly" });
    for (const recorded of events.slice(0, suspended + 1)) fired.store.push(recorded);
    expect(fired.texts()).toContain("⏸ Output needs review; schedule nightly's fire decides it while it runs:");
    expect(fired.view().review).toBeUndefined();
    expect(fired.store.awaitingOwner).toBe(true);

    const replay = manualStore({ rows: 12, columns: 200 }, false);
    replay.store.begin();
    for (const recorded of events.slice(0, suspended + 1)) replay.store.push(recorded);
    expect(replay.view().review).toBeUndefined();
    expect(replay.texts().join("\n")).toContain("--resume --connection <id> --model <id>");
  });

  it("shows a round a schedule's fire answers read-only, naming the schedule, and offers it once the fire has ended", () => {
    const { store, view, texts } = manualStore({ rows: 12, columns: 200 });
    store.begin();
    store.answeredBy("owner", { scheduleId: "sched-1", name: "morning-brief" });
    for (const recorded of fixture("two-call-round").slice(0, 4)) store.push(recorded);
    store.roundCalls(1, new Set(["call-a", "call-b"]));
    expect(texts()).toContain("⏸ Round 1 needs approval; schedule morning-brief's fire decides it while it runs:");
    expect(view().decision).toBeUndefined();
    expect(store.awaitingOwner).toBe(true);
    // The fire ended: the round is this chat's.
    store.answeredBy("client");
    expect(store.awaitingOwner).toBe(false);
    expect(view().decision).toEqual({ taskId: "task-0", steps: 1, scopes: ["once", "session", "always"], scopeGroup: "browser.*" });
    expect(texts().at(-1)).toContain("y allows the browser for this chat");
  });

  it("offers typing as the answer to a question in the task's own conversation, and only there", () => {
    const { store, view, texts } = manualStore({ rows: 12, columns: 120 });
    store.begin();
    store.push(started());
    store.push(
      event("task.waiting", {
        on: "the operator's answer",
        deadlineAt: "2026-09-20T00:00:00.000Z",
        question: "Which one?",
        waitId: "wait-1",
      }),
    );
    // No conversation known: the question is shown, not offered.
    expect(view().answer).toBeUndefined();
    expect(texts()).toContain("  It waits for the answer in the conversation it was asked in.");

    const known = manualStore({ rows: 12, columns: 120 });
    known.store.begin();
    known.store.conversation("task-1", "op-chat-1");
    known.store.push(started());
    known.store.push(
      event("task.waiting", {
        on: "the operator's answer",
        deadlineAt: "2026-09-20T00:00:00.000Z",
        question: "Which one?",
        waitId: "wait-1",
      }),
    );
    expect(known.view().answer).toEqual({ taskId: "task-1", conversationId: "op-chat-1" });
    expect(known.view().status).toBe("⏸ the chat asks: Which one? · type the answer and press Enter");
    expect(known.texts()).toContain("  Type the answer and press Enter.");
    known.store.answering(true);
    expect(known.view().answer).toBeUndefined();
    expect(known.view().status).toBe("… sending the answer");
    known.store.answering(false);
    expect(known.view().answer).toEqual({ taskId: "task-1", conversationId: "op-chat-1" });

    // Learnt after the card was shown: the card says it can be typed now, once.
    const late = manualStore({ rows: 12, columns: 120 });
    late.store.begin();
    late.store.push(started());
    late.store.push(
      event("task.waiting", {
        on: "the operator's answer",
        deadlineAt: "2026-09-20T00:00:00.000Z",
        question: "Which one?",
        waitId: "wait-1",
      }),
    );
    expect(late.texts().at(-1)).toBe("  It waits for the answer in the conversation it was asked in.");
    late.store.conversation("task-1", "op-chat-1");
    expect(late.texts().at(-1)).toBe("  Type the answer and press Enter.");
    late.store.conversation("task-1", "op-chat-1");
    expect(late.texts().filter((line) => line === "  Type the answer and press Enter.")).toHaveLength(1);
    // A conversation the owner found none for: not offered.
    late.store.forgetConversation("task-1");
    expect(late.view().answer).toBeUndefined();
  });

  it("names the review command the owner accepts, with the flags --resume needs, where it offers no keys", () => {
    const { store, texts } = manualStore({ rows: 12, columns: 120 }, false);
    store.begin();
    const events = fixture("review-required");
    const suspended = events.findIndex((event) => event.kind === "task.review_required");
    for (const recorded of events.slice(0, suspended + 1)) store.push(recorded);
    const lines = texts().join("\n");
    expect(lines).toContain("needs review");
    expect(lines).toContain("tavi artifacts approve|reject <artifact-id>");
    expect(lines).toContain("--resume --connection <id> --model <id>");
  });

  it("draws a round read back from the owner by its tool and path, never with a null input, and offers Home's s until tomorrow", () => {
    const { store, view, texts } = manualStore({ rows: 12, columns: 120 });
    store.setHome("home-1");
    store.begin({ taskId: "home-1" });
    store.seed({
      pending: pendingRoundsOf("home-1", [
        {
          record: { approvalId: "approval-1", callId: "call-1", toolId: "fs.write", steps: 1 },
          summary: "notes.txt",
          allowedScopes: ["once", "session"],
        },
        // One stored before its headline was kept: no summary, and no input either.
        { record: { approvalId: "approval-2", callId: "call-2", toolId: "fs.edit", steps: 1 }, allowedScopes: ["once", "session"] },
      ]).rounds,
    });
    store.roundCalls(1, new Set(["call-1", "call-2"]));
    expect(texts().join("\n")).toContain("fs.write — notes.txt");
    expect(texts().join("\n")).not.toContain("null");
    expect(view().status).toBe("⏸ round 1: y approves it, s until tomorrow, n rejects it, N rejects with a reason");
    expect(texts().join("\n")).toContain("  y approves it, s until tomorrow, n rejects it");
    // Another chat's round: for the rest of that chat.
    store.begin({ taskId: "side-1" });
    store.seed({
      pending: pendingRoundsOf("side-1", [
        { record: { approvalId: "approval-3", callId: "call-3", toolId: "fs.write", steps: 1 }, allowedScopes: ["once", "session"] },
      ]).rounds,
    });
    store.roundCalls(1, new Set(["call-3"]));
    expect(view().status).toContain("s for the rest of this chat");
  });

  it("shows the round a resync erased, once it is read from the owner", () => {
    const { store, view, texts } = manualStore({ rows: 12, columns: 80 });
    store.begin();
    for (const recorded of fixture("resync-after-restart").slice(0, 4)) store.push(recorded);
    expect(view().status).toContain("resumed");
    store.seed({
      pending: pendingRoundsOf("task-0", [
        { record: { approvalId: "approval-1", callId: "call-1", toolId: "browser.create_session", steps: 1 } },
      ]).rounds,
    });
    store.roundCalls(1, new Set(["call-1"]));
    expect(view().status).toBe("⏸ round 1: y approves it, n rejects it, N rejects with a reason");
    expect(texts()).toContain(
      "  y approves it, n rejects it, N rejects with a reason — or decide it in another terminal: tavi approvals approve|reject task-0",
    );
  });

  it("ends a run with a line of its own, which the status keeps until the next run", () => {
    const { store, view, texts } = manualStore();
    store.begin();
    store.push(started());
    store.finishWith("✓ task task-1 completed (its recorded outcome).", "notice");
    expect(view().running).toBe(false);
    expect(view().status).toBe("✓ task task-1 completed (its recorded outcome).");
    expect(texts().at(-1)).toBe("✓ task task-1 completed (its recorded outcome).");
    store.begin();
    expect(view().status).toBe("● starting…");
  });

  it("settles a run from its record in the status alone, so its ending is not shown twice around a note", () => {
    const { store, view, texts } = manualStore();
    store.begin();
    store.push(started());
    store.settleWith("✓ task task-1 completed (its recorded outcome).");
    store.note("… type to continue Home", "notice");
    expect(view().running).toBe(false);
    expect(view().status).toBe("✓ task task-1 completed (its recorded outcome).");
    expect(texts().filter((line) => line.includes("its recorded outcome"))).toEqual([]);
    expect(texts().at(-1)).toBe("… type to continue Home");
    store.begin();
    expect(view().status).toBe("● starting…");
  });

  it("replays a recorded run into the same lines a person would read", () => {
    const { store, view, texts } = manualStore({ rows: 12, columns: 60 }, false);
    store.begin();
    for (const recorded of fixture("reused-call-id")) store.push(recorded);
    store.end();
    // Each settlement where the stream settled it: after the round, before the resumed turn.
    expect(texts().filter((line) => !line.startsWith("⏸") && !line.startsWith("  "))).toEqual([
      "working… ",
      "✓ Round 1 approved by automatic approval (--approval approve)",
      "── resuming after approval ──",
      "⏺ browser.create_session ✓ 0 ms",
      "working… ",
      "✓ Round 2 approved by automatic approval (--approval approve)",
      "── resuming after approval ──",
      "⏺ browser.create_session ✓ 0 ms",
      "done",
    ]);
    expect(view().status).toBe("✓ Done.");
  });

  it("hands the tree a new view of the lines when lines are added, and the same one when not", () => {
    const { store, view } = manualStore();
    store.begin();
    store.push(started());
    store.push(delta("one\n"));
    const first = view().committed;
    expect(view().committed).toBe(first);
    store.push(delta("two\n"));
    const second = view().committed;
    expect(second).not.toBe(first);
    // A view reads the lines as of its making; `<Static>` asks only for the new ones.
    expect(first.length).toBe(1);
    expect(second.slice(first.length).map((line) => line.text)).toEqual(["two"]);
  });

  it("coalesces: the tree hears at most once per frame, however many events arrive", () => {
    const scheduled: (() => void)[] = [];
    const store = new ChatStore({
      columns: () => 40,
      rows: () => 12,
      reservedRows: 2,
      schedule: (callback) => {
        scheduled.push(callback);
        return () => undefined;
      },
    });
    let heard = 0;
    const unsubscribe = store.subscribe(() => {
      heard += 1;
    });
    store.begin();
    store.push(started());
    for (let index = 0; index < 1_000; index += 1) store.push(delta("x"));
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    expect(heard).toBe(1);
    expect(store.treeUpdates).toBe(1);
    expect(store.eventsReduced).toBe(1_001);
    // A flush by hand makes the scheduled one stale: it does not flush again.
    store.push(delta("y"));
    store.flush();
    scheduled[1]?.();
    expect(heard).toBe(2);
    unsubscribe();
    store.flush();
    expect(heard).toBe(2);
  });

  it("wraps by display width, and budgets rows", () => {
    expect(wrapRows("abcdefg", 3)).toEqual(["abc", "def", "g"]);
    expect(wrapRows("", 3)).toEqual([""]);
    // Wide characters take two columns; a grapheme cluster is never split.
    expect(wrapRows("日本語", 4)).toEqual(["日本", "語"]);
    expect(wrapRows("a👍🏽b", 2)).toEqual(["a", "👍🏽", "b"]);
    expect(liveRowBudget(24, 2)).toBe(MAX_LIVE_ROWS);
    expect(liveRowBudget(5, 2)).toBe(2);
    expect(liveRowBudget(3, 2)).toBe(0);
    expect(liveRowBudget(1, 2)).toBe(0);
    expect(statusLine(initialRunState(), false)).toContain("Type a prompt");
  });

  it("keeps no copy of the transcript alive through the lines it committed", () => {
    // The collector, exposed at run time: the default suite runs without `--expose-gc`.
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;
    const heap = (): number => {
      collect();
      return process.memoryUsage().heapUsed;
    };
    const { store } = manualStore({ rows: 20, columns: 60 });
    store.begin();
    store.push(started());
    const before = heap();
    // 100,000 deltas, a line every 8, flushed every 250: each committed line,
    // were it a view of the transcript it was cut from, would pin that
    // transcript as it stood — about 130 MiB in all.
    for (let index = 1; index <= 100_000; index += 1) {
      store.push(delta(index % 8 === 0 ? `w${index}\n` : `w${index} `));
      if (index % 250 === 0) store.flush();
    }
    store.flush();
    expect(store.linesCommitted).toBe(12_500);
    const retained = heap() - before;
    expect(retained, `retained ${(retained / 2 ** 20).toFixed(1)} MiB`).toBeLessThan(16 * 2 ** 20);
  });

  it("prints no escape sequence or control character the stream carried", () => {
    expect(printable(`${ESC}]0;owned${BEL}hi ${ESC}[31mred${ESC}[0m\tx${String.fromCharCode(8)}`)).toBe("hi red    x");
    expect(printable("a\r\nb\rc")).toBe("a\nb\nc");
    const { store, texts } = manualStore();
    store.begin();
    store.push(started());
    store.push(delta(`${ESC}]52;c;cGF3bmVk${BEL}copied?\n`));
    expect(texts()).toEqual(["copied?"]);
  });
});

it("renders a spawn as a one-line notice", () => {
  const { store, texts } = manualStore();
  store.begin();
  store.push(started());
  store.push(event("task.spawned", { childRunId: "child", workerAgentId: "worker", depth: 1 }));
  store.push(event("task.completed", { finalText: "done" }));
  expect(texts().join("\n")).toContain("Spawned worker: child (depth 1)");
});

describe("plugins' status lines", () => {
  it("ride the status row while nothing asks the person for anything", () => {
    const running = {
      ...initialRunState({ taskId: "task-1" }),
      status: "running" as const,
      pluginStatus: { "acme.cache": "cache warm 3:12", "acme.other": "ok" },
    };
    expect(statusLine(running, false)).toBe("● running task-1 · Esc aborts it, Ctrl-C detaches · cache warm 3:12 · ok");
    expect(statusLine({ ...running, status: "awaiting_approval" }, false)).toBe("⏸ approval needed (see above) task-1");
  });

  it("stay across a new turn of the same chat, go with another chat's, and are cleared when no longer followed", () => {
    const { store, view } = manualStore({ rows: 12, columns: 200 });
    store.begin({ taskId: "task-1" });
    store.push(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    store.push(event("plugin.status", { pluginId: "acme.tally", line: "3 calls" }));
    store.push(event("task.completed", { finalText: "done" }));
    expect(view().status).toContain("3 calls");
    // The chat's next turn: the line set on the last one stays until a turn changes it.
    store.begin({ taskId: "task-1", continuing: true });
    expect(view().status).toContain("3 calls");
    store.push(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    expect(view().status).toContain("3 calls");
    // The stream that would clear it is no longer followed.
    store.clearPluginStatus();
    expect(view().status).not.toContain("3 calls");
    store.push(event("plugin.status", { pluginId: "acme.tally", line: "4 calls" }));
    // Another chat's turn starts without it.
    store.begin({ taskId: "task-2", continuing: true });
    expect(view().status).not.toContain("4 calls");
  });

  it("takes a line cleared between turns, and still opens the next turn as a continuation", () => {
    const { store, view, texts } = manualStore({ rows: 12, columns: 200 });
    store.begin({ taskId: "task-1" });
    store.push(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    store.push(event("plugin.status", { pluginId: "acme.tally", line: "3 calls" }));
    store.push(event("task.completed", { finalText: "done" }));
    // Its next turn is followed from where this one stopped; another chat's from now.
    expect(store.resumeAt("task-1")).toBeDefined();
    expect(store.resumeAt("task-2")).toBeUndefined();
    store.begin({ taskId: "task-1", continuing: true });
    // The plugin was disabled between the turns: its clear comes first.
    store.push(event("plugin.status", { pluginId: "acme.tally" }));
    expect(view().status).not.toContain("3 calls");
    store.push(event("attempt.replaced", { supersededAttemptId: "attempt-1", reason: "resuming after reply" }, "attempt-2"));
    store.push(delta("green", "attempt-2", "b2"));
    expect(texts().filter((line) => line.includes("resuming after reply") || line.includes("joined late"))).toEqual([]);
    // After a reconnect the place is the old owner's: the next turn is followed from now.
    store.forgetPlace();
    expect(store.resumeAt("task-1")).toBeUndefined();
  });

  it("keeps the row one line, whatever a plugin's line holds", () => {
    const running = { ...initialRunState({ taskId: "task-1" }), status: "running" as const, pluginStatus: { "acme.cache": "cache\nwarm" } };
    expect(statusLine(running, false)).toContain("· cache warm");
  });
});

describe("turn suggestions", () => {
  it("prints what plugins suggest as a notice line", () => {
    const { store, texts } = manualStore({ rows: 12, columns: 200 });
    store.begin({ taskId: "task-1" });
    store.push(event("run.started", { threadId: "thread-1", workspaceId: "default" }));
    store.push(event("turn.suggested", { suggestions: ["Run the tests", "Review the diff"] }));
    expect(texts()).toContain("Suggested next: “Run the tests” · “Review the diff” — type one as your next prompt");
  });

  it("says a reopened chat's recorded ending without its id, and Home as ready", () => {
    expect(recordedLine({ kind: "completed" })).toBe("✓ completed (recorded)");
    expect(recordedLine({ kind: "failed", reason: "MODEL_FAILED" })).toBe("✗ failed: MODEL_FAILED (recorded)");
    expect(recordedLine({ kind: "completed" }, true)).toBe("✓ ready");
    expect(recordedLine({ kind: "failed" }, true)).toBe("✓ ready");
    expect(recordedLine({ kind: "stopped", message: "You stopped this." })).toBe("You stopped this. (recorded)");
    expect(recordedLine({ kind: "stopped", message: "You stopped this." }, true)).toBe("✓ ready");
  });

  it("says a private chat is private on its status line, and nothing of another", () => {
    const { store, view } = manualStore({ rows: 12, columns: 200 });
    store.markPrivate("task-p");
    store.begin({ taskId: "task-p" });
    store.settleWith("✓ Done.");
    expect(view().status).toBe("✓ Done. · private");
    store.begin({ taskId: "task-q" });
    store.settleWith("✓ Done.");
    expect(view().status).toBe("✓ Done.");
  });

  it("shows an answer's Markdown emphasis as its words, and leaves a lone asterisk", () => {
    expect(plainEmphasis("One notable adaptation is *Guillermo del Toro's Pinocchio*.")).toBe(
      "One notable adaptation is Guillermo del Toro's Pinocchio.",
    );
    expect(plainEmphasis("Recommendation: ***Contact* (1997)**, directed by Robert Zemeckis")).toBe(
      "Recommendation: Contact (1997), directed by Robert Zemeckis",
    );
    expect(plainEmphasis("***Both*** at once, and **two** of **them**")).toBe("Both at once, and two of them");
    expect(plainEmphasis("### Why it fits\n\n## **Next**\n# a comment\nC#### sharp")).toBe("Why it fits\n\nNext\n# a comment\nC#### sharp");
    expect(plainEmphasis("**Bold** and *italic*, but 2 * 3 and * a bullet")).toBe("Bold and italic, but 2 * 3 and * a bullet");
  });

  it("leaves what only looks like emphasis", () => {
    for (const line of [
      "x ** 2 + y ** 2 = z ** 2",
      "def f(*args, **kwargs): pass and g(**opts)",
      "src/**/*.ts",
      "**/*.md and **/*.ts",
      "`src/**/*.ts` and `**code span**`",
    ]) {
      expect(plainEmphasis(line)).toBe(line);
    }
    expect(plainEmphasis("**`code`** in bold")).toBe("`code` in bold");
    expect(plainEmphasis("an \\*escaped\\* star")).toBe("an \\*escaped\\* star");
  });

  it("leaves a fence as it is, also one opened in text already shown", () => {
    const fenced = "```md\n## kept\n**kept** *kept*\n```\n## Words\n**out**";
    expect(plainEmphasis(fenced)).toBe("```md\n## kept\n**kept** *kept*\n```\nWords\nout");
    expect(plainEmphasis("~~~\n**kept**\n```\n**kept**\n~~~\n**out**")).toBe("~~~\n**kept**\n```\n**kept**\n~~~\nout");
    expect(plainEmphasis("## kept\n```\n**out**", "intro\n```py\n")).toBe("## kept\n```\nout");
  });

  it("draws a star bullet as a dash", () => {
    expect(plainEmphasis("* one\n  * **two**\n*three*")).toBe("- one\n  - two\nthree");
  });
});

describe("a committed line wider than the terminal", () => {
  it("is laid out whole when a word in it would be broken, and left to word wrap when every word fits", () => {
    const path = "/private/tmp/claude-501/-Users-you-tavi/6d2dd961-8c16-4790-9c61-0c5fba6a84eb/scratchpad/code/plan";
    expect(unbrokenWidth(`… this chat works in ${path}`, 60)).toBe(stringWidth(`… this chat works in ${path}`));
    // Every row of a several-row note is measured, the widest wins.
    expect(unbrokenWidth(`a short row\n  reference (read-only): ${path}`, 60)).toBe(stringWidth(`  reference (read-only): ${path}`));
    expect(unbrokenWidth("A sentence of ordinary words that is longer than the terminal is wide, by a good margin.", 40)).toBeUndefined();
  });
});

describe("colour", () => {
  it("is left out under NO_COLOR, and only there", () => {
    expect(colored("cyan", {})).toEqual({ color: "cyan" });
    expect(colored("cyan", { NO_COLOR: "" })).toEqual({ color: "cyan" });
    expect(colored("cyan", { NO_COLOR: "1" })).toEqual({});
  });
});
