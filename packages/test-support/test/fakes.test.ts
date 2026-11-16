import { createHash } from "node:crypto";

import { CONTEXT_MESSAGE_END, CONTEXT_MESSAGE_HEAD, type ModelEvent, type ModelRequest, type PromptSelectionPolicy } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import {
  admitFixtureTask,
  contextBlockOf,
  createFixtureModel,
  createInMemorySaver,
  createInMemoryTaskRepository,
  isContextBlock,
  withoutContextBlock,
} from "../src/fakes.js";

const policy: PromptSelectionPolicy = { builtin: { text: "You are a fixture.", version: "fixture-1" } };

function request(attemptNumber: number, messages: ModelRequest["messages"] = []): ModelRequest {
  return { attemptId: `attempt-${attemptNumber}`, attemptNumber, messages } as unknown as ModelRequest;
}

describe("createFixtureModel", () => {
  it("plays its turns in order, repeating the last, and streams text in two deltas", async () => {
    const model = createFixtureModel({
      turns: [{ toolCall: { id: "c1", name: "fs.read", input: { path: "a" } } }, { text: "done" }],
      usagePerTurn: { inputTokens: 2, outputTokens: 3 },
    });
    const events: ModelEvent[] = [];
    const signal = new AbortController().signal;
    const first = await model.stream(request(1), { signal, onEvent: (event) => events.push(event) });
    expect(first).toMatchObject({
      status: "completed",
      finishReason: "tool-calls",
      toolCalls: [{ id: "c1", name: "fs.read", input: { path: "a" } }],
      usage: { totalTokens: 5 },
    });
    const second = await model.stream(request(2), { signal, onEvent: (event) => events.push(event) });
    expect(second).toMatchObject({ status: "completed", text: "done", finishReason: "stop" });
    expect(events.filter((event) => event.type === "text.delta").map((event) => (event as { text: string }).text)).toEqual(["do", "ne"]);
    expect((await model.stream(request(5), { signal, onEvent: () => {} })).text).toBe("done");
    expect(model.calls).toHaveLength(3);
  });

  it("fails a call as failWith says, and answers an aborted one as aborted", async () => {
    const model = createFixtureModel({
      turns: [{ text: "never" }],
      failWith: () => ({ error: { code: "rate_limit", message: "429", retryable: true }, partialText: "par" }),
    });
    expect(await model.stream(request(1), { signal: new AbortController().signal, onEvent: () => {} })).toMatchObject({
      status: "failed",
      text: "par",
      error: { code: "rate_limit" },
    });
    const aborted = new AbortController();
    aborted.abort();
    expect(
      (await createFixtureModel({ turns: [{ text: "x" }] }).stream(request(1), { signal: aborted.signal, onEvent: () => {} })).status,
    ).toBe("aborted");
  });
});

describe("the in-memory repositories", () => {
  it("admits a fixture task bound under the given prompt, hashed as the store hashes it", async () => {
    const tasks = createInMemoryTaskRepository();
    await admitFixtureTask(tasks, "t-1", policy, { workspaceId: "w2", principalId: "bob" });
    const task = await tasks.get("t-1");
    expect(task).toMatchObject({ taskId: "t-1", workspaceId: "w2", principalId: "bob" });
    const snapshot = await tasks.getPromptSnapshot("t-1");
    expect(snapshot).toMatchObject({
      source: "builtin",
      text: "You are a fixture.",
      templateVersion: "fixture-1",
      hash: createHash("sha256").update("You are a fixture.").digest("hex"),
    });
  });

  it("opens a checkpoint saver on a fresh in-memory database", () => {
    const { saver, db } = createInMemorySaver();
    expect(saver).toBeDefined();
    expect(db.prepare("select 1 as one").get()).toEqual({ one: 1 });
    db.close();
  });
});

describe("the context block helpers", () => {
  const block = `${CONTEXT_MESSAGE_HEAD}\nfacts\n${CONTEXT_MESSAGE_END}`;

  it("finds a request's context block and strips it from a person's words", () => {
    const folded = { id: "m1", role: "user" as const, text: `${block}\n\nhello` };
    expect(isContextBlock(folded)).toBe(true);
    expect(isContextBlock({ id: "m2", role: "user", text: "hello" })).toBe(false);
    expect(withoutContextBlock(folded.text)).toBe("hello");
    expect(contextBlockOf(request(1, [folded] as never))).toBe(block);
    expect(contextBlockOf(undefined)).toBe("");
  });
});
