import { describe, expect, it } from "vitest";

import {
  ChannelDescriptorSchema,
  GroupCapabilitiesSchema,
  channelIdentity,
  type ChannelDescriptor,
  type GroupCapabilities,
  type InboundEvent,
  type MessagingConnection,
  type MessagingConnectorDefinition,
  type MessagingConnectorInstance,
  type OutboundMessage,
} from "@tavi/contracts";

/**
 * The conformance suite every messaging channel connector passes
 * — builtin or a plugin's.
 * It drives the connector against a fake provider in four moods and holds it
 * to what the host relies on: it describes itself validly, builds a
 * destination for a target, refuses a send it cannot make before calling
 * out, never leaves a send hanging or throws on a provider's odd answer,
 * keeps its secret out of everything it reports, and answers a part it cannot
 * carry with a rejected receipt rather than dropping it.
 *
 * Test-only: it imports vitest, so it is exported for tests and never built.
 */

/** How the fake provider behaves for a send (setup and probes always answer normally). */
export type ProviderMood = "ok" | "hang" | "echo" | "garbled";

export interface ChannelConformanceSubject {
  readonly descriptor: ChannelDescriptor;
  /** The fake provider in `mood`. */
  readonly provider: (mood: ProviderMood) => typeof fetch;
  /** The connector over `fetch`, with a request timeout of a few tens of milliseconds. */
  readonly create: (fetch: typeof globalThis.fetch) => MessagingConnectorDefinition;
  /** The users the secret is sent as in HTTP Basic, when it is (`api` for Mailgun): its base64 form must not leak either. */
  readonly basicUsers?: readonly string[];
  readonly connection: MessagingConnection;
  readonly config: unknown;
  /** The value every credential reference resolves to: the secret nothing may report. */
  readonly secret: string;
  /** A valid target on this channel. */
  readonly target: string;
}

export function describeChannelConformance(name: string, subject: ChannelConformanceSubject): void {
  /** A connection as the host makes one: its secrets, and an OAuth access token — each the secret nothing may report. */
  const connect = (definition: MessagingConnectorDefinition): MessagingConnectorInstance =>
    definition.createConnection({
      connection: subject.connection,
      config: subject.config,
      credentials: { get: async () => subject.secret, accessToken: async () => subject.secret },
    });
  /** The connector over the fake provider, counting what it asks the provider. */
  const connector = (mood: ProviderMood): { definition: MessagingConnectorDefinition; calls: () => number } => {
    let calls = 0;
    const provider = subject.provider(mood);
    const counted = ((...args: Parameters<typeof fetch>) => {
      calls += 1;
      return provider(...args);
    }) as typeof fetch;
    return { definition: subject.create(counted), calls: () => calls };
  };
  const open = async (mood: ProviderMood): Promise<{ definition: MessagingConnectorDefinition; instance: MessagingConnectorInstance }> => {
    const { definition } = connector(mood);
    const instance = connect(definition);
    await instance.start();
    return { definition, instance };
  };
  const message = (
    definition: MessagingConnectorDefinition,
    parts: OutboundMessage["parts"] = [{ content: "hello" }],
  ): OutboundMessage => ({
    effectId: "conformance-1",
    connectionId: subject.connection.connectionId,
    destination: definition.destinationFor?.({ to: subject.target }, subject.connection),
    parts,
  });

  describe(`${name} channel conformance`, () => {
    it("describes itself validly, as the provider its connector is, with a target its descriptor accepts", () => {
      expect(ChannelDescriptorSchema.safeParse(subject.descriptor).success).toBe(true);
      expect(connector("ok").definition.providerId).toBe(subject.descriptor.providerId);
      expect(channelIdentity(subject.target, subject.descriptor.target)).toBeDefined();
    });

    it("builds a destination for a target, and sends to it", async () => {
      const { definition, instance } = await open("ok");
      // The destination names the target, in whatever shape the connector keeps it.
      expect(JSON.stringify(definition.destinationFor?.({ to: subject.target }, subject.connection))).toContain(
        JSON.stringify(subject.target).slice(1, -1),
      );
      expect((await instance.send(message(definition))).status).toBe("accepted");
      await instance.stop();
    });

    it("refuses a send before it starts and after it stops, calling out to nobody", async () => {
      const { definition, calls } = connector("ok");
      const instance = connect(definition);
      await expect(instance.send(message(definition))).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(calls()).toBe(0);
      await instance.start();
      await instance.stop();
      const afterStop = calls();
      await expect(instance.send(message(definition))).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(calls()).toBe(afterStop);
    });

    it("answers a send the provider never answers as uncertain, after its timeout", async () => {
      const { definition, instance } = await open("hang");
      const outcome = await instance.send(message(definition));
      expect(outcome.status).toBe("uncertain");
      await instance.stop();
    });

    it("answers a garbled reply as uncertain, never as a throw", async () => {
      const { definition, instance } = await open("garbled");
      expect((await instance.send(message(definition))).status).toBe("uncertain");
      await instance.stop();
    });

    it("keeps its secret out of every outcome and error it reports", async () => {
      const { definition, instance } = await open("echo");
      const outcome = JSON.stringify(await instance.send(message(definition)).catch((error: unknown) => String(error)));
      expect(outcome).not.toContain(subject.secret);
      for (const user of subject.basicUsers ?? [])
        expect(outcome).not.toContain(Buffer.from(`${user}:${subject.secret}`).toString("base64"));
      expect(JSON.stringify(instance.status())).not.toContain(subject.secret);
      await instance.stop();
    });

    it("answers a file part it cannot carry — no attachments, or no such artifact — with a rejected receipt, never dropping it", async () => {
      const { definition, instance } = await open("ok");
      // A channel with attachments is given an artifact nothing can read.
      const outcome = await instance.send(message(definition, [{ kind: "file", artifactId: "no-such-artifact" }]));
      expect(outcome.status).toBe("rejected");
      expect(outcome.parts[0]?.status).toBe("rejected");
      await instance.stop();
    });
  });
}

/**
 * A platform event the group suite asks a fake to emit: a room message that
 * mentions the agent, replies to one of its
 * messages, is in a thread it started, is one of its commands, or picks
 * another message for it; a plain
 * room message; one written by a bot or by the platform; a button press; and a
 * one-to-one message.
 */
export type GroupScript =
  | { readonly kind: "mention" | "reply" | "thread" | "command" | "picked" | "plain" | "bot" | "system" }
  | { readonly kind: "press"; readonly presser: string; readonly data: string }
  | { readonly kind: "direct"; readonly sender: string };

/** One message the connector put on the platform, as the fake saw it. */
export interface GroupFakeSend {
  /** The conversation it landed in, by the id the connector's events name it with. */
  readonly conversation: string;
  /** Whether the room's members can see it: a private notice to a presser is not. */
  readonly visibleInRoom: boolean;
  readonly text: string;
  /** The platform would fetch and show a preview of a link in it. */
  readonly linkPreview: boolean;
  /** The platform would notify everyone in the room (an `@everyone`, a role ping). */
  readonly massMention: boolean;
}

/** A fake group platform with the connector made over it, not yet started. */
export interface GroupFake {
  readonly definition: MessagingConnectorDefinition;
  readonly instance: MessagingConnectorInstance;
  readonly connection: MessagingConnection;
  /** The room's conversation id. */
  readonly room: string;
  /** A sender the platform lets the agent write to one-to-one, and one it does not (DMs closed, never started the bot). */
  readonly openSender: string;
  readonly closedSender: string;
  /** What every credential resolves to: the secret nothing may report. */
  readonly secret: string;
  /** Emits one platform event; resolves once the connector handed over all it will of it (it may hand over nothing). */
  emit(script: GroupScript): Promise<void>;
  /** Everything the connector put on the platform, in order. */
  sent(): readonly GroupFakeSend[];
  /** With `groups.recentHistory`: the authors' kinds of the room's history before any step, oldest first (check 8). */
  readonly recentKinds?: readonly ("person" | "bot" | "system")[];
  /** With `groups.polls`: how many polls the platform holds, and a vote cast on one. */
  readonly polls?: { readonly count: () => number; readonly vote: (messageId: string, voter: string, answer: number) => void };
}

export interface GroupChannelConformanceSubject {
  readonly descriptor: ChannelDescriptor;
  /** A fresh fake, its connector created and not started. */
  readonly fake: () => Promise<GroupFake>;
}

/**
 * The group conformance suite: what the host's room policy, private
 * approvals and group tools rely on a group channel's connector for, through
 * a fake of its platform. Each check of a feature runs only where the
 * connector's `capabilities.groups` declares it.
 */
export function describeGroupChannelConformance(name: string, subject: GroupChannelConformanceSubject): void {
  /** A started fake, recording what its connector hands the host. */
  const running = async (): Promise<{ readonly fake: GroupFake; readonly events: InboundEvent[] }> => {
    const fake = await subject.fake();
    const events: InboundEvent[] = [];
    fake.instance.onInboundEvent?.(async (event) => {
      events.push(event);
    });
    await fake.instance.start();
    return { fake, events };
  };
  /** What one scripted event made the connector hand over. */
  const emitted = async (fake: GroupFake, events: InboundEvent[], script: GroupScript): Promise<readonly InboundEvent[]> => {
    const before = events.length;
    await fake.emit(script);
    return events.slice(before);
  };
  const groupsOf = (fake: GroupFake): GroupCapabilities => {
    const groups = fake.definition.capabilities.groups;
    if (groups === undefined) throw new Error(`${name} declares no group capabilities`);
    return groups;
  };
  const roomDestination = (fake: GroupFake): unknown =>
    fake.definition.destinationFromInbound?.({ externalConversationId: fake.room, externalSenderId: fake.openSender }, fake.connection);

  describe(`${name} group channel conformance (CHANNEL-PLUGINS.md, group chats)`, () => {
    it("declares group capabilities, and a group policy in its descriptor whose trigger it reports", async () => {
      const fake = await subject.fake();
      const groups = groupsOf(fake);
      expect(GroupCapabilitiesSchema.safeParse(groups).success).toBe(true);
      expect(ChannelDescriptorSchema.safeParse(subject.descriptor).success).toBe(true);
      const policy = subject.descriptor.groups;
      expect(policy).toBeDefined();
      for (const kind of policy?.defaultTrigger ?? []) expect(groups.addressing).toContain(kind);
      // Each method is there exactly when its capability says so.
      expect(fake.definition.directDestinationOf !== undefined).toBe(groups.directToSender);
      expect(fake.instance.listRooms !== undefined).toBe(groups.listRooms);
      expect(fake.instance.leaveRoom !== undefined).toBe(groups.leaveRoom);
      expect(fake.instance.fetchRecent !== undefined).toBe(groups.recentHistory !== undefined);
      expect(fake.instance.createPoll !== undefined && fake.instance.readPoll !== undefined && fake.instance.endPoll !== undefined).toBe(
        groups.polls !== undefined,
      );
      expect(fake.instance.createEvent !== undefined).toBe(groups.events !== undefined);
    });

    it("reports how a room message addressed the agent, for each kind it declares, and nothing for a plain one (check 1)", async () => {
      const { fake, events } = await running();
      for (const kind of groupsOf(fake).addressing) {
        const handed = await emitted(fake, events, { kind });
        expect(handed.length, `a scripted ${kind} is handed over`).toBeGreaterThan(0);
        expect(handed.at(-1)?.addressed ?? []).toContain(kind);
        // A thread's message is in the room's thread, a conversation of its own on some platforms.
        if (kind !== "thread") expect(handed.at(-1)?.externalConversationId).toBe(fake.room);
      }
      const plain = await emitted(fake, events, { kind: "plain" });
      for (const event of plain) expect(event.addressed ?? []).toEqual([]);
      await fake.instance.stop();
    });

    it("hands a bot's message over as a bot's, for the host to drop, and the platform's as the platform's if at all (check 2)", async () => {
      const { fake, events } = await running();
      // A bot's words are the host's to drop and count; a service message with nothing in it may stay with the connector.
      const bots = (await emitted(fake, events, { kind: "bot" })).filter((event) => event.kind === "message");
      expect(bots.length, "a bot's message is handed over").toBeGreaterThan(0);
      for (const event of bots) expect(event.authorKind).toBe("bot");
      for (const event of (await emitted(fake, events, { kind: "system" })).filter((event) => event.kind === "message"))
        expect(event.authorKind).toBe("system");
      await fake.instance.stop();
    });

    it("names a press's sender as the platform's presser, whatever its data claims (check 3)", async () => {
      const { fake, events } = await running();
      const handed = await emitted(fake, events, { kind: "press", presser: fake.openSender, data: `approve:as:${fake.closedSender}` });
      expect(handed).toHaveLength(1);
      expect(handed[0]).toMatchObject({ kind: "interaction", externalSenderId: fake.openSender });
      await fake.instance.stop();
    });

    it("reaches a sender one-to-one in the conversation their own messages come from, and says when it cannot (check 4)", async ({
      skip,
    }) => {
      const { fake, events } = await running();
      if (!groupsOf(fake).directToSender) {
        await fake.instance.stop();
        skip("it cannot reach a sender one-to-one");
      }
      const [direct] = await emitted(fake, events, { kind: "direct", sender: fake.openSender });
      expect(direct).toMatchObject({ conversationKind: "direct", externalSenderId: fake.openSender });
      const destination = fake.definition.directDestinationOf?.(fake.openSender, fake.connection);
      const outcome = await fake.instance.send({
        effectId: "conformance-direct",
        connectionId: fake.connection.connectionId,
        destination,
        parts: [{ content: "just you" }],
      });
      expect(outcome.status).toBe("accepted");
      // A `direct` event's conversation is the one `directDestinationOf` reaches: the host's proof of a sender's own chat.
      expect(fake.sent().at(-1)?.conversation).toBe(direct?.externalConversationId);
      const closed = await fake.instance.send({
        effectId: "conformance-closed",
        connectionId: fake.connection.connectionId,
        destination: fake.definition.directDestinationOf?.(fake.closedSender, fake.connection),
        parts: [{ content: "just you" }],
      });
      expect(closed.status).toBe("rejected");
      expect(closed.parts[0]?.unreachable).toBe(true);
      await fake.instance.stop();
    });

    it("answers a press so only the presser sees it (check 5)", async () => {
      const { fake, events } = await running();
      const handed = await emitted(fake, events, { kind: "press", presser: fake.openSender, data: "x" });
      expect(handed).toHaveLength(1);
      expect(fake.instance.answerInteraction).toBeDefined();
      const before = fake.sent().length;
      await fake.instance.answerInteraction?.(handed[0]?.interaction?.callbackId ?? "", "Only you can see this.");
      const answered = fake.sent().slice(before);
      // Something reached the presser, and nothing the room can see.
      expect(answered.length).toBeGreaterThan(0);
      expect(answered.filter((sent) => sent.visibleInRoom)).toEqual([]);
      await fake.instance.stop();
    });

    it("sends no link preview and no mass mention (check 6)", async () => {
      const { fake } = await running();
      const outcome = await fake.instance.send({
        effectId: "conformance-room",
        connectionId: fake.connection.connectionId,
        destination: roomDestination(fake),
        parts: [{ content: "@everyone see https://example.com/page" }],
      });
      expect(outcome.status).toBe("accepted");
      const sent = fake.sent().at(-1);
      expect(sent).toMatchObject({ conversation: fake.room, visibleInRoom: true, linkPreview: false, massMention: false });
      await fake.instance.stop();
    });

    it("creates one poll for one effect id, and reads its voters as sender ids (check 7)", async ({ skip }) => {
      const { fake } = await running();
      if (groupsOf(fake).polls === undefined) {
        await fake.instance.stop();
        skip("it declares no polls");
      }
      const input = {
        effectId: "conformance-poll",
        destination: roomDestination(fake),
        question: "Lunch?",
        answers: ["Pizza", "Salad"],
        hours: 1,
        multiSelect: false,
      };
      const first = await fake.instance.createPoll?.(input);
      const second = await fake.instance.createPoll?.(input);
      expect(first?.status).toBe("accepted");
      expect(second?.parts[0]?.providerMessageId).toBe(first?.parts[0]?.providerMessageId);
      expect(fake.polls?.count()).toBe(1);
      const messageId = first?.parts[0]?.providerMessageId ?? "";
      fake.polls?.vote(messageId, fake.openSender, 0);
      const state = await fake.instance.readPoll?.(roomDestination(fake), messageId);
      expect(state?.answers[0]).toMatchObject({ text: "Pizza", count: 1, voters: [fake.openSender] });
      await fake.instance.stop();
    });

    it("fetches at most the recent messages asked for, each with its author's kind (check 8)", async ({ skip }) => {
      const { fake } = await running();
      if (groupsOf(fake).recentHistory === undefined) {
        await fake.instance.stop();
        skip("it declares no recent history");
      }
      const recent = (await fake.instance.fetchRecent?.(roomDestination(fake), { limit: 2, signal: new AbortController().signal })) ?? [];
      expect(recent.length).toBeGreaterThan(0);
      expect(recent.length).toBeLessThanOrEqual(2);
      for (const message of recent) expect(["person", "bot", "system"]).toContain(message.authorKind);
      // Each author's kind as the platform says it, so the host drops a bot's and the platform's words: a fake states its history's.
      expect(fake.recentKinds, "the fake states its room history's author kinds").toBeDefined();
      const kinds = fake.recentKinds ?? [];
      const all =
        (await fake.instance.fetchRecent?.(roomDestination(fake), { limit: kinds.length, signal: new AbortController().signal })) ?? [];
      expect(all.map((message) => message.authorKind)).toEqual(kinds);
      await fake.instance.stop();
    });

    it("hands the host nothing while it starts (check 9)", async () => {
      const fake = await subject.fake();
      const handed: { readonly duringStart: boolean }[] = [];
      let starting = true;
      fake.instance.onInboundEvent?.(async () => {
        handed.push({ duringStart: starting });
      });
      const emitting = fake.emit({ kind: "mention" });
      await fake.instance.start();
      starting = false;
      await emitting;
      expect(handed.some((entry) => entry.duringStart)).toBe(false);
      await fake.instance.stop();
    });

    it("keeps its secret out of every event, outcome, status and error (check 10)", async () => {
      const { fake, events } = await running();
      const said: unknown[] = [fake.instance.status()];
      for (const kind of ["mention", "plain"] as const) await fake.emit({ kind });
      said.push(
        await fake.instance
          .send({
            effectId: "conformance-secret",
            connectionId: fake.connection.connectionId,
            destination: roomDestination(fake),
            parts: [{ content: "hi" }],
          })
          .catch((error: unknown) => String(error)),
      );
      said.push(
        await fake.instance
          .send({
            effectId: "conformance-bad",
            connectionId: fake.connection.connectionId,
            destination: { nonsense: true },
            parts: [{ content: "hi" }],
          })
          .catch((error: unknown) => String(error)),
      );
      said.push(fake.instance.status(), events);
      expect(JSON.stringify(said)).not.toContain(fake.secret);
      await fake.instance.stop();
    });
  });
}
