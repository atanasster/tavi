import { join } from "node:path";

import { disarmUrls, normalisedDelivery } from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import type { InvocationContext, MessagingServicePort, OutboundMessage, SendOutcome } from "@tavi/contracts";
import { createFixtureMessagingConnectorDefinition, type FixtureMessagingConnectorInstance } from "@tavi/test-support/messaging";
import { createMessagingService, ToolRegistry } from "@tavi/runtime";
import { temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../support/database-fixture.js";
import { afterEach, describe, expect, it } from "vitest";

import { registerMessagingTools, type MessagingToolOptions } from "../../src/features/channels/tools.js";
import { allowedTargetsOf, assertDestinationEntries, parseDestinationEntry } from "../../src/features/channels/destination.js";

/**
 * `messaging.send` — the governed model tool for
 * replying through the channel a task was admitted from. A model decides
 * explicitly whether to call it; nothing sends automatically.
 */

const messageDrivenContext: InvocationContext = {
  workspaceId: "w1",
  principalId: "alice",
  runId: "run-1",
  caller: "messaging:conn-a",
  messagingReplyTo: { connectionId: "conn-a", externalConversationId: "chat-1", externalSenderId: "user-1" },
};

const operatorContext: InvocationContext = {
  workspaceId: "w1",
  principalId: "alice",
  runId: "run-1",
  caller: "cli",
};

function fixture(
  overrides: Partial<MessagingServicePort> = {},
  options: Pick<MessagingToolOptions, "allowedDestinations" | "connectionIds" | "targetOf" | "providerOf" | "reachable"> = {},
): { readonly registry: ToolRegistry; readonly sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  const messaging: MessagingServicePort = {
    registerConnector: () => {},
    unregisterConnector: async () => false,
    openConnection: async () => {},
    closeConnection: async () => {},
    ingest: async () => ({ accepted: true, duplicate: false }),
    send: async (message) => {
      sent.push(message);
      const outcome: SendOutcome = {
        status: "accepted",
        retryable: false,
        parts: message.parts.map((_part, index) => ({ index, status: "accepted" })),
      };
      return outcome;
    },
    recordDelivery: async () => false,
    buildReplyDestination: (connectionId, replyTo) => ({ chatId: replyTo.externalConversationId, connectionId }),
    buildDestination: (_connectionId, target) => ({
      chatId: target.to,
      ...(target.replyToId === undefined ? {} : { replyToMessageId: target.replyToId }),
    }),
    providerOf: () => "telegram",
    statusOf: () => undefined,
    ingressOf: () => undefined,
    connectionsOf: () => [],
    capabilitiesOf: () => undefined,
    answerInteraction: async () => {},
    editMessage: async () => false,
    // The tools under test never replay a held inbound event; the port requires
    // the method, so the stub states that rather than pretending.
    replay: async () => ({ outcome: "not-found" as const }),
    ...overrides,
  };
  const registry = new ToolRegistry();
  // Incrementing rather than constant: the effect id must differ per
  // invocation, and a constant fixture id would hide exactly that regression.
  let ids = 0;
  registerMessagingTools(registry, messaging, (prefix) => `${prefix}-${(ids += 1)}`, {
    allowedDestinations: options.allowedDestinations ?? ["chat-9", "c", "telegram-main", "8346819670"],
    // One connection by default, which is what makes the bare entries above
    // unambiguous; a test that wants the two-connection reading passes an
    // explicit pair.
    connectionIds: options.connectionIds ?? ["telegram-main"],
    ...(options.targetOf === undefined ? {} : { targetOf: options.targetOf }),
    ...(options.providerOf === undefined ? {} : { providerOf: options.providerOf }),
    ...(options.reachable === undefined ? {} : { reachable: options.reachable }),
  });
  return { registry, sent };
}

async function invoke(registry: ToolRegistry, input: unknown, context: InvocationContext, toolId = "messaging.send"): Promise<unknown> {
  const tool = registry.get(toolId);
  if (tool === undefined) throw new Error(`${toolId} not registered`);
  return tool.handler({ input, context, signal: new AbortController().signal });
}

describe("messaging tools", () => {
  it("registers messaging.send and messaging.send_to", () => {
    const { registry } = fixture();
    expect(registry.list().map((tool) => tool.id)).toEqual(["messaging.send", "messaging.send_to"]);
  });

  it("sends a reply through the connection/conversation named by messagingReplyTo", async () => {
    const { registry, sent } = fixture();
    const outcome = (await invoke(registry, { content: "hello back" }, messageDrivenContext)) as SendOutcome;
    expect(outcome.status).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      connectionId: "conn-a",
      destination: { chatId: "chat-1", connectionId: "conn-a" },
      parts: [{ content: "hello back" }],
    });
  });

  it("sends a tainted turn's reply through the workflow's disarm, and a clean one as written", async () => {
    const { registry, sent } = fixture();
    const tool = registry.get("messaging.send");
    if (tool === undefined) throw new Error("messaging.send not registered");
    const content = "details: https://collect.attacker.example/p?q=secret";
    await tool.handler({ input: { content }, context: messageDrivenContext, signal: new AbortController().signal });
    await tool.handler({
      input: { content },
      context: messageDrivenContext,
      signal: new AbortController().signal,
      disarmUrls: (text) => disarmUrls(text, new Set()),
    });
    expect(sent.map((message) => message.parts[0])).toEqual([
      { content },
      { content: "details: hxxps[:]//collect[.]attacker[.]example/p?q=secret" },
    ]);
  });

  it("refuses a call from a task not admitted from a message (no messagingReplyTo)", async () => {
    const { registry } = fixture();
    await expect(invoke(registry, { content: "hello" }, operatorContext)).rejects.toThrow(
      /only available to a task admitted from a channel message/,
    );
  });

  it("fails closed when the connection is unsupported/not open (buildReplyDestination returns undefined)", async () => {
    const { registry } = fixture({ buildReplyDestination: () => undefined });
    await expect(invoke(registry, { content: "hello" }, messageDrivenContext)).rejects.toThrow(
      /is not open, or its connector supports no reply destination/,
    );
  });

  it("rejects invalid arguments as INVALID_INPUT before touching the service", async () => {
    const { registry, sent } = fixture();
    await expect(invoke(registry, { content: "" }, messageDrivenContext)).rejects.toThrow(/messaging\.send received invalid arguments/);
    expect(sent).toHaveLength(0);
  });

  it("throws CANCELLED when the signal is already aborted", async () => {
    const { registry } = fixture();
    const controller = new AbortController();
    controller.abort();
    const tool = registry.get("messaging.send");
    if (tool === undefined) throw new Error("messaging.send not registered");
    await expect(tool.handler({ input: { content: "hi" }, context: messageDrivenContext, signal: controller.signal })).rejects.toThrow(
      /was cancelled/,
    );
  });

  it("threads externalMessageId through to buildReplyDestination when present, for reply-threading headers", async () => {
    const seen: { externalMessageId?: string }[] = [];
    const { registry } = fixture({
      buildReplyDestination: (_connectionId, replyTo) => {
        seen.push(replyTo);
        return { chatId: replyTo.externalConversationId };
      },
    });
    await invoke(
      registry,
      { content: "hi" },
      {
        ...messageDrivenContext,
        messagingReplyTo: { ...messageDrivenContext.messagingReplyTo!, externalMessageId: "<abc@mail.example.com>" },
      },
    );
    expect(seen[0]?.externalMessageId).toBe("<abc@mail.example.com>");
  });
});

/**
 * `messaging.send_to` — the tool an *unattended* run
 * needs: the 07:00 brief task is admitted by the scheduler, never by an
 * inbound message, so it has no `messagingReplyTo` to reply to and must name
 * a connection and a chat explicitly. It is also the only way a rendered PDF
 * (an approved artifact) reaches a chat.
 */
describe("messaging.send_to", () => {
  const sendTo = async (registry: ToolRegistry, input: unknown) => await invoke(registry, input, operatorContext, "messaging.send_to");

  it("sends text to an explicit connection and chat from a task with no messagingReplyTo", async () => {
    const { registry, sent } = fixture();
    const outcome = (await sendTo(registry, {
      kind: "text",
      connectionId: "telegram-main",
      chatId: 8346819670,
      content: "the brief is ready",
    })) as SendOutcome;
    expect(outcome.status).toBe("accepted");
    expect(sent[0]).toMatchObject({
      connectionId: "telegram-main",
      // The channel builds the destination from the target, always text.
      destination: { chatId: "8346819670" },
      parts: [{ content: "the brief is ready" }],
    });
  });

  it("is a schedule fire's reply when it goes to the schedule's own delivery target: disarmed under taint, every other destination a message", async () => {
    const { registry, sent } = fixture(
      {},
      { allowedDestinations: ["telegram-main:8346819670", "telegram-main:chat-9"], connectionIds: ["telegram-main"] },
    );
    const tool = registry.get("messaging.send_to");
    if (tool?.assess === undefined) throw new Error("messaging.send_to has no assessor");
    const fire: InvocationContext = {
      ...operatorContext,
      caller: "schedule:morning-brief",
      scheduleDelivery: { connectionId: "telegram-main", destination: "8346819670" },
    };
    const brief = {
      kind: "text",
      connectionId: "telegram-main",
      chatId: 8346819670,
      content: "Brief: see https://news.example/a and https://collect.attacker.example/?d=1",
    };
    // Its audience is not known, so it is judged as a group's reply under [A]∧[B].
    expect(tool.assess(brief, fire)).toMatchObject({ sink: "reply", groupDestination: true });
    expect(tool.assess({ ...brief, chatId: "chat-9" }, fire).sink).toBeUndefined();
    // Another topic of the same chat is another destination.
    expect(tool.assess({ ...brief, threadId: "topic-7" }, fire).sink).toBeUndefined();
    expect(tool.assess(brief, operatorContext).sink).toBeUndefined();
    // Tainted: the workflow hands the handler the run's disarm, applied only to the delivery target.
    const known = new Set(["https://news.example/a"]);
    const disarm = (text: string) => disarmUrls(text, known);
    await tool.handler({ input: brief, context: fire, signal: new AbortController().signal, disarmUrls: disarm });
    await tool.handler({ input: { ...brief, chatId: "chat-9" }, context: fire, signal: new AbortController().signal, disarmUrls: disarm });
    await tool.handler({
      input: { ...brief, threadId: "topic-7" },
      context: fire,
      signal: new AbortController().signal,
      disarmUrls: disarm,
    });
    expect(sent.map((message) => message.parts[0])).toEqual([
      { content: "Brief: see https://news.example/a and hxxps[:]//collect[.]attacker[.]example/?d=1" },
      { content: brief.content },
      { content: brief.content },
    ]);
  });

  it("does not send an if-changed schedule's reply again when it is the result last delivered there, and says so", async () => {
    const { registry, sent } = fixture(
      {},
      { allowedDestinations: ["telegram-main:8346819670", "telegram-main:chat-9"], connectionIds: ["telegram-main"] },
    );
    const tool = registry.get("messaging.send_to");
    if (tool === undefined) throw new Error("messaging.send_to is not registered");
    const digest = "Two new matches:\n- Acme\n- Globex";
    const lastDeliveredHash = sha256Hex(normalisedDelivery(digest));
    const fire: InvocationContext = {
      ...operatorContext,
      caller: "schedule:jobs",
      scheduleDelivery: { connectionId: "telegram-main", destination: "8346819670" },
      scheduleNotify: { mode: "if-changed", lastDeliveredHash },
    };
    const send = async (content: string, chatId = "8346819670", context = fire) =>
      (await tool.handler({
        input: { kind: "text", connectionId: "telegram-main", chatId, content },
        context,
        signal: new AbortController().signal,
      })) as Record<string, unknown>;
    // The same words, wrapped differently: declined, with nothing sent.
    expect(await send("  Two new matches: \n - Acme\n\n - Globex ")).toMatchObject({ status: "unchanged", retryable: false });
    expect(sent).toHaveLength(0);
    // Another result goes, and carries the hash the schedule keeps.
    expect(await send("One new match: Initech")).toMatchObject({
      status: "accepted",
      deliveryHash: sha256Hex(normalisedDelivery("One new match: Initech")),
    });
    // Another destination, or a schedule that tells after every run, is never compared.
    expect(await send(digest, "chat-9")).not.toHaveProperty("deliveryHash");
    expect(await send(digest, "8346819670", { ...fire, scheduleNotify: undefined })).toMatchObject({ status: "accepted" });
    expect(sent).toHaveLength(3);
  });

  it("takes the target as `to`, in its channel's own form, and refuses both names at once", async () => {
    const { registry, sent } = fixture(
      {},
      {
        allowedDestinations: ["mailgun-main:ana@example.com"],
        connectionIds: ["telegram-main", "mailgun-main"],
        targetOf: (_connectionId, to) => (to.includes("@") ? to.toLowerCase() : undefined),
      },
    );
    expect(
      (
        (await sendTo(registry, {
          kind: "text",
          connectionId: "mailgun-main",
          to: "Ana@Example.com",
          subject: "Weekly",
          content: "hi",
        })) as SendOutcome
      ).status,
    ).toBe("accepted");
    expect(sent[0]).toMatchObject({ connectionId: "mailgun-main", destination: { chatId: "ana@example.com" } });
    await expect(sendTo(registry, { kind: "text", connectionId: "mailgun-main", to: "not-an-address", content: "hi" })).rejects.toThrow(
      /is not a target/,
    );
    await expect(
      sendTo(registry, { kind: "text", connectionId: "mailgun-main", to: "ana@example.com", chatId: "ana@example.com", content: "hi" }),
    ).rejects.toThrow(/exactly one of `to`, `chatId` \(its older name\) and `person`/);
    await expect(sendTo(registry, { kind: "text", connectionId: "mailgun-main", content: "hi" })).rejects.toThrow(/exactly one of/);
    expect(sent).toHaveLength(1);
  });

  it("sends an approved artifact as a file part with its caption, filename and content type", async () => {
    const { registry, sent } = fixture();
    await sendTo(registry, {
      kind: "file",
      connectionId: "telegram-main",
      chatId: "chat-9",
      artifactId: "artifact-brief-1",
      filename: "daily-brief.pdf",
      mimeType: "application/pdf",
      caption: "Morning brief — 2026-04-05",
      replyToMessageId: 5,
    });
    expect(sent[0]).toMatchObject({
      connectionId: "telegram-main",
      destination: { chatId: "chat-9", replyToMessageId: "5" },
      parts: [
        {
          kind: "file",
          artifactId: "artifact-brief-1",
          filename: "daily-brief.pdf",
          mimeType: "application/pdf",
          caption: "Morning brief — 2026-04-05",
        },
      ],
    });
  });

  it("advertises the text/file choice as one object the model can call, its contract in words", () => {
    const { registry } = fixture();
    const schema = registry.inputJsonSchemaOf("messaging.send_to") as {
      readonly type: string;
      readonly description: string;
      readonly required: readonly string[];
      readonly properties: Record<string, { readonly enum?: readonly string[] }>;
    };
    // A provider requires an object at a function's root (OpenAI refuses the
    // union's bare `oneOf`). A `.refine()` would drop the constraint silently;
    // the flattened union says it, and the handler still enforces it.
    expect(schema.type).toBe("object");
    expect(schema.properties["kind"]?.enum).toEqual(["text", "file"]);
    expect(schema.required).toEqual(["kind"]);
    expect(schema.description).toContain('kind "text" requires content and takes none of artifactId');
    // A document by an approved artifact or a folder file: exactly one, said in words and enforced by the handler.
    expect(schema.description).toContain("A document is given by exactly one of artifactId and path");
    expect(schema.description).toContain('kind "file" requires nothing more and takes none of content');
  });

  it("rejects a contradictory call, where a text variant names an artifactId", async () => {
    const { registry, sent } = fixture();
    await expect(
      sendTo(registry, { kind: "text", connectionId: "telegram-main", chatId: "chat-9", content: "x", artifactId: "a-1" }),
    ).rejects.toThrow(/messaging\.send_to received invalid arguments/);
    expect(sent).toHaveLength(0);
  });

  it("rejects a file variant with neither artifactId nor path, and a text variant with no content", async () => {
    const { registry, sent } = fixture();
    await expect(sendTo(registry, { kind: "file", connectionId: "telegram-main", chatId: "chat-9" })).rejects.toThrow(
      /exactly one of `artifactId` and `path`/,
    );
    await expect(sendTo(registry, { kind: "text", connectionId: "telegram-main", chatId: "chat-9" })).rejects.toThrow(
      /received invalid arguments/,
    );
    expect(sent).toHaveLength(0);
  });

  it("rejects an unknown variant name", async () => {
    const { registry, sent } = fixture();
    await expect(sendTo(registry, { kind: "document", connectionId: "telegram-main", chatId: "chat-9" })).rejects.toThrow(
      /received invalid arguments/,
    );
    expect(sent).toHaveLength(0);
  });

  it("refuses a destination the operator has not allowlisted, before any call", async () => {
    const { registry, sent } = fixture({}, { allowedDestinations: ["8346819670"] });
    await expect(
      sendTo(registry, { kind: "text", connectionId: "telegram-main", chatId: "@attacker_channel", content: "leak" }),
    ).rejects.toThrow(/not in the operator's allowlist/);
    expect(sent).toHaveLength(0);
  });

  it("denies every destination when no allowlist is configured at all", async () => {
    // Deny-by-default, mirroring `http.request`'s host allowlist: the
    // destination is a model-authored argument, so an unconfigured runtime must
    // not be talkable into sending the report anywhere.
    const { registry, sent } = fixture({}, { allowedDestinations: [] });
    await expect(sendTo(registry, { kind: "text", connectionId: "telegram-main", chatId: "8346819670", content: "hi" })).rejects.toThrow(
      /not in the operator's allowlist/,
    );
    expect(sent).toHaveLength(0);
  });

  it("binds a connection-qualified entry to that connection only", async () => {
    // A bare `chatId` matches on any connection, so with several open an id
    // allowlisted for one provider would be addressable through any other.
    // A qualified entry names both halves.
    const qualified = fixture({}, { allowedDestinations: ["telegram-main:chat-9"] });
    await sendTo(qualified.registry, { kind: "text", connectionId: "telegram-main", chatId: "chat-9", content: "hi" });
    expect(qualified.sent).toHaveLength(1);

    // The same chat id through another connection is refused.
    const other = fixture({}, { allowedDestinations: ["telegram-main:chat-9"] });
    await expect(sendTo(other.registry, { kind: "text", connectionId: "mailgun-main", chatId: "chat-9", content: "leak" })).rejects.toThrow(
      /not in the operator's allowlist/,
    );
    expect(other.sent).toHaveLength(0);
  });

  it("keeps a bare entry working while a single connection is configured", async () => {
    // One connection means the bare form is unambiguous, so a single-connection
    // configuration keeps sending without an edit.
    const bare = fixture({}, { allowedDestinations: ["chat-9"], connectionIds: ["telegram-main"] });
    await sendTo(bare.registry, { kind: "text", connectionId: "telegram-main", chatId: "chat-9", content: "hi" });
    expect(bare.sent).toHaveLength(1);
  });

  it("stops honouring a bare entry once a second connection exists, so a Telegram id cannot be reached over Mailgun", async () => {
    // `chat-9` allowlisted with Telegram and
    // Mailgun both configured must not authorize the same conversation through
    // whichever connection the model names.
    const twoConnections = ["telegram-main", "mailgun-main"];
    const bare = fixture({}, { allowedDestinations: ["chat-9"], connectionIds: twoConnections });
    await expect(sendTo(bare.registry, { kind: "text", connectionId: "mailgun-main", chatId: "chat-9", content: "leak" })).rejects.toThrow(
      /must be written `connectionId:chatId`/,
    );
    expect(bare.sent).toHaveLength(0);

    // …while the qualified form for the connection the operator meant still works.
    const qualified = fixture({}, { allowedDestinations: ["telegram-main:chat-9"], connectionIds: twoConnections });
    await sendTo(qualified.registry, { kind: "text", connectionId: "telegram-main", chatId: "chat-9", content: "hi" });
    expect(qualified.sent).toHaveLength(1);
  });

  it("parses the bare and qualified destination forms, and refuses malformed ones", () => {
    expect(parseDestinationEntry("8346819670")).toEqual({ chatId: "8346819670" });
    expect(parseDestinationEntry("telegram-main:chat-9")).toEqual({ connectionId: "telegram-main", chatId: "chat-9" });
    // A chat id may contain a colon — everything after the FIRST one is the id,
    // so a Mailgun `to:` header stays addressable.
    expect(parseDestinationEntry("mailgun-main:Ops: Alerts <a@x.com>")).toEqual({
      connectionId: "mailgun-main",
      chatId: "Ops: Alerts <a@x.com>",
    });
    // Empty halves and surrounding whitespace can never match (the chat id is
    // never empty and an operator never writes the padding deliberately).
    expect(parseDestinationEntry(":chat-9")).toBeUndefined();
    expect(parseDestinationEntry("telegram-main:")).toBeUndefined();
    expect(parseDestinationEntry("telegram-main :chat-9")).toBeUndefined();
  });

  it("refuses an allowlist entry whose colon does not name a configured connection, instead of reinterpreting it", () => {
    // A legacy literal destination such as a Mailgun `to:` header is a valid
    // entry under the bare-only grammar; silently reading its colon as a
    // connection separator would both break it and change what it authorizes.
    // (The display-name form trips the whitespace rule first, hence "malformed".)
    expect(() => assertDestinationEntries(["Ops: Alerts <a@x.com>"], ["telegram-main"], "--messaging-allow-destination")).toThrow(
      /is malformed/,
    );
    expect(() => assertDestinationEntries(["Ops:Alerts"], ["telegram-main"], "--messaging-allow-destination")).toThrow(
      /names connection "Ops", which is not configured/,
    );
    expect(() => assertDestinationEntries(["telegram-main:"], ["telegram-main"], "--messaging-allow-destination")).toThrow(/is malformed/);
    // A qualified entry naming a configured connection, and a bare entry, both pass.
    expect(assertDestinationEntries(["telegram-main:chat-9", "8346819670"], ["telegram-main"], "--messaging-allow-destination")).toEqual([
      "telegram-main:chat-9",
      "8346819670",
    ]);
  });

  it("takes `*:target` on every connection and `providerId:*` for anyone on that channel only", async () => {
    const twoConnections = ["telegram-main", "mailgun-main"];
    const providerOf = (connectionId: string): string | undefined => connectionId.split("-")[0];
    // `*:target` holds however many connections are open, where a bare entry stops.
    const everywhere = fixture({}, { allowedDestinations: ["*:chat-9"], connectionIds: twoConnections, providerOf });
    await sendTo(everywhere.registry, { kind: "text", connectionId: "mailgun-main", to: "chat-9", content: "hi" });
    await sendTo(everywhere.registry, { kind: "text", connectionId: "telegram-main", to: "chat-9", content: "hi" });
    expect(everywhere.sent).toHaveLength(2);
    await expect(sendTo(everywhere.registry, { kind: "text", connectionId: "telegram-main", to: "chat-1", content: "no" })).rejects.toThrow(
      /not in the operator's allowlist/,
    );
    // `telegram:*` is anyone on Telegram, and no one on another channel.
    const anyone = fixture({}, { allowedDestinations: ["telegram:*"], connectionIds: twoConnections, providerOf });
    await sendTo(anyone.registry, { kind: "text", connectionId: "telegram-main", to: "chat-77", content: "hi" });
    await expect(sendTo(anyone.registry, { kind: "text", connectionId: "mailgun-main", to: "chat-77", content: "leak" })).rejects.toThrow(
      /not in the operator's allowlist/,
    );
    expect(anyone.sent).toHaveLength(1);
    // Without knowing a connection's channel, a wildcard matches nothing.
    const unknown = fixture({}, { allowedDestinations: ["telegram:*"], connectionIds: twoConnections });
    await expect(sendTo(unknown.registry, { kind: "text", connectionId: "telegram-main", to: "chat-77", content: "no" })).rejects.toThrow(
      /not in the operator's allowlist/,
    );
    // `*:target` is a target in each channel's own form, and none on a channel it is no target of.
    const emailOrChat = (connectionId: string, to: string): string | undefined =>
      connectionId.startsWith("mailgun") ? (to.includes("@") ? to.toLowerCase() : undefined) : to;
    const channels = { providerOf, targetOf: emailOrChat };
    const mailed = fixture(
      {},
      { allowedDestinations: ["*:Ops@Example.com"], connectionIds: twoConnections, providerOf, targetOf: emailOrChat },
    );
    await sendTo(mailed.registry, { kind: "text", connectionId: "mailgun-main", to: "OPS@example.com", content: "hi" });
    expect(mailed.sent).toHaveLength(1);
    // What the agent is told each connection allows.
    const entries = ["telegram:*", "*:chat-9", "*:Ana@Example.com", "mailgun-main:ops@example.com", "chat-1"];
    expect(allowedTargetsOf("telegram-main", entries, twoConnections, channels)).toEqual(["*"]);
    expect(allowedTargetsOf("mailgun-main", entries, twoConnections, channels)).toEqual(["ana@example.com", "ops@example.com"]);
    expect(allowedTargetsOf("local-w1", entries, twoConnections, channels)).toEqual([]);
  });

  it("refuses a wildcard anywhere but `providerId:*` for an installed channel", () => {
    const flag = "--messaging-allow-destination";
    expect(assertDestinationEntries(["telegram:*", "*:chat-9"], ["telegram-main"], flag, ["telegram"])).toEqual(["telegram:*", "*:chat-9"]);
    expect(() => assertDestinationEntries(["telegram-main:*"], ["telegram-main"], flag, ["telegram"])).toThrow(/only as `providerId:\*`/);
    expect(() => assertDestinationEntries(["pager:*"], ["telegram-main"], flag, ["telegram"])).toThrow(/installed channel \(telegram\)/);
    expect(() => assertDestinationEntries(["*:*"], ["telegram-main"], flag, ["telegram"])).toThrow(/wildcard/);
  });

  it("matches a numeric allowlist entry against the numeric chatId the model supplies", async () => {
    const { registry, sent } = fixture({}, { allowedDestinations: ["8346819670"] });
    await sendTo(registry, { kind: "text", connectionId: "telegram-main", chatId: 8346819670, content: "hi" });
    expect(sent).toHaveLength(1);
  });

  it("does not apply the destination allowlist to messaging.send, whose destination comes from the inbound message", async () => {
    const { registry, sent } = fixture({}, { allowedDestinations: [] });
    await invoke(registry, { content: "a reply" }, messageDrivenContext);
    expect(sent).toHaveLength(1);
  });

  it("mints a fresh effectId per call, so two genuinely different sends both go out", async () => {
    const { registry, sent } = fixture();
    // The regression this guards: deriving the effectId from the call identity
    // (`msg-${runId}-${callId}`) made it the *primary key* of
    // `tavi_messaging_outbox`, whose insert is `ON CONFLICT DO NOTHING` with no
    // content check — so a provider that repeats a `toolCallId` within one run
    // (the repo's own local-endpoint stub reuses one for every call) had the
    // second, different message silently dropped while the model was handed the
    // first one's `accepted` outcome. The workflow's effect ledger already
    // prevents handler re-entry for a known call, so this id needs no
    // content-independence trade-off at all.
    await sendTo(registry, { kind: "text", connectionId: "telegram-main", chatId: "c", content: "first" });
    await sendTo(registry, { kind: "text", connectionId: "telegram-main", chatId: "c", content: "second" });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.effectId).not.toBe(sent[1]?.effectId);
    expect(sent.map((message) => (message.parts[0] as { content?: string }).content)).toEqual(["first", "second"]);
  });

  it("claims the invoking workspace on the message, so the service can refuse a foreign connection", async () => {
    const { registry, sent } = fixture();
    await sendTo(registry, { kind: "text", connectionId: "telegram-main", chatId: "c", content: "hi" });
    expect(sent[0]?.workspaceId).toBe(operatorContext.workspaceId);
  });

  it("throws CANCELLED when the signal is already aborted", async () => {
    const { registry, sent } = fixture();
    const controller = new AbortController();
    controller.abort();
    const tool = registry.get("messaging.send_to");
    if (tool === undefined) throw new Error("messaging.send_to not registered");
    await expect(
      tool.handler({
        input: { kind: "text", connectionId: "telegram-main", chatId: "c", content: "hi" },
        context: operatorContext,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/was cancelled/);
    expect(sent).toHaveLength(0);
  });
});

/**
 * The tool against a REAL `MessagingService` and a real SQLite outbox.
 *
 * The unit tests above drive a stub `MessagingServicePort` whose `send` is a
 * plain array push, so they cannot observe the outbox at all. Keying the
 * outbox on a content-blind `(runId, callId)` id would silently drop a second,
 * different message while reporting the first one's `accepted` outcome — a bug
 * only a test that goes through `tavi_messaging_outbox` can see.
 */
describe("messaging.channels", () => {
  it("lists the caller's workspace's reachable channels, and is not offered without a source for them", async () => {
    const channel = {
      connectionId: "telegram-main",
      label: "Telegram",
      channel: "Telegram",
      kind: "chat" as const,
      target: "Chat ID",
      buttons: true,
      files: true,
      maxTextLength: 4096,
      allowedTargets: ["*"],
    };
    const asked: string[] = [];
    const { registry } = fixture(
      {},
      {
        reachable: (workspaceId) => {
          asked.push(workspaceId);
          return [channel];
        },
      },
    );
    expect(registry.get("messaging.channels")?.effect).toBe("read-only");
    expect(await invoke(registry, {}, operatorContext, "messaging.channels")).toEqual({ channels: [channel] });
    expect(asked).toEqual(["w1"]);
    await expect(invoke(registry, { connectionId: "x" }, operatorContext, "messaging.channels")).rejects.toThrow(/takes no arguments/);
    expect(fixture().registry.get("messaging.channels")).toBeUndefined();
  });
});

describe("messaging.send_to through a real MessagingService and outbox", () => {
  const directories = temporaryDirectories();
  afterEach(() => directories.cleanup());

  async function composed(): Promise<{
    readonly registry: ToolRegistry;
    readonly sent: readonly OutboundMessage[];
    readonly close: () => void;
  }> {
    const directory = directories.create("tavi-messaging-tools-real-");
    const store = await SqliteStore.open({
      databasePath: join(directory, "tavi.sqlite"),
      artifactsDirectory: join(directory, "artifacts"),
    });
    let instance: FixtureMessagingConnectorInstance | undefined;
    const service = createMessagingService(store.asPort(), { now: () => "2026-01-01T00:00:00.000Z" });
    service.registerConnector(
      createFixtureMessagingConnectorDefinition({
        onInstanceCreated: (created) => {
          instance = created;
        },
      }),
    );
    await service.openConnection({
      connection: {
        connectionId: "telegram-main",
        providerId: "fixture",
        accountIdentity: "bot",
        workspaceId: "w1",
        configRevision: 1,
        enabled: true,
      },
      config: {},
    });
    const registry = new ToolRegistry();
    let ids = 0;
    registerMessagingTools(registry, service, (prefix) => `${prefix}-${(ids += 1)}`, {
      allowedDestinations: ["chat-9"],
    });
    return {
      registry,
      get sent() {
        return instance?.sent ?? [];
      },
      close: () => store.close(),
    };
  }

  it("delivers two distinct messages and reports two distinct receipts", async () => {
    const { registry, sent, close } = await composed();
    const first = (await invoke(
      registry,
      { kind: "text", connectionId: "telegram-main", chatId: "chat-9", content: "first" },
      operatorContext,
      "messaging.send_to",
    )) as SendOutcome;
    const second = (await invoke(
      registry,
      { kind: "text", connectionId: "telegram-main", chatId: "chat-9", content: "second" },
      operatorContext,
      "messaging.send_to",
    )) as SendOutcome;

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    // The connector genuinely saw both — not "the outbox returned the first
    // call's outcome because the two ids collided".
    expect(sent).toHaveLength(2);
    expect(sent.map((message) => (message.parts[0] as { content?: string }).content)).toEqual(["first", "second"]);
    expect(first.parts[0]?.providerMessageId).not.toBe(second.parts[0]?.providerMessageId);
    close();
  });

  it("refuses a send claiming another workspace, and delivers nothing", async () => {
    const { registry, sent, close } = await composed();
    // The connection belongs to `w1`; a task admitted elsewhere must not be
    // able to use it, whatever destination it names.
    await expect(
      invoke(
        registry,
        { kind: "text", connectionId: "telegram-main", chatId: "chat-9", content: "hi" },
        { ...operatorContext, workspaceId: "w2" },
        "messaging.send_to",
      ),
    ).rejects.toThrow(/belongs to workspace w1, not w2/);
    expect(sent).toHaveLength(0);
    close();
  });
});
