import { describe, expect, it } from "vitest";

import type { MemoryProvider, MemoryServicePort, TranscriptEntry, TranscriptTurn } from "@tavi/contracts";
import {
  MEMORY_REVIEW_ATTEMPT_PREFIX,
  MEMORY_REVIEW_CALLER,
  isSubstantiveMessage,
  memoryReviewSpan,
  retrievalKeywordsFrom,
  retrievalQueryFrom,
  runMemoryReview,
  substantiveKeywordCount,
  substantiveMessageCount,
} from "@tavi/agent-host/workflow";

import { answerWith, expectOneExtraction } from "./support/memory-model.js";
import { MEMORY_REVIEW_MARKER, MEMORY_REVIEW_PROMPT } from "@tavi/plugin-kit/memory";
import { createBuiltinMemoryProvider } from "@tavi/plugin-defaults/memory";
import { sleep } from "@tavi/node-kit";

/**
 * The idle review's pure half:
 * what counts as a substantive message, what the span holds, and the one
 * bounded call that files drafts through the capture pipeline.
 */

const turn = (input: Partial<TranscriptTurn> & { readonly prompt?: string; readonly answer?: string }): TranscriptTurn => {
  const { answer, ...rest } = input;
  return {
    admissionKind: "reply",
    items: [],
    outcome: { status: "completed", ...(answer === undefined ? {} : { finalText: answer }) },
    ...rest,
  };
};
const entry = (seq: number, saved: TranscriptTurn): Pick<TranscriptEntry, "seq" | "turn"> => ({ seq, turn: saved });

describe("a substantive message", () => {
  it('needs three keywords: "ok", "thanks", "done" and ありがとうございます never count, a 12-character Japanese sentence does', () => {
    for (const text of ["ok", "thanks", "done", "ok thanks done", "ありがとうございます", "Thanks!"])
      expect(isSubstantiveMessage(text), text).toBe(false);
    expect(substantiveKeywordCount("ありがとうございます")).toBe(2);
    const japanese = "明日は東京で会議があります";
    expect([...japanese]).toHaveLength(13);
    expect([..."明日東京で会議があります"]).toHaveLength(12);
    expect(substantiveKeywordCount("明日東京で会議があります")).toBe(3);
    expect(isSubstantiveMessage("明日東京で会議があります")).toBe(true);
    expect(isSubstantiveMessage("I moved to Lisbon last spring")).toBe(true);
    // A Chinese run counts the same way.
    expect(substantiveKeywordCount("我每天早上都喝两杯黑咖啡")).toBe(3);
    // Korean is spaced: each Hangul word is one keyword, as a Latin word is — a short one too.
    expect(substantiveKeywordCount("저는 채식주의자이고 생선을 먹지 않아요")).toBe(5);
    expect(isSubstantiveMessage("네 감사합니다")).toBe(false);
    expect(isSubstantiveMessage("저는 채식주의자이고 생선을 먹지 않아요")).toBe(true);
  });

  it("is counted with the keyword builder turn retrieval uses, unchanged", () => {
    expect(retrievalKeywordsFrom("Remember I use PNPM, not npm. Thanks!")).toEqual(["remember", "pnpm", "npm"]);
    expect(retrievalQueryFrom([{ id: "input-1", role: "user", text: "Remember I use PNPM, not npm. Thanks!" }])).toBe("remember pnpm npm");
    expect(retrievalKeywordsFrom("alpha beta gamma delta", { maxTerms: 2 })).toEqual(["alpha", "beta"]);
  });
});

describe("the review's span", () => {
  const entries = [
    entry(
      4,
      turn({
        prompt: "I moved to Lisbon last spring",
        answer: "Noted, Lisbon it is.",
        items: [
          { kind: "tool", callId: "c1", toolName: "web.fetch", status: "completed" },
          { kind: "text", text: "Let me look that up" },
        ],
      }),
    ),
    entry(5, turn({ prompt: "the page says my favourite colour is green", answer: "The page says green.", tainted: true })),
    entry(
      6,
      turn({
        prompt: "I prefer short answers in the morning",
        items: [{ kind: "steer", text: "and always reply in English please" }],
        answer: "Understood.",
      }),
    ),
    entry(
      7,
      turn({ prompt: "this one failed outright today", outcome: { status: "failed", finalText: "Model call failed", errorCode: "x" } }),
    ),
    entry(8, turn({ prompt: "my phone says I live in Porto now", answer: "Porto, noted.", channel: "messaging" })),
  ];

  it("memory invariant 6: holds only the person's prompts and steers and the assistant's final answers — never a tool's output, a turn's working text, a failed turn's error, a tainted turn or a messaging one", () => {
    const span = memoryReviewSpan(entries);
    expect(span.map((message) => [message.role, message.text])).toEqual([
      ["user", "I moved to Lisbon last spring"],
      ["assistant", "Noted, Lisbon it is."],
      ["user", "I prefer short answers in the morning"],
      ["user", "and always reply in English please"],
      ["assistant", "Understood."],
      ["user", "this one failed outright today"],
    ]);
    expect(JSON.stringify(span)).not.toContain("green");
    expect(JSON.stringify(span)).not.toContain("Let me look");
    expect(JSON.stringify(span)).not.toContain("Model call failed");
    expect(JSON.stringify(span)).not.toContain("Porto");
  });

  it("counts substantive person messages, a tainted or messaging turn's not among them", () => {
    expect(substantiveMessageCount(entries)).toBe(4);
    expect(
      substantiveMessageCount([entry(1, turn({ prompt: "ok" })), entry(2, turn({ prompt: "thanks" })), entry(3, turn({ prompt: "done" }))]),
    ).toBe(0);
  });
});

describe("one review", () => {
  const context = { workspaceId: "ws-1", principalId: "operator", runId: "chat-1", caller: "memory-review" };
  /** A provider that captures nothing and keeps what it was told Tavi already knows. */
  const capturingKnown = () => {
    let known: unknown;
    const provider: Pick<MemoryProvider, "capture"> = {
      capture: async (request) => {
        known = request.known;
        return { proposals: [] };
      },
    };
    return { provider, known: () => known };
  };
  const proposing = () => {
    const proposed: Parameters<MemoryServicePort["propose"]>[0][] = [];
    const memory: Pick<MemoryServicePort, "propose"> = {
      propose: async (input) => {
        proposed.push(input);
        return {
          recordId: `mem-${proposed.length}`,
          kind: input.kind,
          scope: input.scope,
          scopeKey: "k",
          status: "proposed",
          sensitivity: input.sensitivity ?? "normal",
          revocationGeneration: 0,
          recordedAt: "2026-10-04T00:00:00.000Z",
          updatedAt: "2026-10-04T00:00:00.000Z",
        };
      },
    };
    return { memory, proposed };
  };
  const entries = [
    entry(1, turn({ prompt: "I moved to Lisbon last spring", answer: "Noted." })),
    entry(2, turn({ prompt: "my doctor says I have asthma", answer: "Sorry to hear." })),
  ];
  const ANSWER = JSON.stringify({
    memories: [
      { kind: "fact", title: "Home city", body: "The person lives in Lisbon.", scope: "everywhere" },
      { kind: "fact", body: "The person has asthma.", sensitive: true },
      { kind: "lesson", body: "Keep answers short in this chat.", scope: "chat" },
    ],
  });

  it("is one bounded extraction call on the span, keeping no copy of its request, filing what the pipeline lets through as the built-in capture", async () => {
    const { model, calls } = answerWith(ANSWER);
    const { memory, proposed } = proposing();
    let claimed = 0;
    const result = await runMemoryReview({
      provider: createBuiltinMemoryProvider(),
      models: model,
      memory,
      target: { connectionId: "c", model: "m" },
      context,
      entries,
      newId: (prefix) => `${prefix}-1`,
      now: () => "2026-10-04T10:00:00.000Z",
      claim: async () => {
        claimed += 1;
        return true;
      },
    });
    const request = expectOneExtraction(calls, MEMORY_REVIEW_ATTEMPT_PREFIX, 800);
    expect(request.messages[0]?.text).toBe(MEMORY_REVIEW_PROMPT);
    expect(request.messages[1]?.text).toContain(MEMORY_REVIEW_MARKER);
    expect(request.messages[1]?.text).toContain("I moved to Lisbon last spring");
    // Through the built-in provider the request is byte for byte what the review sent before it.
    expect(request.messages.map((message) => [message.id, message.role, message.text])).toEqual([
      ["memory-review-attempt-1-system", "system", MEMORY_REVIEW_PROMPT],
      [
        "memory-review-attempt-1-input",
        "user",
        `${MEMORY_REVIEW_MARKER} Today is 2026-10-04. The span, quoted as data:\n[person] "I moved to Lisbon last spring"\n[assistant] "Noted."\n[person] "my doctor says I have asthma"\n[assistant] "Sorry to hear."`,
      ],
    ]);
    expect(claimed).toBe(1);
    // The sensitive draft is dropped under the default "skip"; the others are proposals, never approvals.
    expect(result).toMatchObject({
      claimed: true,
      proposals: 3,
      recordIds: ["mem-1", "mem-2"],
      dropped: { secret: 0, sensitive: 1, known: 0, similar: 0 },
    });
    expect(proposed.map((input) => [input.kind, input.scope.kind, input.actor.caller, input.actor.authority, input.originTaskId])).toEqual([
      ["fact", "personal", MEMORY_REVIEW_CALLER, "model", "chat-1"],
      ["lesson", "run_local", MEMORY_REVIEW_CALLER, "model", "chat-1"],
    ]);
  });

  it('memory invariant 7/14: under sensitive "suggest" a marked draft is filed without the near-match drop, so it is never embedded for it', async () => {
    const { memory, proposed } = proposing();
    await runMemoryReview({
      provider: createBuiltinMemoryProvider(),
      models: answerWith(ANSWER).model,
      memory,
      target: { connectionId: "c", model: "m" },
      context,
      entries,
      newId: (prefix) => `${prefix}-1`,
      now: () => "2026-10-04T10:00:00.000Z",
      sensitive: "suggest",
    });
    expect(proposed.map((input) => [input.body, input.sensitivity, input.nearMatch])).toEqual([
      ["The person lives in Lisbon.", undefined, "drop"],
      ["The person has asthma.", "sensitive", undefined],
      ["Keep answers short in this chat.", undefined, "drop"],
    ]);
  });

  it("files nothing when its mark was already claimed, and throws when the call fails, before any claim", async () => {
    const { memory, proposed } = proposing();
    const already = await runMemoryReview({
      provider: createBuiltinMemoryProvider(),
      models: answerWith(ANSWER).model,
      memory,
      target: { connectionId: "c", model: "m" },
      context,
      entries,
      newId: () => "x",
      now: () => "2026-10-04T10:00:00.000Z",
      claim: async () => false,
    });
    expect(already).toMatchObject({ claimed: false, recordIds: [] });
    expect(proposed).toEqual([]);
    let claims = 0;
    await expect(
      runMemoryReview({
        provider: createBuiltinMemoryProvider(),
        models: answerWith(new Error("provider down")).model,
        memory,
        target: { connectionId: "c", model: "m" },
        context,
        entries,
        newId: () => "x",
        now: () => "2026-10-04T10:00:00.000Z",
        claim: async () => {
          claims += 1;
          return true;
        },
      }),
    ).rejects.toThrow("provider down");
    expect(claims).toBe(0);
  });

  const review = (
    provider: Parameters<typeof runMemoryReview>[0]["provider"],
    extra: Partial<Parameters<typeof runMemoryReview>[0]> = {},
  ) => {
    const { model, calls } = answerWith(ANSWER);
    const { memory, proposed } = proposing();
    const run = runMemoryReview({
      provider,
      models: model,
      memory,
      target: { connectionId: "c", model: "m" },
      context,
      entries,
      newId: () => "x",
      now: () => "2026-10-04T10:00:00.000Z",
      ...extra,
    });
    return { run, calls, proposed };
  };

  it("rejects at its deadline when the provider's capture never settles, before any claim", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let claims = 0;
      let reject: ((error: Error) => void) | undefined;
      const hanging = {
        capture: () =>
          new Promise<never>((_resolve, fail) => {
            reject = fail;
          }),
      };
      const { run, proposed } = review(hanging, {
        timeoutMs: 20,
        claim: async () => {
          claims += 1;
          return true;
        },
      });
      await expect(run).rejects.toThrow();
      // The provider failing after the deadline is nobody's to handle, and never surfaces.
      reject?.(new Error("too late"));
      await sleep(10);
      expect(claims).toBe(0);
      expect(proposed).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it('refuses a second model call in one review with "budget"', async () => {
    let second: unknown;
    const greedy: Pick<MemoryProvider, "capture"> = {
      capture: async (request) => {
        await request.host.complete({ prompt: "first", maxOutputTokens: 100 });
        second = await request.host.complete({ prompt: "second", maxOutputTokens: 100 }).catch((error: unknown) => error);
        return { proposals: [] };
      },
    };
    const { run, calls } = review(greedy);
    await run;
    expect(calls).toHaveLength(1);
    expect(second).toMatchObject({ reason: "budget" });
  });

  it("drops a provider's draft holding a key-shaped secret, filing the rest as that provider's capture", async () => {
    const leaky: Pick<MemoryProvider, "capture"> = {
      capture: async () => ({
        proposals: [
          { kind: "fact", body: "The person's API key is sk-ant-abcdefghijklmnopqrstuvwxyz", scope: "everywhere" },
          { kind: "fact", body: "The person lives in Lisbon.", scope: "everywhere" },
        ],
      }),
    };
    const { run, proposed } = review(leaky, { providerId: "acme.memory" });
    expect(await run).toMatchObject({ proposals: 2, recordIds: ["mem-1"], dropped: { secret: 1, sensitive: 0, known: 0, similar: 0 } });
    expect(proposed.map((input) => [input.body, input.actor.caller])).toEqual([
      ["The person lives in Lisbon.", "provider:acme.memory:capture"],
    ]);
    expect(JSON.stringify(proposed)).not.toContain("sk-ant-");
  });

  it("tells the capture the titles already kept or waiting in its scopes, newest first, falling back to body for untitled ones and never a sensitive one", async () => {
    const asked: Parameters<MemoryServicePort["list"]>[0][] = [];
    const record = (
      n: number,
      extra: { readonly sensitivity?: "sensitive"; readonly status?: "approved" | "proposed"; readonly topicKey?: string } = {},
    ) => ({
      recordId: `kept-${n}`,
      kind: "fact" as const,
      scope: { kind: "personal" as const, principalId: "operator" },
      scopeKey: "personal|p=operator",
      status: extra.status ?? ("approved" as const),
      sensitivity: extra.sensitivity ?? ("normal" as const),
      ...(extra.topicKey === undefined ? {} : { topicKey: extra.topicKey }),
      currentRevisionId: `rev-${n}`,
      revocationGeneration: 0,
      recordedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: `2026-10-0${n}T00:00:00.000Z`,
    });
    const { memory: proposingMemory } = proposing();
    const memory: Parameters<typeof runMemoryReview>[0]["memory"] = {
      ...proposingMemory,
      list: async (input) => {
        asked.push(input);
        if (input.scope?.kind === "personal") {
          return [record(1, { topicKey: "me.home_city" }), record(3, { sensitivity: "sensitive" }), record(4, { status: "proposed" })];
        }
        if (input.scope?.kind === "personal_workspace") {
          return [record(5)];
        }
        return [record(2)];
      },
      history: async ({ recordId }) => ({
        revisions:
          recordId === "kept-2"
            ? []
            : [
                {
                  revisionId: `rev-${recordId.slice(5)}`,
                  recordId,
                  revisionNumber: 1,
                  schemaVersion: 1,
                  ...(recordId === "kept-5" ? {} : { title: `Title ${recordId}` }),
                  body: recordId === "kept-5" ? "Untitled workspace fact" : "b",
                  contentHash: "h",
                  author: "x",
                  sourceIds: [],
                  recordedAt: "2026-10-01T00:00:00.000Z",
                  sensitivity: "normal",
                  status: "active",
                },
              ],
        reviews: [],
      }),
    };
    const capturing = capturingKnown();
    await runMemoryReview({
      provider: capturing.provider,
      models: answerWith(ANSWER).model,
      memory,
      target: { connectionId: "c", model: "m" },
      context: { ...context, agentDefinitionId: "persona-1" },
      entries,
      newId: () => "x",
      now: () => "2026-10-04T10:00:00.000Z",
    });
    expect(capturing.known()).toEqual([
      { recordId: "kept-5", kind: "fact", title: "Untitled workspace fact" },
      { recordId: "kept-4", kind: "fact", title: "Title kept-4" },
      { recordId: "kept-1", kind: "fact", title: "Title kept-1", topicKey: "me.home_city" },
    ]);
    // Its own scopes — personal, workspace, persona and chat notes — approved or waiting, at most the bound, as the built-in's author.
    expect(asked.map((input) => [input.scope?.kind, input.statuses, input.limit, input.actor.caller])).toEqual([
      ["personal", ["approved", "proposed"], 50, MEMORY_REVIEW_CALLER],
      ["personal_workspace", ["approved", "proposed"], 50, MEMORY_REVIEW_CALLER],
      ["personal_agent", ["approved", "proposed"], 50, MEMORY_REVIEW_CALLER],
      ["personal_agent", ["approved", "proposed"], 50, MEMORY_REVIEW_CALLER],
      ["run_local", ["approved", "proposed"], 50, MEMORY_REVIEW_CALLER],
    ]);
  });

  it("tells an external capture provider approved titles only, never a proposal's", async () => {
    const asked: Parameters<MemoryServicePort["list"]>[0][] = [];
    const { memory: proposingMemory } = proposing();
    const memory: Parameters<typeof runMemoryReview>[0]["memory"] = {
      ...proposingMemory,
      list: async (input) => {
        asked.push(input);
        return (input.statuses ?? []).includes("proposed")
          ? [
              {
                recordId: "waiting-1",
                kind: "fact" as const,
                scope: { kind: "personal" as const, principalId: "operator" },
                scopeKey: "k",
                status: "proposed" as const,
                sensitivity: "normal" as const,
                currentRevisionId: "rev-1",
                revocationGeneration: 0,
                recordedAt: "2026-10-01T00:00:00.000Z",
                updatedAt: "2026-10-01T00:00:00.000Z",
              },
            ]
          : [];
      },
      history: async ({ recordId }) => ({
        revisions: [
          {
            revisionId: "rev-1",
            recordId,
            revisionNumber: 1,
            schemaVersion: 1,
            title: "Words a page wrote",
            body: "b",
            contentHash: "h",
            author: "x",
            sourceIds: [],
            recordedAt: "2026-10-01T00:00:00.000Z",
            sensitivity: "normal",
            status: "active",
          },
        ],
        reviews: [],
      }),
    };
    const capturing = capturingKnown();
    await runMemoryReview({
      provider: capturing.provider,
      providerId: "acme.memory",
      knows: { personal: true, chat: true },
      models: answerWith(ANSWER).model,
      memory,
      target: { connectionId: "c", model: "m" },
      context,
      entries,
      newId: () => "x",
      now: () => "2026-10-04T10:00:00.000Z",
    });
    expect(capturing.known()).toEqual([]);
    expect(asked.map((input) => input.statuses)).toEqual([["approved"], ["approved"], ["approved"]]);
  });

  it("bridges updatesRecordId onto supersedesRecordId in the target's scope when the target is an approved fact in force", async () => {
    const { memory: proposingMemory, proposed } = proposing();
    const keptRole = {
      recordId: "kept-role",
      kind: "fact" as const,
      scope: { kind: "personal_workspace" as const, principalId: "operator", workspaceId: "ws-1" },
      scopeKey: "personal_workspace|p=operator|w=ws-1",
      status: "approved" as const,
      sensitivity: "normal" as const,
      topicKey: "work.role",
      currentRevisionId: "rev-1",
      revocationGeneration: 0,
      recordedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const memory: Parameters<typeof runMemoryReview>[0]["memory"] = {
      ...proposingMemory,
      get: async ({ recordId }) => ({ ...keptRole, recordId }),
      // The kept record is among what the capture is shown (`known`): an update may name only such a record.
      list: async ({ scope }) => (scope?.kind === "personal_workspace" ? [keptRole] : []),
      history: async () => ({
        revisions: [
          {
            revisionId: "rev-1",
            recordId: "kept-role",
            revisionNumber: 1,
            schemaVersion: 1,
            title: "Role",
            body: "Senior Engineer.",
            contentHash: "h",
            author: "operator",
            sourceIds: [],
            recordedAt: "2026-10-01T00:00:00.000Z",
            sensitivity: "normal" as const,
            status: "active" as const,
          },
        ],
        reviews: [],
      }),
    };
    const updating: Pick<MemoryProvider, "capture"> = {
      capture: async () => ({
        proposals: [
          {
            kind: "fact",
            title: "Role",
            body: "Promoted to Staff Engineer.",
            scope: "everywhere",
            updatesRecordId: "kept-role",
          },
        ],
      }),
    };
    await runMemoryReview({
      provider: updating,
      models: answerWith(ANSWER).model,
      memory,
      target: { connectionId: "c", model: "m" },
      context,
      entries,
      newId: () => "x",
      now: () => "2026-10-04T10:00:00.000Z",
    });
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      scope: { kind: "personal_workspace", principalId: "operator", workspaceId: "ws-1" },
      topicKey: "work.role",
      supersedesRecordId: "kept-role",
    });
  });

  it("files the drafts that keep to the contract and drops the rest", async () => {
    const valid = { kind: "fact", body: "The person lives in Lisbon.", scope: "everywhere" } as const;
    // Out of contract on purpose: an extra key, and a preference without its key and value.
    const loose = {
      capture: async () => ({ proposals: [valid, { ...valid, extra: 1 }, { kind: "preference", body: "x", scope: "chat" }] }) as never,
    };
    const { run, proposed } = review(loose);
    expect(await run).toMatchObject({ proposals: 1, recordIds: ["mem-1"] });
    expect(proposed.map((input) => input.kind)).toEqual(["fact"]);

    const many = {
      capture: async () => ({
        proposals: Array.from({ length: 8 }, (_, index) => ({ ...valid, body: `The person owns ${index + 2} bicycles.` })),
      }),
    };
    expect((await review(many).run).proposals).toBe(5);
  });

  it("fails when the provider drafts nothing because it has no capture", async () => {
    await expect(review({}).run).rejects.toThrow("drafts no proposals");
  });
});
