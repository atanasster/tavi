import { randomBytes } from "node:crypto";

import {
  HEARTBEAT_LIMITS,
  containsRedactionPlaceholder,
  redactToolOutput,
  redactToolText,
  heartbeatKeyMuted,
  type HeartbeatItem,
  type HeartbeatLedgerRow,
  type HeartbeatRepositoryPort,
  type HeartbeatState,
  type HeartbeatTarget,
  type TellHeartbeatItem,
  disarmUrls,
  localDateTime,
  noticeWordsOf,
  storedWordsIn,
  textRef,
  type StoredWords,
  type TextRef,
} from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { errorMessage } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";

/**
 * The heartbeat's delivery, channel-blind:
 * what a tick reported is cleaned, tiered by `tellMe`, checked against the
 * ledger, mutes and snoozes, held to the hourly limit and written to the
 * ledger — all before the tick is recorded — and only then told, through the
 * owner's port: a Home notice, and one message per target. The digest,
 * retraction and pause alerts take the same path.
 */

/** A key is told again only past this, however its item changed. */
export const HEARTBEAT_COOLDOWN_MS = 6 * 60 * 60_000;
/** A `later` item not in a digest within this leaves it (it stays in the log). */
export const HEARTBEAT_DIGEST_WINDOW_MS = 24 * 60 * 60_000;
/** The most items one digest lists. */
export const HEARTBEAT_DIGEST_ITEMS = 50;
const HOUR_MS = 60 * 60_000;

/** One message to a target. An item's carries its button token: Open, Snooze and Don't tell me where the channel has buttons. */
export interface HeartbeatMessage {
  readonly effectId: string;
  readonly text: string;
  readonly subject: string;
  readonly buttonToken?: string;
}

/** What the owner does with a heartbeat's words: Home and the channels. */
export interface HeartbeatDeliveryPort {
  /** The words its channel messages are said in: the workspace's language; absent, English. */
  words?(state: HeartbeatState): Promise<CoreT>;
  /** Post (or update, under the same key) a notice in the person's Home; false when Home is off. */
  notify(
    state: HeartbeatState,
    notice: {
      readonly sourceKey: string;
      readonly title: string;
      readonly summary: string;
      /** `title` and `summary` by key, where they are Tavi's words: Home says them in its reader's language. */
      readonly titleRef?: TextRef;
      readonly summaryRef?: TextRef;
      readonly heartbeatItemId?: string;
    },
  ): Promise<boolean>;
  /**
   * Send to one target, once per effect id. A target whose connection is
   * deleted, missing or needs signing in again is skipped and logged.
   */
  send(
    state: HeartbeatState,
    target: HeartbeatTarget,
    message: HeartbeatMessage,
  ): Promise<"accepted" | "rejected" | "uncertain" | "skipped">;
  /** Edit what an effect sent to a target, where its channel can edit; false otherwise. */
  edit(state: HeartbeatState, target: HeartbeatTarget, message: { readonly effectId: string; readonly text: string }): Promise<boolean>;
}

const digest = (text: string, length = 16): string => sha256Hex(text).slice(0, length);

/** What makes an item the same item when told again: its words, its sources, its signals and its proposal. */
export function heartbeatItemHash(item: HeartbeatItem): string {
  return digest(JSON.stringify([item.title, item.body ?? null, item.sources, item.signalKeys ?? [], item.proposedAction ?? null]));
}

/** Every effect a target is sent for one telling: the target and the key are part of it, because effect ids are global. */
export function heartbeatEffectId(principalId: string, target: HeartbeatTarget, what: string): string {
  return `heartbeat:${principalId}:${target.connectionId}:${digest(target.to)}:${digest(what)}`;
}

const PATH_KEYS = new Set(["path", "cwd", "folder"]);

/** Whether a proposed action's input names a file path: a path key, or an absolute path string. */
function namesPath(value: unknown, depth = 0): boolean {
  if (depth > 16) return true;
  if (typeof value === "string") return /^(\/|~[\\/]|[A-Za-z]:|\\\\)/.test(value);
  if (Array.isArray(value)) return value.some((entry) => namesPath(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, entry]) => PATH_KEYS.has(key) || namesPath(entry, depth + 1));
  }
  return false;
}

/** The contract's bounds on a source's label and a proposal's summary. */
const SOURCE_LABEL_CHARS = 80;
const ACTION_SUMMARY_CHARS = 200;

/**
 * Clean what a tick reported: a proposal holding a masked secret or a
 * file path is dropped (the item stays), a source's `ref` survives only when
 * the host itself produced it — a signal or memory record this tick saw — and
 * every address in its words is disarmed but a watched page's (`keptPages`,
 * known-URL normal forms: `knownUrlSet`).
 */
export function cleanHeartbeatItems(
  items: readonly HeartbeatItem[],
  knownRefs: ReadonlySet<string>,
  keptPages: ReadonlySet<string> = new Set(),
): HeartbeatItem[] {
  return items.map((item) => {
    const { proposedAction: raw, ...rest } = item;
    // Anything secret-shaped the model copied in (from a page, a memory record) is masked before it is kept or sent;
    // a proposal whose input held a secret is dropped.
    const proposedAction = raw === undefined ? undefined : { ...raw, input: redactToolOutput(raw.input).value };
    const keepAction =
      proposedAction !== undefined && !containsRedactionPlaceholder(proposedAction.input) && !namesPath(proposedAction.input);
    // Disarmed words are a little longer: cut back to the contract's bounds.
    const disarm = (text: string, max: number): string => disarmUrls(redactToolText(text).text, keptPages).slice(0, max);
    return {
      ...rest,
      title: disarm(item.title, HEARTBEAT_LIMITS.titleChars),
      ...(item.body === undefined ? {} : { body: disarm(item.body, HEARTBEAT_LIMITS.bodyChars) }),
      sources: item.sources.map((source) =>
        source.ref === undefined || knownRefs.has(source.ref)
          ? { ...source, label: disarm(source.label, SOURCE_LABEL_CHARS) }
          : { label: disarm(source.label, SOURCE_LABEL_CHARS) },
      ),
      ...(keepAction ? { proposedAction: { ...proposedAction, summary: disarm(proposedAction.summary, ACTION_SUMMARY_CHARS) } } : {}),
    };
  });
}

/** Whether the ledger lets a key be told now: new, changed past the cooldown, resolved and back, or out of its snooze. */
function mayTell(row: HeartbeatLedgerRow | undefined, hash: string, now: Date): boolean {
  if (row === undefined) return true;
  if (row.state === "muted") return false;
  if (row.state === "snoozed") return row.snoozedUntil !== undefined && Date.parse(row.snoozedUntil) <= now.getTime();
  if (row.state !== "resolved" && row.hash === hash) return false;
  return now.getTime() - Date.parse(row.lastToldAt) >= HEARTBEAT_COOLDOWN_MS;
}

export interface HeartbeatDeliveryDependencies {
  readonly repository: HeartbeatRepositoryPort;
  readonly newId: (prefix: string) => string;
}

/** What mods answered for one item: hold it back, or make it wait for the summary; nothing, tell it as decided. */
export type HeartbeatItemVerdict = { readonly drop: string } | { readonly urgency: "later" } | Record<string, never>;

/**
 * Decide what a tick tells and write it to the ledger:
 * `tellMe`, then the ledger, mutes and snoozes, then the hourly limit — a
 * `now` item past it is told `later`, held back. Answers the ledger rows told.
 */
export async function planHeartbeatDelivery(
  deps: HeartbeatDeliveryDependencies,
  state: HeartbeatState,
  items: readonly HeartbeatItem[],
  now: Date,
  itemHook?: (item: HeartbeatItem) => Promise<HeartbeatItemVerdict>,
): Promise<readonly HeartbeatLedgerRow[]> {
  if (items.length === 0) return [];
  const scope = { workspaceId: state.workspaceId, principalId: state.principalId };
  const tiered = items.map((item): HeartbeatItem => {
    if (state.config.tellMe === "everything-now") return { ...item, urgency: "now" };
    if (state.config.tellMe === "digest-only") return { ...item, urgency: "later" };
    return item;
  });
  const rows = new Map((await deps.repository.ledgerRows({ ...scope, keys: tiered.map((item) => item.key) })).map((row) => [row.key, row]));
  const told = tiered
    .map((item) => ({ item, hash: heartbeatItemHash(item) }))
    .filter(({ item, hash }) => mayTell(rows.get(item.key), hash, now) && !heartbeatKeyMuted(item.key, state.config.mutes));
  if (told.length === 0) return [];
  // Mods may hold an item back or make it wait for the summary, after dedup and mute and before the hourly limit.
  const judged = await Promise.all(
    told.map(async ({ item, hash }) => {
      const verdict: HeartbeatItemVerdict = itemHook === undefined ? {} : await itemHook(item);
      return { item: "urgency" in verdict ? { ...item, urgency: "later" as const } : item, hash, filtered: "drop" in verdict };
    }),
  );
  let room = Math.max(
    0,
    state.config.maxNowPerHour - (await deps.repository.nowToldSince({ ...scope, since: new Date(now.getTime() - HOUR_MS).toISOString() })),
  );
  const tell = judged.map(({ item, hash, filtered }): TellHeartbeatItem => {
    const heldBack = !filtered && item.urgency === "now" && room <= 0;
    if (!filtered && item.urgency === "now" && !heldBack) room -= 1;
    return {
      itemId: deps.newId("hbi"),
      item: heldBack ? { ...item, urgency: "later" } : item,
      hash,
      heldBack,
      buttonToken: randomBytes(12).toString("base64url"),
      ...(filtered ? { filtered: true } : {}),
    };
  });
  // What was held back is recorded, and told nowhere.
  return (await deps.repository.tellItems({ ...scope, items: tell, now: now.toISOString() })).filter((row) => row.state !== "filtered");
}

/** A notice's summary: the sources and the instruction it answers, never the body (Home turns read it as context). */
function noticeSummary(row: HeartbeatLedgerRow): StoredWords {
  const sources = row.sources.map((source) => source.label).join(", ");
  const said =
    row.instructionLine === undefined
      ? sources
      : textRef("notice.heartbeat.summary.instruction", { sources, line: String(row.instructionLine) });
  return row.heldBack ? textRef("notice.heartbeat.summary.heldBack", { rest: said }) : said;
}

/** An item as a channel message: its title, its body, and where it came from. */
function itemText(row: HeartbeatLedgerRow, t: CoreT): string {
  return [row.title, row.body, t("channel.heartbeat.sources", { list: row.sources.map((source) => source.label).join(", ") })]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");
}

/** One telling's effect id for a target: its key, its hash and when it was told, so each telling is a message of its own and a replay is none. */
const itemEffect = (state: HeartbeatState, target: HeartbeatTarget, row: Pick<HeartbeatLedgerRow, "key" | "hash" | "lastToldAt">): string =>
  heartbeatEffectId(state.principalId, target, `item:${row.key}:${row.hash}:${row.lastToldAt}`);

/** Send to every target, one failing never stopping the rest; answers how many were accepted. */
async function sendAll(
  port: HeartbeatDeliveryPort,
  state: HeartbeatState,
  message: (target: HeartbeatTarget) => HeartbeatMessage,
  log: HeartbeatDeliveryLog,
): Promise<number> {
  let accepted = 0;
  for (const target of state.config.targets) {
    try {
      const outcome = await port.send(state, target, message(target));
      if (outcome === "accepted") accepted += 1;
      else if (outcome !== "skipped")
        log("warn", `a heartbeat message was not delivered (${outcome}); it stays in the app`, {
          workspaceId: state.workspaceId,
          connectionId: target.connectionId,
        });
    } catch (error) {
      log("warn", "a heartbeat message could not be sent; it stays in the app", {
        workspaceId: state.workspaceId,
        connectionId: target.connectionId,
        error: errorMessage(error),
      });
    }
  }
  return accepted;
}

/** The words the channel messages are said in; English when the port has none or they cannot be read. */
async function wordsOf(port: HeartbeatDeliveryPort, state: HeartbeatState, log: HeartbeatDeliveryLog): Promise<CoreT> {
  try {
    return (await port.words?.(state)) ?? coreEnglish;
  } catch (error) {
    log("warn", "a heartbeat's language could not be read; its channel messages are in English", {
      workspaceId: state.workspaceId,
      error: errorMessage(error),
    });
    return coreEnglish;
  }
}

export type HeartbeatDeliveryLog = (level: "info" | "warn", message: string, fields?: Record<string, unknown>) => void;

/** A Home notice that could not be written is logged, never what stops the channel messages. */
async function notifyIn(
  port: HeartbeatDeliveryPort,
  state: HeartbeatState,
  notice: Parameters<HeartbeatDeliveryPort["notify"]>[1],
  log: HeartbeatDeliveryLog,
): Promise<void> {
  try {
    await port.notify(state, notice);
  } catch (error) {
    log("warn", "a heartbeat notice could not be shown in the app", { workspaceId: state.workspaceId, error: errorMessage(error) });
  }
}

/**
 * Tell what was planned, after the tick is recorded: every item
 * as a Home notice; a `now` item also to every target. A send never retries
 * here — the effect id makes a replay a no-op, and a refused or uncertain one
 * is recorded by the outbox and left in the app.
 */
export async function deliverHeartbeatItems(
  port: HeartbeatDeliveryPort,
  state: HeartbeatState,
  rows: readonly HeartbeatLedgerRow[],
  log: HeartbeatDeliveryLog,
): Promise<void> {
  const t = rows.some((row) => row.urgency === "now") ? await wordsOf(port, state, log) : coreEnglish;
  for (const row of rows) {
    await notifyIn(
      port,
      state,
      {
        sourceKey: `heartbeat:item:${row.itemId}`,
        heartbeatItemId: row.itemId,
        ...noticeWordsOf({ title: row.title, summary: noticeSummary(row) }),
      },
      log,
    );
    if (row.urgency !== "now") continue;
    await sendAll(
      port,
      state,
      (target) => ({
        effectId: itemEffect(state, target, row),
        text: itemText(row, t),
        subject: row.title,
        ...(row.buttonToken === undefined ? {} : { buttonToken: row.buttonToken }),
      }),
      log,
    );
  }
}

/**
 * The digest, when a new window opens: the `later` items in no digest
 * yet told in the last 24 h — or since the window before opened (`since`),
 * when days without a window lie between (Friday's items on Monday) — as one
 * Home notice and one message per target. Answers how many it listed;
 * nothing to list sends nothing.
 */
export async function deliverHeartbeatDigest(
  deps: HeartbeatDeliveryDependencies,
  port: HeartbeatDeliveryPort,
  state: HeartbeatState,
  window: { readonly start: string; readonly since?: string },
  now: Date,
  log: HeartbeatDeliveryLog,
): Promise<number> {
  const scope = { workspaceId: state.workspaceId, principalId: state.principalId };
  const dayAgo = now.getTime() - HEARTBEAT_DIGEST_WINDOW_MS;
  const since = window.since === undefined ? dayAgo : Math.min(dayAgo, Date.parse(window.since));
  const rows = await deps.repository.digestItems({ ...scope, since: new Date(since).toISOString(), limit: HEARTBEAT_DIGEST_ITEMS });
  if (rows.length === 0) return 0;
  const titleRef = textRef("notice.heartbeat.digest.title", { count: rows.length, n: String(rows.length) });
  const t = await wordsOf(port, state, log);
  const title = storedWordsIn(titleRef, t);
  const lines = rows.map((row) => `• ${row.title}`);
  await notifyIn(
    port,
    state,
    { sourceKey: `heartbeat:digest:${window.start}`, ...noticeWordsOf({ title: titleRef, summary: lines.join("\n") }) },
    log,
  );
  await sendAll(
    port,
    state,
    (target) => ({
      effectId: heartbeatEffectId(state.principalId, target, `digest:${window.start}`),
      text: `${title}\n\n${lines.join("\n")}`,
      subject: title,
    }),
    log,
  );
  // Only the tellings listed: one told again while the digest was sending waits for the next.
  await deps.repository.markDigested({
    ...scope,
    items: rows.map((row) => ({ itemId: row.itemId, lastToldAt: row.lastToldAt })),
    now: now.toISOString(),
  });
  return rows.length;
}

/** "14:20" in the heartbeat's timezone, 24-hour, the same in every language. */
export function heartbeatClock(at: Date, timezone: string): string {
  const parts = localDateTime(at, timezone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/**
 * Retraction: resolved items' Home notices read "Resolved · 14:20",
 * and a channel message is edited to say so only where its channel can edit;
 * elsewhere nothing more is sent.
 */
export async function retractHeartbeatItems(
  port: HeartbeatDeliveryPort,
  state: HeartbeatState,
  resolved: readonly HeartbeatLedgerRow[],
  now: Date,
  timezone: string,
  log: HeartbeatDeliveryLog,
): Promise<void> {
  const time = heartbeatClock(now, timezone);
  const t = resolved.some((row) => row.urgency === "now") ? await wordsOf(port, state, log) : coreEnglish;
  const label = t("channel.heartbeat.resolved", { time });
  for (const row of resolved) {
    await notifyIn(
      port,
      state,
      {
        sourceKey: `heartbeat:item:${row.itemId}`,
        heartbeatItemId: row.itemId,
        ...noticeWordsOf({ title: textRef("notice.heartbeat.resolved.title", { time, title: row.title }), summary: noticeSummary(row) }),
      },
      log,
    );
    if (row.urgency !== "now") continue;
    for (const target of state.config.targets) {
      try {
        await port.edit(state, target, { effectId: itemEffect(state, target, row), text: `${label}\n\n${itemText(row, t)}` });
      } catch (error) {
        log("warn", "a heartbeat message could not be marked resolved", {
          workspaceId: state.workspaceId,
          connectionId: target.connectionId,
          error: errorMessage(error),
        });
      }
    }
  }
}

/** An alert when a heartbeat pauses itself (failures, budget, a missing provider): a Home notice, plus the targets. */
export async function deliverHeartbeatAlert(
  port: HeartbeatDeliveryPort,
  state: HeartbeatState,
  alert: { readonly key: string; readonly title: StoredWords; readonly text: StoredWords },
  log: HeartbeatDeliveryLog,
): Promise<void> {
  await notifyIn(
    port,
    state,
    { sourceKey: `heartbeat:alert:${alert.key}`, ...noticeWordsOf({ title: alert.title, summary: alert.text }) },
    log,
  );
  const t = await wordsOf(port, state, log);
  const title = storedWordsIn(alert.title, t);
  await sendAll(
    port,
    state,
    (target) => ({
      effectId: heartbeatEffectId(state.principalId, target, `alert:${alert.key}`),
      text: `${title}\n\n${storedWordsIn(alert.text, t)}`,
      subject: title,
    }),
    log,
  );
}
