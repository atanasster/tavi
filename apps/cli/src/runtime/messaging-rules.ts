import {
  type ToolRule,
  grantInForce,
  type GrantScopeKind,
  type MessagingGrantRecord,
  type ChannelDescriptor,
  type InvocationContext,
  isLocalConnectionId,
} from "@tavi/contracts";
import { coreEnglish } from "@tavi/contracts/locales/core";

/**
 * What a task started from a chat is held back from, unless the owner allows
 * the tool with `serve --messaging-allow-tool` — in their own
 * one-to-one chats only (`inOperatorDirectChat`): a shell, file writes,
 * and `http.request` with a credential. A person typing in a chat is not
 * reading the shell's output, and a message is easier to forge than a terminal.
 */
export function messagingProfileRules(allowed: readonly string[], liftedInOwnChats: readonly string[] = []): readonly ToolRule[] {
  const held = [
    { toolPattern: "sandbox.run" },
    { toolPattern: "fs.write" },
    { toolPattern: "fs.edit" },
    { toolPattern: "http.request", argMatcher: "credential:*" },
    // It runs a plugin's register in a sandbox: code execution, held back as the shell is.
    { toolPattern: "plugins.validate" },
  ];
  return held
    .filter((entry) => !allowed.includes(entry.toolPattern))
    .map((entry) => ({
      ruleId: `profile-messaging-${entry.toolPattern}`,
      workspaceId: "*",
      ...entry,
      decision: "deny" as const,
      source: "shipped" as const,
      createdBy: "tavi",
      createdVia: "config" as const,
      createdAt: "2026-09-27T00:00:00.000Z",
      origin: "messaging" as const,
      note: liftedInOwnChats.includes(entry.toolPattern)
        ? coreEnglish("permissions.note.messagingLifted")
        : coreEnglish("permissions.note.messagingAllow"),
    }));
}

/**
 * A chat turn's rules with its chat's grants in force: in a
 * one-to-one chat its contact's, in a room (or a thread of it) the room's. A
 * grant's `deny` holds whatever else allows. A contact's `allow` lifts that
 * tool from the messaging profile in their own chat alone, as
 * `--messaging-allow-tool` does in the operator's: the tool is then asked
 * about as anywhere else, never let through unasked. Only a chat channel's
 * one-to-one chat is lifted: an email thread is one-to-one too, yet no chat,
 * so there a contact's deny holds and its allow does not. A room is
 * never allowed anything (refused at save), and another workspace's grant is
 * not this turn's.
 */
export async function messagingGrantRules(
  profile: readonly ToolRule[],
  invocation: Pick<InvocationContext, "workspaceId" | "messagingReplyTo"> | undefined,
  grantsOf: (connectionId: string, scopeKind: GrantScopeKind, scopeId: string) => Promise<readonly MessagingGrantRecord[]>,
  at: string,
  options: { readonly channelKindOf: (connectionId: string) => ChannelDescriptor["kind"] | undefined; readonly delegated?: boolean },
): Promise<readonly ToolRule[]> {
  const replyTo = invocation?.messagingReplyTo;
  if (invocation === undefined || replyTo === undefined || isLocalConnectionId(replyTo.connectionId)) return profile;
  const contact = replyTo.audience === "one-to-one";
  const lifts = contact && options.channelKindOf(replyTo.connectionId) === "chat";
  // A delegated worker (`delegated`): its chat's room's and its person's denies, whichever the chat was; no allow.
  const scoped =
    options.delegated === true
      ? [
          ...(await grantsOf(replyTo.connectionId, "room", replyTo.externalConversationId)),
          ...(await grantsOf(replyTo.connectionId, "contact", replyTo.externalSenderId)),
        ]
      : await grantsOf(
          replyTo.connectionId,
          contact ? "contact" : "room",
          contact ? replyTo.externalSenderId : replyTo.externalConversationId,
        );
  const grants = scoped.filter(
    (grant) =>
      grant.workspaceId === invocation.workspaceId &&
      grantInForce(grant, at) &&
      (grant.mode === "deny" || (options.delegated !== true && lifts && grant.scopeKind === "contact")),
  );
  if (grants.length === 0) return profile;
  const lifted = new Set(grants.filter((grant) => grant.mode === "allow").map((grant) => grant.toolId));
  return [
    ...profile.filter((rule) => !lifted.has(rule.toolPattern)),
    ...grants
      .filter((grant) => grant.mode === "deny")
      .map(
        (grant): ToolRule => ({
          ruleId: `messaging-grant-${grant.grantId}`.slice(0, 128),
          workspaceId: grant.workspaceId,
          toolPattern: grant.toolId,
          decision: "deny",
          source: "operator",
          createdBy: grant.createdBy,
          createdVia: "channel",
          createdAt: grant.createdAt,
          origin: "messaging",
          note: `denied by a ${grant.scopeKind} grant on ${grant.connectionId}`,
        }),
      ),
  ];
}
