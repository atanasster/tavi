import type { WorkflowMessage } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { browserSessionProgress, type ReadOnlyTool, repeatEscalation, repeatedToolCall } from "../src/workflow/repeats.js";

/** A model call and its answer, as the conversation keeps them. */
function exchange(id: string, name: string, input: unknown, output: unknown): WorkflowMessage[] {
  return [
    { id: `a-${id}`, role: "assistant", text: "", toolCalls: [{ id, name, input }] },
    { id: `t-${id}`, role: "tool", text: "", toolCallId: id, toolName: name, output },
  ];
}

describe("repeatedToolCall", () => {
  it("counts the same call with its keys in another order as a repeat, and its answer likewise", () => {
    const conversation = [
      ...exchange("c1", "web_search", { query: "tea", count: 5 }, { results: [], total: 0 }),
      ...exchange("c2", "web_search", { count: 5, query: "tea" }, { total: 0, results: [] }),
    ];
    expect(repeatedToolCall(conversation)).toMatchObject({ tool: "web_search", times: 2 });
  });

  it("does not count a call whose answer changed", () => {
    const conversation = [
      ...exchange("c1", "web_search", { query: "tea" }, { results: ["a"] }),
      ...exchange("c2", "web_search", { query: "tea" }, { results: ["b"] }),
    ];
    expect(repeatedToolCall(conversation)).toBeUndefined();
  });
});

/** A step of several calls made together, and their answers. */
function fanOut(
  id: string,
  calls: readonly { readonly name: string; readonly input: unknown; readonly output: unknown }[],
): WorkflowMessage[] {
  return [
    {
      id: `a-${id}`,
      role: "assistant",
      text: "",
      toolCalls: calls.map((call, index) => ({ id: `${id}-${index}`, name: call.name, input: call.input })),
    },
    ...calls.map(
      (call, index): WorkflowMessage => ({
        id: `t-${id}-${index}`,
        role: "tool",
        text: "",
        toolCallId: `${id}-${index}`,
        toolName: call.name,
        output: call.output,
      }),
    ),
  ];
}

/** The calls the tests treat as reads, as a registry's annotations would say. */
const reads: ReadOnlyTool = (name) => name === "fs.read" || name === "agents.status" || name === "web_search";

describe("callFingerprint's semantic fields", () => {
  it("counts a call alike in all but its idempotency key, nonce or timestamp as a repeat", () => {
    const conversation = [
      ...exchange("c1", "agents.spawn", { goal: "sum the logs", operationKey: "k1", nonce: "n1" }, { status: "refused" }),
      ...exchange(
        "c2",
        "agents.spawn",
        { goal: "sum the logs", operationKey: "k2", timestamp: "2026-10-27T10:00:00Z" },
        { status: "refused" },
      ),
    ];
    expect(repeatedToolCall(conversation)).toMatchObject({ tool: "agents.spawn", times: 2 });
  });

  it("names an agents.status call by its task alone", () => {
    const conversation = [
      ...exchange("c1", "agents.status", { taskId: "t1", why: "check" }, { status: "running" }),
      ...exchange("c2", "agents.status", { taskId: "t1", why: "check again" }, { status: "running" }),
    ];
    expect(repeatedToolCall(conversation, reads)).toMatchObject({ tool: "agents.status", times: 2 });
    const other = [...conversation.slice(0, 2), ...exchange("c2", "agents.status", { taskId: "t2" }, { status: "running" })];
    expect(repeatedToolCall(other, reads)).toBeUndefined();
  });
});

describe("polling", () => {
  it("never flags agents.status polling whose state changes, nor refuses its next poll", () => {
    const states = ["queued", "running", "running: 2 of 5 done", "running: 4 of 5 done", "completed"];
    const conversation = states.flatMap((status, index) =>
      exchange(`p${index}`, "agents.status", { taskId: "t1" }, { taskId: "t1", status }),
    );
    expect(repeatedToolCall(conversation, reads)).toBeUndefined();
    expect(repeatEscalation(conversation, "agents.status", { taskId: "t1" }, reads)).toBeUndefined();
  });

  it("never flags a back-and-forth whose poll answer changes", () => {
    const conversation = [0, 1, 2, 3].flatMap((round) => [
      ...exchange(`w${round}`, "agents.send", { taskId: "t1", text: "go on" }, { delivered: true }),
      ...exchange(`s${round}`, "agents.status", { taskId: "t1" }, { status: `step ${round}` }),
    ]);
    expect(repeatedToolCall(conversation, reads)).toBeUndefined();
    expect(repeatEscalation(conversation, "agents.status", { taskId: "t1" }, reads)).toBeUndefined();
  });

  it("does not count waiting on a worker again", () => {
    const conversation = [0, 1, 2, 3, 4].flatMap((round) =>
      exchange(`w${round}`, "agents.wait", { taskId: "t1" }, { outcome: { kind: "wait-timeout" } }),
    );
    expect(repeatedToolCall(conversation, reads)).toBeUndefined();
    expect(repeatEscalation(conversation, "agents.wait", { taskId: "t1" }, reads)).toBeUndefined();
  });
});

describe("back-and-forth", () => {
  const read = (id: string) => exchange(id, "fs.read", { path: "a.txt" }, { text: "old" });
  const write = (id: string) => exchange(id, "fs.edit", { path: "a.txt", find: "x", replace: "y" }, { error: "NOT_FOUND" });

  it("is told of after two rounds with the same answers, and not before", () => {
    // The edit made again is the same call twice; no back-and-forth yet.
    expect(repeatedToolCall([...write("1"), ...read("2"), ...write("3")], reads)).not.toHaveProperty("alternate");
    expect(repeatedToolCall([...write("1"), ...read("2"), ...write("3"), ...read("4")], reads)).toMatchObject({
      tool: "fs.read",
      alternate: "fs.edit",
      times: 2,
    });
  });

  it("refuses the call that goes on past the third round, then asks the person past the fourth", () => {
    const rounds = (count: number) => Array.from({ length: count }, (_, round) => [...write(`w${round}`), ...read(`r${round}`)]).flat();
    expect(repeatEscalation(rounds(2), "fs.edit", { path: "a.txt", find: "x", replace: "y" }, reads)).toBeUndefined();
    expect(repeatEscalation(rounds(3), "fs.edit", { path: "a.txt", find: "x", replace: "y" }, reads)).toMatchObject({
      kind: "refuse",
      reason: expect.stringContaining("taken turns"),
    });
    // Another edit is a new approach, and runs.
    expect(repeatEscalation(rounds(3), "fs.edit", { path: "a.txt", find: "z", replace: "y" }, reads)).toBeUndefined();
    // A refusal is no answer: the model that goes on past it is asked about next.
    const refused = exchange("w3", "fs.edit", { path: "a.txt", find: "x", replace: "y" }, { error: "REPEATED_CALL", reason: "…" }).map(
      (message) => (message.role === "tool" ? { ...message, isError: true } : message),
    );
    const pastRefusal = [...rounds(3), ...refused, ...read("r3")];
    expect(repeatEscalation(pastRefusal, "fs.edit", { path: "a.txt", find: "x", replace: "y" }, reads)).toMatchObject({ kind: "ask" });
  });

  it("is no back-and-forth when the turns come in fan-out steps", () => {
    const step = (id: string) =>
      fanOut(id, [
        { name: "fs.read", input: { path: "a.txt" }, output: { text: "a" } },
        { name: "fs.read", input: { path: "b.txt" }, output: { text: "b" } },
      ]);
    expect(repeatedToolCall([...step("1")], reads)).toBeUndefined();
  });
});

describe("exemptions", () => {
  it("starts counting again when the person speaks: a call they asked for again is no loop", () => {
    const run = (id: string) => exchange(id, "sandbox.run", { command: "make" }, { exitCode: 0 });
    const asked: WorkflowMessage = { id: "u2", role: "user", text: "run it again" };
    expect(repeatEscalation([...run("1"), ...run("2"), ...run("3")], "sandbox.run", { command: "make" })).toMatchObject({ kind: "refuse" });
    expect(repeatEscalation([...run("1"), ...run("2"), ...run("3"), asked], "sandbox.run", { command: "make" })).toBeUndefined();
  });

  it("starts counting again after the person answers the repeated-call question", () => {
    const run = (id: string) => exchange(id, "sandbox.run", { command: "make" }, { exitCode: 0 });
    const answered: WorkflowMessage[] = [
      { id: "a-q", role: "assistant", text: "", toolCalls: [{ id: "q", name: "sandbox.run", input: { command: "make" } }] },
      {
        id: "t-q",
        role: "tool",
        text: "",
        toolCallId: "q",
        toolName: "sandbox.run",
        isError: true,
        output: { error: "REPEATED_CALL", reason: "looping", person: { status: "answered", answer: "run it once more" } },
      },
    ];
    const before = [...run("1"), ...run("2"), ...run("3"), ...run("4")];
    expect(repeatEscalation(before, "sandbox.run", { command: "make" })).toBeDefined();
    expect(repeatEscalation([...before, ...answered], "sandbox.run", { command: "make" })).toBeUndefined();
  });

  it("does not count a read made again to check a write", () => {
    const conversation = [
      ...exchange("r1", "fs.read", { path: "a.txt" }, { text: "same" }),
      ...exchange("w1", "fs.write", { path: "a.txt", text: "new" }, { written: true }),
      ...exchange("r2", "fs.read", { path: "a.txt" }, { text: "same" }),
    ];
    expect(repeatedToolCall(conversation, reads)).toBeUndefined();
    // Without knowing which tools read, the two reads are the same call twice.
    expect(repeatedToolCall(conversation)).toMatchObject({ tool: "fs.read", times: 2 });
  });

  it("counts a fan-out of reads naming the same call as one look", () => {
    const conversation = fanOut("f1", [
      { name: "web_search", input: { query: "tea" }, output: { results: [] } },
      { name: "web_search", input: { query: "tea" }, output: { results: [] } },
      { name: "fs.read", input: { path: "a.txt" }, output: { text: "a" } },
    ]);
    const searched = [
      ...fanOut("f1", [
        { name: "fs.read", input: { path: "a.txt" }, output: { text: "a" } },
        { name: "web_search", input: { query: "tea" }, output: { results: [] } },
        { name: "web_search", input: { query: "tea" }, output: { results: [] } },
      ]),
    ];
    expect(repeatedToolCall(conversation, reads)).toBeUndefined();
    expect(repeatedToolCall(searched, reads)).toBeUndefined();
    // A later step making it again is a repeat, the fan-out counted once.
    expect(repeatedToolCall([...searched, ...exchange("s2", "web_search", { query: "tea" }, { results: [] })], reads)).toMatchObject({
      times: 2,
    });
  });
});

describe("browserSessionProgress", () => {
  it("reads a page whose elements came back with their keys in another order, and a new epoch, as unchanged", () => {
    const page = (elements: readonly unknown[], epoch: number) => ({
      page: { sessionId: "s1", url: "https://shop.example/", epoch, elements },
    });
    const conversation = [
      ...exchange(
        "c1",
        "browser.act",
        { sessionId: "s1", kind: "click", ref: "el-1" },
        page([{ ref: "el-1", role: "button", text: "Buy" }], 1),
      ),
      ...exchange(
        "c2",
        "browser.act",
        { sessionId: "s1", kind: "click", ref: "el-1" },
        page([{ text: "Buy", role: "button", ref: "el-1" }], 2),
      ),
    ];
    // The first act sets the page's signature; the second, alike in all but key order and epoch, made no progress.
    expect(browserSessionProgress(conversation).get("s1")?.noChangeActions).toBe(1);
  });
});
