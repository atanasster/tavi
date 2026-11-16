import type { IdeaCapability, IdeaDraft, ModEnvelope } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import type { IdeasCommandDependencies } from "../../src/features/ideas/owner.js";
import { ideasDigestReplyHook, ideasDigestSender, ideasSlashCommand } from "../../src/features/ideas/slash.js";
import { SqliteStore } from "../support/database-fixture.js";

/** `/ideas`: the operator's top ideas, and refresh. */

const NOW = new Date("2026-10-19T10:00:00.000Z");

const draft = (key: string): IdeaDraft => ({
  key,
  category: "travel",
  icon: "✈️",
  title: `I can help with ${key}`,
  pitch: "A pitch.",
  label: `Try ${key}`,
  prompt: `Help me with ${key}.`,
  basis: [{ kind: "general", ref: "general" }],
  uses: [{ capability: "web", approval: false }],
});

const envelope = (principalId = "operator"): ModEnvelope => ({
  workspaceId: "default",
  principalId,
  taskId: "task-1",
  runId: "run-1",
  source: "web",
  attended: true,
});

async function fixture(refresh?: IdeasCommandDependencies["refresh"]) {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const repositories = store.asPort().repositories;
  const run = ideasSlashCommand({
    repositories,
    principalOf: () => "operator",
    now: () => NOW,
    ...(refresh === undefined ? {} : { refresh }),
  });
  const say = async (args: string, principalId?: string) =>
    (await run({ envelope: envelope(principalId), args, signal: new AbortController().signal })).text;
  return { repositories, say };
}

describe("/ideas", () => {
  it("lists the top ideas with what to send, and says when there are none", async () => {
    const { repositories, say } = await fixture();
    expect(await say("")).toBe("No ideas yet. /ideas refresh looks for some.");
    await repositories.ideas.startRun({ runId: "run-a", workspaceId: "default", trigger: "schedule", now: NOW.toISOString() });
    await repositories.ideas.store({
      workspaceId: "default",
      runId: "run-a",
      providerId: "tavi.ideasagent",
      now: NOW.toISOString(),
      ideas: ["travel.a", "travel.b", "travel.c", "travel.d", "travel.e"].map((key, index) => ({
        id: key,
        score: 0.9 - index / 10,
        draft: draft(key),
      })),
    });
    const text = await say("");
    expect(text.split("\n")).toEqual([
      "Ideas for you:",
      "1. I can help with travel.a (Travel & errands)",
      "   Try: Help me with travel.a.",
      "2. I can help with travel.b (Travel & errands)",
      "   Try: Help me with travel.b.",
      "3. I can help with travel.c (Travel & errands)",
      "   Try: Help me with travel.c.",
      "4. I can help with travel.d (Travel & errands)",
      "   Try: Help me with travel.d.",
      "More in the Ideas tab.",
    ]);
    // Off, it lists nothing, as the tab shows no cards.
    await repositories.ideas.saveSettings({ workspaceId: "default", patch: { enabled: false }, now: NOW.toISOString() });
    expect(await say("")).toBe("Ideas are off. Turn them on in Settings → Ideas, or with tavi ideas on.");
  });

  it("refreshes through the host, and is the operator's only", async () => {
    const statuses = ["started", "queued", "busy"] as const;
    let index = 0;
    const { say } = await fixture(async () => statuses[index++] ?? "busy");
    expect(await say("refresh")).toBe("Looking for new ideas; /ideas shows them in a moment.");
    expect(await say("refresh")).toBe("A look is under way; another follows it.");
    expect(await say("refresh")).toBe("Ideas are being looked for elsewhere; try /ideas in a minute.");
    expect(await say("pin 3")).toMatch(/^Usage: \/ideas/u);
    expect(await say("", "someone-else")).toBe("/ideas is the workspace operator's.");
  });

  it("answers on a channel only in the operator's own direct chat, never a group or an email thread", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    const places: Record<string, "direct" | "group" | "email" | undefined> = { direct: "direct", group: "group", email: "email" };
    const run = ideasSlashCommand({
      repositories: store.asPort().repositories,
      principalOf: () => "operator",
      now: () => NOW,
      placeOf: (envelope) => places[envelope.taskId],
    });
    const on = async (taskId: string) =>
      (await run({ envelope: { ...envelope(), taskId, source: "messaging" }, args: "", signal: new AbortController().signal })).text;
    expect(await on("direct")).toBe("No ideas yet. /ideas refresh looks for some.");
    for (const place of ["group", "email", "unknown"])
      expect(await on(place)).toBe("/ideas answers only in your own direct chat with Tavi, never where others read.");
  });

  it("adds the idea a digest reply picks to the operator's message, and passes everything else by", async () => {
    const { repositories } = await fixture();
    await repositories.ideas.startRun({ runId: "run-a", workspaceId: "default", trigger: "schedule", now: NOW.toISOString() });
    await repositories.ideas.store({
      workspaceId: "default",
      runId: "run-a",
      providerId: "tavi.ideasagent",
      now: NOW.toISOString(),
      ideas: [{ id: "travel.a", score: 0.9, draft: draft("travel.a") }],
    });
    const { settings } = await repositories.ideas.settings("default");
    await repositories.ideas.saveSettings({
      workspaceId: "default",
      settings: {
        ...settings,
        digest: { channel: "tg-1", weekday: 1 },
        digestSent: { on: "2026-10-19", at: NOW.toISOString(), connectionId: "tg-1", chatId: "chat-9", ideaIds: ["travel.a"] },
      },
      now: NOW.toISOString(),
    });
    const chats: Record<string, { connectionId: string; chatId: string }> = {
      "task-1": { connectionId: "tg-1", chatId: "chat-9" },
      "task-group": { connectionId: "tg-1", chatId: "group-1" },
    };
    let here: readonly IdeaCapability[] = [];
    const hook = ideasDigestReplyHook({
      repositories,
      principalOf: () => "operator",
      chatOf: async (taskId) => chats[taskId],
      census: async () => here,
      now: () => NOW,
      newId: () => "f1",
      log: () => undefined,
    });
    const next = Object.assign(async () => ({ context: ["below"] }), { signal: new AbortController().signal });
    const reply = (prompt: string, principalId = "operator", taskId = "task-1") =>
      hook({ envelope: { ...envelope(principalId), taskId, source: "messaging", channel: "tg-1" }, prompt, steer: false }, next);
    // Another person, or a group room on the same connection: only a message.
    expect(await reply("1", "someone-else")).toEqual({ context: ["below"] });
    expect(await reply("1", "operator", "task-group")).toEqual({ context: ["below"] });
    expect(await reply("hello")).toEqual({ context: ["below"] });
    // What the idea uses is gone from here: no longer offered, so not picked.
    expect(await reply("1")).toEqual({ context: ["below"] });
    here = ["web"];
    expect(await reply("1")).toEqual({
      context: [
        "below",
        'They picked this from their weekly ideas digest: "I can help with travel.a". What it asks: Help me with travel.a.',
      ],
    });
    expect((await repositories.ideas.get("default", "travel.a"))?.status).toBe("tried");
    // One pick a digest: the next "1" answers whatever was asked since.
    expect(await reply("1")).toEqual({ context: ["below"] });
  });

  it("sends the digest only to the operator's own authorized chat on its connection, and says when the channel refused", async () => {
    const sends: { connectionId: string; to: unknown }[] = [];
    let status: "accepted" | "rejected" = "accepted";
    const messaging = {
      buildDestination: (connectionId: string, to: { readonly to?: string }) => ({
        connectionId,
        kind: "direct" as const,
        to: to.to ?? "",
      }),
      send: async (message: { readonly connectionId: string; readonly destination: unknown }) => (
        sends.push({ connectionId: message.connectionId, to: message.destination }), { status, parts: [] }
      ),
    } as unknown as Parameters<typeof ideasDigestSender>[0]["messaging"];
    const sender = ideasDigestSender({
      principalOf: () => "operator",
      operatorTargets: async () => [
        { connectionId: "discord-1", chatId: "dm-d" },
        { connectionId: "tg-1", chatId: "dm-t" },
      ],
      messaging,
      log: () => undefined,
    });
    expect(await sender({ workspaceId: "default", connectionId: "tg-1", text: "Ideas", effectId: "e1" })).toEqual({
      status: "sent",
      chatId: "dm-t",
    });
    expect(sends).toEqual([{ connectionId: "tg-1", to: { connectionId: "tg-1", kind: "direct", to: "dm-t" } }]);
    expect(await sender({ workspaceId: "default", connectionId: "slack-9", text: "Ideas", effectId: "e2" })).toEqual({ status: "skipped" });
    status = "rejected";
    expect(await sender({ workspaceId: "default", connectionId: "tg-1", text: "Ideas", effectId: "e3" })).toEqual({ status: "skipped" });
  });
});
