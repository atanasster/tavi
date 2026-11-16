import { CLIENT_PROTOCOL_VERSION, ClientEventSchema, type ClientEvent } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { createEventRenderer, fireFinalText } from "../../src/features/run/client-events.js";

/** `tavi run --format text`'s rendering of an attempt boundary: a resume, and a failover. */

const base = { protocolVersion: CLIENT_PROTOCOL_VERSION, epoch: "epoch-0", runId: "task-1", at: "2026-09-19T00:00:00.000Z" };
let sequence = 0;
const event = (fields: Record<string, unknown>): ClientEvent =>
  ClientEventSchema.parse({ ...base, sequence: (sequence += 1), attemptId: "attempt-1", ...fields });

describe("the text renderer", () => {
  it("puts a failover on its own line after half a line, saying the text above is not the answer", () => {
    let written = "";
    const renderer = createEventRenderer({ format: "text", write: (chunk) => void (written += chunk) });
    renderer.render(event({ kind: "text.delta", blockId: "b", text: "Half an" }));
    renderer.render(
      event({
        kind: "attempt.replaced",
        attemptId: "attempt-2",
        supersededAttemptId: "attempt-1",
        reason: "the model call failed over: a/m answered rate_limit",
        discarded: true,
      }),
    );
    renderer.render(event({ kind: "text.delta", attemptId: "attempt-2", blockId: "b", text: "A whole answer." }));
    renderer.finish();
    expect(written).toBe(
      "Half an\n[attempt] the model call failed over: a/m answered rate_limit — the text above from attempt-1 is not the answer\nA whole answer.\n",
    );
  });

  it("says a stopped turn without a failure or a code", () => {
    let written = "";
    const renderer = createEventRenderer({ format: "text", write: (chunk) => void (written += chunk) });
    renderer.render(event({ kind: "task.stopped", message: "You stopped this." }));
    expect(written).toBe("\n[stopped] You stopped this.\n");
  });

  it("words a resume after a round as after the decision, which may have been a denial", () => {
    let written = "";
    const renderer = createEventRenderer({ format: "text", write: (chunk) => void (written += chunk) });
    renderer.render(
      event({ kind: "attempt.replaced", attemptId: "attempt-2", supersededAttemptId: "attempt-1", reason: "resuming after approval" }),
    );
    renderer.render(
      event({ kind: "attempt.replaced", attemptId: "attempt-3", supersededAttemptId: "attempt-2", reason: "resuming after deadline" }),
    );
    expect(written).toBe(
      "[attempt] replaced attempt-1: resuming after the decision\n[attempt] replaced attempt-2: resuming after deadline\n",
    );
  });

  const approval = (fields: Record<string, unknown>) =>
    event({
      kind: "approval.required",
      callId: "call-1",
      toolName: "fs.edit",
      summary: "Edit todo.txt",
      steps: 1,
      approvalId: "approval-1",
      ...fields,
    });

  it("prints a file change once, as its diff, not its input as JSON", () => {
    let written = "";
    const renderer = createEventRenderer({ format: "text", write: (chunk) => void (written += chunk) });
    renderer.render(
      approval({
        input: { path: "todo.txt", oldText: "- call the plumber\n", newText: "- call the plumber\n- buy milk\n" },
        display: { title: "Edit todo.txt", detail: "--- todo.txt\n+++ todo.txt\n@@ -1 +1,2 @@\n - call the plumber\n+- buy milk" },
      }),
    );
    expect(written).toBe(
      "[approval] Edit todo.txt\n  --- todo.txt\n  +++ todo.txt\n  @@ -1 +1,2 @@\n   - call the plumber\n  +- buy milk\n",
    );
  });

  it("prints any other call with its input, what it would hide marked", () => {
    let written = "";
    const renderer = createEventRenderer({ format: "text", write: (chunk) => void (written += chunk) });
    renderer.render(approval({ toolName: "sandbox.run", summary: "Run ls", input: { command: `ls\u202e` } }));
    expect(written).toBe('[approval] Run ls {"command":"ls⟨U+202E⟩"}\n');
  });

  it("says what flagged a call besides taint, as a guard mod gave it (Mac mini tests)", () => {
    let written = "";
    const renderer = createEventRenderer({ format: "text", write: (chunk) => void (written += chunk) });
    renderer.render(
      approval({
        toolName: "sandbox.run",
        summary: "Run rm -rf build",
        input: { command: "rm -rf build" },
        risk: {
          level: "high",
          tainted: true,
          reasons: [
            "deletes files recursively",
            "acme.guard: deletes files recursively",
            "the conversation contains untrusted content from the web or a document",
          ],
        },
      }),
    );
    expect(written).toBe(
      '[approval] Run rm -rf build {"command":"rm -rf build"}\n  Flagged: deletes files recursively · acme.guard: deletes files recursively\n',
    );
  });

  it("says how a round was decided, and that --approval deny decided it", () => {
    let written = "";
    const renderer = createEventRenderer({ format: "text", write: (chunk) => void (written += chunk) });
    const settled = (decidedBy: string, approved: boolean[]) =>
      event({
        kind: "approval.settled",
        steps: 1,
        decidedBy,
        decisions: approved.map((ok, index) => ({ callId: `call-${index}`, approved: ok })),
      });
    renderer.render(settled("auto:local", [false]));
    renderer.render(settled("auto:local", [true, true]));
    renderer.render(settled("schedule:morning-brief", [false]));
    renderer.render(settled("local", [true, false]));
    expect(written).toBe(
      [
        "[approval] denied by --approval deny",
        "[approval] approved by --approval approve",
        "[approval] denied by the schedule morning-brief's policy",
        "[approval] 1 approved, 1 denied by local",
        "",
      ].join("\n"),
    );
  });

  it("under --approval approve, says a refused call needed a person, never that --approval deny refused it", () => {
    let written = "";
    const renderer = createEventRenderer({ format: "text", write: (chunk) => void (written += chunk), approval: "approve" });
    const settled = (approved: boolean[]) =>
      event({
        kind: "approval.settled",
        steps: 1,
        decidedBy: "auto:local",
        decisions: approved.map((ok, index) => ({ callId: `call-${index}`, approved: ok })),
      });
    renderer.render(settled([false]));
    renderer.render(settled([true, false]));
    renderer.render(settled([true]));
    expect(written).not.toContain("--approval deny");
    expect(written.split("\n")).toEqual([
      "[approval] denied, as a person must decide it and nobody attends this run (--approval approve does not cover it)",
      "[approval] 1 approved by --approval approve, 1 denied, as a person must decide it and nobody attends this run (--approval approve does not cover it)",
      "[approval] approved by --approval approve",
      "",
    ]);
  });

  it("prints a schedule fire's quiet marker in words, and any other answer as it streams", () => {
    const rendered = (texts: readonly string[], end: "completed" | "tool") => {
      let written = "";
      const renderer = createEventRenderer({ format: "text", write: (chunk) => void (written += chunk), quietMarker: true });
      for (const text of texts) renderer.render(event({ kind: "text.delta", blockId: "b", text }));
      if (end === "completed") renderer.render(event({ kind: "task.completed", finalText: texts.join("") }));
      else renderer.render(event({ kind: "tool.started", blockId: "t", callId: "call-1", toolName: "fs.read", input: {} }));
      renderer.finish();
      return written;
    };
    expect(rendered(["[nothing", " to report]"], "completed")).toBe("nothing to report\n");
    expect(rendered(["[Nothing to report]\n"], "completed")).toBe("nothing to report\n");
    expect(rendered(["[nothing", " new] The library is closed."], "completed")).toBe("[nothing new] The library is closed.\n");
    expect(rendered(["The library", " is closed."], "completed")).toBe("The library is closed.\n");
    // A fire that ran nothing live (offline `run-now`, or one the owner answered at once).
    expect(fireFinalText(" [nothing to report] ")).toBe("nothing to report");
    expect(fireFinalText("Closed today.")).toBe("Closed today.");
    expect(rendered(["[nothing to report]"], "tool")).toBe("[nothing to report]\n[tool] fs.read ← {}\n");
  });

  it("prints a plugin's notice and the suggested next prompts, each on its own line", () => {
    let written = "";
    const renderer = createEventRenderer({ format: "text", write: (chunk) => void (written += chunk) });
    renderer.render(event({ kind: "text.delta", blockId: "b", text: "Done" }));
    renderer.render(event({ kind: "plugin.notice", pluginId: "acme.meter", notice: "the cache is warm\u001b[2J" }));
    renderer.render(event({ kind: "turn.suggested", suggestions: ["Run the tests", "Open a PR"] }));
    expect(written).toBe("Done\n[plugin] acme.meter: the cache is warm[2J\n[suggested] Run the tests · Open a PR\n");
  });
});
