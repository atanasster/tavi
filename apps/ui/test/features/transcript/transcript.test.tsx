import type { TranscriptEntry } from "@tavi/client/browser";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TOOL_HEADLINE_FIELDS } from "@tavi/contracts";
import { groupEntries, Transcript } from "../../../src/features/transcript/Transcript.js";
import { headlineOf, rendererFor, TOOL_FAMILIES, TOOL_RENDERERS } from "../../../src/features/transcript/ToolCards.js";
import { textEntry as text, toolCard as card } from "../../support/rows.js";

/**
 * How a transcript is drawn: consecutive tool calls
 * as one collapsed block, a renderer per family rather than a `switch`, and an
 * entry that cannot be rendered taking only its own row.
 */

describe("grouping consecutive tool calls", () => {
  it("folds a run of tool calls into one group and leaves everything else alone", () => {
    const groups = groupEntries([text("t1", "first"), card("c1"), card("c2"), card("c3"), text("t2", "second"), card("c4")]);
    expect(groups.map((group) => group.kind)).toEqual(["entry", "tools", "entry", "tools"]);
    expect(groups[1]?.kind === "tools" && groups[1].cards.map((entry) => entry.callId)).toEqual(["c1", "c2", "c3"]);
    expect(groups[3]?.kind === "tools" && groups[3].cards).toHaveLength(1);
  });

  it("keys a group by its first card, so folding does not renumber what is already on screen", () => {
    expect(groupEntries([card("c1"), card("c2")])[0]?.key).toBe("c1");
  });

  it("holds an empty transcript without inventing a group", () => {
    expect(groupEntries([])).toEqual([]);
  });

  const resume: TranscriptEntry = {
    kind: "boundary",
    key: "b1",
    attemptId: "a2",
    supersededAttemptId: "a1",
    reason: "resuming after approval",
  };
  const failover: TranscriptEntry = {
    kind: "boundary",
    key: "b2",
    attemptId: "a3",
    supersededAttemptId: "a2",
    reason: "m1 answered rate_limited",
    discarded: true,
  };

  it("drops a resume, so calls decided one by one stay one group", () => {
    const groups = groupEntries([card("c1"), resume, card("c2"), { ...resume, key: "b3" }, card("c3")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind === "tools" && groups[0].cards.map((entry) => entry.callId)).toEqual(["c1", "c2", "c3"]);
  });

  it("puts a failover inside the group it falls in, or the next one, and alone only when text follows it", () => {
    const within = groupEntries([card("c1"), failover, card("c2")]);
    expect(within).toHaveLength(1);
    expect(within[0]?.kind === "tools" && within[0].failovers).toEqual([failover]);
    const before = groupEntries([text("t1", "x"), failover, card("c1")]);
    expect(before.map((group) => group.kind)).toEqual(["entry", "tools"]);
    expect(before[1]?.kind === "tools" && before[1].failovers).toEqual([failover]);
    const after = groupEntries([card("c1"), failover, text("t1", "x")]);
    expect(after.map((group) => group.kind)).toEqual(["tools", "entry"]);
    expect(after[0]?.kind === "tools" && after[0].failovers).toEqual([failover]);
    const alone = groupEntries([failover, text("t1", "x")]);
    expect(alone.map((group) => group.key)).toEqual(["b2", "t1"]);
  });
});

describe("the tool renderer registry", () => {
  it("is keyed on the families this runtime registers, not on plausible names", () => {
    // The families are the contracts' headline table, which the approvals
    // inbox shares; each has a renderer, and no renderer is for a family the
    // table does not name.
    expect(Object.keys(TOOL_RENDERERS).sort()).toEqual([...TOOL_FAMILIES].sort());
    for (const family of TOOL_FAMILIES) expect(rendererFor(`${family}.anything`).headline, family).toBeDefined();
    expect([...TOOL_FAMILIES]).toEqual(Object.keys(TOOL_HEADLINE_FIELDS).sort());
    expect(TOOL_FAMILIES).toEqual([
      "agents",
      "artifacts",
      "browser",
      "collect",
      "fs",
      "gcp",
      "gsc",
      "http",
      "memory",
      "messaging",
      "news",
      "operator",
      "pdf",
      "projects",
      "reports",
      "sandbox",
      "stripe",
      "video",
      "web",
    ]);
  });

  it("names what the collectors and the report tools are scoped by", () => {
    for (const toolName of ["collect.daily", "gcp.billing", "gsc.query", "news.search", "projects.get", "stripe.subscriptions"]) {
      expect(headlineOf(card("c1", { toolName, input: { projectId: "acme" } })), toolName).toBe("acme");
    }
    expect(headlineOf(card("c1", { toolName: "reports.history", input: { metricKey: "mrr" } }))).toBe("mrr");
  });

  it("picks a renderer by family, and falls back to one that adds nothing", () => {
    expect(rendererFor("sandbox.run")).toBe(TOOL_RENDERERS["sandbox"]);
    expect(rendererFor("http.request")).toBe(TOOL_RENDERERS["http"]);
    // A tool no family claims still renders: the fallback adds no headline, and
    // is the contract for a family registered after this table was written.
    expect(rendererFor("fixture.echo").headline).toBeUndefined();
    expect(rendererFor("bare").headline).toBeUndefined();
    // And a tool id that names something on `Object.prototype` is not a renderer.
    expect(rendererFor("constructor.x").headline).toBeUndefined();
    expect(rendererFor("toString.x").body).toBeUndefined();
  });

  it("puts what the call touched on the summary, clamped to one line", () => {
    expect(headlineOf(card("c1", { toolName: "sandbox.run", input: { command: "pnpm run build" } }))).toBe("pnpm run build");
    expect(headlineOf(card("c1", { toolName: "http.request", input: { url: "https://example.com/a" } }))).toBe("https://example.com/a");
    expect(headlineOf(card("c1", { toolName: "web_search", input: { query: "tavi orchestrator" } }))).toBe("tavi orchestrator");
    expect(headlineOf(card("c1", { toolName: "browser.navigate", input: { sessionId: "s-1", url: "https://example.com" } }))).toBe(
      "https://example.com",
    );
    expect(headlineOf(card("c1", { toolName: "agents.spawn", input: { agentDefinitionId: "researcher", input: "go" } }))).toBe(
      "researcher",
    );
    expect(headlineOf(card("c1", { toolName: "operator.ask_user", input: { question: "Which folder?" } }))).toBe("Which folder?");
    expect(headlineOf(card("c1", { toolName: "sandbox.run", input: { command: "rm -rf build/\nthen more" } }))).toBe("rm -rf build/");
    expect(headlineOf(card("c1", { toolName: "sandbox.run", input: { command: "x".repeat(200) } }))).toHaveLength(72);
  });

  it("says nothing rather than guessing when the payload is not what the family expects", () => {
    expect(headlineOf(card("c1", { toolName: "sandbox.run", input: undefined }))).toBeUndefined();
    expect(headlineOf(card("c1", { toolName: "sandbox.run", input: "a string" }))).toBeUndefined();
    expect(headlineOf(card("c1", { toolName: "messaging.send_to", input: { chatId: 42 } }))).toBe("42");
    // A number that is not one: `NaN` is not a headline.
    expect(headlineOf(card("c1", { toolName: "messaging.send_to", input: { chatId: Number.NaN } }))).toBeUndefined();
    expect(headlineOf(card("c1", { toolName: "sandbox.run", input: { nothing: "useful" } }))).toBeUndefined();
  });
});

describe("the rendered transcript", () => {
  it("collapses a run of finished tool calls, and says how they ended", () => {
    const html = renderToStaticMarkup(
      <Transcript
        entries={[
          card("c1", { toolName: "sandbox.run", input: { command: "pnpm build" } }),
          card("c2", { toolName: "http.request", status: "failed", message: "502" }),
          card("c3", { toolName: "web_search" }),
        ]}
      />,
    );
    // One block, not three sibling cards.
    expect(html).toContain("Worked · 3 steps");
    expect(html).toContain("1 failed");
    // Nothing running: collapsed.
    expect(html).not.toContain("<details open");
    expect(html).toContain("sandbox.run, http.request, web_search");
    expect(renderToStaticMarkup(<Transcript entries={[card("c1"), card("c2"), card("c3", { toolName: "http.request" })]} />)).toContain(
      "sandbox.run ×2, http.request",
    );
    expect(html).toContain("pnpm build");
  });

  it("does not count keeping the plan as a step", () => {
    const plan = (callId: string) => card(callId, { toolName: "plan.update", input: { items: [{ content: "Search", status: "done" }] } });
    const html = renderToStaticMarkup(
      <Transcript entries={[plan("p1"), card("c1", { toolName: "web_search" }), plan("p2"), card("c2", { toolName: "web_search" })]} />,
    );
    expect(html).toContain("Worked · 2 steps");
    expect(html).toContain('truncate">web_search ×2</span>');
    expect(html).not.toContain("plan.update ×");
    expect(renderToStaticMarkup(<Transcript entries={[plan("p1"), plan("p2")]} />)).toContain("Updated the plan");
    // A plan update under way is not the step the block names.
    const updating = renderToStaticMarkup(
      <Transcript entries={[card("c1", { toolName: "web_search" }), { ...plan("p1"), status: "running" }]} />,
    );
    expect(updating).toContain("Worked · 1 step");
    expect(updating).toContain('truncate">web_search</span>');
  });

  it("leaves a group folded while one of its calls is still going: open or shut is the reader's", () => {
    const html = renderToStaticMarkup(
      <Transcript entries={[card("c1"), card("c2", { status: "running", input: { command: "pnpm test" } })]} />,
    );
    expect(html).not.toContain('<details class="tools" open');
    // The summary says what the turn is doing now.
    expect(html).toContain("Working · 2 steps");
    expect(html).toContain("sandbox.run pnpm test");
    // A running call with no headline is named alone.
    const bare = renderToStaticMarkup(<Transcript entries={[card("c1"), card("c2", { toolName: "custom.tool", status: "running" })]} />);
    expect(bare).toContain('truncate">custom.tool</span>');
  });

  it("renders a lone tool call with its own line, in the element a second call will join", () => {
    const html = renderToStaticMarkup(<Transcript entries={[card("c1", { durationMs: 340, input: { command: "ls" } })]} />);
    expect(html).not.toContain("1 step");
    // The same `details.tools` a group uses, so expanding it survives the next
    // call arriving rather than being replaced and folded away.
    expect(html).toContain('class="tools"');
    expect(html).toContain("sandbox.run");
    expect(html).toContain("340ms");
    expect(html).toContain("ls");
    expect(renderToStaticMarkup(<Transcript entries={[card("c1", { durationMs: 1500 })]} />)).toContain("1.5s");
  });

  it("keeps the plan out of the transcript: it is in the Activity tab", () => {
    const html = renderToStaticMarkup(
      <Transcript entries={[card("c1", { toolName: "plan.update", input: { items: [{ content: "Search", status: "done" }] } })]} />,
    );
    expect(html).not.toContain('aria-label="plan"');
  });

  it("labels text, draws no resume, and says a failover inside the block it interrupted", () => {
    const html = renderToStaticMarkup(
      <Transcript
        entries={[
          text("t1", "an answer"),
          { kind: "boundary", key: "b", attemptId: "a2", supersededAttemptId: "a1", reason: "resuming after approval" },
        ]}
      />,
    );
    expect(html).toContain("assistant: ");
    expect(html).toContain("an answer");
    expect(html).not.toContain("resuming after approval");
    const retried = renderToStaticMarkup(
      <Transcript
        entries={[
          card("c1"),
          { kind: "boundary", key: "b", attemptId: "a2", supersededAttemptId: "a1", reason: "m1 answered rate_limited", discarded: true },
          card("c2"),
        ]}
      />,
    );
    expect(retried).toContain("retried");
    expect(retried).toContain("Retried on another model: m1 answered rate_limited");
  });

  it("escapes what a model or a tool wrote, never interpreting it", () => {
    const html = renderToStaticMarkup(
      <Transcript entries={[text("t1", "<script>alert(1)</script>"), card("c1", { output: "<b>not bold</b>" })]} />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
  });
});

describe("a settled question's receipt", () => {
  it("follows the card that asked it, once, and not before it is asked", () => {
    const receipt = {
      waitId: "wait:6:task-1:1:ask-1",
      outcome: "answered" as const,
      answers: ["Ship it"],
      decidedBy: "Ana",
      via: "telegram-main",
      at: "2026-10-02T14:02:00.000Z",
    };
    const html = renderToStaticMarkup(
      <Transcript
        entries={[
          text("t1", "Checking."),
          card("ask-1", { toolName: "operator.ask_user", status: "interrupted" }),
          card("ask-1b", { toolName: "operator.ask_user", callId: "ask-1" }),
          text("t2", "Shipping."),
        ]}
        receipts={[receipt]}
      />,
    );
    expect(html.match(/class="need-receipt /g)).toHaveLength(1);
    expect(html.indexOf("need-receipt")).toBeGreaterThan(html.indexOf("Checking."));
    expect(html.indexOf("need-receipt")).toBeLessThan(html.indexOf("Shipping."));
    expect(renderToStaticMarkup(<Transcript entries={[text("t1", "Checking.")]} receipts={[receipt]} />)).not.toContain("need-receipt");
  });
});

describe("placing receipts when a call id is reused", () => {
  it("hands each completed ask its own receipt, in order, and an unread one to the last that asked", async () => {
    const { placeReceipts } = await import("../../../src/features/transcript/Transcript.js");
    const at = (minute: number) => `2026-10-02T14:0${minute}:00.000Z`;
    const first = { waitId: "wait:6:task-1:1:ask", outcome: "answered" as const, replyText: "first", at: at(1) };
    const second = { waitId: "wait:6:task-1:3:ask", outcome: "answered" as const, replyText: "second", at: at(3) };
    const entries = [
      card("k1", { toolName: "operator.ask_user", callId: "ask" }),
      text("t", "between"),
      card("k2", { toolName: "operator.ask_user", callId: "ask" }),
    ];
    expect([...placeReceipts(entries, [second, first])].map(([key, list]) => [key, list.map((receipt) => receipt.replyText)])).toEqual([
      ["k1", ["first"]],
      ["k2", ["second"]],
    ]);
    // The second answer's turn has not completed its call yet: it follows that ask all the same.
    const pending = [
      card("k1", { toolName: "operator.ask_user", callId: "ask" }),
      card("k2", { toolName: "operator.ask_user", callId: "ask", status: "interrupted" }),
    ];
    expect([...placeReceipts(pending, [first, second])].map(([key, list]) => [key, list.map((receipt) => receipt.replyText)])).toEqual([
      ["k1", ["first"]],
      ["k2", ["second"]],
    ]);
  });
});

describe("a browser handoff's receipt", () => {
  it("follows the call that waited for the person, and says how it went without anything they typed", async () => {
    const { placeReceipts } = await import("../../../src/features/transcript/Transcript.js");
    const { HandoffReceipt } = await import("../../../src/features/transcript/Receipts.js");
    const at = "2026-10-04T10:05:00.000Z";
    const done = {
      waitId: "wait:6:task-1:2:hand",
      outcome: "answered" as const,
      replyText: "Signed in as guest",
      handoff: { outcome: "done" as const, controlledMs: 72_000 },
      handedOver: true as const,
      at,
    };
    const converted = {
      waitId: "wait:6:task-1:4:nav",
      outcome: "answered" as const,
      handoff: { outcome: "failed" as const, controlledMs: 5_000 },
      handedOver: true as const,
      at,
    };
    const entries = [
      card("k1", { toolName: "browser.request_handoff", callId: "hand" }),
      card("k2", { toolName: "browser.navigate", callId: "nav" }),
    ];
    expect([...placeReceipts(entries, [done, converted])].map(([key, list]) => [key, list.map((receipt) => receipt.waitId)])).toEqual([
      ["k1", [done.waitId]],
      ["k2", [converted.waitId]],
    ]);
    // A reused call id: the question's receipt stays with the question, the handoff's with the browser call.
    const question = { waitId: "wait:6:task-1:2:same", outcome: "answered" as const, replyText: "Acme", at };
    const handedBack = { ...done, waitId: "wait:6:task-1:4:same" };
    const reused = [
      card("q", { toolName: "operator.ask_user", callId: "same" }),
      card("b", { toolName: "browser.navigate", callId: "same" }),
    ];
    expect([...placeReceipts(reused, [handedBack, question])].map(([key, list]) => [key, list.map((receipt) => receipt.waitId)])).toEqual([
      ["q", [question.waitId]],
      ["b", [handedBack.waitId]],
    ]);
    expect(renderToStaticMarkup(<HandoffReceipt receipt={done} />)).toContain(
      "You controlled the browser for 1 m 12 s — done · Signed in as guest",
    );
    expect(renderToStaticMarkup(<HandoffReceipt receipt={converted} />)).toContain(
      "You controlled the browser for 5 s — couldn&#x27;t do it",
    );
    expect(
      renderToStaticMarkup(
        <HandoffReceipt receipt={{ ...done, handoff: { outcome: "failed", controlledMs: 0 }, replyText: "No access" }} />,
      ),
    ).toContain("You told Tavi you couldn&#x27;t do it · No access");
    expect(renderToStaticMarkup(<HandoffReceipt receipt={{ waitId: "w", outcome: "wait-timeout", handedOver: true, at }} />)).toContain(
      "Nobody took over the browser in time",
    );
  });

  it("says the same of a hold the task did not wait for", async () => {
    const { BrowserControlRow } = await import("../../../src/features/transcript/Receipts.js");
    const at = "2026-10-04T10:05:00.000Z";
    const sessionId = "6f1d2c3b-0000-4000-8000-000000000001";
    expect(
      renderToStaticMarkup(<BrowserControlRow receipt={{ sessionId, outcome: "done", controlledMs: 72_000, note: "Logged in", at }} />),
    ).toContain("You controlled the browser for 1 m 12 s — done · Logged in");
    expect(renderToStaticMarkup(<BrowserControlRow receipt={{ sessionId, outcome: "timeout", controlledMs: 720_000, at }} />)).toContain(
      "You controlled the browser for 12 m 0 s — handed back when it went idle",
    );
  });
});
