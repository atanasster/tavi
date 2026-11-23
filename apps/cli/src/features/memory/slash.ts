import {
  memoryPendingProvidersNote,
  MEMORY_CARD_ITEMS_MAX,
  MemoryPayloadSchema,
  TaviError,
  memoryCardItemName,
  memoryListedHeading,
  memoryCardScopeLabel,
  memoryCardTitleOf,
  memoryCommandReceiptKey,
  memoryKeptAllText,
  memoryMayUpdateLine,
  memoryProvenanceLine,
  memoryUpdatesLine,
  type ChatMemoryMode,
  type EffectiveMemorySettings,
  type MemoryForgetAnswer,
  type MemoryItem,
  type MemoryListAnswer,
  type MemoryPayload,
  type MemoryPromptRow,
  type MemoryWhyAnswer,
  type ModCommandDeclaration,
  type ModCommandInput,
  type ModCommandResult,
  type ModEnvelope,
  type PersistencePort,
  type WorkspaceSettings,
  localeOf,
  navPath,
  renderTextRef,
  taviErrorOf,
  errorTextIn,
} from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

import { channelWords, zonedClock, zonedShortDay } from "../channels/channel-words.js";
import { MEMORY_WORDS, REMEMBER_CHAT_FLAGS, typedWord, typedWords } from "../channels/typed-words.js";

import { decideMemoryRecord, keepAllPlain, memoryDecisionWords, type MemoryDecision } from "./bulk.js";
import { memoryCommand, type MemoryCommandDependencies } from "./owner.js";

/**
 * The memory commands: `/remember`,
 * `/forget`, `/memory` and `/why`, registered by the built-in host plugin
 * `tavi.memory` as `/heartbeat` is by `tavi.heartbeat`, so they reach the
 * canvas, the terminal and direct chats alike. They are host-parsed and act
 * with operator authority for the **sender's own principal**, only on records
 * in that person's scopes (invariant 21): a bound channel user decides their
 * own memory, and nobody decides another's. They never act in a group or on
 * email (invariant 11), where the fixed answers below say so. Natural phrases
 * ("remember that…") still go to the model, which proposes.
 *
 * Numbers (`/memory keep 2`, `/forget 1`) belong to the chat they were shown
 * in: the newest memory card there, or this front end's or channel's own
 * newest listing (`/memory review`, `/forget <words>`) or command receipt
 * (`/remember`, `/memory keep all`), held in `tavi_memory_prompts.number` — so
 * a listing or a `/remember` in the terminal never renumbers what a Telegram
 * chat was shown.
 */

export const MEMORY_PLUGIN_ID = "tavi.memory";

/** Where a memory is undone without a chat to number it in, in `t`'s words. */
const centerPlace = (t: CoreT): string => renderTextRef(navPath("nav.route.center", "nav.center.identity"), t) ?? "";

export const MEMORY_COMMANDS: readonly ModCommandDeclaration[] = [
  { name: "remember", description: coreEnglish("command.memory.remember") },
  { name: "forget", description: coreEnglish("command.memory.forget") },
  { name: "memory", description: coreEnglish("command.memory.memory") },
  { name: "why", description: coreEnglish("command.memory.why") },
];

/** Any of `/remember`'s chat flags as a word of its own, to take out of the text saved. */
const REMEMBER_CHAT_FLAG = new RegExp(
  `(^|\\s)(?:${REMEMBER_CHAT_FLAGS.map((flag) => flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?=\\s|$)`,
  "gu",
);

/** The fixed answers: groups and email never take a memory command. */
export const MEMORY_GROUP_ANSWER = coreEnglish("channel.memory.group");
export const MEMORY_EMAIL_ANSWER = coreEnglish("channel.memory.email");
export const MEMORY_PAUSE_REFUSAL = coreEnglish("channel.memory.pauseRefusal");
/** Punctuation a clipped name was cut after: `jumper,…` reads as `jumper…`. */
const CLIP_AFTER_PUNCTUATION = /[\s,;:–—-]+…$/;
/** A messaging command whose place was not recorded: refused, as only a direct chat takes memory commands (invariant 11). */
export const MEMORY_UNKNOWN_PLACE_ANSWER = coreEnglish("channel.memory.unknownPlace");
/** What every memory command but `/memory on | off | status` answers in a chat whose memory is off. */
export const MEMORY_OFF_ANSWER = coreEnglish("channel.memory.off");
/** The same in a private chat, whose memory stays off. */
export const MEMORY_PRIVATE_ANSWER = coreEnglish("channel.memory.private");

/** `/forget <words>` lists at most this many matches. */
const FORGET_MATCHES_MAX = 5;
/** A preference typed as `key: value`: a lowercase key, dotted or not, then the value. */
const PREFERENCE_LINE = /^([a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)*):\s+(\S[\s\S]*)$/;

/** Where a messaging command was typed: only a direct chat takes memory commands. */
export type MemoryCommandPlace = "direct" | "group" | "email";

export interface MemorySlashDependencies {
  readonly memory: MemoryCommandDependencies["memory"];
  readonly repositories: MemoryCommandDependencies["repositories"] & {
    readonly transcripts: Pick<
      PersistencePort["repositories"]["transcripts"],
      "getNotice" | "memoryPrompts" | "page" | "postMemoryCard" | "postMemoryListing" | "memoryNumbers"
    >;
    readonly workspaceSettings: PersistencePort["repositories"]["workspaceSettings"];
  };
  /** The workspace's operator: the only one who pauses or resumes memory. */
  readonly operatorOf: (workspaceId: string) => string | undefined;
  /** Where a messaging command was typed; undefined for the front ends, and for a messaging envelope nobody registered (refused). */
  readonly placeOf: (envelope: ModEnvelope) => MemoryCommandPlace | undefined;
  /** Whether a chat reads only its own notes (a group's): a second check on the chat itself. */
  readonly reachOf?: (taskId: string) => Promise<"chat-only" | undefined>;
  readonly memorySettings: (workspaceId: string) => Promise<EffectiveMemorySettings>;
  readonly timezoneOf: (workspaceId: string) => Promise<string>;
  readonly newId: (prefix: string) => string;
  readonly now: () => Date;
  /** Before a forget: which channels' messages still show the record and cannot be edited, said in the receipt. */
  readonly channelNote?: (recordId: string, t?: CoreT) => Promise<string | undefined>;
}

type CommandRun = (input: ModCommandInput) => Promise<ModCommandResult>;

/** Who and where a command runs: the sender, their chat (when it is theirs), and the surface whose numbers it reads. */
interface CommandContext {
  readonly envelope: ModEnvelope;
  /** The sender's own chat the command was typed in; undefined when it names none of theirs. */
  readonly chatTaskId: string | undefined;
  /** That chat's memory mode: absent while its memory is on. */
  readonly chatMode: ChatMemoryMode | undefined;
  readonly surface: string;
  readonly ipc: <T>(payload: MemoryPayload) => Promise<T>;
  /** The workspace's words: every answer is said in its language. */
  readonly t: CoreT;
}

/** The four commands, by name, each answering within the command budget. */
export function memorySlashCommands(deps: MemorySlashDependencies): Readonly<Record<"remember" | "forget" | "memory" | "why", CommandRun>> {
  /** The context, or the fixed answer that refuses the command here. */
  const contextOf = async (envelope: ModEnvelope): Promise<CommandContext | ModCommandResult> => {
    const t = await channelWords(
      async (workspaceId) => localeOf((await deps.repositories.workspaceSettings.get(workspaceId)).settings),
      envelope.workspaceId,
    );
    const place = deps.placeOf(envelope);
    if (place === "group") return { text: t("channel.memory.group") };
    if (place === "email") return { text: t("channel.memory.email") };
    if (envelope.source === "messaging" && place !== "direct") return { text: t("channel.memory.unknownPlace") };
    const task = await deps.repositories.tasks.get(envelope.taskId);
    const chatTaskId =
      task !== undefined &&
      task.workspaceId === envelope.workspaceId &&
      task.principalId === envelope.principalId &&
      task.chatKind !== "worker" &&
      task.chatKind !== "run"
        ? task.taskId
        : undefined;
    if (chatTaskId !== undefined && (await deps.reachOf?.(chatTaskId)) === "chat-only") return { text: t("channel.memory.group") };
    const commandDeps: MemoryCommandDependencies = {
      memory: deps.memory,
      repositories: deps.repositories,
      // The sender's own memory, with operator authority: what they see and may change is theirs (invariant 21).
      principalOf: (workspaceId) => (workspaceId === envelope.workspaceId ? envelope.principalId : undefined),
      fromBridge: false,
      caller: "operator:command",
      now: deps.now,
      memorySettings: deps.memorySettings,
    };
    const ipc = async <T>(payload: MemoryPayload): Promise<T> => {
      // Bounded as the IPC bounds it: a command builds its payload from what was typed.
      const parsed = MemoryPayloadSchema.safeParse({ ...payload, workspaceId: envelope.workspaceId });
      if (!parsed.success) throw new TaviError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "That is not a memory this can save");
      const answer = await memoryCommand(commandDeps, parsed.data);
      if (!answer.ok) throw taviErrorOf(answer.error);
      return answer.result as T;
    };
    return {
      envelope,
      chatTaskId,
      chatMode: chatTaskId === undefined ? undefined : task?.memoryMode,
      surface: envelope.channel ?? envelope.frontEnd ?? envelope.source,
      ipc,
      t,
    };
  };

  /**
   * A command body run in its context, with a refusal said in its own words.
   * In a chat whose memory is off only `/memory on | off | status` are taken
   * (`inOffChat`); everything else answers that it is off.
   */
  const command =
    (body: (context: CommandContext, args: string) => Promise<string>, inOffChat: (args: string) => boolean = () => false): CommandRun =>
    async ({ envelope, args }) => {
      const context = await contextOf(envelope);
      if (!("ipc" in context)) return context;
      if (context.chatMode !== undefined && !inOffChat(args.trim()))
        return { text: context.t(context.chatMode === "private" ? "channel.memory.private" : "channel.memory.off") };
      try {
        return { text: await body(context, args.trim()) };
      } catch (error) {
        return { text: refusalText(TaviError.from(error), context.t) };
      }
    };

  const dateOf = async (context: CommandContext, iso: string): Promise<string> =>
    memoryDateText(iso, await deps.timezoneOf(context.envelope.workspaceId), context.t);

  /** The sender's own waiting proposals, oldest first: never the shared scope, which the operator shares on purpose. */
  const waiting = async (context: CommandContext): Promise<readonly MemoryItem[]> => {
    const listed = await context.ipc<MemoryListAnswer>({ action: "list", statuses: ["proposed"], limit: 100 });
    return [...listed.records]
      .filter((record) => record.target !== "shared")
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  };

  /** Number `records` for this chat and surface; undefined when there is no chat of the sender's to hold the numbers. */
  const number = async (context: CommandContext, records: readonly MemoryItem[]): Promise<readonly MemoryPromptRow[] | undefined> => {
    if (context.chatTaskId === undefined) return undefined;
    return await deps.repositories.transcripts.postMemoryListing({
      noticeId: deps.newId("notice"),
      taskId: context.chatTaskId,
      surface: context.surface,
      createdAt: deps.now().toISOString(),
      records: records.map((record) => ({
        recordId: record.recordId,
        workspaceId: context.envelope.workspaceId,
        principalId: context.envelope.principalId,
      })),
    });
  };

  /**
   * A *Saved* card in the sender's chat for what a command saved or kept, whose Undo forgets exactly those.
   * Keyed by the surface it was typed on, so its numbers never renumber another surface's.
   */
  const receipt = async (context: CommandContext, recordIds: readonly string[]): Promise<void> => {
    if (context.chatTaskId === undefined || recordIds.length === 0) return;
    await deps.repositories.transcripts.postMemoryCard({
      noticeId: deps.newId("notice"),
      taskId: context.chatTaskId,
      sourceKey: memoryCommandReceiptKey(context.surface, deps.newId("cmd")),
      createdAt: deps.now().toISOString(),
      records: recordIds.map((recordId) => ({
        recordId,
        workspaceId: context.envelope.workspaceId,
        principalId: context.envelope.principalId,
      })),
    });
  };

  /** The rows `n…` name in this chat, each the sender's own; `undefined` for a number shown nowhere here. */
  const numbered = async (
    context: CommandContext,
    numbers: readonly number[],
  ): Promise<readonly { readonly n: number; readonly row: MemoryPromptRow | undefined }[]> => {
    const rows =
      context.chatTaskId === undefined
        ? []
        : await deps.repositories.transcripts.memoryNumbers({ taskId: context.chatTaskId, surface: context.surface });
    return numbers.map((n) => ({
      n,
      row: rows.find(
        (row) => row.number === n && row.principalId === context.envelope.principalId && row.workspaceId === context.envelope.workspaceId,
      ),
    }));
  };

  /** A record's name as a command says it: its title, never a sensitive one's text. */
  const nameOf = (record: MemoryItem, t: CoreT): string =>
    memoryCardItemName(
      {
        state: "proposed",
        sensitive: record.redacted,
        title: memoryCardTitleOf({
          ...(record.title === null ? {} : { title: record.title }),
          ...(record.body === null ? {} : { body: record.body }),
        }),
      },
      t,
    ).replace(CLIP_AFTER_PUNCTUATION, "…");

  /** A name closing a sentence: a full stop unless it already ends in one, a `?`, `!` or the clip's `…`. */
  const sentenceOf = (record: MemoryItem, t: CoreT): string => nameOf(record, t).replace(/([^….?!])$/, "$1.");

  const readRecord = async (context: CommandContext, recordId: string): Promise<MemoryItem | undefined> => {
    try {
      return (await context.ipc<{ readonly record: MemoryItem }>({ action: "get", recordId })).record;
    } catch (error) {
      if (TaviError.from(error).code === "NOT_FOUND") return undefined;
      throw error;
    }
  };

  const forgetOne = async (context: CommandContext, record: MemoryItem): Promise<string> => {
    const { t } = context;
    // The note is optional: a failed read leaves it out of the answer.
    const note = await deps.channelNote?.(record.recordId, t).catch(() => undefined);
    const receipt = await context.ipc<MemoryForgetAnswer>({
      action: "forget",
      recordId: record.recordId,
      reason: "forgotten with /forget",
    });
    // A provider that could not take the removal now is named, as the CLI's receipt does.
    const waiting = memoryPendingProvidersNote(receipt?.pendingProviders, t);
    return `${t("channel.memory.forgotten", { name: sentenceOf(record, t) })} ${t("memory.forget.unreached")}${waiting === undefined ? "" : ` ${waiting}`}${note === undefined ? "" : ` ${note}`}`;
  };

  /** Keep or discard one waiting record, in the words a card would use when it was decided elsewhere. */
  const decide = (context: CommandContext, record: MemoryItem, decision: "approve" | "reject"): Promise<MemoryDecision> =>
    decideMemoryRecord({ record, decision, run: (payload) => context.ipc(payload), reread: () => readRecord(context, record.recordId) });

  const remember: CommandRun = command(async (context, args) => {
    const words = args.split(/\s+/);
    const chatOnly = words.some((word) => REMEMBER_CHAT_FLAGS.includes(word));
    const text = args.replace(REMEMBER_CHAT_FLAG, " ").trim();
    const { t } = context;
    if (text === "") return t("channel.memory.rememberUsage");
    if (chatOnly && context.chatTaskId === undefined) return t("channel.memory.chatFirst");
    const preference = PREFERENCE_LINE.exec(text);
    const target = chatOnly && context.chatTaskId !== undefined ? (`chat:${context.chatTaskId}` as const) : ("personal" as const);
    const saved = await context.ipc<MemoryItem>({
      action: "remember",
      kind: preference === null ? "fact" : "preference",
      scope: target,
      body: text,
      ...(preference === null ? {} : { preferenceKey: preference[1] as string, preferenceValue: (preference[2] as string).trim() }),
      reason: "saved with /remember",
      ...(context.chatTaskId === undefined || chatOnly ? {} : { originTaskId: context.chatTaskId }),
    });
    await receipt(context, [saved.recordId]);
    const said = { scope: memoryCardScopeLabel(saved.target, t), name: sentenceOf(saved, t) };
    // No chat yet, so nothing is numbered and no card is posted: the Center (or the id) undoes it.
    return context.chatTaskId === undefined
      ? t("channel.memory.savedUndoCenter", { ...said, place: centerPlace(t), id: saved.recordId })
      : t("channel.memory.savedUndo", said);
  });

  const forget: CommandRun = command(async (context, args) => {
    const { t } = context;
    if (args === "") return t("channel.memory.forgetUsage");
    if (/^\d{1,4}$/.test(args)) {
      const [{ row } = { row: undefined }] = await numbered(context, [Number(args)]);
      if (row === undefined) return t("channel.memory.notNumbered", { n: args });
      const record = await readRecord(context, row.recordId);
      return record === undefined ? t("channel.memory.alreadyForgotten", { n: args }) : await forgetOne(context, record);
    }
    // One word that names a record of the sender's: that record.
    if (!/\s/.test(args)) {
      const record = /^[A-Za-z0-9_-]{1,128}$/.test(args) ? await readRecord(context, args) : undefined;
      if (record !== undefined && record.target !== "shared") return await forgetOne(context, record);
    }
    const found = await context.ipc<MemoryListAnswer>({ action: "list", query: args, limit: 20 });
    if (found.coverage === "unavailable") return t("channel.memory.searchUnavailable");
    const matches = found.records.filter((record) => record.target !== "shared").slice(0, FORGET_MATCHES_MAX);
    if (matches.length === 0) return t("channel.memory.noMatch", { words: args });
    const rows = await number(context, matches);
    const names = matches.map((record) => nameOf(record, t));
    // Two notes that read alike (a wardrobe saved again) are told apart by when each was saved (QA 2060).
    const alike = names.map((name) => names.filter((other) => other === name).length > 1);
    const zone = alike.includes(true) ? await deps.timezoneOf(context.envelope.workspaceId) : undefined;
    const newest = (name: string): string | undefined =>
      matches
        .filter((_, index) => names[index] === name)
        .map((record) => record.recordedAt)
        .sort()
        .at(-1);
    const savedOf = (record: MemoryItem, index: number): string => {
      if (zone === undefined || alike[index] !== true) return "";
      const when = { date: memoryDateText(record.recordedAt, zone, t), time: memoryClockText(record.recordedAt, zone) };
      return t(newest(names[index] as string) === record.recordedAt ? "channel.memory.savedAtNewest" : "channel.memory.savedAt", when);
    };
    const lines = matches.map(
      (record, index) =>
        `${rows === undefined ? "-" : `${index + 1}.`} ${names[index]}${savedOf(record, index)}${rows === undefined ? ` (${record.recordId})` : ""}`,
    );
    // Listed only: nothing is forgotten until a number or an id is named.
    return [
      t("channel.memory.matches", { count: matches.length, n: String(matches.length) }),
      ...lines,
      rows === undefined ? t("channel.memory.forgetInCenter", { place: centerPlace(t) }) : t("channel.memory.forgetHint"),
    ].join("\n");
  });

  const status = async (context: CommandContext): Promise<string> => {
    const { t } = context;
    const settings = await deps.memorySettings(context.envelope.workspaceId);
    const pending = await waiting(context);
    // The first settings — on or paused, capture, sensitive topics — and this chat's mode: one line says all.
    // Kinds kept without asking are named to the operator whenever there are any: they relax the approval gate,
    // and only the operator's own — never another sender's, whom auto-approve never covers.
    const operator = deps.operatorOf(context.envelope.workspaceId) === context.envelope.principalId;
    const kept =
      !operator || settings.autoApprove.length === 0 ? "" : t("channel.memory.status.kept", { kinds: settings.autoApprove.join(", ") });
    const workspace = t("channel.memory.status.line", {
      state: t(settings.enabled ? "channel.memory.status.on" : "channel.memory.status.paused"),
      capture: settings.capture,
      kept,
      sensitive: settings.sensitive,
    });
    const state =
      context.chatMode === "private"
        ? t("channel.memory.status.private", { workspace })
        : context.chatMode === "off"
          ? t("channel.memory.status.off", { workspace })
          : workspace;
    if (pending.length === 0) return t("channel.memory.status.nothing", { state });
    const oldest = pending
      .map((record) => record.expiresAt)
      .filter((at): at is string => at !== undefined)
      .sort()[0];
    const expiry = oldest === undefined ? "" : t("channel.memory.status.oldest", { date: await dateOf(context, oldest) });
    return t("channel.memory.status.waiting", { state, count: pending.length, n: String(pending.length), expiry });
  };

  const review = async (context: CommandContext): Promise<string> => {
    const { t } = context;
    const pending = await waiting(context);
    if (pending.length === 0) return t("channel.memory.review.nothing");
    const listed = pending.slice(0, MEMORY_CARD_ITEMS_MAX);
    const rows = await number(context, listed);
    const lines: string[] = [];
    for (const [index, record] of listed.entries()) {
      const expires =
        record.expiresAt === undefined ? "" : t("channel.memory.review.expires", { date: await dateOf(context, record.expiresAt) });
      // An update is replaced in the app, and a tidy-up compared there: neither is kept from here.
      const how = record.redacted
        ? t("channel.memory.review.openToReview")
        : record.updates !== undefined
          ? t("channel.memory.review.replace", { line: memoryUpdatesLine(record.updates, t) })
          : record.mayUpdate !== undefined
            ? t("channel.memory.review.replace", { line: memoryMayUpdateLine(record.mayUpdate, t) })
            : record.supersedes !== undefined
              ? ` — ${t("memory.card.tidyUpLook")}`
              : expires;
      // One proposed after its chat read untrusted content says what it read, and is kept on its own.
      const read = record.redacted ? undefined : memoryProvenanceLine(record.provenance, { tidyUp: record.supersedes !== undefined }, t);
      lines.push(
        `${rows === undefined ? "-" : `${index + 1}.`} ${nameOf(record, t)}${how}${read === undefined ? "" : ` — ${read}; ${t("memory.card.keepAllLeavesIt")}`}`,
      );
    }
    const more = pending.length > listed.length ? [t("channel.memory.review.more", { n: String(pending.length - listed.length) })] : [];
    const how = rows === undefined ? t("channel.memory.review.decideInApp") : t("channel.memory.review.commands");
    return [t("channel.memory.review.heading", { count: pending.length, n: String(pending.length) }), ...lines, ...more, how].join("\n");
  };

  /** `/memory keep <n…>`, `discard <n…>`: each number's record, decided one by one. */
  const decideNumbers = async (context: CommandContext, decision: "approve" | "reject", words: readonly string[]): Promise<string> => {
    const { t } = context;
    const numbers = words.map((word) => (/^\d{1,4}$/.test(word) ? Number(word) : Number.NaN));
    if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n < 1)) return t("channel.memory.usage");
    const lines: string[] = [];
    for (const { n, row } of await numbered(context, [...new Set(numbers)])) {
      const record = row === undefined ? undefined : await readRecord(context, row.recordId);
      if (row === undefined) {
        lines.push(t("channel.memory.decide.notNumbered", { n: String(n) }));
        continue;
      }
      if (record === undefined) {
        lines.push(t("channel.memory.decide.forgotten", { n: String(n) }));
        continue;
      }
      const outcome = await decide(context, record, decision);
      const name = nameOf(record, t);
      lines.push(
        outcome === "done"
          ? t(decision === "approve" ? "channel.memory.decide.kept" : "channel.memory.decide.discarded", { name })
          : outcome === "conflict"
            ? t("channel.memory.decide.conflict", { n: String(n), name })
            : outcome === "tidy"
              ? `${n}: ${name}: ${t("memory.card.tidyUpNeedsLook")}`
              : outcome === "stale"
                ? `${n}: ${name}: ${t("channel.memory.tidyStale")}`
                : `${n}: ${memoryDecisionWords(outcome, t)}.`,
      );
    }
    return lines.join("\n");
  };

  /**
   * `/memory keep all`: every plain proposal numbered here
   * is kept; a sensitive one, one proposed after its chat read untrusted
   * content, or one that conflicts, stays waiting and is named. The answer is a *Saved · N* card whose Undo forgets exactly those.
   */
  const keepAll = async (context: CommandContext): Promise<string> => {
    const rows =
      context.chatTaskId === undefined
        ? []
        : (await deps.repositories.transcripts.memoryNumbers({ taskId: context.chatTaskId, surface: context.surface })).filter(
            (row) => row.principalId === context.envelope.principalId && row.workspaceId === context.envelope.workspaceId,
          );
    const listed: MemoryItem[] = [];
    for (const row of rows) {
      const record = await readRecord(context, row.recordId);
      if (record?.status === "proposed") listed.push(record);
    }
    const { t } = context;
    if (listed.length === 0) return t("channel.memory.keepAll.nothing");
    const { kept, needsLook } = await keepAllPlain(listed, (record) => decide(context, record, "approve"));
    await receipt(context, kept);
    return `${memoryKeptAllText(kept.length, needsLook, t)}.${kept.length > 0 && context.chatTaskId !== undefined ? ` ${t("channel.memory.keepAll.undo")}` : ""}`;
  };

  /** `/memory pause | resume`: the workspace's `memory.enabled`, the operator's alone (invariant 13). */
  const pause = async (context: CommandContext, paused: boolean): Promise<string> => {
    const { t } = context;
    const { workspaceId, principalId } = context.envelope;
    if (deps.operatorOf(workspaceId) !== principalId) return t(paused ? "channel.memory.pauseRefusal" : "channel.memory.resumeRefusal");
    const current = await deps.repositories.workspaceSettings.get(workspaceId);
    const next = applyMemoryPause(current.settings, paused);
    if (next === undefined) return t(paused ? "channel.memory.alreadyPaused" : "channel.memory.alreadyOn");
    await deps.repositories.workspaceSettings.set({
      workspaceId,
      settings: next,
      expectedRevision: current.revision,
      actor: "operator:command",
      now: deps.now().toISOString(),
    });
    return t(paused ? "channel.memory.paused" : "channel.memory.resumed");
  };

  /** `/memory off | on`: this chat's memory, anyone's for their own chat. */
  const chatMode = async (context: CommandContext, on: boolean): Promise<string> => {
    const { t } = context;
    if (context.chatTaskId === undefined) return t("channel.memory.chat.noChat");
    if (context.chatMode === "private") return t("channel.memory.private");
    if (on && context.chatMode === undefined) return t("channel.memory.chat.alreadyOn");
    if (!on && context.chatMode === "off") return t("channel.memory.chat.alreadyOff");
    await deps.repositories.tasks.setMemoryMode({ taskId: context.chatTaskId, mode: on ? "on" : "off", now: deps.now().toISOString() });
    return t(on ? "channel.memory.chat.on" : "channel.memory.chat.off");
  };

  const memory: CommandRun = command(
    async (context, args) => {
      const usage = context.t("channel.memory.usage");
      // Its words in any language Tavi speaks: `запази всички` is `keep all`.
      const [verb = "status", ...rest] = typedWords(
        args.split(/\s+/).filter((word) => word !== ""),
        MEMORY_WORDS,
      );
      switch (verb) {
        case "status":
          return rest.length === 0 ? await status(context) : usage;
        case "review":
          return rest.length === 0 ? await review(context) : usage;
        case "keep":
          return rest.length === 1 && rest[0] === "all" ? await keepAll(context) : await decideNumbers(context, "approve", rest);
        case "discard":
          return await decideNumbers(context, "reject", rest);
        case "pause":
        case "resume":
          return rest.length === 0 ? await pause(context, verb === "pause") : usage;
        case "off":
        case "on":
          return rest.length === 0 ? await chatMode(context, verb === "on") : usage;
        default:
          return usage;
      }
    },
    (args) => args === "" || ["status", "on", "off"].includes(typedWord(args, MEMORY_WORDS) ?? ""),
  );

  const why: CommandRun = command(async (context, args) => {
    if (args !== "") return context.t("channel.memory.why.usage");
    if (context.chatTaskId === undefined) return context.t("channel.memory.why.noAnswer");
    const answer = await context.ipc<MemoryWhyAnswer>({ action: "why", taskId: context.chatTaskId });
    return await whyText(answer, (iso) => dateOf(context, iso), context.t);
  });

  return { remember, forget, memory, why };
}

/** A time of day as the memory commands say it: in the workspace's `timeZone`, e.g. "14:02". */
function memoryClockText(iso: string, timeZone: string): string {
  return zonedClock(new Date(iso), timeZone);
}

/** A date as the memory commands say it: in the workspace's `timeZone`, e.g. "Sun 11 Oct", in `t`'s words. */
export function memoryDateText(iso: string, timeZone: string, t: CoreT = coreEnglish): string {
  return zonedShortDay(new Date(iso), timeZone, t);
}

/**
 * What `/why` and `tavi memory why` say: the memories an answer used, then
 * those it only looked through, each with its date, source chat and id; a
 * sensitive one never by its text.
 */
export async function whyText(
  answer: MemoryWhyAnswer,
  dateOf: (iso: string) => string | Promise<string>,
  t: CoreT = coreEnglish,
): Promise<string> {
  if (answer.seq === undefined) return t("channel.memory.why.nothing");
  const used = answer.used;
  // A turn saved before answers recorded their memory: what it used is not known, which is not "none".
  if (used?.recorded === false) {
    return answer.answeredAt === undefined
      ? t("channel.memory.why.notRecorded")
      : t("channel.memory.why.notRecordedAt", { date: await dateOf(answer.answeredAt) });
  }
  const preferences =
    used === undefined || used.preferences === 0
      ? ""
      : t("channel.memory.why.preferences", { count: used.preferences, n: String(used.preferences) });
  const count = used?.used ?? answer.records.length;
  const listed = used?.listed;
  if (count === 0 && listed === undefined)
    return preferences === "" ? t("channel.memory.why.none") : `${t("channel.memory.why.none")} ${preferences}`;
  /** One group of records: its lines, and what of it is forgotten since or past the names. */
  const group = async (records: readonly MemoryItem[], total: number, forgotten: number): Promise<string[]> => {
    const lines: string[] = [];
    for (const record of records) {
      const name = memoryCardItemName(
        {
          state: "saved",
          sensitive: record.redacted,
          title: memoryCardTitleOf({
            ...(record.title === null ? {} : { title: record.title }),
            ...(record.body === null ? {} : { body: record.body }),
          }),
        },
        t,
      );
      const said = { name, kind: record.kind, date: await dateOf(record.recordedAt), id: record.recordId };
      lines.push(
        record.originTaskId === undefined
          ? t("channel.memory.why.line", said)
          : t("channel.memory.why.lineFrom", { ...said, chat: record.originTaskId }),
      );
    }
    if (forgotten > 0) lines.push(t("channel.memory.why.forgotten", { count: forgotten, n: String(forgotten) }));
    const named = records.length + forgotten;
    if (total > named) lines.push(t("channel.memory.why.notListed", { n: String(total - named) }));
    return lines;
  };
  const lines: string[] = [];
  if (count > 0) {
    lines.push(t("channel.memory.why.used", { count, n: String(count) }));
    lines.push(...(await group(answer.records, used?.used ?? count, used?.forgotten ?? 0)));
  }
  if (listed !== undefined) {
    lines.push(`${memoryListedHeading(listed.count, count, t)}:`);
    lines.push(...(await group(answer.listed ?? [], listed.count, listed.forgotten)));
  }
  if (preferences !== "") lines.push(preferences);
  return lines.join("\n");
}

/** A refusal in the person's words: the service's message, never a stack. */
function refusalText(error: TaviError, t: CoreT): string {
  switch (error.code) {
    case "MEMORY_CONFLICT":
      return t("channel.memory.refusal.conflict");
    case "QUOTA_EXCEEDED":
      return t("channel.memory.refusal.full");
    case "NOT_FOUND":
      return t("channel.memory.notYours");
    default:
      return errorTextIn(error, t);
  }
}

/**
 * The settings with memory paused or resumed: `enabled: false`, or the key
 * cleared (on is the default) and an emptied section dropped; undefined when
 * it already is so.
 */
function applyMemoryPause(settings: WorkspaceSettings, paused: boolean): WorkspaceSettings | undefined {
  const section = settings.memory ?? {};
  if ((section.enabled === false) === paused) return undefined;
  const { enabled: _enabled, ...rest } = section;
  const memory = paused ? { ...rest, enabled: false } : rest;
  const { memory: _memory, ...others } = settings;
  return Object.keys(memory).length === 0 ? others : { ...others, memory };
}
