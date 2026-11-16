import type {
  ChatContextAnswer,
  MemoryCardAllAnswer,
  MemoryGetAnswer,
  MemoryItem,
  MemoryWhyAnswer,
  WorkspaceSettingsAnswer,
} from "@tavi/contracts";
import { memoryReviewSpan } from "@tavi/agent-host/workflow";
import { until } from "@tavi/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MANIFEST_MARKERS,
  OPERATOR_ACTOR,
  PERSONAL,
  READ_PAGE_PHRASE,
  REMEMBER_PHRASE,
  VEGETARIAN,
  commandIn,
  memoryTools,
  replyIn,
  startChat,
  startMemoryOwner,
  contextOf,
  type MemoryOwner,
} from "../support/memory-owner.js";

/**
 * Memory's usage flows over IPC, the companion
 * of `memory-ui.browser.test.ts` in the default suite: the same served owner
 * and the same steps, each through the IPC call the canvas makes for it.
 * U1 a proposal kept reaches the next prompt; U2 `/remember` then Undo;
 * U3 *Forget* from an answer's memory list; U4 memory off for a chat; U6 a
 * digest lists a 25-day-old proposal and *Keep all* keeps it; U5
 * *Facts* ticked under *Keep without asking*: the next fact proposal arrives
 * *Saved* with *Undo*, its review naming the settings revision. U7:
 * once a chat has read a page, every later
 * turn is saved tainted, so automatic capture and auto-approve pass it by
 * while `/remember` still saves.
 */

let owner: MemoryOwner | undefined;
const the = (): MemoryOwner => {
  if (owner === undefined) throw new Error("no owner");
  return owner;
};

beforeAll(async () => {
  owner = await startMemoryOwner("tavi-memory-flow-");
}, 60_000);

afterAll(async () => {
  await owner?.close();
});

describe("memory's usage flows over IPC", () => {
  it("U1: a turn that proposes posts a Proposed card; Keep approves it, and the next turn's prompt carries it", async () => {
    const chat = await startChat(the(), `I'm vegetarian, ${REMEMBER_PHRASE}`);
    const [card] = await until(
      async () => await the().cards(chat),
      (cards) => cards.length === 1,
    );
    const [item] = card?.items ?? [];
    expect(item).toMatchObject({ state: "proposed", title: VEGETARIAN.title, target: "personal" });
    const kept = await the().memory<MemoryItem>({
      action: "approve",
      recordId: item?.recordId,
      ...(item?.currentRevisionId === undefined ? {} : { expectedRevisionId: item.currentRevisionId }),
    });
    expect(kept.status).toBe("approved");
    expect((await the().cards(chat))[0]?.items[0]?.state).toBe("saved");
    const from = the().requests.length;
    await replyIn(the(), chat, "any vegetarian dinner ideas?");
    expect(contextOf(the().generationsSince(from)[0])).toContain(VEGETARIAN.body);
    // Cleaned up so the later flows read only their own memory.
    await the().memory({ action: "forget", recordId: kept.recordId });
  }, 60_000);

  it("U2: /remember posts a Saved card; Undo forgets it with a journal row, and the next prompt does not carry it", async () => {
    // Under `v2` (the default) the forget drops the kept block that showed it, so the same chat's next prompt
    // goes without it as under `v1`.
    await rememberThenUndo();
  }, 60_000);

  async function rememberThenUndo(): Promise<void> {
    const chat = await startChat(the(), "hello");
    const answer = await commandIn(the(), chat, "/remember I prefer metric units");
    expect(answer).toContain("I prefer metric units");
    const [card] = await until(
      async () => await the().cards(chat),
      (cards) => cards.some((each) => each.items.some((item) => item.state === "saved")),
    );
    const saved = card?.items.find((item) => item.state === "saved");
    expect(saved?.title).toBe("I prefer metric units");
    const recordId = saved?.recordId ?? "";
    // The record reaches a prompt while it is saved…
    let from = the().requests.length;
    await replyIn(the(), chat, "which metric units again?");
    expect(contextOf(the().generationsSince(from)[0])).toContain("metric units");
    // …and Undo forgets it.
    await the().memory({ action: "forget", recordId, reason: "undone from a memory card" });
    expect(await the().deletions(recordId)).toBe(1);
    expect(await the().record(recordId)).toBeUndefined();
    expect((await the().cards(chat)).flatMap((each) => each.items).find((item) => item.recordId === recordId)).toBeUndefined();
    from = the().requests.length;
    await replyIn(the(), chat, "which metric units again?");
    expect(contextOf(the().generationsSince(from)[0])).not.toContain("prefer metric units");
  }

  it("U3: an answer that used one memory lists it; Forget forgets it, and /why lists nothing for the next answer", async () => {
    const record = await the().handle.runtime.memory.remember({
      actor: OPERATOR_ACTOR,
      scope: PERSONAL,
      kind: "fact",
      body: "The wombat sleeps in Lisbon",
    });
    const chat = await startChat(the(), "where does the wombat sleep?");
    const used = await the().memory<{ readonly records: readonly MemoryItem[]; readonly used?: { readonly used: number } }>({
      action: "list",
      statuses: ["approved"],
      usedInTurn: { taskId: chat },
    });
    expect(used.records.map((each) => each.recordId)).toEqual([record.recordId]);
    expect(used.used?.used).toBe(1);
    await the().memory({ action: "forget", recordId: record.recordId, reason: "forgotten from an answer's memory list" });
    expect(await the().record(record.recordId)).toBeUndefined();
    await replyIn(the(), chat, "and the wombat?");
    const why = await the().memory<MemoryWhyAnswer>({ action: "why", taskId: chat });
    expect(why.records).toEqual([]);
    expect(why.used).toMatchObject({ recorded: true, used: 0 });
    expect(await commandIn(the(), chat, "/why")).toBe("The last answer used no memory.");
  }, 60_000);

  it("U4: memory off for a chat: the next prompt has no manifest and no memory tools; on again, both are back", async () => {
    const record = await the().handle.runtime.memory.remember({
      actor: OPERATOR_ACTOR,
      scope: PERSONAL,
      kind: "fact",
      body: "The otter swims at dawn",
    });
    const chat = await startChat(the(), "when does the otter swim?");
    const off = await the().client.request(
      "chat-context",
      { action: "memory", workspaceId: "default", taskId: chat, mode: "off" },
      "memory-off",
    );
    expect((off.result as ChatContextAnswer | undefined)?.memoryMode).toBe("off");
    let from = the().requests.length;
    await replyIn(the(), chat, "when does the otter swim?");
    const offRequest = the().generationsSince(from)[0];
    for (const marker of MANIFEST_MARKERS) expect(contextOf(offRequest)).not.toContain(marker);
    expect(memoryTools(offRequest)).toEqual([]);
    expect(
      await the().client.request("chat-context", { action: "memory", workspaceId: "default", taskId: chat, mode: "on" }, "memory-on"),
    ).toMatchObject({ ok: true });
    from = the().requests.length;
    await replyIn(the(), chat, "when does the otter swim?");
    const onRequest = the().generationsSince(from)[0];
    expect(contextOf(onRequest)).toContain("The otter swims");
    expect(memoryTools(onRequest)).toContain("memory.propose");
    await the().memory({ action: "forget", recordId: record.recordId });
  }, 60_000);

  it("U7: a clean-input turn after a page read is saved tainted; the idle review reads none of it, its proposal waits with Facts ticked, and /remember still saves", async () => {
    const settings = async (payload: Record<string, unknown>) => {
      const answer = await the().client.request(
        "workspace-settings",
        { workspaceId: "default", ...payload },
        `settings-${Math.random().toString(36).slice(2)}`,
      );
      if (!answer.ok) throw new Error(JSON.stringify(answer.error));
      return answer.result as WorkspaceSettingsAnswer;
    };
    const read = await settings({ action: "get" });
    await settings({
      action: "set",
      key: "memory",
      value: JSON.stringify({ ...read.settings.memory, autoApprove: ["fact"] }),
      expectedRevision: read.revision,
    });
    try {
      const chat = await startChat(the(), "I cook dinner at home most evenings");
      await replyIn(the(), chat, `please ${READ_PAGE_PHRASE} of recipes`);
      // Its own input carries nothing untrusted: the page was read a turn before.
      await replyIn(the(), chat, `I'm vegetarian and cook at home, ${REMEMBER_PHRASE}`);
      const { entries } = await the().repositories().transcripts.page(chat, { limit: 50 });
      expect(entries.map((entry) => entry.turn.tainted === true)).toEqual([false, true, true]);
      // The idle review reads the clean turn before the page, and nothing from it on.
      expect(memoryReviewSpan(entries).map((message) => message.text)).toEqual(["I cook dinner at home most evenings", "Noted."]);
      // The model's proposal in it is filed, but waits for the person though Facts are ticked.
      const [card] = await until(
        async () => await the().cards(chat),
        (cards) => cards.length === 1,
      );
      const [proposed] = card?.items ?? [];
      expect(proposed).toMatchObject({ state: "proposed", title: VEGETARIAN.title });
      // /remember is the person's own ask: it still saves.
      expect(await commandIn(the(), chat, "/remember I prefer metric units")).toContain("I prefer metric units");
      const saved = (
        await until(
          async () => await the().cards(chat),
          (cards) => cards.some((each) => each.items.some((item) => item.state === "saved")),
        )
      )
        .flatMap((each) => each.items)
        .find((item) => item.state === "saved");
      expect(saved?.title).toBe("I prefer metric units");
      await the().memory({ action: "forget", recordId: proposed?.recordId });
      await the().memory({ action: "forget", recordId: saved?.recordId });
    } finally {
      const now = await settings({ action: "get" });
      await settings({ action: "set", key: "memory", value: JSON.stringify(read.settings.memory ?? {}), expectedRevision: now.revision });
    }
  }, 60_000);

  it("U5: Facts ticked under Keep without asking: the next fact proposal arrives Saved with Undo, and its review names the settings revision", async () => {
    const settings = async (payload: Record<string, unknown>) => {
      const answer = await the().client.request(
        "workspace-settings",
        { workspaceId: "default", ...payload },
        `settings-${Math.random().toString(36).slice(2)}`,
      );
      if (!answer.ok) throw new Error(JSON.stringify(answer.error));
      return answer.result as WorkspaceSettingsAnswer;
    };
    const read = await settings({ action: "get" });
    // The Center's tick: the memory section with autoApprove, at the revision read.
    const ticked = await settings({
      action: "set",
      key: "memory",
      value: JSON.stringify({ ...read.settings.memory, autoApprove: ["fact"] }),
      expectedRevision: read.revision,
    });
    expect(ticked.effective.memory?.autoApprove).toEqual(["fact"]);
    try {
      const chat = await startChat(the(), `I'm vegetarian and cook at home, ${REMEMBER_PHRASE}`);
      const [card] = await until(
        async () => await the().cards(chat),
        (cards) => cards.length === 1,
      );
      const [item] = card?.items ?? [];
      expect(item).toMatchObject({ state: "saved", title: VEGETARIAN.title });
      const got = await the().memory<MemoryGetAnswer>({ action: "get", recordId: item?.recordId });
      expect(got.reviews.map((review) => review.reason)).toEqual([`auto-approve (settings revision ${ticked.revision})`]);
      // Undo on the Saved card.
      await the().memory({ action: "forget", recordId: item?.recordId, reason: "undone from a memory card" });
      expect(await the().record(item?.recordId ?? "")).toBeUndefined();
    } finally {
      const now = await settings({ action: "get" });
      await settings({ action: "set", key: "memory", value: JSON.stringify(read.settings.memory ?? {}), expectedRevision: now.revision });
    }
  }, 60_000);

  it("U6: a proposal 25 days old is listed by the digest in Home, and Keep all approves it", async () => {
    const proposal = await the().propose("I cycle to work");
    the().setDigestClock(the().daysAfter(proposal.recordedAt, 25));
    try {
      const digest = await until(
        async () => (await the().cards(the().homeId)).find((card) => card.digest !== undefined),
        (card) => card !== undefined,
      );
      expect(digest?.items.map((item) => item.recordId)).toContain(proposal.recordId);
      const all = await the().memory<MemoryCardAllAnswer>({ action: "card-all", noticeId: digest?.noticeId, decision: "keep" });
      expect(all.kept).toBe(1);
      expect((await the().record(proposal.recordId))?.status).toBe("approved");
    } finally {
      the().setDigestClock(undefined);
    }
  }, 60_000);
});
