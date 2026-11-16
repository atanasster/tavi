import { z } from "zod";

import {
  TaviError,
  refusedEarly,
  normalisedDelivery,
  type CallAssessment,
  type InvocationContext,
  type MessagingIdentityBindingRepositoryPort,
  type MessagingServicePort,
  type OutboundMessage,
  type OutboundMessagePart,
  type ReachableChannel,
  type ToolOfferContext,
} from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import { clip, definedOnly } from "@tavi/contracts/util";
import { prefixedId, sha256Hex } from "@tavi/node-kit";
import type { ToolRegistry } from "@tavi/runtime";

import { allowedTargetsOf, destinationAllowed, destinationRefusal, type DestinationChannels } from "./destination.js";
import { assessMessagingSend, assessMessagingSendTo } from "../approvals/call-assessors.js";
import { awaitingReview, type FolderPromotion } from "../folders/promotion.js";

/**
 * The governed model tools for sending through a messaging connection.
 *
 * `messaging.send` replies through the channel a task was admitted from
 * — an explicit tool call, not an automatic
 * finalText-to-reply shortcut (confirmed design choice: mirrors
 * `agents.send`/`memory.propose`'s own "the model decides, nothing happens
 * silently" discipline, so a task can send zero, one, or several replies
 * without a special case). Only ever usable by a message-driven task:
 * `context.messagingReplyTo` (`InvocationContext`, set once at admission)
 * is absent for every operator/CLI-driven or
 * spawned-worker task, and this tool fails closed with `INVALID_INPUT`
 * rather than guessing a destination when it's missing.
 *
 * `messaging.send_to` addresses a connection and a chat
 * explicitly, which is what an *unattended* run needs: the 07:00 brief task
 * is admitted by the scheduler, never by an inbound message, so it has no
 * `messagingReplyTo` to reply to. It also carries a file part, which is how
 * the rendered PDF reaches Telegram.
 *
 * **Its destination is model-authored, so it is operator-allowlisted.** See
 * `MessagingToolOptions.allowedDestinations`.
 */

export interface MessagingToolOptions {
  /**
   * The destinations `messaging.send_to` may address — exact provider
   * conversation ids (a Telegram `chatId`, a Mailgun recipient), written
   * `chatId` for any connection or `connectionId:chatId` for exactly one. The
   * grammar and its rationale live in `features/channels/destination.ts`, which
   * `operator.ask_user` shares.
   *
   * Deny-by-default, mirroring `http.request`'s host allowlist: an empty or
   * absent list refuses every destination, so an unconfigured runtime has no
   * model-directed egress of approved documents. This matters because the
   * destination is a model-authored argument, the collector pipeline in the
   * same run ingests text the model did not author (news headlines, Stripe
   * descriptions, API payloads), and an unattended run's policy may
   * auto-approve this tool — after which an injected
   * instruction naming an attacker chat would otherwise be enough to
   * exfiltrate the report.
   *
   * `messaging.send` (a reply) is deliberately NOT subject to this: its
   * destination is derived from the inbound message the connection itself
   * received, never from the model.
   */
  readonly allowedDestinations?: readonly string[];
  /**
   * The connection ids this runtime can send through, used only to decide
   * whether a bare `chatId` entry is unambiguous (it is, while at most one
   * connection exists). Composition always passes it; a
   * caller that omits it gets the single-connection reading, which is the
   * non-breaking one.
   */
  readonly connectionIds?: readonly string[] | (() => readonly string[]);
  /**
   * A send target as the connection's channel accepts it: normalized by its descriptor's `target`, or `undefined` when it is
   * not one (or the connection's channel is unknown). Absent: a target is
   * taken as given.
   */
  readonly targetOf?: (connectionId: string, to: string) => string | undefined;
  /** The channel a connection is, for a `providerId:*` allowlist entry. */
  readonly providerOf?: (connectionId: string) => string | undefined;
  /**
   * The connections a workspace can send through, as `messaging.channels`
   * answers. Absent: the tool is not registered.
   */
  readonly reachable?: (workspaceId: string) => readonly ReachableChannel[];
  /**
   * Turns a file of the chat's folder into the artifact a `kind: "file"` send
   * by `path` delivers. Absent: a file is
   * sent by `artifactId` only.
   */
  readonly promotion?: FolderPromotion;
  /**
   * The workspace's bound people (`channels allow`, a pairing), for
   * `messaging.channels`' `people` and `messaging.send_to`'s `person`. Only a
   * person the allowlist already lets the tool reach is ever named or resolved:
   * a binding says who someone is, never that they may be written to.
   * Absent: no person is known, and `person` is refused.
   */
  readonly bindings?: Pick<MessagingIdentityBindingRepositoryPort, "list">;
}

/** A bound person `messaging.send_to` may write to: a binding whose own sender id is an allowed target on its connection. */
interface MessagingContact {
  /** What the operator calls them, else their principal id. */
  readonly person: string;
  readonly connectionId: string;
  /** The binding's sender id, in its channel's own target form. */
  readonly target: string;
}

/** A contact with the principal its binding names, which a `person` may also be given as; never listed. */
interface KnownContact extends MessagingContact {
  readonly principalId: string;
}

/**
 * The one contact a `person` names: by name or principal id, case and
 * surrounding space aside, and on `connectionId` when the call gives one.
 * Strict — never a prefix, never the nearest — and refused when it names
 * none, or more than one destination, with the people it could have meant.
 */
function resolveContact(
  contacts: readonly KnownContact[],
  person: string,
  connectionId: string | undefined,
): { readonly contact: KnownContact } | { readonly code: "NOT_FOUND" | "INVALID_INPUT"; readonly refused: string } {
  const fold = (name: string): string => name.normalize("NFKC").trim().toLocaleLowerCase();
  const wanted = fold(person);
  const named = contacts.filter(
    (contact) =>
      (fold(contact.person) === wanted || fold(contact.principalId) === wanted) &&
      (connectionId === undefined || contact.connectionId === connectionId),
  );
  const distinct = [...new Map(named.map((contact) => [`${contact.connectionId}\n${contact.target}`, contact] as const)).values()];
  const [only] = distinct;
  if (only !== undefined && distinct.length === 1) return { contact: only };
  if (distinct.length > 1)
    return {
      code: "INVALID_INPUT",
      refused: `${person} names more than one destination: ${distinct.map(contactLine).join("; ")}. Pass connectionId, or the target as \`to\``,
    };
  const known = [...new Set(contacts.map((contact) => contact.person))];
  return {
    code: "NOT_FOUND",
    refused: `${person} is not someone this task can message${connectionId === undefined ? "" : ` on ${connectionId}`}; the people it can: ${known.join(", ") || "none"}`,
  };
}

const contactLine = (contact: MessagingContact): string => `${contact.person} on ${contact.connectionId} (${contact.target})`;

const MessagingChannelsInputSchema = z.strictObject({});

const MessagingSendInputSchema = z.object({
  content: z.string().min(1).max(4_000).describe("The reply text to send back through the originating channel"),
});

/**
 * Two variants rather than one object with a `content`/`artifactId` choice and
 * a `.refine()` enforcing it: `ToolRegistry` refuses any tool whose argument
 * schema uses a custom refinement, because the model-facing JSON Schema must
 * state the same constraint the handler enforces
 * (`packages/runtime/src/tools/registry.ts`). A discriminated union states
 * "exactly one of these two" to the handler exactly. Providers require an
 * object at a function's root, so the registry sends the model the union as
 * one object — `kind` an enum, each form's own fields optional — with the
 * contract said in its description (`objectRoot`); a mix no form allows is
 * refused here, the issues named in the refusal the model reads.
 *
 * There is no "both" variant because `capabilities.maxPartsPerMessage` is 1
 * for every registered connector: `caption` is the supported way to
 * accompany a document with text.
 */
/**
 * Where a send goes: `to`, the target as the channel
 * names one (a chat id, an email address, a phone number). `chatId` is its
 * older name, still accepted; `person` names a bound person instead, resolved
 * to their connection and target. Exactly one of the three is given, and a
 * connection with `to`/`chatId` — checked in the handler, since a tool schema
 * states no refinement.
 */
const sendTarget = {
  connectionId: z
    .string()
    .min(1)
    .optional()
    .describe("The messaging connection to send through, as listed among the channels you can reach; optional with person"),
  person: z.string().min(1).max(200).optional().describe("A person messaging.channels lists, by name, in place of to"),
  to: z
    .string()
    .min(1)
    .max(320)
    .optional()
    .describe("Who to send to, as the connection's channel names a target: a chat id, an email address, a phone number"),
  chatId: z
    .union([z.string().min(1), z.number()])
    .optional()
    .describe("Deprecated name for `to`"),
  threadId: z.string().min(1).max(256).optional().describe("The topic or thread to post in, where the channel has them"),
  subject: z.string().min(1).max(998).optional().describe("The subject line, where the channel has one (email)"),
};

const MessagingSendToTextSchema = z.strictObject({
  kind: z.literal("text").describe("Send a text message"),
  ...sendTarget,
  content: z.string().min(1).max(4_000).describe("The message body"),
  replyToMessageId: z.union([z.string(), z.number()]).optional().describe("The provider message id this send replies to"),
});

const MessagingSendToFileSchema = z.strictObject({
  kind: z.literal("file").describe("Send an approved artifact, or a file in your working folder, as a document"),
  ...sendTarget,
  artifactId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "An authorized artifact reference, e.g. from `reports.generate`. The artifact must already be approved for release. Give this or path",
    ),
  path: z
    .string()
    .min(1)
    .max(4_096)
    .optional()
    .describe(
      "A file in your working folder or an attached folder (relative to your working folder, or absolute). The person approving the send is shown its name, size and sha256. Give this or artifactId",
    ),
  filename: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Filename to present the document under; defaults to one derived from the artifact"),
  mimeType: z.string().min(1).max(255).optional().describe("Content type override; defaults to the artifact's own recorded type"),
  caption: z.string().min(1).max(1_024).optional().describe("Text to attach to the document"),
  replyToMessageId: z.union([z.string(), z.number()]).optional().describe("The provider message id this send replies to"),
});

const MessagingSendToInputSchema = z
  .discriminatedUnion("kind", [MessagingSendToTextSchema, MessagingSendToFileSchema])
  .describe("A document is given by exactly one of artifactId and path.");

export function registerMessagingTools(
  registry: ToolRegistry,
  messaging: MessagingServicePort,
  newId: (prefix: string) => string = prefixedId,
  options: MessagingToolOptions = {},
): void {
  const allowedDestinations = options.allowedDestinations ?? [];
  // Composition always supplies this; the fallback is the single-connection
  // reading (a bare entry matches), so a caller that has not been taught about
  // the connection set never starts refusing sends it used to accept.
  // Read at each call: a connection opened from Settings since startup counts.
  const destinationChannels: DestinationChannels | undefined =
    options.providerOf === undefined
      ? undefined
      : { providerOf: options.providerOf, targetOf: options.targetOf ?? ((_connectionId, to) => to) };
  const currentConnectionIds = (): readonly string[] =>
    typeof options.connectionIds === "function" ? options.connectionIds() : (options.connectionIds ?? []);
  /**
   * Whether a send goes to its schedule's own delivery target
   * (`InvocationContext.scheduleDelivery`), in the channel's own form of each:
   * then it is the fire's reply, its destination fixed by configuration
   * and its words go out disarmed under taint.
   */
  const toScheduleDelivery = (connectionId: unknown, given: string | undefined, threadId: unknown, context: InvocationContext): boolean => {
    const delivery = context.scheduleDelivery;
    // The configured destination names no thread or topic: a send into one is another destination.
    if (delivery === undefined || given === undefined || threadId !== undefined || connectionId !== delivery.connectionId) return false;
    const form = (target: string): string | undefined =>
      options.targetOf === undefined ? target : options.targetOf(delivery.connectionId, target);
    const target = form(given);
    return target !== undefined && target === form(delivery.destination);
  };

  /** Each workspace's contacts as last read — when its tools were offered, or a call resolved one — for the card, which is assessed without I/O. */
  const known = new Map<string, readonly KnownContact[]>();
  /**
   * The people `messaging.send_to` may write to by name, as the bindings and
   * the allowlist say now: a binding of this workspace, on a connection it can
   * send through when that is known, whose sender id is a target the allowlist
   * allows on its connection (never the owner's local one, which
   * `destinationAllowed` refuses whatever the entry).
   */
  const contactsOf = async (workspaceId: string): Promise<readonly KnownContact[]> => {
    if (options.bindings === undefined) return [];
    const reachable =
      options.reachable === undefined ? undefined : new Set(options.reachable(workspaceId).map((channel) => channel.connectionId));
    const connectionIds = currentConnectionIds();
    const contacts = (await options.bindings.list(workspaceId)).flatMap((binding): KnownContact[] => {
      if (binding.workspaceId !== workspaceId || (reachable !== undefined && !reachable.has(binding.connectionId))) return [];
      const target =
        options.targetOf === undefined ? binding.externalSenderId : options.targetOf(binding.connectionId, binding.externalSenderId);
      if (
        target === undefined ||
        !destinationAllowed(binding.connectionId, target, allowedDestinations, connectionIds, destinationChannels)
      )
        return [];
      return [
        {
          person: binding.displayName ?? binding.principalId,
          principalId: binding.principalId,
          connectionId: binding.connectionId,
          target,
        },
      ];
    });
    known.set(workspaceId, contacts);
    return contacts;
  };

  if (options.reachable !== undefined)
    registerChannelsTool(registry, options.reachable, options.bindings === undefined ? undefined : contactsOf);

  registry.register({
    id: "messaging.send",
    sink: "reply",
    version: "1.0.0",
    description:
      "Reply here: send a message to the conversation this task came from, on the channel it came through. To message anyone or anywhere else, or from a task no message started, use messaging.send_to.",
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    inputSchema: MessagingSendInputSchema,
    // Not offered in a turn no channel message started: there it can only fail, and a local chat's own answer is its reply.
    offered: (context) => context.outsideConversation !== true,
    assess: assessMessagingSend,
    handler: async ({ input, context, signal, disarmUrls }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "messaging.send was cancelled");
      const parsed = MessagingSendInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError("INVALID_INPUT", "messaging.send received invalid arguments", {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      const replyTo = requireMessagingReplyTo(context);
      const destination = messaging.buildReplyDestination(replyTo.connectionId, {
        externalConversationId: replyTo.externalConversationId,
        externalSenderId: replyTo.externalSenderId,
        ...definedOnly({
          externalMessageId: replyTo.externalMessageId,
          externalReferences: replyTo.externalReferences,
          externalThreadId: replyTo.externalThreadId,
          subject: replyTo.subject,
        }),
      });
      if (destination === undefined) {
        throw new TaviError(
          "UNSUPPORTED",
          `Connection ${replyTo.connectionId} is not open, or its connector supports no reply destination`,
        );
      }
      const message: OutboundMessage = {
        effectId: newId("msg"),
        connectionId: replyTo.connectionId,
        // The caller's workspace, exactly as `messaging.send_to` below claims
        // it: `MessagingService.send` skips its workspace comparison when the
        // field is absent, so leaving it off would make one of the two handlers
        // in this file silently un-checked as they share a send path.
        workspaceId: context.workspaceId,
        destination,
        // In a tainted turn, a URL the conversation does not know goes out defanged.
        parts: [{ content: disarmUrls === undefined ? parsed.data.content : disarmUrls(parsed.data.content) }],
      };
      return messaging.send(message);
    },
  });

  registry.register({
    id: "messaging.send_to",
    sink: "message",
    version: "1.0.0",
    description:
      "Send a text message, an approved artifact (a PDF report) or a file from your working folder (by path) through one of the channels you can reach, by its connection id, to a target the operator has allowed there — or to a person by name. The runtime facts list those channels and targets; `messaging.channels` lists them too, and the people. Use this to reach someone else, or from a task with no message to reply to; to answer the conversation this task came from, use messaging.send.",
    effect: "external",
    requiredPermissions: ["tools.invoke"],
    inputSchema: MessagingSendToInputSchema,
    // Offered as ever; with people known, its listing also reads who they are now, for the cards of this turn's calls.
    ...(options.bindings === undefined
      ? {}
      : {
          offered: async (context: ToolOfferContext) => {
            await contactsOf(context.workspaceId).catch(() => undefined);
            return true;
          },
        }),
    assess: (input, context) => {
      let call = input as {
        readonly kind?: unknown;
        readonly path?: unknown;
        readonly connectionId?: unknown;
        readonly to?: unknown;
        readonly chatId?: unknown;
        readonly threadId?: unknown;
        readonly person?: unknown;
      };
      // A person is shown, and matched by rules, as the connection and target they resolve to.
      let person: KnownContact | undefined;
      let unresolved: string | undefined;
      if (typeof call?.person === "string") {
        const refuse = (why: string): CallAssessment => ({
          ...assessMessagingSendTo(input),
          hardDeny: clip(`messaging.send_to refused: ${why}`, 500),
        });
        if (call.to !== undefined || call.chatId !== undefined) return refuse("give one of `to`, `chatId` and `person`");
        if (options.bindings === undefined) return refuse("no person is known here; pass connectionId and `to`");
        const contacts = known.get(context.workspaceId);
        if (contacts === undefined) unresolved = call.person;
        else {
          const resolved = resolveContact(contacts, call.person, typeof call.connectionId === "string" ? call.connectionId : undefined);
          if ("refused" in resolved) return refuse(resolved.refused);
          person = resolved.contact;
          call = { ...call, connectionId: person.connectionId, to: person.target };
        }
      }
      // A file by path: the card shows it as it is now.
      const read = assessMessagingSendTo(
        call,
        call?.kind === "file" && typeof call.path === "string" ? options.promotion?.describe(call.path, context) : undefined,
      );
      const assessed = labelledPerson(read, person, unresolved);
      const given =
        typeof call?.to === "string"
          ? call.to
          : typeof call?.chatId === "string" || typeof call?.chatId === "number"
            ? String(call.chatId)
            : undefined;
      // Who reads the configured destination is not known: as a reply of unknown audience, it counts as a group (`private-group-reply`).
      return toScheduleDelivery(call?.connectionId, given, call?.threadId, context)
        ? { ...assessed, sink: "reply", groupDestination: true }
        : assessed;
    },
    handler: async ({ input, context, signal, approvedBy, approvedContentHash, assessedSubjects, contextLabel, disarmUrls }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "messaging.send_to was cancelled");
      const parsed = MessagingSendToInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TaviError(
          "INVALID_INPUT",
          `messaging.send_to received invalid arguments: ${zodIssues(parsed.error, "input").join("; ")}`,
          {
            details: { issues: parsed.error.issues.map((issue) => issue.message) },
          },
        );
      }
      if (parsed.data.kind === "file" && (parsed.data.artifactId === undefined) === (parsed.data.path === undefined)) {
        throw new TaviError("INVALID_INPUT", "messaging.send_to sends a file by exactly one of `artifactId` and `path`");
      }
      const named = parsed.data.person;
      if (named !== undefined && (parsed.data.to !== undefined || parsed.data.chatId !== undefined))
        throw new TaviError("INVALID_INPUT", "messaging.send_to needs exactly one of `to`, `chatId` (its older name) and `person`");
      // A person resolves now, strictly, among the people the allowlist lets this reach; to where the card named them, or not at all.
      let contact: KnownContact | undefined;
      if (named !== undefined) {
        if (options.bindings === undefined)
          throw refusedEarly("NOT_CONFIGURED", "messaging.send_to knows no people here; pass connectionId and `to`");
        const shown = known.get(context.workspaceId);
        const resolved = resolveContact(await contactsOf(context.workspaceId), named, parsed.data.connectionId);
        if ("refused" in resolved) throw new TaviError(resolved.code, `messaging.send_to refused: ${resolved.refused}`);
        const before = shown === undefined ? undefined : resolveContact(shown, named, parsed.data.connectionId);
        if (
          before !== undefined &&
          "contact" in before &&
          (before.contact.connectionId !== resolved.contact.connectionId || before.contact.target !== resolved.contact.target)
        )
          throw new TaviError(
            "CONFLICT",
            `messaging.send_to refused: ${named} is now ${contactLine(resolved.contact)}, not where the approval named them; send again`,
          );
        // What the gate decided on, whoever decided it, outlives the cache above (a later listing, a restart): a person
        // whose destination is not among its subjects moved since, and is not sent to.
        const subject = `${resolved.contact.connectionId}:${resolved.contact.target}`;
        // A card shown before the person was known names no target (`…:?`): it resolves here, at high risk, as it said.
        const decided = (assessedSubjects ?? []).filter((entry) => !entry.endsWith(":?"));
        if (decided.length > 0 && !decided.includes(subject))
          throw new TaviError(
            "CONFLICT",
            `messaging.send_to refused: ${named} is now ${contactLine(resolved.contact)}, not where the approval named them; send again`,
          );
        contact = resolved.contact;
      }
      const connectionId = contact?.connectionId ?? parsed.data.connectionId;
      if (connectionId === undefined) throw new TaviError("INVALID_INPUT", "messaging.send_to needs `connectionId`, or a `person`");
      const given = contact?.target ?? parsed.data.to ?? (parsed.data.chatId === undefined ? undefined : String(parsed.data.chatId));
      if (given === undefined || (parsed.data.to !== undefined && parsed.data.chatId !== undefined)) {
        throw new TaviError("INVALID_INPUT", "messaging.send_to needs exactly one of `to`, `chatId` (its older name) and `person`");
      }
      // The channel's own form of the target, so `Ana@Example.com` and
      // `ana@example.com` are one destination to the allowlist below.
      const to = options.targetOf === undefined ? given : options.targetOf(connectionId, given);
      if (to === undefined) {
        throw new TaviError("INVALID_INPUT", `messaging.send_to: ${given} is not a target on connection ${connectionId}'s channel`, {
          details: { connectionId: connectionId },
        });
      }
      // Checked before the message is built, so a refused destination makes no
      // call at all — the same "denied operations make no call" discipline
      // `MessagingService.send` states and `http.request`'s own allowlist
      // follows by refusing before the request is issued.
      const connectionIds = currentConnectionIds();
      if (!destinationAllowed(connectionId, to, allowedDestinations, connectionIds, destinationChannels)) {
        // What it may address there instead, each known person's name beside their target: the model's next call, not a guess.
        const allowed = allowedTargetsOf(
          connectionId,
          allowedDestinations,
          connectionIds,
          destinationChannels ?? { providerOf: () => undefined, targetOf: (_connectionId, target) => target },
        );
        const people = (known.get(context.workspaceId) ?? []).filter((person) => person.connectionId === connectionId);
        const labelled = allowed.slice(0, 20).map((target) => {
          const person = people.find((candidate) => candidate.target === target);
          return person === undefined ? target : `${target} (${person.person})`;
        });
        throw new TaviError(
          "NOT_AUTHORIZED",
          `messaging.send_to refused: ${destinationRefusal(connectionId, to, connectionIds)}. Allowed on ${connectionId}: ${labelled.join(", ") || "none"}`,
          // The refused subject, matching the message, and what is allowed on its connection.
          { details: { connectionId, chatId: to, allowedTargets: allowed } },
        );
      }
      // The connector builds its own destination from the generic target.
      const destination = messaging.buildDestination(connectionId, {
        to,
        ...(parsed.data.threadId === undefined ? {} : { threadId: parsed.data.threadId }),
        ...(parsed.data.subject === undefined ? {} : { subject: parsed.data.subject }),
        ...(parsed.data.replyToMessageId === undefined ? {} : { replyToId: String(parsed.data.replyToMessageId) }),
      });
      if (destination === undefined) {
        throw new TaviError("UNSUPPORTED", `Connection ${connectionId} is not open, or its channel cannot be sent to except as a reply`);
      }
      // A file by path is sent as an artifact, approved by this call's own
      // approval — only after the destination checks above, so a refused send
      // stores nothing.
      let artifactId = parsed.data.kind === "file" ? parsed.data.artifactId : undefined;
      let promotedName: string | undefined;
      if (parsed.data.kind === "file" && parsed.data.path !== undefined) {
        if (options.promotion === undefined)
          throw refusedEarly("NOT_CONFIGURED", "files from the chat's folder cannot be sent here; pass an approved artifactId");
        const promoted = await options.promotion.promote({
          path: parsed.data.path,
          context,
          approvedBy,
          approvedContentHash,
          contextLabel,
        });
        if (promoted.pending) return awaitingReview("messaging.send_to", promoted);
        artifactId = promoted.record.artifactId;
        promotedName = promoted.record.fileName;
      }
      // The union decides which part this is, and the check above that a file
      // has exactly one source; there is no empty-string stand-in for a
      // missing body.
      const parts: OutboundMessagePart[] = [];
      // A schedule's send to its own delivery target is a reply: in a tainted run, a URL the run does not know goes out defanged.
      const toDelivery = toScheduleDelivery(connectionId, given, parsed.data.threadId, context);
      const disarm = disarmUrls !== undefined && toDelivery ? disarmUrls : (text: string) => text;
      // An `if-changed` schedule's reply the same as the last result it delivered there is not sent again, and says so;
      // one that is sent carries its hash, which the schedule keeps once the run ends.
      const deliveryHash =
        toDelivery && context.scheduleNotify?.mode === "if-changed" && parsed.data.kind === "text"
          ? sha256Hex(normalisedDelivery(parsed.data.content))
          : undefined;
      if (deliveryHash !== undefined && deliveryHash === context.scheduleNotify?.lastDeliveredHash)
        return {
          status: "unchanged",
          retryable: false,
          note: "Not sent: it is the same as the last result this schedule delivered there. Nothing more is needed.",
        };
      if (parsed.data.kind === "text") {
        parts.push({ content: disarm(parsed.data.content) });
      } else {
        if (artifactId === undefined) throw new TaviError("INTERNAL", "messaging.send_to has no artifact to send");
        const filename = parsed.data.filename ?? promotedName;
        parts.push({
          kind: "file",
          artifactId,
          ...(filename === undefined ? {} : { filename }),
          ...(parsed.data.mimeType === undefined ? {} : { mimeType: parsed.data.mimeType }),
          ...(parsed.data.caption === undefined ? {} : { caption: disarm(parsed.data.caption).slice(0, 1_024) }),
        });
      }
      const message: OutboundMessage = {
        // A FRESH id per handler entry, deliberately. This handler runs at most
        // once per logical tool call: `dispatchTool` writes the effect-ledger
        // row *before* invoking it and, on a replay of a known effect key,
        // returns `EFFECT_UNCERTAIN` without re-entering it
        // (`packages/agent-host/src/workflow/dispatch.ts`). The ledger — not this id — is
        // therefore the replay guard. Deriving this id from the call identity
        // instead would be worse, not safer: the messaging
        // outbox insert is `ON CONFLICT (effect_id) DO NOTHING` with no content
        // check (`packages/runtime/src/persistence/store/messaging.ts`), so a provider
        // that repeats a `toolCallId` within one run — the repo's own
        // local-endpoint stub reuses a single id for every call — would have
        // silently dropped a genuinely different second message and reported
        // the first one's outcome back to the model as success.
        effectId: newId("msg"),
        connectionId: connectionId,
        // The caller's workspace, so `MessagingService.send` can refuse a send
        // through another workspace's connection and the artifact reader can
        // require the artifact to be this workspace's.
        workspaceId: context.workspaceId,
        destination,
        parts,
      };
      const sent = await messaging.send(message);
      const outcome = deliveryHash === undefined || sent.status !== "accepted" ? sent : { ...sent, deliveryHash };
      // Where a person was sent to, said back: the model reads who it reached.
      return contact === undefined
        ? outcome
        : { ...outcome, sentTo: { person: contact.person, connectionId: contact.connectionId, target: contact.target } };
    },
  });
}

/**
 * A send_to card for a person: the destination they resolved to, with their
 * name — or, when who they are was not read yet, their name alone and high
 * risk, the send resolving them then.
 */
function labelledPerson(assessed: CallAssessment, person: MessagingContact | undefined, unresolved: string | undefined): CallAssessment {
  if (person !== undefined) {
    const destination = `${person.connectionId}:${person.target}`;
    const named = `${person.person} (${destination})`;
    return {
      ...assessed,
      display: {
        ...assessed.display,
        title: clip(assessed.display.title.replace(destination, named), 300),
        destination: clip(named, 300),
      },
    };
  }
  if (unresolved === undefined) return assessed;
  return {
    ...assessed,
    display: { ...assessed.display, destination: clip(`${unresolved} (found among the people allowed when it is sent)`, 300) },
    risk: "high",
    reasons: [...assessed.reasons, "who the person is was not read before asking"],
  };
}

/** `messaging.channels`: the connections this task's workspace can send through, and to whom — the people among them by name. */
function registerChannelsTool(
  registry: ToolRegistry,
  reachable: (workspaceId: string) => readonly ReachableChannel[],
  contactsOf: ((workspaceId: string) => Promise<readonly KnownContact[]>) | undefined,
): void {
  registry.register({
    id: "messaging.channels",
    sink: "none",
    version: "1.0.0",
    description:
      "List the channels you can send through with `messaging.send_to`: each connection's id, its channel, what a message there can carry, and the targets the operator allowed; and the people you can message by name.",
    effect: "read-only",
    requiredPermissions: ["tools.invoke"],
    inputSchema: MessagingChannelsInputSchema,
    handler: async ({ input, context, signal }) => {
      if (signal.aborted) throw new TaviError("CANCELLED", "messaging.channels was cancelled");
      if (!MessagingChannelsInputSchema.safeParse(input).success)
        throw new TaviError("INVALID_INPUT", "messaging.channels takes no arguments");
      const channels = reachable(context.workspaceId);
      if (contactsOf === undefined) return { channels };
      // The binding's principal stays here: a person is named as the operator calls them.
      const people = (await contactsOf(context.workspaceId)).map(({ person, connectionId, target }) => ({ person, connectionId, target }));
      return { channels, people };
    },
  });
}

function requireMessagingReplyTo(context: InvocationContext): NonNullable<InvocationContext["messagingReplyTo"]> {
  if (context.messagingReplyTo === undefined) {
    throw new TaviError("INVALID_INPUT", "messaging.send is only available to a task admitted from a channel message");
  }
  return context.messagingReplyTo;
}
