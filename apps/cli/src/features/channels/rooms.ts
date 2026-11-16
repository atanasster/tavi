import {
  TaviError,
  triggerInWords,
  type AddressKind,
  type ChannelRoomRecord,
  type ChannelsPayload,
  type ChannelsRoomsAnswer,
  type MessagingServicePort,
  type PersistencePort,
  type RoomTrigger,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import type { ChannelHost } from "@tavi/runtime";

import { channelDescriptorOf } from "./catalog.js";
import type { RoomInvitations } from "./group-pairing.js";

/**
 * The `channels` command's `rooms` action: the rooms an operator lists on a group channel's connection, each
 * with the trigger that addresses the agent there and who may speak to it.
 * Adding one sends the room its introduction, once. No tool reaches it.
 */

export interface ChannelRoomsDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "messagingIdentityBindings" | "channelRooms">;
  /** The connections the owner is configured to open, saved and flag-named alike. */
  readonly channels: Pick<ChannelHost, "configured">;
  readonly messaging: Pick<
    MessagingServicePort,
    "send" | "buildReplyDestination" | "capabilitiesOf" | "listRooms" | "leaveRoom" | "roomDrops" | "roomDetails" | "fetchRecent"
  >;
  /** Rooms the agent was added to, or that spoke while unlisted, waiting for the operator. */
  readonly roomInvitations?: Pick<RoomInvitations, "list" | "settle"> | undefined;
  /** The workspace's operator, whose agent the introduction says this is. */
  readonly operatorOf?: ((workspaceId: string) => string | undefined) | undefined;
  readonly now: () => string;
}

type RoomsPayload = Extract<ChannelsPayload, { readonly action: "rooms" }>;

/**
 * The introduction a room gets when it is added: whose agent this is,
 * what addresses it here, that it never learns from the room for its owner's
 * private use, that it never reads people it does not know, and how to be
 * left out.
 */
export function roomIntroduction(owner: string, room: Pick<ChannelRoomRecord, "trigger" | "members">): string {
  const who =
    room.members === "operator-only"
      ? `I answer only ${owner} here, when they ${triggerInWords(room.trigger)}`
      : `I answer people ${owner} has told me about when they ${triggerInWords(room.trigger)}`;
  return [
    `Hi, I'm Tavi, ${owner}'s assistant. ${who}.`,
    `I never learn from this room for ${owner}'s private use, and I never read messages from people Tavi doesn't know.`,
    `If you'd rather be left out, ask ${owner}.`,
  ].join("\n");
}

/** What a room is told once its context becomes `recent`: what more the agent reads there, and what it never does. */
export function roomContextIntroduction(owner: string, room: Pick<ChannelRoomRecord, "members">): string {
  const who =
    room.members === "operator-only" ? `when ${owner} addresses me here` : `when someone ${owner} has told me about addresses me here`;
  return [
    `From now on, ${who}, I also read up to 20 of this room's messages before theirs, for context.`,
    `Messages from people Tavi doesn't know are left out, and nothing I read here is kept for ${owner}'s private use.`,
  ].join("\n");
}

/** A room's `context`, refused on a channel that cannot read a room's recent messages. */
function checkedContext(
  deps: ChannelRoomsDependencies,
  connectionId: string,
  context: ChannelRoomRecord["context"],
  label: string,
): ChannelRoomRecord["context"] {
  if (context === "off") return context;
  needsOpen(deps, connectionId, "check whether its rooms can read their recent messages");
  if (deps.messaging.capabilitiesOf(connectionId)?.groups?.recentHistory === undefined)
    throw new TaviError("UNSUPPORTED", `${label} cannot read a room's recent messages`);
  return context;
}

/** The name the introduction gives its owner: what the operator is called on this connection, else "my owner". */
async function ownerName(deps: ChannelRoomsDependencies, workspaceId: string, connectionId: string): Promise<string> {
  const operator = deps.operatorOf?.(workspaceId);
  if (operator === undefined) return "my owner";
  const binding = (await deps.repositories.messagingIdentityBindings.list(workspaceId)).find(
    (candidate) => candidate.connectionId === connectionId && candidate.principalId === operator && candidate.displayName !== undefined,
  );
  return binding?.displayName ?? "my owner";
}

/** Refuses what needs the open connection's connector when it is not open (no owner runs it, or it failed). */
function needsOpen(deps: ChannelRoomsDependencies, connectionId: string, what: string): void {
  if (deps.messaging.capabilitiesOf(connectionId) === undefined)
    throw new TaviError("UNAVAILABLE", `Connection ${connectionId} is not open: start it to ${what}`);
}

/** A trigger the connector reports. */
function checkedTrigger(deps: ChannelRoomsDependencies, connectionId: string, trigger: readonly AddressKind[], label: string): RoomTrigger {
  needsOpen(deps, connectionId, "check what its rooms can be triggered by");
  const reported = deps.messaging.capabilitiesOf(connectionId)?.groups?.addressing ?? [];
  const unreported = trigger.filter((kind) => !reported.includes(kind));
  if (unreported.length > 0)
    throw new TaviError(
      "INVALID_INPUT",
      `${label} does not report ${unreported.join(", ")}; its rooms can be triggered by ${reported.join(", ") || "nothing"}`,
    );
  return [...new Set(trigger)] as RoomTrigger;
}

/**
 * A room's `autoThread`, refused on a channel that cannot open threads. On,
 * the room hears `thread` too, whatever its trigger said: a message in the
 * thread opened for a task needs no mention.
 */
function checkedAutoThread(
  deps: ChannelRoomsDependencies,
  connectionId: string,
  autoThread: boolean,
  label: string,
  trigger: RoomTrigger,
): { readonly autoThread?: true; readonly trigger: RoomTrigger } {
  if (!autoThread) return { trigger };
  needsOpen(deps, connectionId, "check whether its rooms can answer in threads");
  if (deps.messaging.capabilitiesOf(connectionId)?.groups?.autoThread !== true)
    throw new TaviError("UNSUPPORTED", `${label} cannot open a thread for each message`);
  return {
    autoThread: true,
    trigger: trigger.includes("thread") ? trigger : checkedTrigger(deps, connectionId, [...trigger, "thread"], label),
  };
}

export async function channelRooms(deps: ChannelRoomsDependencies, payload: RoomsPayload): Promise<ChannelsRoomsAnswer> {
  const { channelRooms: rooms } = deps.repositories;
  const configured = deps.channels.configured();
  const connection = configured.find((candidate) => candidate.connectionId === payload.connectionId);
  if (connection === undefined || connection.workspaceId !== payload.workspaceId)
    // Named, with where to look, as the other `channels` actions refuse it.
    throw new TaviError("NOT_FOUND", `No connection ${payload.connectionId} in workspace ${payload.workspaceId} (\`tavi channels list\`)`);
  const descriptor = channelDescriptorOf(connection.providerId);
  const groups = descriptor?.groups;
  if (descriptor === undefined || groups === undefined)
    throw new TaviError("UNSUPPORTED", `${descriptor?.label ?? connection.providerId} has no rooms`);
  const listing = async (notApplied?: string): Promise<ChannelsRoomsAnswer> => {
    const open = deps.messaging.capabilitiesOf(payload.connectionId);
    // The platform's list is a picker's help, not the record: one that cannot be read leaves it out.
    const candidates =
      open?.groups?.listRooms === true
        ? await deps.messaging.listRooms?.(payload.connectionId, payload.workspaceId).catch(() => undefined)
        : undefined;
    const listed = await rooms.listForConnection(payload.connectionId);
    // A refused send to a one-to-one chat, or to a room since removed, is no room's detail.
    const details = deps.messaging.roomDetails?.(payload.connectionId);
    const roomDetails =
      details === undefined
        ? undefined
        : Object.fromEntries(
            listed.flatMap((room) => {
              const detail = details[room.conversationId];
              return detail === undefined ? [] : [[room.conversationId, detail] as const];
            }),
          );
    return {
      rooms: listed,
      ...(candidates === undefined ? {} : { candidates }),
      waiting: (deps.roomInvitations?.list(payload.connectionId) ?? []).map(({ connectionId: _connectionId, ...waiting }) => waiting),
      drops: deps.messaging.roomDrops?.(payload.connectionId) ?? {},
      ...(roomDetails === undefined ? {} : { details: roomDetails }),
      ...(notApplied === undefined ? {} : { notApplied }),
    };
  };
  if (payload.op === "list") {
    // A room whose introduction was refused is introduced when its rooms are next listed with the connection open;
    // one whose send may have gone out (`uncertain`) never is again, as a resend would be blind.
    if (deps.messaging.capabilitiesOf(payload.connectionId) !== undefined) {
      for (const room of await rooms.listForConnection(payload.connectionId))
        if (room.introState === "pending" && room.disabledAt === undefined) await introduce(deps, room, true);
    }
    return listing();
  }
  const conversationId = payload.conversationId;
  if (conversationId === undefined) throw new TaviError("INVALID_INPUT", `rooms ${payload.op} names the room`);
  const existing = await rooms.get(payload.connectionId, conversationId);
  switch (payload.op) {
    case "add": {
      if (existing !== undefined) throw new TaviError("DUPLICATE", `${existing.label} is already a room of ${payload.connectionId}`);
      needsOpen(deps, payload.connectionId, "add a room");
      // One connection per platform room: two bots of the provider in one room would both answer it.
      for (const other of configured) {
        if (other.connectionId === payload.connectionId || other.providerId !== connection.providerId) continue;
        if ((await rooms.get(other.connectionId, conversationId)) !== undefined)
          throw new TaviError("CONFLICT", `That room is already a room of connection ${other.connectionId}`);
      }
      const at = deps.now();
      const room: ChannelRoomRecord = {
        connectionId: payload.connectionId,
        conversationId,
        workspaceId: payload.workspaceId,
        label: payload.label ?? `Room ${conversationId}`.slice(0, 120),
        members: payload.members ?? "bound",
        ...checkedAutoThread(
          deps,
          payload.connectionId,
          payload.autoThread === true,
          descriptor.label,
          checkedTrigger(deps, payload.connectionId, payload.trigger ?? groups.defaultTrigger, descriptor.label),
        ),
        context: "off",
        introState: "pending",
        createdAt: at,
        updatedAt: at,
      };
      await rooms.upsert(room);
      deps.roomInvitations?.settle(payload.connectionId, conversationId);
      return listing(await introduce(deps, room));
    }
    case "set": {
      if (existing === undefined) throw new TaviError("NOT_FOUND", `${conversationId} is not a room of ${payload.connectionId}`);
      // Turned off, it is left out: the record keeps no `autoThread: false`.
      const { autoThread: _wasAutoThread, ...kept } = existing;
      const trigger =
        payload.trigger === undefined ? existing.trigger : checkedTrigger(deps, payload.connectionId, payload.trigger, descriptor.label);
      const autoThread = payload.autoThread ?? existing.autoThread === true;
      // Checked again only when either changed: a room kept as it was needs no open connection.
      const threading =
        payload.autoThread === undefined && payload.trigger === undefined
          ? { trigger, ...(autoThread ? { autoThread: true as const } : {}) }
          : checkedAutoThread(deps, payload.connectionId, autoThread, descriptor.label, trigger);
      const context =
        payload.context === undefined ? existing.context : checkedContext(deps, payload.connectionId, payload.context, descriptor.label);
      const updated: ChannelRoomRecord = {
        ...kept,
        ...(payload.label === undefined ? {} : { label: payload.label }),
        ...threading,
        ...(payload.members === undefined ? {} : { members: payload.members }),
        context,
        updatedAt: deps.now(),
      };
      // The room is told before any turn of it reads more: told first, and reading only once it was.
      const untold = existing.context !== "recent" && context === "recent" ? await introduceContext(deps, updated) : undefined;
      await rooms.upsert(untold === undefined ? updated : { ...updated, context: existing.context });
      return listing(untold === undefined ? undefined : `its context stays off: ${untold}`);
    }
    case "remove":
      if (!(await rooms.remove(payload.connectionId, conversationId)))
        throw new TaviError("NOT_FOUND", `${conversationId} is not a room of ${payload.connectionId}`);
      return listing();
    case "leave": {
      needsOpen(deps, payload.connectionId, "leave a room");
      if (deps.messaging.capabilitiesOf(payload.connectionId)?.groups?.leaveRoom !== true || deps.messaging.leaveRoom === undefined)
        throw new TaviError("UNSUPPORTED", `${descriptor.label} cannot leave a room from Tavi: remove the bot in the room itself`);
      const destination = deps.messaging.buildReplyDestination(payload.connectionId, {
        externalConversationId: conversationId,
        externalSenderId: conversationId,
      });
      if (destination === undefined) throw new TaviError("UNAVAILABLE", `Connection ${payload.connectionId} is not open`);
      await deps.messaging.leaveRoom(payload.connectionId, payload.workspaceId, destination);
      await rooms.remove(payload.connectionId, conversationId);
      deps.roomInvitations?.settle(payload.connectionId, conversationId);
      return listing();
    }
  }
}

/** Tells a room its context became `recent`, once for each time it does; answers why not, when it could not. */
async function introduceContext(deps: ChannelRoomsDependencies, room: ChannelRoomRecord): Promise<string | undefined> {
  const destination = deps.messaging.buildReplyDestination(room.connectionId, {
    externalConversationId: room.conversationId,
    externalSenderId: room.conversationId,
  });
  if (destination === undefined) return "the room cannot be written to from this connection, so it was not told";
  // Read once first: a room is told only what Tavi can do there, and the intent or a permission may be missing.
  const unread =
    deps.messaging.fetchRecent === undefined
      ? "this connection cannot read the room's messages"
      : await deps.messaging
          .fetchRecent(room.connectionId, room.workspaceId, destination, { limit: 1, signal: AbortSignal.timeout(10_000) })
          .then(
            () => undefined,
            (error: unknown) => `its messages cannot be read: ${errorMessage(error)}`,
          );
  if (unread !== undefined) return unread;
  const outcome = await deps.messaging
    .send({
      effectId: `room-context:${room.connectionId}:${room.conversationId}:${room.updatedAt}`,
      connectionId: room.connectionId,
      workspaceId: room.workspaceId,
      destination,
      parts: [{ content: roomContextIntroduction(await ownerName(deps, room.workspaceId, room.connectionId), room) }],
    })
    .catch((error: unknown) => ({ status: "rejected" as const, parts: [{ error: errorMessage(error) }] }));
  if (outcome.status === "accepted") return undefined;
  const detail = outcome.parts.find((part) => part.error !== undefined)?.error;
  return outcome.status === "uncertain"
    ? "the room may not have been told it now reads its recent messages"
    : `the room was not told it now reads its recent messages${detail === undefined ? "" : `: ${detail}`}`;
}

/** The rooms whose introduction is being sent now, in this owner: a second listing never sends one twice. */
const introducing = new Set<string>();

/**
 * Sends a new room its introduction once (`room-intro:<conn>:<conversation>:<added at>`);
 * answers why it did not go out, if it did not. The time it was added is in
 * the id, so a room removed and added again is introduced again: the outbox
 * answers a repeated id from what it stored. A `retry` of a refused one adds
 * the time it was last refused (the room's `updatedAt`): a new send, since the
 * outbox answers the refused id with its refusal.
 *
 * Only a definite refusal leaves the room `pending`, to be tried again. The
 * room is `uncertain` from before the send until its answer, so a crash
 * mid-send, or an error that does not say nothing went out, leaves it
 * `uncertain`, never resent blind.
 */
async function introduce(deps: ChannelRoomsDependencies, room: ChannelRoomRecord, retry = false): Promise<string | undefined> {
  const destination = deps.messaging.buildReplyDestination(room.connectionId, {
    externalConversationId: room.conversationId,
    externalSenderId: room.conversationId,
  });
  if (destination === undefined) return "the room cannot be written to from this connection";
  const key = `${room.connectionId}\u0000${room.conversationId}`;
  if (introducing.has(key)) return "the introduction is being sent";
  introducing.add(key);
  try {
    await deps.repositories.channelRooms.setIntroState(room.connectionId, room.conversationId, "uncertain", deps.now());
    const outcome = await deps.messaging
      .send({
        effectId: `room-intro:${room.connectionId}:${room.conversationId}:${room.createdAt}${retry ? `:retry:${room.updatedAt}` : ""}`,
        connectionId: room.connectionId,
        workspaceId: room.workspaceId,
        destination,
        parts: [{ content: roomIntroduction(await ownerName(deps, room.workspaceId, room.connectionId), room) }],
      })
      .catch((error: unknown) => {
        // Refused before dispatch (the connection not open, the message invalid): nothing went out. Anything else may have.
        const refused = error instanceof TaviError && (error.code === "UNAVAILABLE" || error.code === "INVALID_INPUT");
        return { status: refused ? ("rejected" as const) : ("uncertain" as const), parts: [{ error: errorMessage(error) }] };
      });
    const state = outcome.status === "accepted" ? "sent" : outcome.status === "uncertain" ? "uncertain" : "pending";
    await deps.repositories.channelRooms.setIntroState(room.connectionId, room.conversationId, state, deps.now());
    if (state === "sent") return undefined;
    const detail = outcome.parts.find((part) => part.error !== undefined)?.error;
    return state === "uncertain"
      ? "the introduction may not have reached the room"
      : `the introduction was not sent${detail === undefined ? "" : `: ${detail}`}`;
  } finally {
    introducing.delete(key);
  }
}
