import { describe, expect, it } from "vitest";

import type { ChannelDescriptor, InvocationContext, MessagingGrantRecord } from "@tavi/contracts";

import { inOperatorDirectChat } from "../../src/runtime/chat-scope.js";
import { messagingGrantRules, messagingProfileRules } from "../../src/runtime/messaging-rules.js";

/**
 * `serve --messaging-allow-tool` narrowed: it lifts the messaging profile only in the operator's own
 * one-to-one chats.
 */

const bindings = new Map([
  ["tg:100", { workspaceId: "w1", principalId: "owner" }],
  ["tg:200", { workspaceId: "w1", principalId: "friend" }],
  ["tg:300", { workspaceId: "w2", principalId: "owner" }],
  ["mail:owner@example.com", { workspaceId: "w1", principalId: "owner" }],
]);
const kinds: Record<string, ChannelDescriptor["kind"]> = { tg: "chat", mail: "email" };
const deps = {
  bindingOf: async (connectionId: string, senderId: string) => bindings.get(`${connectionId}:${senderId}`),
  operatorOf: (workspaceId: string) => (workspaceId === "w1" || workspaceId === "w2" ? "owner" : undefined),
  channelKindOf: (connectionId: string) => kinds[connectionId],
};
const turn = (
  connectionId: string,
  sender: string,
  conversation: string,
  oneToOne: boolean,
  workspaceId = "w1",
): Pick<InvocationContext, "workspaceId" | "messagingReplyTo"> => ({
  workspaceId,
  messagingReplyTo: {
    connectionId,
    externalSenderId: sender,
    externalConversationId: conversation,
    ...(oneToOne ? { audience: "one-to-one" as const } : {}),
  },
});

describe("--messaging-allow-tool is the operator's own one-to-one chats only", () => {
  it("lifts in the operator's DM", async () => {
    expect(await inOperatorDirectChat(deps, turn("tg", "100", "100", true))).toBe(true);
  });

  it("does not lift in a group the operator writes in", async () => {
    expect(await inOperatorDirectChat(deps, turn("tg", "100", "-500", false))).toBe(false);
  });

  it("does not lift in a bound person's DM", async () => {
    expect(await inOperatorDirectChat(deps, turn("tg", "200", "200", true))).toBe(false);
  });

  it("does not lift in an email thread, even the operator's own", async () => {
    expect(await inOperatorDirectChat(deps, turn("mail", "owner@example.com", "thread-1", true))).toBe(false);
  });

  it("does not lift for a binding to another workspace, an unbound sender, or a turn with no chat", async () => {
    expect(await inOperatorDirectChat(deps, turn("tg", "300", "300", true))).toBe(false);
    expect(await inOperatorDirectChat(deps, turn("tg", "999", "999", true))).toBe(false);
    expect(await inOperatorDirectChat(deps, { workspaceId: "w1" })).toBe(false);
    expect(await inOperatorDirectChat(deps, turn("local-owner", "owner", "c", true))).toBe(false);
  });

  it("lists the flag's tools as held back, saying they are lifted in the operator's own chats", () => {
    const listed = messagingProfileRules([], ["fs.write"]);
    expect(listed.find((rule) => rule.toolPattern === "fs.write")?.note).toContain("lifted in your own one-to-one chats");
    expect(listed.find((rule) => rule.toolPattern === "sandbox.run")?.note).toBe(
      "messaging profile: allow with serve --messaging-allow-tool",
    );
  });
});

describe("a chat's grants", () => {
  const AT = "2026-10-18T09:00:00.000Z";
  const grant = (changes: Partial<MessagingGrantRecord>): MessagingGrantRecord => ({
    grantId: "g1",
    workspaceId: "w",
    connectionId: "c1",
    scopeKind: "contact",
    scopeId: "u-bob",
    toolId: "fs.write",
    mode: "allow",
    createdBy: "operator",
    createdAt: AT,
    ...changes,
  });
  const turn = (audience: "one-to-one" | undefined, conversation = "dm-bob", sender = "u-bob") =>
    ({
      workspaceId: "w",
      messagingReplyTo: {
        connectionId: "c1",
        externalConversationId: conversation,
        externalSenderId: sender,
        ...(audience === undefined ? {} : { audience }),
      },
    }) as Pick<InvocationContext, "workspaceId" | "messagingReplyTo">;
  const rules = (grants: readonly MessagingGrantRecord[], invocation: Pick<InvocationContext, "workspaceId" | "messagingReplyTo">) =>
    messagingGrantRules(
      messagingProfileRules([]),
      invocation,
      async (_connection, kind, id) => grants.filter((candidate) => candidate.scopeKind === kind && candidate.scopeId === id),
      AT,
      { channelKindOf: (connectionId) => (connectionId === "mail" ? "email" : "chat") },
    );
  const denied = (list: readonly { toolPattern: string; decision: string }[]) =>
    list.filter((rule) => rule.decision === "deny").map((rule) => rule.toolPattern);

  it("lifts a contact's allowed tool in their one-to-one chat alone, never letting it through unasked", async () => {
    const inDm = await rules([grant({})], turn("one-to-one"));
    expect(denied(inDm)).not.toContain("fs.write");
    expect(inDm.some((rule) => rule.decision === "allow")).toBe(false);
    // In a room the same person speaks in: the room's grants, and the profile.
    expect(denied(await rules([grant({})], turn(undefined, "room-1")))).toContain("fs.write");
  });

  it("never lifts a contact's allow in an email thread, one-to-one yet no chat; their deny still holds there", async () => {
    const mail = {
      workspaceId: "w",
      messagingReplyTo: { connectionId: "mail", externalConversationId: "thread-1", externalSenderId: "u-bob", audience: "one-to-one" },
    } as Pick<InvocationContext, "workspaceId" | "messagingReplyTo">;
    expect(denied(await rules([grant({ connectionId: "mail" })], mail))).toContain("fs.write");
    expect(denied(await rules([grant({ connectionId: "mail", toolId: "web_search", mode: "deny" })], mail))).toContain("web_search");
  });

  it("holds a deny, and ignores a revoked, expired or other workspace's grant", async () => {
    expect(
      denied(await rules([grant({ scopeKind: "room", scopeId: "room-1", toolId: "web_search", mode: "deny" })], turn(undefined, "room-1"))),
    ).toContain("web_search");
    for (const ignored of [grant({ revokedAt: AT }), grant({ expiresAt: "2026-10-18T08:00:00.000Z" }), grant({ workspaceId: "other" })]) {
      expect(denied(await rules([ignored], turn("one-to-one")))).toContain("fs.write");
    }
    // A worker a chat's turn delegated to: its chat's room's and person's denies, never an allow.
    const delegated = await messagingGrantRules(
      messagingProfileRules([]),
      turn(undefined, "room-1"),
      async (_connection, kind, id) =>
        [
          grant({}),
          grant({ grantId: "g2", scopeKind: "room", scopeId: "room-1", toolId: "web_search", mode: "deny" }),
          grant({ grantId: "g3", toolId: "news", mode: "deny" }),
        ].filter((candidate) => candidate.scopeKind === kind && candidate.scopeId === id),
      AT,
      { channelKindOf: () => "chat", delegated: true },
    );
    expect(denied(delegated)).toEqual(expect.arrayContaining(["fs.write", "web_search", "news"]));
    // A turn with no chat: the profile alone.
    expect(
      await messagingGrantRules(messagingProfileRules([]), { workspaceId: "w" }, async () => [grant({})], AT, {
        channelKindOf: () => "chat",
      }),
    ).toEqual(messagingProfileRules([]));
  });
});
