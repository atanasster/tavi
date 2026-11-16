import {
  TaviError,
  type InboundEvent,
  isLocalConnectionId,
  type PersistencePort,
  SCHEDULE_EMAIL_MAX_TEXT_BYTES,
  type ScheduleEmailTriggerAnswer,
  type ScheduleEmailTriggerInput,
  ScheduleEmailTriggerInputSchema,
  type ScheduleRecord,
  type ScheduleRepositoryPort,
  scheduleEmailSenderListed,
  scheduleEmailSubjectMatches,
  scheduleEmailTriggerSentence,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { ScheduleEmailFire } from "@tavi/agent-host/schedule-scheduler";
import type { MessageTaken } from "@tavi/runtime";

import type { ScheduleFireNow } from "./actions.js";
import { createRefusalCounter, createTriggerRateLimit, type ScheduleTriggerDeps } from "./trigger-limits.js";
import { channelDescriptorOf } from "../channels/catalog.js";
import { BUILTIN_CHANNEL_DESCRIPTORS } from "../plugins/catalog.js";

/**
 * A schedule's email trigger: an email on one email connection, from a sender
 * its list names and whose domain the channel verified (a DKIM signature
 * aligned with the sender's domain, relaxed alignment; neither SPF alone nor
 * a `dmarc=pass` resting on SPF alone counts: it proves the domain, not who
 * at it sent the mail),
 * fires the schedule now, as `run-now` does. Its
 * subject and text reach the run quoted as untrusted data, the run starts
 * tainted, and it is a reader session: only tools that read are offered or
 * run, whatever the schedule's tool list says, besides delivering its result
 * as the schedule is set to. Off by default; a person turns it on
 * (`tavi schedules email-trigger`, the app), never a model.
 *
 * An email the trigger takes — from a listed sender, authenticated, its
 * subject matching — is the trigger's alone, whether it fired the schedule or
 * was refused (rate limit, paused, a run in flight): it is never also a
 * conversation's message. Any other email goes on as it would without the
 * trigger, so mail a trigger refuses as unauthenticated is held, as such mail
 * always is.
 */

/** Why an email meant for a trigger started nothing, as its ledger row counts it. */
type Refusal = "unauthenticated" | "not a listed sender" | "over the rate limit" | "paused" | "not allowed" | "in flight" | "not started";

/**
 * Mailbox domains anyone can get an address on: as an `@domain` sender, any
 * stranger's mail would fire the trigger. An exact address on one is allowed.
 */
const PUBLIC_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
]);

/** How a connection's channel authenticates its senders; `undefined` for a channel this build does not know. */
function senderAuthenticationOf(providerId: string): "provider" | "per-message" | undefined {
  const descriptor =
    channelDescriptorOf(providerId) ?? BUILTIN_CHANNEL_DESCRIPTORS.find((candidate) => candidate.providerId === providerId);
  return descriptor?.sender.authentication;
}

/**
 * `schedules email-trigger <schedule> on …|off`: `on` checks that the connection is one of the schedule's workspace
 * whose channel authenticates each sender (email), and listens as given; `off` forgets it.
 */
export async function setScheduleEmailTrigger(
  repositories: Pick<PersistencePort["repositories"], "schedules" | "messagingConnections">,
  schedule: ScheduleRecord,
  setting: "off" | ScheduleEmailTriggerInput,
  at: Date,
): Promise<ScheduleEmailTriggerAnswer> {
  const schedules = repositories.schedules;
  if (setting === "off") {
    const had = schedule.emailTrigger !== undefined;
    if (had) await schedules.setEmailTrigger({ scheduleId: schedule.scheduleId, trigger: null, now: at.toISOString() });
    return { scheduleId: schedule.scheduleId, name: schedule.name, emailTrigger: "off", ...(had ? {} : { unchanged: true as const }) };
  }
  const parsed = ScheduleEmailTriggerInputSchema.safeParse(setting);
  if (!parsed.success)
    throw new TaviError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "an email trigger needs a connection and at least one sender");
  const input = parsed.data;
  const publicDomain = input.senders.find((sender) => sender.startsWith("@") && PUBLIC_MAILBOX_DOMAINS.has(sender.slice(1)));
  if (publicDomain !== undefined)
    throw new TaviError(
      "INVALID_INPUT",
      `${publicDomain} is a public mailbox domain: anyone can get an address there, so list exact addresses on it instead`,
    );
  const connection = await repositories.messagingConnections.get(input.connectionId);
  if (connection === undefined || connection.workspaceId !== schedule.workspaceId || isLocalConnectionId(input.connectionId))
    throw new TaviError("NOT_FOUND", `no email connection ${input.connectionId} in ${schedule.name}'s workspace`);
  if (senderAuthenticationOf(connection.providerId) !== "per-message")
    throw new TaviError(
      "INVALID_INPUT",
      `${input.connectionId} cannot authenticate each sender (it is not an email connection that checks each message for an aligned DKIM signature), so an email trigger cannot use it`,
    );
  const trigger = {
    connectionId: input.connectionId,
    senders: [...new Set(input.senders)],
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    since: at.toISOString(),
  };
  if (!(await schedules.setEmailTrigger({ scheduleId: schedule.scheduleId, trigger, now: at.toISOString() })))
    throw new TaviError("NOT_FOUND", `no schedule ${schedule.scheduleId}`);
  return { scheduleId: schedule.scheduleId, name: schedule.name, emailTrigger: "on", trigger };
}

/** `schedules email-trigger`'s text: what it listens for, and what a run it starts may do. */
export function scheduleEmailTriggerText(answer: ScheduleEmailTriggerAnswer): string {
  if (answer.emailTrigger === "off")
    return `${answer.scheduleId}\t${answer.name}\temail trigger off${answer.unchanged === true ? " (it had none)" : ""}`;
  return [
    `${answer.scheduleId}\t${answer.name}\temail trigger on`,
    `  listens   ${scheduleEmailTriggerSentence(answer.trigger)}`,
    "  An email from a listed sender whose domain the channel verified fires it now, at most once a minute and 12 times",
    "  an hour. The channel proves the domain, not the person: an exact address relies on that domain's own mail servers",
    "  to stop its other users sending as it. Its subject and text (at most 8 KiB) reach the run as quoted, untrusted",
    "  data; the run may only read — no tool that changes, sends or fetches anything runs, whatever its tool list says —",
    "  besides delivering its result as the schedule is set to. Email is where injected instructions come from most:",
    "  list only senders you trust.",
  ].join("\n");
}

/** What the trigger needs from the owner. */
export interface ScheduleEmailTriggerDependencies extends ScheduleTriggerDeps<ScheduleEmailFire> {
  readonly schedules: Pick<ScheduleRepositoryPort, "emailTriggered" | "recordFire">;
}

/**
 * The email triggers, offered each new inbound message (`MessagingServiceOptions.takeMessage`): when a trigger took
 * it — by its subject, its sender and the channel's verdict alone — what fires the schedules that took it, which the
 * messaging service runs once the message is done with. A message whose subject a trigger's filter matches but whose
 * sender is not listed, or a listed sender's message the channel did not authenticate, is counted as refused (sender
 * and words never kept) and left to go on as any other message.
 */
export function createScheduleEmailTriggers(
  deps: ScheduleEmailTriggerDependencies,
): (event: InboundEvent) => Promise<MessageTaken | undefined> {
  const nowMs = (): number => Date.parse(deps.now());
  const rate = createTriggerRateLimit(nowMs);
  const refuse = createRefusalCounter<Refusal>({
    schedules: deps.schedules,
    reasonCode: "email-refused",
    label: "email trigger",
    noun: ["email", "emails"],
    logMessage: "an email meant for a schedule's email trigger was refused",
    nowMs,
    now: deps.now,
    log: deps.log,
  });

  /** Fires one schedule for an email it took, or counts why it did not. */
  const fireFor = async (schedule: ScheduleRecord, email: ScheduleEmailFire): Promise<void> => {
    if (!schedule.enabled) return refuse(schedule, "paused");
    if (deps.actsIn !== undefined && !deps.actsIn(schedule.workspaceId, schedule.principalId)) return refuse(schedule, "not allowed");
    if (await deps.routineOwned(schedule.scheduleId)) return refuse(schedule, "not started");
    if (deps.inFlight(schedule.scheduleId)) return refuse(schedule, "in flight");
    if (rate.wait(schedule.scheduleId) > 0) return refuse(schedule, "over the rate limit");
    const giveBack = rate.take(schedule.scheduleId);
    let fired: ScheduleFireNow;
    try {
      fired = await deps.fire(schedule, email);
    } catch (error) {
      giveBack();
      deps.log("warn", "a schedule's email trigger could not fire it", {
        scheduleId: schedule.scheduleId,
        error: errorMessage(error),
      });
      return refuse(schedule, "not started");
    }
    if (fired.taskId !== undefined) {
      deps.log("info", "a schedule's email trigger fired it", { scheduleId: schedule.scheduleId, taskId: fired.taskId });
      return;
    }
    // A fire that started no run took none of the hour's fires, and its own record says why: not counted again here.
    giveBack();
    deps.log("info", "an email to a schedule's email trigger started no run", {
      scheduleId: schedule.scheduleId,
      outcome: fired.outcome?.kind,
    });
  };

  return async (event) => {
    if (event.kind !== "message") return undefined;
    const triggered = await deps.schedules.emailTriggered(event.connectionId);
    if (triggered.length === 0) return undefined;
    const taken: ScheduleRecord[] = [];
    for (const schedule of triggered) {
      const trigger = schedule.emailTrigger;
      if (trigger === undefined || !scheduleEmailSubjectMatches(trigger, event.subject)) continue;
      if (!scheduleEmailSenderListed(trigger.senders, event.externalSenderId)) {
        // Mail with no subject filter is anyone's mail on the connection, not an attempt at this trigger.
        if (trigger.subject !== undefined) await refuse(schedule, "not a listed sender");
        continue;
      }
      // Only the channel's own verdict counts: a forged From of a listed address fires nothing.
      if (event.senderAuthentication !== "pass") {
        await refuse(schedule, "unauthenticated");
        continue;
      }
      taken.push(schedule);
    }
    if (taken.length === 0) return undefined;
    const email = emailFireOf(event);
    return {
      fire: async () => {
        for (const schedule of taken) await fireFor(schedule, email);
      },
    };
  };
}

/** What ends an email's text that was cut to fit. */
const CUT_MARK = "\n[… the rest was cut]";
const CUT_MARK_BYTES = Buffer.byteLength(CUT_MARK, "utf8");

/** What an email gives its run: its sender, and its subject and text cut to `SCHEDULE_EMAIL_MAX_TEXT_BYTES` together. */
export function emailFireOf(event: Pick<InboundEvent, "externalSenderId" | "subject" | "content">): ScheduleEmailFire {
  const subject = utf8Prefix((event.subject ?? "").trim(), 998);
  const room = SCHEDULE_EMAIL_MAX_TEXT_BYTES - Buffer.byteLength(subject, "utf8");
  const whole = (event.content ?? "").trim();
  const text = Buffer.byteLength(whole, "utf8") <= room ? whole : `${utf8Prefix(whole, room - CUT_MARK_BYTES)}${CUT_MARK}`;
  return {
    sender: event.externalSenderId.trim().toLowerCase(),
    ...(subject === "" ? {} : { subject }),
    ...(text === "" ? {} : { text }),
  };
}

/** The longest prefix of `text` within `bytes` of UTF-8, never splitting a character. */
function utf8Prefix(text: string, bytes: number): string {
  if (bytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= bytes) return text;
  let end = 0;
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > bytes) break;
    used += size;
    end += character.length;
  }
  return text.slice(0, end);
}
