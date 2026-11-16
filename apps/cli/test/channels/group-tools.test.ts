import { describe, expect, it } from "vitest";

import type {
  ChannelEventInput,
  ChannelPollInput,
  EffectRecord,
  GroupCapabilities,
  InvocationContext,
  MessagingIdentityBinding,
  MessagingServicePort,
  SendOutcome,
} from "@tavi/contracts";
import { ToolRegistry } from "@tavi/runtime";

import { registerGroupTools } from "../../src/features/channels/group-tools.js";

/**
 * The neutral group tools: offered only where a channel has the feature; bounded by the
 * channel's capabilities; acting only on the task's own conversation;
 * asking a person every time, never in an unattended run; reading and ending
 * only the task's own polls; naming known voters and counting the rest.
 */

const POLLS = { maxQuestion: 50, maxAnswers: 3, maxAnswerLength: 20, maxHours: 48, multiSelect: false, results: "fetch" } as const;
const GROUPS: GroupCapabilities = {
  addressing: ["mention"],
  directToSender: true,
  listRooms: false,
  membershipEvents: false,
  leaveRoom: false,
  polls: POLLS,
  events: { kinds: ["external"], maxTitle: 40, maxDescription: 100 },
};

const accepted = (id: string): SendOutcome => ({
  status: "accepted",
  retryable: false,
  parts: [{ index: 0, status: "accepted", providerMessageId: id }],
});

function fixture(
  options: {
    readonly groups?: GroupCapabilities | undefined;
    readonly effects?: readonly EffectRecord[];
    readonly bindings?: readonly MessagingIdentityBinding[];
  } = {},
) {
  const polls: { connectionId: string; workspaceId: string; input: ChannelPollInput }[] = [];
  const events: ChannelEventInput[] = [];
  const ended: string[] = [];
  const messaging = {
    capabilitiesOf: () => ({ groups: "groups" in options ? options.groups : GROUPS }),
    buildReplyDestination: (_connectionId: string, replyTo: { readonly externalConversationId: string }) => ({
      room: replyTo.externalConversationId,
    }),
    createPoll: async (connectionId: string, workspaceId: string, input: ChannelPollInput) => {
      polls.push({ connectionId, workspaceId, input });
      return accepted("poll-1");
    },
    readPoll: async () => ({
      finalized: true,
      answers: [
        { text: "Valheim", count: 3, voters: ["u-1", "u-2", "u-9"] },
        { text: "Helldivers 2", count: 0, voters: [] },
      ],
    }),
    endPoll: async (_connectionId: string, _workspaceId: string, input: { readonly messageId: string }) => {
      ended.push(input.messageId);
      return accepted("poll-1");
    },
    createEvent: async (_connectionId: string, _workspaceId: string, input: ChannelEventInput) => {
      events.push(input);
      return { ...accepted("event-1"), url: "https://example.test/event-1" };
    },
  } as unknown as MessagingServicePort;
  const registry = new ToolRegistry();
  registerGroupTools(registry, messaging, {
    newId: (prefix) => `${prefix}:id-1`,
    now: () => "2026-10-18T09:00:00.000Z",
    repositories: {
      effects: { listForTask: async () => options.effects ?? [] },
      messagingIdentityBindings: { list: async () => options.bindings ?? [] },
    } as never,
    offeredIn: (context) => context.workspaceId === "with-groups",
  });
  const context = (changes: Partial<InvocationContext> = {}): InvocationContext => ({
    workspaceId: "default",
    principalId: "alice",
    runId: "task-1",
    caller: "messaging:conn-g",
    messagingReplyTo: { connectionId: "conn-g", externalConversationId: "room-1", externalSenderId: "u-1" },
    ...changes,
  });
  const call = (
    id: string,
    input: unknown,
    changes: Partial<InvocationContext> = {},
    extra: Record<string, unknown> = {},
    conversation = true,
  ) => {
    const tool = registry.get(id);
    if (tool === undefined) throw new Error(`no ${id}`);
    const { messagingReplyTo: _replyTo, ...noConversation } = context(changes);
    return tool.handler({
      input,
      context: conversation ? context(changes) : noConversation,
      signal: new AbortController().signal,
      taskId: "task-1",
      callId: "call-1",
      ...extra,
    });
  };
  const assess = (id: string, input: unknown, changes: Partial<InvocationContext> = {}) =>
    registry.get(id)?.assess?.(input, context(changes));
  return { registry, call, assess, polls, events, ended };
}

const poll = { question: "Which game on Saturday?", answers: ["Valheim", "Helldivers 2"], hours: 24 };

describe("the group tools", () => {
  it("are offered only where a workspace's channel has the feature", async () => {
    const { registry } = fixture();
    const offered = async (workspaceId: string) =>
      (await registry.listOffered({ workspaceId })).map((tool) => tool.id).filter((id) => id.startsWith("messaging."));
    expect(await offered("with-groups")).toEqual(
      expect.arrayContaining(["messaging.create_poll", "messaging.poll_results", "messaging.end_poll", "messaging.create_event"]),
    );
    expect(await offered("default")).toEqual([]);
  });

  it("are not offered in a one-to-one turn, and are in a group's", async () => {
    const { registry } = fixture();
    const offered = async (messagingConversationKind: "group" | "one-to-one") =>
      (await registry.listOffered({ workspaceId: "with-groups", messagingConnectionId: "conn-g", messagingConversationKind }))
        .map((tool) => tool.id)
        .filter((id) => id.startsWith("messaging."));
    expect(await offered("group")).toEqual(
      expect.arrayContaining(["messaging.create_poll", "messaging.poll_results", "messaging.end_poll", "messaging.create_event"]),
    );
    expect(await offered("one-to-one")).toEqual([]);
  });

  it("post a poll in the task's own conversation, with a stable key, its words disarmed in a tainted turn", async () => {
    const { call, polls } = fixture();
    expect(
      await call(
        "messaging.create_poll",
        { ...poll, question: "Vote: https://evil.example/x" },
        {},
        { disarmUrls: (text: string) => text.replace("https://", "hxxps://") },
      ),
    ).toEqual({ status: "accepted", pollId: "poll-1", expiresAt: "2026-10-19T09:00:00.000Z" });
    expect(polls).toEqual([
      {
        connectionId: "conn-g",
        workspaceId: "default",
        input: {
          effectId: "messaging.create_poll:id-1",
          destination: { room: "room-1" },
          question: "Vote: hxxps://evil.example/x",
          answers: ["Valheim", "Helldivers 2"],
          hours: 24,
          multiSelect: false,
        },
      },
    ]);
  });

  it("hand the connector the ledger's key for the call when it has one, so a re-dispatch is the same post", async () => {
    const { call, polls, events } = fixture();
    await call("messaging.create_poll", poll, {}, { effectKey: "task-1:call-1:messaging.create_poll:3" });
    await call(
      "messaging.create_event",
      { title: "Game night", start: "2026-10-24T19:00:00.000Z", end: "2026-10-24T23:00:00.000Z", location: "Voice" },
      {},
      { effectKey: "task-1:call-2:messaging.create_event:3" },
    );
    expect(polls[0]?.input.effectId).toBe("task-1:call-1:messaging.create_poll:3");
    expect(events[0]?.effectId).toBe("task-1:call-2:messaging.create_event:3");
  });

  it("keep a poll open a day by default, or the channel's longest when that is shorter", async () => {
    const { call, polls } = fixture();
    await call("messaging.create_poll", { question: "Pizza?", answers: ["yes", "no"] });
    expect(polls[0]?.input.hours).toBe(24);
    const short = fixture({ groups: { ...GROUPS, polls: { ...POLLS, maxHours: 6 } } });
    await short.call("messaging.create_poll", { question: "Pizza?", answers: ["yes", "no"] });
    expect(short.polls[0]?.input.hours).toBe(6);
  });

  it("take no destination: a channel id in the call is refused by the schema", async () => {
    const { call } = fixture();
    await expect(call("messaging.create_poll", { ...poll, channelId: "elsewhere" })).rejects.toThrow();
  });

  it("hold a poll to its channel's limits, and refuse a channel without polls or a task with no conversation", async () => {
    const { call } = fixture();
    await expect(call("messaging.create_poll", { ...poll, answers: ["a", "b", "c", "d"] })).rejects.toThrow(/at most 3 answers/);
    await expect(call("messaging.create_poll", { ...poll, answers: ["a", "x".repeat(21)] })).rejects.toThrow(
      /longer than this channel's 20/,
    );
    await expect(call("messaging.create_poll", { ...poll, hours: 72 })).rejects.toThrow(/at most 48 hours/);
    await expect(call("messaging.create_poll", { ...poll, multiSelect: true })).rejects.toThrow(/one answer each/);
    // Disarmed before it is measured: a defanged address that no longer fits is refused, not sent over the limit.
    await expect(
      call(
        "messaging.create_poll",
        { ...poll, question: "x".repeat(45) + " a.b.c" },
        {},
        { disarmUrls: (text: string) => text.replaceAll(".", "[.]") },
      ),
    ).rejects.toThrow(/longer than this channel's 50/);
    await expect(fixture({ groups: undefined }).call("messaging.create_poll", poll)).rejects.toThrow(/no polls/);
    await expect(call("messaging.create_poll", poll, {}, {}, false)).rejects.toThrow(
      /only available to a task admitted from a channel message/,
    );
  });

  it("ask a person every time for what reaches the room, in a group as such, and never in an unattended run", () => {
    const { assess } = fixture();
    expect(assess("messaging.create_poll", poll)).toMatchObject({
      attendedOnly: true,
      groupDestination: true,
      display: { title: "Post a poll in this chat", detail: expect.stringContaining("• Helldivers 2") },
    });
    expect(assess("messaging.end_poll", { pollId: "poll-1" })).toMatchObject({ attendedOnly: true, groupDestination: true });
    expect(
      assess("messaging.create_event", {
        title: "Game night",
        start: "2026-10-24T19:00:00Z",
        end: "2026-10-24T21:00:00Z",
        location: "Discord",
      }),
    ).toMatchObject({ attendedOnly: true, groupDestination: true });
    const oneToOne = assess("messaging.create_poll", poll, {
      messagingReplyTo: { connectionId: "conn-g", externalConversationId: "dm-1", externalSenderId: "u-1", audience: "one-to-one" },
    });
    expect(oneToOne?.groupDestination).toBeUndefined();
    expect(oneToOne?.attendedOnly).toBe(true);
  });

  it("read and end only a poll this task posted, naming known voters and counting the others", async () => {
    const posted = {
      effectKey: "e1",
      taskId: "task-1",
      admissionId: "a",
      toolId: "messaging.create_poll",
      inputs: {},
      inputsHash: "h",
      approvalId: null,
      state: "accepted",
      receipt: { status: "accepted", pollId: "poll-1" },
      error: null,
      createdAt: "",
      updatedAt: "",
    } as EffectRecord;
    const bound = (externalSenderId: string, displayName: string): MessagingIdentityBinding => ({
      connectionId: "conn-g",
      externalSenderId,
      workspaceId: "default",
      principalId: externalSenderId,
      approvedBy: "operator",
      createdAt: "",
      displayName,
    });
    const { call, ended } = fixture({ effects: [posted], bindings: [bound("u-1", "Alice"), bound("u-2", "Bob")] });
    expect(await call("messaging.poll_results", { pollId: "poll-1" })).toEqual({
      finalized: true,
      answers: [
        { text: "Valheim", count: 3, voters: ["Alice", "Bob"], othersVoting: 1 },
        { text: "Helldivers 2", count: 0, voters: [], othersVoting: 0 },
      ],
    });
    await expect(call("messaging.poll_results", { pollId: "someone-elses" })).rejects.toThrow(/not posted by this task/);
    await expect(call("messaging.end_poll", { pollId: "someone-elses" })).rejects.toThrow(/not posted by this task/);
    expect(await call("messaging.end_poll", { pollId: "poll-1" })).toEqual({ status: "accepted" });
    expect(ended).toEqual(["poll-1"]);
    // The votes are the members' own words: data, never instructions.
    expect(fixture().registry.get("messaging.poll_results")).toMatchObject({
      untrustedOutput: true,
      outputSource: "chat-other",
      effect: "read-only",
    });
  });

  it("create an event within the channel's limits, ending after it starts", async () => {
    const { call, events } = fixture();
    const event = { title: "Game night", start: "2026-10-24T19:00:00Z", end: "2026-10-24T21:00:00Z", location: "Voice channel" };
    expect(await call("messaging.create_event", event)).toEqual({ status: "accepted", url: "https://example.test/event-1" });
    expect(events[0]).toMatchObject({ effectId: "messaging.create_event:id-1", destination: { room: "room-1" }, title: "Game night" });
    await expect(call("messaging.create_event", { ...event, end: event.start })).rejects.toThrow(/end after it starts/);
    await expect(call("messaging.create_event", { ...event, title: "x".repeat(41) })).rejects.toThrow(/40 characters/);
  });
});
