import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkflowWaitSuspend } from "@tavi/contracts";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories, delay } from "@tavi/test-support";

import { McpConnection, type McpElicitation } from "../../src/features/mcp/client.js";
import { planElicitation } from "../../src/features/mcp/elicitation.js";
import { McpSupervisor } from "../../src/features/mcp/supervisor.js";

/** Elicitation: a server's question, asked of the task's person. */

const FAKE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures/mcp/fake-server.mjs");
const directories = temporaryDirectories();
const open: McpConnection[] = [];
afterAll(() => directories.cleanup());
afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
});

function stdio(era: "legacy" | "modern"): McpConnection {
  const connection = new McpConnection({
    endpoint: {
      transport: "stdio",
      spawn: {
        command: process.execPath,
        args: [FAKE],
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", FAKE_ERA: era },
        stdinGraceMs: 200,
        killGraceMs: 500,
      },
    },
  });
  open.push(connection);
  return connection;
}

describe("the client answers a server's question in each era", () => {
  for (const era of ["legacy", "modern"] as const) {
    it(`${era}: through the call's answerer, declined without one`, async () => {
      const connection = stdio(era);
      const asked: { request: McpElicitation; era: string }[] = [];
      const result = await connection.callTool(
        "pick",
        {},
        {
          elicit: async (request, givenEra) => {
            asked.push({ request, era: givenEra });
            return { action: "accept", content: { colour: "green" } };
          },
        },
      );
      expect(result.content).toBe('pick: accept {"colour":"green"}');
      expect(asked).toEqual([{ request: expect.objectContaining({ message: "Which colour?" }), era }]);
      expect((await connection.callTool("confirm", {})).content).toBe("confirm: decline");
    }, 30_000);

    it(`${era}: a question the person has not answered yet suspends the call's task, however the SDK carries it`, async () => {
      const connection = stdio(era);
      const suspend = new WorkflowWaitSuspend({ waitId: "w", deadlineAt: "2026-10-15T00:00:00.000Z" });
      const call = connection.callTool(
        "confirm",
        {},
        {
          elicit: async () => {
            throw suspend;
          },
        },
      );
      await expect(call).rejects.toBe(suspend);
      // The connection is not broken by it.
      expect((await connection.callTool("echo", { text: "after" })).content).toBe("after");
    }, 30_000);
  }
});

describe("the supervisor's clock", () => {
  it("pauses while a legacy question waits: an answer after the tool's own timeout still reaches the call", async () => {
    const supervisor = new McpSupervisor({
      dataDirectory: directories.create("tavi-mcp-elicit-"),
      spec: async () => ({
        pluginId: "mcp.fake",
        version: "1.0.0",
        transport: "stdio",
        maxMessageBytes: 1024 * 1024,
        concurrency: 4,
        prior: { kind: "legacy" },
        endpoint: async () => ({
          transport: "stdio",
          spawn: {
            command: process.execPath,
            args: [FAKE],
            env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", FAKE_ERA: "legacy" },
            stdinGraceMs: 200,
            killGraceMs: 500,
          },
        }),
      }),
    });
    try {
      const result = await supervisor.call(
        "mcp.fake",
        "confirm",
        {},
        {
          timeoutMs: 1_000,
          elicit: async () => {
            await delay(2_500);
            return { action: "accept", content: {} };
          },
        },
      );
      expect(result.content).toBe("confirm: accept");
    } finally {
      await supervisor.shutdown();
    }
  }, 30_000);
});

describe("a server's question as the person sees it", () => {
  const answered = (text: string) => ({ kind: "answered" as const, answers: [text] });
  it("a confirmation is Accept or Decline; nobody answering sends nothing", () => {
    const plan = planElicitation(
      "docs",
      { mode: "form", message: "Delete the draft?", requestedSchema: { type: "object", properties: {} } },
      "modern",
    );
    if (plan.kind !== "ask") throw new Error("declined");
    expect(plan.question).toMatchObject({
      question: "docs asks: Delete the draft?",
      choices: { options: [{ label: "Accept" }, { label: "Decline" }] },
      deadlineMs: 24 * 60 * 60 * 1000,
    });
    expect(plan.read(answered("Accept"))).toEqual({ action: "accept", content: {} });
    expect(plan.read(answered("Decline"))).toEqual({ action: "decline" });
    expect(plan.read({ kind: "wait-timeout" })).toBeUndefined();
    expect(plan.read({ kind: "cancelled" })).toBeUndefined();
  });

  it("a boolean or a short enum gets buttons; a long one, a number or free text is typed, and checked", () => {
    const one = (property: Record<string, unknown>) => {
      const plan = planElicitation(
        "docs",
        { mode: "form", message: "Q", requestedSchema: { type: "object", properties: { f: property as never } } },
        "legacy",
      );
      if (plan.kind !== "ask") throw new Error("declined");
      return plan;
    };
    const flag = one({ type: "boolean" });
    expect(flag.question.choices?.options.map((option) => option.label)).toEqual(["Yes", "No", "Decline"]);
    expect(flag.read(answered("No"))).toEqual({ action: "accept", content: { f: false } });
    expect(flag.question.deadlineMs).toBe(10 * 60 * 1000);
    const colour = one({
      type: "string",
      oneOf: [
        { const: "r", title: "Red" },
        { const: "g", title: "Green" },
      ],
    });
    expect(colour.question.choices?.options.map((option) => option.label)).toEqual(["Red", "Green", "Decline"]);
    expect(colour.read(answered("Green"))).toEqual({ action: "accept", content: { f: "g" } });
    const many = one({ type: "string", enum: ["a", "b", "c", "d"] });
    expect(many.question.choices).toBeUndefined();
    expect(many.question.question).toContain("one of a, b, c, d");
    expect(many.read({ kind: "answered", replyText: "c" })).toEqual({ action: "accept", content: { f: "c" } });
    expect(many.read({ kind: "answered", replyText: "z" })).toEqual({ action: "decline" });
    const count = one({ type: "integer" });
    expect(count.read({ kind: "answered", replyText: "3" })).toEqual({ action: "accept", content: { f: 3 } });
    expect(count.read({ kind: "answered", replyText: "3.5" })).toEqual({ action: "decline" });
  });

  it("several fields are answered one line each", () => {
    const plan = planElicitation(
      "docs",
      {
        mode: "form",
        message: "Details?",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string", title: "Name" }, age: { type: "number" } },
          required: ["name"],
        },
      },
      "modern",
    );
    if (plan.kind !== "ask") throw new Error("declined");
    expect(plan.question.question).toContain("- Name (name)\n- age (optional)");
    expect(plan.read({ kind: "answered", replyText: "name: Ada\nage: 36" })).toEqual({
      action: "accept",
      content: { name: "Ada", age: 36 },
    });
    expect(plan.read({ kind: "answered", replyText: "age: 36" })).toEqual({ action: "decline" });
  });

  it("a URL shows its host and is never opened; only https", () => {
    const plan = planElicitation(
      "docs",
      { mode: "url", message: "Sign in.", url: "https://login.example.com/start", elicitationId: "e1" },
      "legacy",
    );
    if (plan.kind !== "ask") throw new Error("declined");
    expect(plan.question.question).toBe(
      "docs asks you to open a page on login.example.com: Sign in.\nhttps://login.example.com/start\nIt is not opened for you. Choose Done once you have finished there.",
    );
    expect(plan.read(answered("Done"))).toEqual({ action: "accept" });
    expect(planElicitation("docs", { mode: "url", message: "x", url: "http://login.example.com/", elicitationId: "e2" }, "legacy")).toEqual(
      { kind: "decline", reason: "only an https address is shown" },
    );
  });

  it("labels from the server are cleaned; a field is matched by its name or title, whatever the case", () => {
    const plan = planElicitation(
      "docs",
      {
        mode: "form",
        message: "Who?",
        requestedSchema: {
          type: "object",
          properties: { author: { type: "string", title: "Author\u202e evil" }, session_name: { type: "string" } },
        },
      },
      "modern",
    );
    if (plan.kind !== "ask") throw new Error(`declined: ${plan.reason}`);
    expect(plan.question.question).not.toContain("\u202e");
    expect(plan.read({ kind: "answered", replyText: "AUTHOR: Ada\nSession_Name: standup" })).toEqual({
      action: "accept",
      content: { author: "Ada", session_name: "standup" },
    });
  });

  it("refuses a password or secret field, and the same question keeps its key", () => {
    expect(
      planElicitation(
        "docs",
        {
          mode: "form",
          message: "Log in",
          requestedSchema: { type: "object", properties: { value: { type: "string", title: "Your bank password" } } },
        },
        "modern",
      ),
    ).toMatchObject({ kind: "decline" });
    expect(
      planElicitation(
        "docs",
        {
          mode: "form",
          message: "Key",
          requestedSchema: { type: "object", properties: { k: { type: "string", description: "Your API key" } } },
        },
        "modern",
      ),
    ).toMatchObject({ kind: "decline" });
    expect(
      planElicitation(
        "docs",
        { mode: "form", message: "Password?", requestedSchema: { type: "object", properties: { password: { type: "string" } } } },
        "modern",
      ),
    ).toMatchObject({ kind: "decline", reason: expect.stringContaining("password or secret") });
    expect(
      planElicitation(
        "docs",
        {
          mode: "form",
          message: "Key?",
          requestedSchema: { type: "object", properties: { k: { type: "string", format: "password" } as never } },
        },
        "modern",
      ),
    ).toMatchObject({ kind: "decline" });
    const a = planElicitation("docs", { mode: "form", message: "Delete?", requestedSchema: { type: "object", properties: {} } }, "modern");
    const b = planElicitation(
      "docs",
      { mode: "form", message: "Delete?", requestedSchema: { type: "object", properties: {} }, _meta: { x: 1 } } as never,
      "modern",
    );
    expect(a.kind === "ask" && b.kind === "ask" && a.question.key === b.question.key).toBe(true);
  });
});
