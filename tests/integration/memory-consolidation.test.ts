import { describe, expect, it } from "vitest";

import type { InvocationContext, MemoryProvider, MemoryScope, MemoryServicePort } from "@tavi/contracts";
import { MEMORY_CONSOLIDATE_MARKER, MEMORY_CONSOLIDATE_PROMPT } from "@tavi/plugin-kit/memory";
import { createBuiltinMemoryProvider } from "@tavi/plugin-defaults/memory";
import {
  MEMORY_CONSOLIDATION_ATTEMPT_PREFIX,
  isConsolidationAuthor,
  runMemoryConsolidation,
  type ConsolidationRecord,
} from "@tavi/agent-host/workflow";

import { answerWith, expectOneExtraction } from "./support/memory-model.js";

/**
 * Consolidation's pure half:
 * one bounded call over a person's kept records, and each tidy-up draft
 * validated and filed as a proposal naming what it supersedes — never an
 * approval, never an edit.
 */

const NOW = "2026-10-12T03:05:00.000Z";
const workspace: MemoryScope = { kind: "personal_workspace", principalId: "alice", workspaceId: "w1" };
const personal: MemoryScope = { kind: "personal", principalId: "alice" };
const context: InvocationContext = { workspaceId: "w1", principalId: "alice", runId: "home-1", caller: "memory-consolidation" };

const record = (
  n: number,
  scope: MemoryScope,
  kind: "fact" | "lesson",
  body: string,
  extra: { readonly topicKey?: string; readonly title?: string } = {},
): ConsolidationRecord => ({
  scope,
  ...(extra.topicKey === undefined ? {} : { topicKey: extra.topicKey }),
  snapshot: {
    recordId: `mem-${n}`,
    revisionId: `rev-${n}`,
    scopeKey: scope.kind === "personal" ? "personal|p=alice" : "personal_workspace|p=alice|w=w1",
    kind,
    body,
    recordedAt: "2026-09-01T00:00:00.000Z",
    ...(extra.title === undefined ? {} : { title: extra.title }),
  },
});
const RECORDS: readonly ConsolidationRecord[] = [
  record(1, workspace, "fact", "Alice keeps a vegetable garden", { topicKey: "garden", title: "Garden" }),
  record(2, workspace, "fact", "Alice grows tomatoes in her garden", { topicKey: "garden" }),
  record(3, workspace, "lesson", "Alice is in Lisbon until the 20th"),
  record(4, personal, "fact", "Alice runs on Mondays at 7"),
];

const proposing = (refuse?: (input: Parameters<MemoryServicePort["propose"]>[0]) => boolean) => {
  const proposed: Parameters<MemoryServicePort["propose"]>[0][] = [];
  const memory: Pick<MemoryServicePort, "propose"> = {
    propose: async (input) => {
      if (refuse?.(input) === true) throw Object.assign(new Error("changed"), { code: "REVISION_CONFLICT" });
      proposed.push(input);
      return {
        recordId: `tidy-${proposed.length}`,
        kind: input.kind,
        scope: input.scope,
        scopeKey: "k",
        status: "proposed",
        sensitivity: input.sensitivity ?? "normal",
        revocationGeneration: 0,
        recordedAt: NOW,
        updatedAt: NOW,
      };
    },
  };
  return { memory, proposed };
};

const TIDY = JSON.stringify({
  tidy: [
    {
      action: "merge",
      ids: ["m1", "m2"],
      title: "Garden",
      body: "Alice keeps a vegetable garden and grows tomatoes in it",
      reason: "the same garden",
    },
    { action: "expire", id: "m3", until: "2026-10-20", reason: "time-bound" },
    { action: "supersede", id: "m1", body: "Named again in one run is no draft", reason: "x" },
    { action: "supersede", id: "m4", body: "Alice's API key is sk-ant-abcdefghijklmnopqrstuvwxyz0123", reason: "a secret is never filed" },
  ],
});

describe("a consolidation run", () => {
  it("memory invariant 8: is one bounded extraction call keeping no copy of its request, its drafts filed only as proposals that supersede their inputs at their revisions", async () => {
    const { model, calls } = answerWith(TIDY);
    const { memory, proposed } = proposing();
    let claimed = 0;
    const result = await runMemoryConsolidation({
      models: model,
      memory,
      provider: createBuiltinMemoryProvider(),
      target: { connectionId: "c", model: "m" },
      context,
      records: RECORDS,
      newId: (prefix) => `${prefix}-1`,
      now: () => NOW,
      timeZone: "UTC",
      claim: async () => {
        claimed += 1;
        return true;
      },
    });
    const request = expectOneExtraction(calls, MEMORY_CONSOLIDATION_ATTEMPT_PREFIX, 2_000);
    expect(request.messages[0]?.text).toBe(MEMORY_CONSOLIDATE_PROMPT);
    expect(request.messages[1]?.text.startsWith(`${MEMORY_CONSOLIDATE_MARKER} Today is 2026-10-12.`)).toBe(true);
    expect(claimed).toBe(1);
    // The built-in's parser already left out the record named twice; the secret is dropped by the host.
    expect(result).toMatchObject({
      claimed: true,
      drafts: 3,
      recordIds: ["tidy-1", "tidy-2"],
      dropped: { secret: 1, sensitive: 0, known: 0, similar: 0, invalid: 0 },
    });
    expect(
      proposed.map((input) => ({
        scope: input.scope,
        kind: input.kind,
        title: input.title,
        body: input.body,
        topicKey: input.topicKey,
        validTo: input.validTo,
        expiryAt: input.expiryAt,
        supersedes: input.supersedes,
        caller: input.actor.caller,
        authority: input.actor.authority,
        nearMatch: input.nearMatch,
      })),
    ).toEqual([
      // A merge: a new record of the inputs' scope and kind, keeping the topic they share.
      {
        scope: workspace,
        kind: "fact",
        title: "Garden",
        body: "Alice keeps a vegetable garden and grows tomatoes in it",
        topicKey: "garden",
        validTo: undefined,
        expiryAt: undefined,
        supersedes: [
          { recordId: "mem-1", revisionId: "rev-1" },
          { recordId: "mem-2", revisionId: "rev-2" },
        ],
        caller: "provider:tavi.memoryprovider:consolidate",
        authority: "model",
        nearMatch: undefined,
      },
      // An expire: the lesson's own words with an end date, mapped by kind (a lesson expires) through that day.
      {
        scope: workspace,
        kind: "lesson",
        title: undefined,
        body: "Alice is in Lisbon until the 20th",
        topicKey: undefined,
        validTo: undefined,
        expiryAt: "2026-10-21T00:00:00.000Z",
        supersedes: [{ recordId: "mem-3", revisionId: "rev-3" }],
        caller: "provider:tavi.memoryprovider:consolidate",
        authority: "model",
        nearMatch: undefined,
      },
    ]);
    expect(proposed.every((input) => isConsolidationAuthor(input.actor.caller))).toBe(true);
  });

  it("drops a draft naming a record it was not given, mixing scopes, changing kind or dating the past, and authors an external provider's by its id", async () => {
    const external: Pick<MemoryProvider, "consolidate"> = {
      consolidate: async () => ({
        drafts: [
          {
            action: "merge",
            recordIds: ["mem-1", "mem-404"],
            replacement: { kind: "fact", body: "Invented input", scope: "everywhere" },
            reason: "x",
          },
          {
            action: "merge",
            recordIds: ["mem-1", "mem-4"],
            replacement: { kind: "fact", body: "Across scopes", scope: "everywhere" },
            reason: "x",
          },
          {
            action: "supersede",
            recordId: "mem-3",
            replacement: { kind: "fact", body: "A lesson made a fact", scope: "everywhere" },
            reason: "x",
          },
          { action: "expire", recordId: "mem-2", validUntil: "2026-01-01", reason: "already past" },
          {
            action: "supersede",
            recordId: "mem-4",
            replacement: { kind: "fact", body: "Alice runs on Mondays and Thursdays", scope: "everywhere" },
            reason: "newer",
          },
        ],
      }),
    };
    const { memory, proposed } = proposing();
    const result = await runMemoryConsolidation({
      models: answerWith("{}").model,
      memory,
      provider: external,
      providerId: "acme.memory",
      target: { connectionId: "c", model: "m" },
      context,
      records: RECORDS,
      newId: () => "x",
      now: () => NOW,
    });
    expect(result).toMatchObject({ drafts: 5, recordIds: ["tidy-1"], dropped: { invalid: 4 } });
    expect(proposed.map((input) => [input.scope.kind, input.body, input.supersedes, input.actor.caller])).toEqual([
      ["personal", "Alice runs on Mondays and Thursdays", [{ recordId: "mem-4", revisionId: "rev-4" }], "provider:acme.memory:consolidate"],
    ]);
  });

  it("files nothing once its mark was claimed, throws before any claim when the call fails, and counts a refused proposal", async () => {
    const { memory, proposed } = proposing();
    const already = await runMemoryConsolidation({
      models: answerWith(TIDY).model,
      memory,
      provider: createBuiltinMemoryProvider(),
      target: { connectionId: "c", model: "m" },
      context,
      records: RECORDS,
      newId: () => "x",
      now: () => NOW,
      claim: async () => false,
    });
    expect(already).toMatchObject({ claimed: false, recordIds: [] });
    expect(proposed).toEqual([]);
    let claims = 0;
    await expect(
      runMemoryConsolidation({
        models: answerWith(new Error("provider down")).model,
        memory,
        provider: createBuiltinMemoryProvider(),
        target: { connectionId: "c", model: "m" },
        context,
        records: RECORDS,
        newId: () => "x",
        now: () => NOW,
        claim: async () => ((claims += 1), true),
      }),
    ).rejects.toThrow("provider down");
    expect(claims).toBe(0);
    // An input changed between the read and the filing: the service refuses that one; the rest still go.
    const refusing = proposing((input) => input.supersedes?.some((entry) => entry.recordId === "mem-1") === true);
    const result = await runMemoryConsolidation({
      models: answerWith(TIDY).model,
      memory: refusing.memory,
      provider: createBuiltinMemoryProvider(),
      target: { connectionId: "c", model: "m" },
      context,
      records: RECORDS,
      newId: () => "x",
      now: () => NOW,
    });
    expect(result.recordIds).toHaveLength(1);
    expect(result.dropped.invalid).toBe(1);
  });

  it("drops a sensitive replacement under skip and files it masked under suggest", async () => {
    const sensitive: Pick<MemoryProvider, "consolidate"> = {
      consolidate: async () => ({
        drafts: [
          {
            action: "supersede",
            recordId: "mem-4",
            replacement: { kind: "fact", body: "Alice runs to manage her asthma", scope: "everywhere" },
            reason: "x",
          },
        ],
      }),
    };
    const skip = proposing();
    expect(
      (
        await runMemoryConsolidation({
          models: answerWith("{}").model,
          memory: skip.memory,
          provider: sensitive,
          target: { connectionId: "c", model: "m" },
          context,
          records: RECORDS,
          newId: () => "x",
          now: () => NOW,
        })
      ).dropped.sensitive,
    ).toBe(1);
    const suggest = proposing();
    await runMemoryConsolidation({
      models: answerWith("{}").model,
      memory: suggest.memory,
      provider: sensitive,
      target: { connectionId: "c", model: "m" },
      context,
      records: RECORDS,
      newId: () => "x",
      now: () => NOW,
      sensitive: "suggest",
    });
    expect(suggest.proposed.map((input) => input.sensitivity)).toEqual(["sensitive"]);
  });

  it("calls nothing with no records", async () => {
    const { model, calls } = answerWith(TIDY);
    const result = await runMemoryConsolidation({
      models: model,
      memory: proposing().memory,
      provider: createBuiltinMemoryProvider(),
      target: { connectionId: "c", model: "m" },
      context,
      records: [],
      newId: () => "x",
      now: () => NOW,
    });
    expect(result).toMatchObject({ drafts: 0, recordIds: [] });
    expect(calls).toEqual([]);
  });
});
