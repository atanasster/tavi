import { describe, expect, it } from "vitest";

import type {
  InvocationContext,
  MessagingIdentityBinding,
  MessagingServicePort,
  OutboundMessage,
  ReachableChannel,
  SendOutcome,
} from "@tavi/contracts";
import { ToolRegistry } from "@tavi/runtime";

import { registerMessagingTools } from "../../src/features/channels/tools.js";

/**
 * `messaging.send_to` by `person`: resolved strictly among the workspace's bound
 * people the allowlist already reaches, refused when ambiguous or unknown with
 * who it could be, shown on the card as the destination it resolved to; and a
 * refused destination says what is allowed on its connection instead.
 */

const bound = (connectionId: string, externalSenderId: string, displayName?: string, workspaceId = "w1"): MessagingIdentityBinding => ({
  connectionId,
  externalSenderId,
  workspaceId,
  principalId: `p-${externalSenderId}`,
  approvedBy: "operator",
  createdAt: "",
  ...(displayName === undefined ? {} : { displayName }),
});

const channel = (connectionId: string): ReachableChannel => ({
  connectionId,
  label: connectionId,
  channel: "Telegram",
  kind: "chat",
  target: "Chat ID",
  buttons: true,
  files: true,
  maxTextLength: 4096,
  allowedTargets: [],
});

const context: InvocationContext = { workspaceId: "w1", principalId: "alice", runId: "run-1", caller: "cli" };

function fixture(bindings: readonly MessagingIdentityBinding[], allowedDestinations: readonly string[]) {
  const sent: OutboundMessage[] = [];
  const messaging = {
    send: async (message: OutboundMessage): Promise<SendOutcome> => {
      sent.push(message);
      return { status: "accepted", retryable: false, parts: [{ index: 0, status: "accepted" }] };
    },
    buildDestination: (_connectionId: string, target: { readonly to: string }) => ({ chatId: target.to }),
  } as unknown as MessagingServicePort;
  const registry = new ToolRegistry();
  const list = [...bindings];
  registerMessagingTools(registry, messaging, (prefix) => `${prefix}-1`, {
    allowedDestinations,
    connectionIds: ["tg-a", "tg-b", "local-w1"],
    targetOf: (_connectionId, to) => to.toLowerCase(),
    providerOf: () => "telegram",
    reachable: () => [channel("tg-a"), channel("tg-b")],
    bindings: { list: async () => list },
  });
  const tool = (id: string) => {
    const found = registry.get(id);
    if (found === undefined) throw new Error(`no ${id}`);
    return found;
  };
  const send = (input: Record<string, unknown>) =>
    tool("messaging.send_to").handler({ input: { kind: "text", content: "hi", ...input }, context, signal: new AbortController().signal });
  return { registry, tool, send, sent, list };
}

const people = [
  bound("tg-a", "111", "Ana"),
  bound("tg-b", "222", "Ana"),
  bound("tg-a", "333", "Bob"),
  // Bound, but the allowlist does not reach them: never named, never resolved.
  bound("tg-a", "444", "Eve"),
  // Another workspace's, and a connection this workspace cannot send through.
  bound("tg-a", "555", "Zed", "w2"),
  bound("tg-c", "666", "Cy"),
];
const allowed = ["tg-a:111", "tg-b:222", "tg-a:333", "tg-a:555", "*:666", "tg-a:chat-9"];

describe("messaging contacts", () => {
  it("lists the people the allowlist reaches beside the channels, by the name the operator gave", async () => {
    const { tool } = fixture(people, allowed);
    expect(await tool("messaging.channels").handler({ input: {}, context, signal: new AbortController().signal })).toEqual({
      channels: [channel("tg-a"), channel("tg-b")],
      people: [
        { person: "Ana", connectionId: "tg-a", target: "111" },
        { person: "Ana", connectionId: "tg-b", target: "222" },
        { person: "Bob", connectionId: "tg-a", target: "333" },
      ],
    });
  });

  it("sends to a person by name or principal, case aside, and says where", async () => {
    const { send, sent } = fixture(people, allowed);
    expect(await send({ person: " bob " })).toMatchObject({
      status: "accepted",
      sentTo: { person: "Bob", connectionId: "tg-a", target: "333" },
    });
    expect(await send({ person: "p-222" })).toMatchObject({ sentTo: { connectionId: "tg-b", target: "222" } });
    expect(await send({ person: "Ana", connectionId: "tg-b" })).toMatchObject({ sentTo: { connectionId: "tg-b", target: "222" } });
    expect(sent.map((message) => [message.connectionId, message.destination])).toEqual([
      ["tg-a", { chatId: "333" }],
      ["tg-b", { chatId: "222" }],
      ["tg-b", { chatId: "222" }],
    ]);
  });

  it("refuses an ambiguous name with its candidates, an unknown or unreachable one with who it can be, and a mix with `to`", async () => {
    const { send, sent } = fixture(people, allowed);
    await expect(send({ person: "Ana" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("Ana on tg-a (111); Ana on tg-b (222)"),
    });
    await expect(send({ person: "Eve" })).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("Ana, Bob") });
    await expect(send({ person: "Zed" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(send({ person: "Cy" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(send({ person: "An" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(send({ person: "Bob", to: "333" })).rejects.toThrow(/exactly one of `to`, `chatId`/);
    await expect(send({ to: "333" })).rejects.toThrow(/needs `connectionId`, or a `person`/);
    expect(sent).toEqual([]);
  });

  it("shows the resolved person on the card, and refuses there what the send would", async () => {
    const { registry, tool } = fixture(people, allowed);
    const assess = (input: Record<string, unknown>) =>
      tool("messaging.send_to").assess?.({ kind: "text", content: "hi", ...input }, context);
    // Before the turn's tools are offered, who a person is has not been read: the card says so.
    expect(assess({ person: "Bob" })).toMatchObject({ risk: "high", display: { destination: expect.stringContaining("Bob") } });
    await registry.listOffered({ workspaceId: "w1" });
    expect(assess({ person: "Bob" })).toMatchObject({
      display: { title: "Send a message to Bob (tg-a:333)", destination: "Bob (tg-a:333)" },
      subjects: ["tg-a:333"],
    });
    expect(assess({ person: "Ana" })?.hardDeny).toContain("more than one destination");
    expect(assess({ person: "Eve" })?.hardDeny).toContain("not someone this task can message");
    expect(assess({ person: "Bob", to: "333" })?.hardDeny).toContain("one of `to`, `chatId` and `person`");
  });

  it("refuses a send whose person changed since the card named them", async () => {
    const { registry, send, list, sent } = fixture(people, allowed);
    await registry.listOffered({ workspaceId: "w1" });
    // Bob is bound again, to another chat the allowlist also reaches, after the card was assessed.
    list.splice(2, 1, bound("tg-a", "chat-9", "Bob"));
    await expect(send({ person: "Bob" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(sent).toEqual([]);
  });

  it("refuses a send whose person moved since the gate decided it, though the cache was read again since (a restart)", async () => {
    const { registry, tool, list, sent } = fixture(people, allowed);
    // Bob moved, and a later listing (or a restart) read where he is now: only the gate's subjects remember the card.
    list.splice(2, 1, bound("tg-a", "chat-9", "Bob"));
    await registry.listOffered({ workspaceId: "w1" });
    await expect(
      tool("messaging.send_to").handler({
        input: { kind: "text", content: "hi", person: "Bob" },
        context,
        signal: new AbortController().signal,
        assessedSubjects: ["tg-a:333"],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(sent).toEqual([]);
  });

  it("names what is allowed on a connection when it refuses a destination there", async () => {
    const { registry, send } = fixture(people, allowed);
    await registry.listOffered({ workspaceId: "w1" });
    await expect(send({ connectionId: "tg-a", to: "999" })).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
      message: expect.stringContaining("Allowed on tg-a: 111 (Ana), 333 (Bob), 555, 666, chat-9"),
      details: { connectionId: "tg-a", chatId: "999", allowedTargets: ["111", "333", "555", "666", "chat-9"] },
    });
    await expect(fixture([], []).send({ connectionId: "tg-a", to: "999" })).rejects.toThrow(/Allowed on tg-a: none/);
  });

  it("refuses a person where no people are known", async () => {
    const registry = new ToolRegistry();
    registerMessagingTools(registry, {} as MessagingServicePort, () => "msg-1", { allowedDestinations: ["111"] });
    const tool = registry.get("messaging.send_to");
    expect(tool?.assess?.({ kind: "text", content: "hi", person: "Bob" }, context)?.hardDeny).toContain("no person is known here");
    await expect(
      tool?.handler({ input: { kind: "text", content: "hi", person: "Bob" }, context, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});
