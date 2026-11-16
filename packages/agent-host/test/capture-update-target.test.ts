import { describe, expect, it } from "vitest";

import type { MemoryActor, MemoryRecord, MemoryServicePort } from "@tavi/contracts";

import { fileCaptureProposals } from "../src/memory/epoch-flush.js";

/** A draft's `updatesRecordId` is honoured only for a record the capture was shown, and never a sensitive one. */

const NOW = "2026-03-01T10:00:00.000Z";
const actor: MemoryActor & { readonly runId: string } = {
  principalId: "alice",
  workspaceId: "w1",
  runId: "run-1",
  caller: "epoch-flush:e1",
  authority: "model",
};

function kept(recordId: string, extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    recordId,
    kind: "fact",
    scope: { kind: "personal", principalId: "alice" },
    scopeKey: "personal:alice",
    status: "approved",
    sensitivity: "normal",
    revocationGeneration: 0,
    recordedAt: NOW,
    updatedAt: NOW,
    currentRevisionId: `${recordId}-rev`,
    ...extra,
  } as MemoryRecord;
}

async function supersedesOf(updatesRecordId: string, knownRecordIds: readonly string[]): Promise<string | undefined> {
  const records = new Map([
    ["mem-known", kept("mem-known")],
    ["mem-unshown", kept("mem-unshown")],
    ["mem-secret", kept("mem-secret", { sensitivity: "sensitive" })],
  ]);
  const proposed: Parameters<MemoryServicePort["propose"]>[0][] = [];
  const memory: Pick<MemoryServicePort, "propose" | "get"> = {
    get: async ({ recordId }) => {
      const record = records.get(recordId);
      if (record === undefined) throw new Error("not found");
      return record;
    },
    propose: async (input) => {
      proposed.push(input);
      return kept("mem-new", { status: "proposed" });
    },
  };
  await fileCaptureProposals({
    memory,
    proposals: [{ kind: "fact", body: "Lives in Porto now", scope: "everywhere", updatesRecordId }],
    knownRecordIds,
    actor,
    chatTaskId: "run-1",
    now: () => NOW,
  });
  expect(proposed).toHaveLength(1);
  return proposed[0]?.supersedesRecordId;
}

describe("a captured update's target", () => {
  it("is a record among the known the capture was given", async () => {
    expect(await supersedesOf("mem-known", ["mem-known", "mem-secret"])).toBe("mem-known");
  });

  it("is ignored for a readable record the capture was not shown, filing the draft as an ordinary one", async () => {
    expect(await supersedesOf("mem-unshown", ["mem-known"])).toBeUndefined();
  });

  it("is ignored for a sensitive record, even one named as known", async () => {
    expect(await supersedesOf("mem-secret", ["mem-known", "mem-secret"])).toBeUndefined();
  });
});
