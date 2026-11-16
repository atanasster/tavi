import {
  MEMORY_FORGET_UNREACHED,
  memoryPendingProvidersNote,
  MEMORY_CARD_ITEMS_MAX,
  MEMORY_PROVENANCE_KEEP_ALONE,
  MEMORY_TIDY_UP_LOOK,
  MEMORY_TIDY_UP_NEEDS_LOOK,
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
  type TaviErrorCode,
  type WorkspaceSettings,
} from "@tavi/contracts";

import { decideMemoryRecord, keepAllPlain, MEMORY_TIDY_STALE, type MemoryDecision } from "./bulk.js";
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

/** Where a memory is undone without a chat to number it in. */
const MEMORY_CENTER_PLACE = "Center → Soul & memory";

export const MEMORY_COMMANDS: readonly ModCommandDeclaration[] = [
  { name: "remember", description: "Save your own words to memory: /remember <text>, with --chat for this chat only." },
  { name: "forget", description: "Forget a memory: /forget <words> lists matches, /forget <n> forgets one." },
  {
    name: "memory",
    description:
      "Your memory: status, review, keep <n…> | keep all, discard <n…>, off | on for this chat, and pause | resume (the workspace owner).",
  },
  { name: "why", description: "The memories the last answer used." },
];

/** The fixed answers: groups and email never take a memory command. */
export const MEMORY_GROUP_ANSWER = "Memory isn't used in group chats.";
export const MEMORY_EMAIL_ANSWER = "Memory commands aren't taken by email, where a sender can be forged. Open Tavi to review your memory.";
export const MEMORY_PAUSE_REFUSAL = "Only the workspace owner can pause memory; /memory off turns it off for this chat.";
const MEMORY_RESUME_REFUSAL = "Only the workspace owner can resume memory.";
/** Punctuation a clipped name was cut after: `jumper,…` reads as `jumper…`. */
const CLIP_AFTER_PUNCTUATION = /[\s,;:–—-]+…$/;
/** A messaging command whose place was not recorded: refused, as only a direct chat takes memory commands (invariant 11). */
export const MEMORY_UNKNOWN_PLACE_ANSWER = "Memory commands are taken only in a direct chat. Open Tavi to review your memory.";
/** What every memory command but `/memory on | off | status` answers in a chat whose memory is off. */
export const MEMORY_OFF_ANSWER = "Memory is off in this chat. /memory on turns it back on.";
/** The same in a private chat, whose memory stays off. */
export const MEMORY_PRIVATE_ANSWER = "This is a private chat: memory stays off here. Start a new chat to use memory.";

const MEMORY_USAGE = "Usage: /memory [status | review | keep <n…> | keep all | discard <n…> | off | on | pause | resume].";
const REMEMBER_USAGE =
  'Usage: /remember <text> — saved as you wrote it; --chat keeps it for this chat only, and "key: value" saves a preference.';
const FORGET_USAGE = "Usage: /forget <words> to list matches, then /forget <n>; or /forget <memory id>.";
/** `/forget <words>` lists at most this many matches. */
const FORGET_MATCHES_MAX = 5;
/** What a forget's answer says it cannot reach. */
const FORGET_RECEIPT_TAIL = MEMORY_FORGET_UNREACHED;
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
  readonly channelNote?: (recordId: string) => Promise<string | undefined>;
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
}

/** The four commands, by name, each answering within the command budget. */
export function memorySlashCommands(deps: MemorySlashDependencies): Readonly<Record<"remember" | "forget" | "memory" | "why", CommandRun>> {
  /** The context, or the fixed answer that refuses the command here. */
  const contextOf = async (envelope: ModEnvelope): Promise<CommandContext | ModCommandResult> => {
    const place = deps.placeOf(envelope);
    if (place === "group") return { text: MEMORY_GROUP_ANSWER };
    if (place === "email") return { text: MEMORY_EMAIL_ANSWER };
    if (envelope.source === "messaging" && place !== "direct") return { text: MEMORY_UNKNOWN_PLACE_ANSWER };
    const task = await deps.repositories.tasks.get(envelope.taskId);
    const chatTaskId =
      task !== undefined &&
      task.workspaceId === envelope.workspaceId &&
      task.principalId === envelope.principalId &&
      task.chatKind !== "worker" &&
      task.chatKind !== "run"
        ? task.taskId
        : undefined;
    if (chatTaskId !== undefined && (await deps.reachOf?.(chatTaskId)) === "chat-only") return { text: MEMORY_GROUP_ANSWER };
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
      if (!answer.ok) throw new TaviError(answer.error.code as TaviErrorCode, answer.error.message);
      return answer.result as T;
    };
    return {
      envelope,
      chatTaskId,
      chatMode: chatTaskId === undefined ? undefined : task?.memoryMode,
      surface: envelope.channel ?? envelope.frontEnd ?? envelope.source,
      ipc,
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
        return { text: context.chatMode === "private" ? MEMORY_PRIVATE_ANSWER : MEMORY_OFF_ANSWER };
      try {
        return { text: await body(context, args.trim()) };
      } catch (error) {
        return { text: refusalText(TaviError.from(error)) };
      }
    };

  const dateOf = async (workspaceId: string, iso: string): Promise<string> => memoryDateText(iso, await deps.timezoneOf(workspaceId));

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
  const nameOf = (record: MemoryItem): string =>
    memoryCardItemName({
      state: "proposed",
      sensitive: record.redacted,
      title: memoryCardTitleOf({
        ...(record.title === null ? {} : { title: record.title }),
        ...(record.body === null ? {} : { body: record.body }),
      }),
    }).replace(CLIP_AFTER_PUNCTUATION, "…");

  /** A name closing a sentence: a full stop unless it already ends in one, a `?`, `!` or the clip's `…`. */
  const sentenceOf = (record: MemoryItem): string => nameOf(record).replace(/([^….?!])$/, "$1.");

  const readRecord = async (context: CommandContext, recordId: string): Promise<MemoryItem | undefined> => {
    try {
      return (await context.ipc<{ readonly record: MemoryItem }>({ action: "get", recordId })).record;
    } catch (error) {
      if (TaviError.from(error).code === "NOT_FOUND") return undefined;
      throw error;
    }
  };

  const forgetOne = async (context: CommandContext, record: MemoryItem): Promise<string> => {
    // The note is optional: a failed read leaves it out of the answer.
    const note = await deps.channelNote?.(record.recordId).catch(() => undefined);
    const receipt = await context.ipc<MemoryForgetAnswer>({
      action: "forget",
      recordId: record.recordId,
      reason: "forgotten with /forget",
    });
    // A provider that could not take the removal now is named, as the CLI's receipt does.
    const waiting = memoryPendingProvidersNote(receipt?.pendingProviders);
    return `Forgotten: ${sentenceOf(record)} ${FORGET_RECEIPT_TAIL}${waiting === undefined ? "" : ` ${waiting}`}${note === undefined ? "" : ` ${note}`}`;
  };

  /** Keep or discard one waiting record, in the words a card would use when it was decided elsewhere. */
  const decide = (context: CommandContext, record: MemoryItem, decision: "approve" | "reject"): Promise<MemoryDecision> =>
    decideMemoryRecord({ record, decision, run: (payload) => context.ipc(payload), reread: () => readRecord(context, record.recordId) });

  const remember: CommandRun = command(async (context, args) => {
    const words = args.split(/\s+/);
    const chatOnly = words.includes("--chat");
    const text = args.replace(/(^|\s)--chat(?=\s|$)/g, " ").trim();
    if (text === "") return REMEMBER_USAGE;
    if (chatOnly && context.chatTaskId === undefined)
      return "--chat keeps it for a chat of yours: say something here first, then /remember again.";
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
    const said = `Saved (${memoryCardScopeLabel(saved.target)}): ${sentenceOf(saved)}`;
    // No chat yet, so nothing is numbered and no card is posted: the Center (or the id) undoes it.
    return context.chatTaskId === undefined
      ? `${said} Undo it in ${MEMORY_CENTER_PLACE}, or with /forget ${saved.recordId}.`
      : `${said} /forget 1 undoes it.`;
  });

  const forget: CommandRun = command(async (context, args) => {
    if (args === "") return FORGET_USAGE;
    if (/^\d{1,4}$/.test(args)) {
      const [{ row } = { row: undefined }] = await numbered(context, [Number(args)]);
      if (row === undefined) return `Nothing is numbered ${args} here: /forget <words> lists matches to choose from.`;
      const record = await readRecord(context, row.recordId);
      return record === undefined ? `${args}: already forgotten.` : await forgetOne(context, record);
    }
    // One word that names a record of the sender's: that record.
    if (!/\s/.test(args)) {
      const record = /^[A-Za-z0-9_-]{1,128}$/.test(args) ? await readRecord(context, args) : undefined;
      if (record !== undefined && record.target !== "shared") return await forgetOne(context, record);
    }
    const found = await context.ipc<MemoryListAnswer>({ action: "list", query: args, limit: 20 });
    if (found.coverage === "unavailable") return "Memory search is unavailable right now; try again, or forget by id.";
    const matches = found.records.filter((record) => record.target !== "shared").slice(0, FORGET_MATCHES_MAX);
    if (matches.length === 0) return `Nothing you saved matches "${args}".`;
    const rows = await number(context, matches);
    const names = matches.map(nameOf);
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
      const latest = newest(names[index] as string) === record.recordedAt ? ", the newest" : "";
      return ` (saved ${memoryDateText(record.recordedAt, zone)} ${memoryClockText(record.recordedAt, zone)}${latest})`;
    };
    const lines = matches.map(
      (record, index) =>
        `${rows === undefined ? "-" : `${index + 1}.`} ${names[index]}${savedOf(record, index)}${rows === undefined ? ` (${record.recordId})` : ""}`,
    );
    // Listed only: nothing is forgotten until a number or an id is named.
    return [
      `${matches.length === 1 ? "1 match" : `${matches.length} matches`} — nothing forgotten yet:`,
      ...lines,
      rows === undefined ? `Forget one in ${MEMORY_CENTER_PLACE}, or with /forget <id>.` : "/forget <n> forgets one.",
    ].join("\n");
  });

  const status = async (context: CommandContext): Promise<string> => {
    const settings = await deps.memorySettings(context.envelope.workspaceId);
    const pending = await waiting(context);
    // The first settings — on or paused, capture, sensitive topics — and this chat's mode: one line says all.
    // Kinds kept without asking are named to the operator whenever there are any: they relax the approval gate,
    // and only the operator's own — never another sender's, whom auto-approve never covers.
    const operator = deps.operatorOf(context.envelope.workspaceId) === context.envelope.principalId;
    const kept = !operator || settings.autoApprove.length === 0 ? "" : ` · kept without asking: ${settings.autoApprove.join(", ")}`;
    const workspace = `${settings.enabled ? "Memory on" : "Memory paused by the workspace owner"} · capture ${settings.capture}${kept} · sensitive ${settings.sensitive}`;
    const state =
      context.chatMode === "private"
        ? `${workspace} · private chat: memory off here`
        : context.chatMode === "off"
          ? `${workspace} · off in this chat (/memory on)`
          : workspace;
    if (pending.length === 0) return `${state} · nothing waiting.`;
    const oldest = pending
      .map((record) => record.expiresAt)
      .filter((at): at is string => at !== undefined)
      .sort()[0];
    const expiry = oldest === undefined ? "" : `, the oldest expires ${await dateOf(context.envelope.workspaceId, oldest)}`;
    return `${state} · ${pending.length} waiting${expiry} — /memory review lists them.`;
  };

  const review = async (context: CommandContext): Promise<string> => {
    const pending = await waiting(context);
    if (pending.length === 0) return "Nothing waiting to be remembered.";
    const listed = pending.slice(0, MEMORY_CARD_ITEMS_MAX);
    const rows = await number(context, listed);
    const lines: string[] = [];
    for (const [index, record] of listed.entries()) {
      const expires = record.expiresAt === undefined ? "" : ` — expires ${await dateOf(context.envelope.workspaceId, record.expiresAt)}`;
      // An update is replaced in the app, and a tidy-up compared there: neither is kept from here.
      const how = record.redacted
        ? " — open Tavi to review"
        : record.updates !== undefined
          ? ` — ${memoryUpdatesLine(record.updates)}, open Tavi to replace it`
          : record.mayUpdate !== undefined
            ? ` — ${memoryMayUpdateLine(record.mayUpdate)}, open Tavi to replace it`
            : record.supersedes !== undefined
              ? ` — ${MEMORY_TIDY_UP_LOOK}`
              : expires;
      // One proposed after its chat read untrusted content says what it read, and is kept on its own.
      const read = record.redacted ? undefined : memoryProvenanceLine(record.provenance, { tidyUp: record.supersedes !== undefined });
      lines.push(
        `${rows === undefined ? "-" : `${index + 1}.`} ${nameOf(record)}${how}${read === undefined ? "" : ` — ${read}; ${MEMORY_PROVENANCE_KEEP_ALONE}`}`,
      );
    }
    const more = pending.length > listed.length ? [`and ${pending.length - listed.length} more — open Tavi to review`] : [];
    const how =
      rows === undefined
        ? "Decide them in the app, or with tavi memory review."
        : "/memory keep <n…> · /memory keep all · /memory discard <n…>";
    return [`${pending.length} waiting:`, ...lines, ...more, how].join("\n");
  };

  /** `/memory keep <n…>`, `discard <n…>`: each number's record, decided one by one. */
  const decideNumbers = async (context: CommandContext, decision: "approve" | "reject", words: readonly string[]): Promise<string> => {
    const numbers = words.map((word) => (/^\d{1,4}$/.test(word) ? Number(word) : Number.NaN));
    if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n < 1)) return MEMORY_USAGE;
    const lines: string[] = [];
    for (const { n, row } of await numbered(context, [...new Set(numbers)])) {
      const record = row === undefined ? undefined : await readRecord(context, row.recordId);
      if (row === undefined) {
        lines.push(`${n}: nothing is numbered ${n} here — /memory review lists what waits.`);
        continue;
      }
      if (record === undefined) {
        lines.push(`${n}: forgotten.`);
        continue;
      }
      const outcome = await decide(context, record, decision);
      lines.push(
        outcome === "done"
          ? `${decision === "approve" ? "Kept" : "Discarded"}: ${nameOf(record)}.`
          : outcome === "conflict"
            ? `${n}: ${nameOf(record)} needs a look — another value is kept for it; open Tavi to replace it.`
            : outcome === "tidy"
              ? `${n}: ${nameOf(record)}: ${MEMORY_TIDY_UP_NEEDS_LOOK}`
              : outcome === "stale"
                ? `${n}: ${nameOf(record)}: ${MEMORY_TIDY_STALE}`
                : `${n}: ${outcome}.`,
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
    if (listed.length === 0) return "Nothing numbered here waits: /memory review lists what does.";
    const { kept, needsLook } = await keepAllPlain(listed, (record) => decide(context, record, "approve"));
    await receipt(context, kept);
    return `${memoryKeptAllText(kept.length, needsLook)}.${kept.length > 0 && context.chatTaskId !== undefined ? " Undo it from the Saved card." : ""}`;
  };

  /** `/memory pause | resume`: the workspace's `memory.enabled`, the operator's alone (invariant 13). */
  const pause = async (context: CommandContext, paused: boolean): Promise<string> => {
    const { workspaceId, principalId } = context.envelope;
    if (deps.operatorOf(workspaceId) !== principalId) return paused ? MEMORY_PAUSE_REFUSAL : MEMORY_RESUME_REFUSAL;
    const current = await deps.repositories.workspaceSettings.get(workspaceId);
    const next = applyMemoryPause(current.settings, paused);
    if (next === undefined) return paused ? "Memory is already paused." : "Memory is already on.";
    await deps.repositories.workspaceSettings.set({
      workspaceId,
      settings: next,
      expectedRevision: current.revision,
      actor: "operator:command",
      now: deps.now().toISOString(),
    });
    return paused
      ? "Memory paused for this workspace: nothing is recalled or captured until /memory resume. Nothing was deleted."
      : "Memory resumed: recall and capture start again from the next answer.";
  };

  /** `/memory off | on`: this chat's memory, anyone's for their own chat. */
  const chatMode = async (context: CommandContext, on: boolean): Promise<string> => {
    if (context.chatTaskId === undefined) return "There is no chat of yours here yet: say something first, then /memory off.";
    if (context.chatMode === "private") return MEMORY_PRIVATE_ANSWER;
    if (on && context.chatMode === undefined) return "Memory is already on in this chat.";
    if (!on && context.chatMode === "off") return "Memory is already off in this chat.";
    await deps.repositories.tasks.setMemoryMode({ taskId: context.chatTaskId, mode: on ? "on" : "off", now: deps.now().toISOString() });
    return on
      ? "Memory on in this chat from the next answer. Nothing said while it was off will be remembered."
      : "Memory off in this chat: nothing is recalled here, and nothing said here is remembered, until /memory on. Nothing was deleted.";
  };

  const memory: CommandRun = command(
    async (context, args) => {
      const [verb = "status", ...rest] = args.split(/\s+/).filter((word) => word !== "");
      switch (verb) {
        case "status":
          return rest.length === 0 ? await status(context) : MEMORY_USAGE;
        case "review":
          return rest.length === 0 ? await review(context) : MEMORY_USAGE;
        case "keep":
          return rest.length === 1 && rest[0] === "all" ? await keepAll(context) : await decideNumbers(context, "approve", rest);
        case "discard":
          return await decideNumbers(context, "reject", rest);
        case "pause":
        case "resume":
          return rest.length === 0 ? await pause(context, verb === "pause") : MEMORY_USAGE;
        case "off":
        case "on":
          return rest.length === 0 ? await chatMode(context, verb === "on") : MEMORY_USAGE;
        default:
          return MEMORY_USAGE;
      }
    },
    (args) => ["", "status", "on", "off"].includes(args),
  );

  const why: CommandRun = command(async (context, args) => {
    if (args !== "") return "Usage: /why — the memories the last answer used.";
    if (context.chatTaskId === undefined) return "There is no answer of yours here yet.";
    const answer = await context.ipc<MemoryWhyAnswer>({ action: "why", taskId: context.chatTaskId });
    return await whyText(answer, (iso) => dateOf(context.envelope.workspaceId, iso));
  });

  return { remember, forget, memory, why };
}

/** A time of day as the memory commands say it: in the workspace's `timeZone`, e.g. "14:02". */
function memoryClockText(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(iso));
}

/** A date as the memory commands say it: in the workspace's `timeZone`, e.g. "Sun 11 Oct". */
export function memoryDateText(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).format(new Date(iso));
}

/**
 * What `/why` and `tavi memory why` say: the memories an answer used, then
 * those it only looked through, each with its date, source chat and id; a
 * sensitive one never by its text.
 */
export async function whyText(answer: MemoryWhyAnswer, dateOf: (iso: string) => string | Promise<string>): Promise<string> {
  if (answer.seq === undefined) return "Nothing answered here yet.";
  const used = answer.used;
  // A turn saved before answers recorded their memory: what it used is not known, which is not "none".
  if (used?.recorded === false) {
    const when = answer.answeredAt === undefined ? "" : ` (${await dateOf(answer.answeredAt)})`;
    return `Not recorded: this answer${when} is from before Tavi recorded which memories each answer used. The chat panel's Used here lists what the chat's turns were given.`;
  }
  const preferences =
    used === undefined || used.preferences === 0
      ? ""
      : ` ${used.preferences === 1 ? "1 preference" : `${used.preferences} preferences`} applied.`;
  const count = used?.used ?? answer.records.length;
  const listed = used?.listed;
  if (count === 0 && listed === undefined) return `The last answer used no memory.${preferences}`;
  /** One group of records: its lines, and what of it is forgotten since or past the names. */
  const group = async (records: readonly MemoryItem[], total: number, forgotten: number): Promise<string[]> => {
    const lines: string[] = [];
    for (const record of records) {
      const name = memoryCardItemName({
        state: "saved",
        sensitive: record.redacted,
        title: memoryCardTitleOf({
          ...(record.title === null ? {} : { title: record.title }),
          ...(record.body === null ? {} : { body: record.body }),
        }),
      });
      const source = record.originTaskId === undefined ? "" : `, from chat ${record.originTaskId}`;
      lines.push(`- ${name} — ${record.kind}, ${await dateOf(record.recordedAt)}${source} (${record.recordId})`);
    }
    if (forgotten > 0) lines.push(`- ${forgotten === 1 ? "1 more is" : `${forgotten} more are`} forgotten since, or not yours`);
    const named = records.length + forgotten;
    if (total > named) lines.push(`- and ${total - named} more not listed`);
    return lines;
  };
  const lines: string[] = [];
  if (count > 0) {
    lines.push(`The answer used ${count === 1 ? "1 memory" : `${count} memories`}:`);
    lines.push(...(await group(answer.records, used?.used ?? count, used?.forgotten ?? 0)));
  }
  if (listed !== undefined) {
    lines.push(`${memoryListedHeading(listed.count, count)}:`);
    lines.push(...(await group(answer.listed ?? [], listed.count, listed.forgotten)));
  }
  if (preferences !== "") lines.push(preferences.trim());
  return lines.join("\n");
}

/** A refusal in the person's words: the service's message, never a stack. */
function refusalText(error: TaviError): string {
  switch (error.code) {
    case "MEMORY_CONFLICT":
      return "You already have a value for that preference: change it in the Center, or forget the old one first.";
    case "QUOTA_EXCEEDED":
      return "Your memory is full: forget something first, or ask the workspace owner to raise limits.maxRecords.";
    case "NOT_FOUND":
      return "That memory doesn't exist, or isn't yours.";
    default:
      return error.message;
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
