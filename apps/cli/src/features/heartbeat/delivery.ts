import { navPath, renderTextRef } from "@tavi/contracts";
import type { MessagingConnectionRecord, MessagingOutboxRepositoryPort, MessagingServicePort, OutboundButton } from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import type { HeartbeatDeliveryPort } from "@tavi/agent-host/heartbeat-delivery";

import { channelWords, type WorkspaceLocaleOf } from "../channels/channel-words.js";
import type { ChatNotices } from "../tasks/notices.js";

/**
 * Where a heartbeat's words go in this owner:
 * Home notices through the chat notices, and channel messages through the
 * messaging service — the same outbox, pacer and grants as any send. A target
 * whose connection is deleted, not open (its provider missing) or waiting to
 * be signed in again is skipped and logged, never queued.
 */
export interface HeartbeatDeliveryDependencies {
  readonly notices: Pick<ChatNotices, "postHeartbeat">;
  readonly messaging: Pick<MessagingServicePort, "send" | "buildDestination" | "capabilitiesOf" | "editMessage">;
  readonly connections: { get(connectionId: string): Promise<MessagingConnectionRecord | undefined> };
  readonly outbox: Pick<MessagingOutboxRepositoryPort, "get">;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
  /** The workspace's language, which its channel messages and buttons speak; absent, English. */
  readonly localeOf?: WorkspaceLocaleOf;
}

/** Where an item is opened, for a channel without buttons, in `t`'s words; the owner knows no address for the canvas. */
export function heartbeatOpenHint(t: CoreT = coreEnglish): string {
  return t("channel.heartbeat.openHint", { path: renderTextRef(navPath("nav.route.center", "nav.center.heartbeat"), t) ?? "" });
}

/** Where an item is opened, in English. */
export const HEARTBEAT_OPEN_HINT = heartbeatOpenHint();

/**
 * An item's buttons: at most three, labels at most 20 characters, data
 * `h:<token>:<o|s|m>` — Open, Snooze 1 h, Don't tell me — 20 bytes, well
 * within a channel's 64.
 */
export function heartbeatButtons(token: string, t: CoreT = coreEnglish): readonly (readonly OutboundButton[])[] {
  return [
    [
      { label: t("channel.heartbeat.button.open"), data: `h:${token}:o` },
      { label: t("channel.heartbeat.button.snooze"), data: `h:${token}:s` },
      { label: t("channel.heartbeat.button.mute"), data: `h:${token}:m` },
    ],
  ];
}

export function createHeartbeatDelivery(deps: HeartbeatDeliveryDependencies): HeartbeatDeliveryPort {
  /** Why a target cannot be sent to now, or undefined when it can. */
  const unreachable = async (workspaceId: string, connectionId: string): Promise<string | undefined> => {
    const connection = await deps.connections.get(connectionId);
    if (connection === undefined || connection.deletedAt !== undefined) return "its connection was removed";
    if (connection.workspaceId !== workspaceId) return "its connection belongs to another workspace";
    if (connection.authState === "expired" || connection.authState === "needs-consent") return "its connection needs signing in again";
    if (deps.messaging.capabilitiesOf(connectionId) === undefined) return "its connection is not open (its channel may be missing)";
    return undefined;
  };

  return {
    words: async (state) => await channelWords(deps.localeOf, state.workspaceId, deps.log),

    notify: async (state, notice) =>
      await deps.notices.postHeartbeat({ workspaceId: state.workspaceId, principalId: state.principalId, ...notice }),

    async send(state, target, message) {
      const interactive = deps.messaging.capabilitiesOf(target.connectionId)?.interactions === true;
      const why = await unreachable(state.workspaceId, target.connectionId);
      const destination =
        why === undefined ? deps.messaging.buildDestination(target.connectionId, { to: target.to, subject: message.subject }) : undefined;
      if (destination === undefined) {
        deps.log("a heartbeat target was skipped", {
          workspaceId: state.workspaceId,
          connectionId: target.connectionId,
          reason: why ?? "its channel cannot be sent to except as a reply",
        });
        return "skipped";
      }
      const t = await channelWords(deps.localeOf, state.workspaceId, deps.log);
      const outcome = await deps.messaging.send({
        effectId: message.effectId,
        connectionId: target.connectionId,
        workspaceId: state.workspaceId,
        destination,
        subject: message.subject,
        // An item's message: three buttons where the channel has them, else a line saying where to open it.
        parts: [
          { content: message.buttonToken === undefined || interactive ? message.text : `${message.text}\n\n${heartbeatOpenHint(t)}` },
        ],
        ...(message.buttonToken !== undefined && interactive ? { buttons: heartbeatButtons(message.buttonToken, t) } : {}),
      });
      return outcome.status;
    },

    async edit(_state, target, message) {
      if (deps.messaging.capabilitiesOf(target.connectionId)?.editOrProgress !== true) return false;
      const sent = await deps.outbox.get(message.effectId);
      const messageId = sent?.outcome?.status === "accepted" ? sent.outcome.parts[0]?.providerMessageId : undefined;
      const destination = deps.messaging.buildDestination(target.connectionId, { to: target.to });
      if (messageId === undefined || destination === undefined) return false;
      return await deps.messaging.editMessage(target.connectionId, { destination, messageId, text: message.text });
    },
  };
}
