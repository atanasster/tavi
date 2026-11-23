import { z } from "zod";

// Acyclic: neither tool-policy.ts nor task-origins.ts imports this module or one that does.
import { ToolPatternSchema } from "./tool-policy.js";
import { TASK_ORIGINS, type FrontEnd } from "./task-origins.js";
import type { ModelUsage } from "./model.js";
import type { Locale } from "./i18n.js";
import type { AdmissionKind, ChatKind } from "./ports/tasks.js";
import type { ChatFolder, ChatFolderMode, ChatFolderPrimaryKind } from "./chat-folders.js";

/**
 * Mods: an external plugin's hooks into the turn.
 *
 * A plugin declares each hook in its manifest's `mods` block, with a sentence
 * the operator reads at approval; its module registers only what it declared.
 * Versioned in its own nested field, as `ui.abi` and `channelAbi` are, so the
 * manifest's own `schemaVersion` and top-level `abi` stay as they are.
 */
export const MODS_ABI = "tavi.mods/1" as const;

/**
 * The events a mod can hook. A turn is one admission; a
 * model step is one model call inside it.
 */
export const MOD_EVENTS = [
  "turn.start",
  "prompt.submit",
  "model.step",
  "tool.check",
  "tool.call",
  "tool.result",
  "turn.complete",
  "heartbeat.tick",
  "heartbeat.item",
] as const;
export type ModEvent = (typeof MOD_EVENTS)[number];

/**
 * What a hook that throws, times out or answers the wrong shape stands
 * for. Gating events fail closed: a `tool.check` that fails asks (or, if
 * declared, denies) and a `tool.result` that fails withholds the result.
 * Observers are skipped. The first entry of each list is the default.
 */
export const MOD_FAILURE_KINDS = ["skip", "drop", "ask", "deny", "withhold"] as const;
export type ModFailureRule = (typeof MOD_FAILURE_KINDS)[number];

export const MOD_FAILURE_RULES = {
  "turn.start": ["skip"],
  "prompt.submit": ["skip", "drop"],
  "model.step": ["skip"],
  "tool.check": ["ask", "deny"],
  "tool.call": ["skip", "deny"],
  "tool.result": ["withhold"],
  "turn.complete": ["skip"],
  // A heartbeat hook that fails changes nothing: the check stands as recorded, the item is told as decided.
  "heartbeat.tick": ["skip"],
  "heartbeat.item": ["skip"],
} as const satisfies Record<ModEvent, readonly [ModFailureRule, ...ModFailureRule[]]>;

/** The events whose answer can refuse what was asked: their hooks fail closed. */
export const MOD_GATING_EVENTS: readonly ModEvent[] = ["tool.check", "tool.result"];

/** The events that concern one tool call, so a `tools` match applies to them. */
export const MOD_TOOL_EVENTS: readonly ModEvent[] = ["tool.check", "tool.call", "tool.result"];

/** The sources a hook can narrow to: a task's origin, or `routine` for a routine run, which has none. */
export const MOD_SOURCES = [...TASK_ORIGINS, "routine"] as const;
export type ModSource = (typeof MOD_SOURCES)[number];

export const ModHookMatchSchema = z.strictObject({
  /** Tool patterns, as rules write them (`fs.read`, `browser.*`); only for tool events. */
  tools: z.array(ToolPatternSchema).min(1).max(32).optional(),
  /** Where the turn came from. */
  sources: z.array(z.enum(MOD_SOURCES)).min(1).max(MOD_SOURCES.length).optional(),
  /** Messaging connection ids a turn arrived on. */
  channels: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
});
export type ModHookMatch = z.infer<typeof ModHookMatchSchema>;

export const ModHookDeclarationSchema = z
  .strictObject({
    event: z.enum(MOD_EVENTS),
    match: ModHookMatchSchema.optional(),
    onFailure: z.enum(MOD_FAILURE_KINDS).optional(),
    /** What the hook does, in the author's words, shown at approval. */
    disclosure: z.string().trim().min(1).max(300),
    /**
     * A `prompt.submit` hook's context blocks are the plugin's own trusted data,
     * not text it read from elsewhere: they do
     * not taint the turn. Shown at approval. Absent: every block it adds is
     * untrusted (`plugin`, principal `tool:<plugin id>`), from every front end.
     */
    contextTrusted: z.literal(true).optional(),
  })
  .superRefine((hook, context) => {
    if (hook.contextTrusted === true && hook.event !== "prompt.submit") {
      context.addIssue({
        code: "custom",
        path: ["contextTrusted"],
        message: `a ${hook.event} hook adds no context, so it cannot declare it trusted`,
      });
    }
    const allowed: readonly string[] = MOD_FAILURE_RULES[hook.event];
    if (hook.onFailure !== undefined && !allowed.includes(hook.onFailure)) {
      context.addIssue({ code: "custom", path: ["onFailure"], message: `a ${hook.event} hook fails as ${allowed.join(" or ")}` });
    }
    if (hook.match?.tools !== undefined && !MOD_TOOL_EVENTS.includes(hook.event)) {
      context.addIssue({
        code: "custom",
        path: ["match", "tools"],
        message: `a ${hook.event} hook concerns no one tool call, so it cannot match tools`,
      });
    }
  });
export type ModHookDeclaration = z.infer<typeof ModHookDeclarationSchema>;

export const MAX_MOD_HOOKS = 16;

/** A slash command's name: what follows the `/`. */
export const MOD_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_MOD_COMMANDS = 8;
/** What a command answers: shown to the person, never to the model. */
export const MOD_COMMAND_TEXT_MAX_CHARS = 4_000;

/** A slash command a plugin adds: `/name args` in `tavi chat`, the canvas and a channel. */
export const ModCommandDeclarationSchema = z.strictObject({
  name: z.string().regex(MOD_COMMAND_NAME_PATTERN, "a command name is lower-case letters, digits and dashes, starting with a letter"),
  /** What it does, shown in the command list and at approval. */
  description: z.string().trim().min(1).max(200),
});
export type ModCommandDeclaration = z.infer<typeof ModCommandDeclarationSchema>;

export const ModsDeclarationSchema = z
  .strictObject({
    abi: z.literal(MODS_ABI),
    hooks: z.array(ModHookDeclarationSchema).max(MAX_MOD_HOOKS).default([]),
    commands: z.array(ModCommandDeclarationSchema).max(MAX_MOD_COMMANDS).default([]),
  })
  .superRefine((mods, context) => {
    if (mods.hooks.length === 0 && mods.commands.length === 0)
      context.addIssue({ code: "custom", path: ["hooks"], message: "a mods block declares at least one hook or command" });
    if (new Set(mods.commands.map((command) => command.name)).size !== mods.commands.length)
      context.addIssue({ code: "custom", path: ["commands"], message: "a command is declared twice" });
    const seen = new Set<string>();
    for (const [index, hook] of mods.hooks.entries()) {
      const key = `${hook.event} ${JSON.stringify(hook.match ?? {})}`;
      if (seen.has(key))
        context.addIssue({ code: "custom", path: ["hooks", index], message: `${hook.event} is declared twice with the same match` });
      seen.add(key);
    }
  });
export type ModsDeclaration = z.infer<typeof ModsDeclarationSchema>;

/** The failure rule a declared hook stands for: its own, or the event's default. */
export function modFailureRuleOf(hook: Pick<ModHookDeclaration, "event" | "onFailure">): ModFailureRule {
  return hook.onFailure ?? MOD_FAILURE_RULES[hook.event][0];
}

/**
 * What a hook can read, in Tavi's words rather than the author's: shown
 * beside the disclosure at approval, so a hook with no match is
 * seen to read everything it is offered.
 */
export function modHookReadsLine(hook: Pick<ModHookDeclaration, "event" | "match" | "contextTrusted">): string {
  const tools = hook.match?.tools === undefined ? "every tool" : hook.match.tools.map((pattern) => `\`${pattern}\``).join(", ");
  const where = [
    hook.match?.sources === undefined ? undefined : `from ${hook.match.sources.join(", ")}`,
    hook.match?.channels === undefined ? undefined : `on ${hook.match.channels.join(", ")}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  const scope = where.length === 0 ? "" : ` (turns ${where})`;
  // A match has no workspace: the hook sees every workspace's turns it covers (invariant 9).
  return `${readsOf(hook, tools, where, scope)} It sees this in every workspace.`;
}

function readsOf(hook: Pick<ModHookDeclaration, "event" | "contextTrusted">, tools: string, where: string, scope: string): string {
  switch (hook.event) {
    case "tool.check":
    case "tool.call":
      return `Sees the input of ${tools}${scope}, and can refuse the call.`;
    case "tool.result":
      return `Sees and can change the output of ${tools}${scope}.`;
    case "prompt.submit":
      return `Reads every prompt and every message you receive${where.length === 0 ? ", on every channel" : scope}, and can add to it or drop it.${hook.contextTrusted === true ? " What it adds is trusted context: it does not mark the chat as holding untrusted content." : ""}`;
    case "model.step":
      return `Sees each model call as it starts: its step and its model${scope}.`;
    case "turn.start":
    case "turn.complete":
      return `Sees when each turn starts and ends, and its token usage${scope}.`;
    case "heartbeat.tick":
      return "Sees when each heartbeat check runs and how it ended.";
    case "heartbeat.item":
      return "Sees each heartbeat item's key, title, urgency, sources and signal keys, with the check's time and your timezone, and can hold it back for good or make it wait for the summary.";
  }
}

/** A version's hooks as its review shows them. */
export interface PluginModHookView {
  readonly event: ModEvent;
  readonly match?: ModHookMatch;
  readonly onFailure: ModFailureRule;
  readonly disclosure: string;
  /** Tavi's own line: what the hook can read. */
  readonly reads: string;
  /** A `prompt.submit` hook whose context the manifest declares trusted: it does not taint the turn. */
  readonly contextTrusted?: true;
}

export function modHookViewsOf(mods: ModsDeclaration): readonly PluginModHookView[] {
  return mods.hooks.map((hook) => ({
    event: hook.event,
    ...(hook.match === undefined ? {} : { match: hook.match }),
    onFailure: modFailureRuleOf(hook),
    disclosure: hook.disclosure,
    reads: modHookReadsLine(hook),
    ...(hook.contextTrusted === true ? { contextTrusted: true as const } : {}),
  }));
}

/**
 * Who and where a dispatched event belongs to. Isolation
 * is per workspace and principal: a hook sees only what its plugin's match
 * admits, and nothing crosses workspaces.
 */
export interface ModEnvelope {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly source: ModSource;
  readonly frontEnd?: FrontEnd;
  /** The messaging connection the turn arrived on, when it did. */
  readonly channel?: string;
  readonly chatKind?: ChatKind;
  /** A person can answer an `ask` in this run: false for a schedule or a routine. */
  readonly attended: boolean;
  /** The chat's working folder by label: no hook, tavi's own or a plugin's, learns host paths from its envelope. */
  readonly folder?: ModEnvelopeFolder;
  /** A heartbeat check's turn: the provider that asked for it, whose own hooks pass it over. */
  readonly heartbeatProvider?: string;
  /** An idea's prepared step: the provider that wrote the idea, whose own hooks pass it over. */
  readonly ideasProvider?: string;
  /**
   * The workspace's language (`workspace.locale`), for what a hook or command says to the person:
   * absent means English. Text a model reads stays English.
   */
  readonly locale?: Locale;
}

/**
 * The chat's folder on a hook's envelope, by label: the folders' names and
 * modes and the managed folder's own entries relative to it, so no hook learns
 * host paths it was not given. A hook reads a command's paths relative to the
 * working folder (`.`).
 */
export type ModEnvelopeFolder = ModEnvelopeFolderLabels;

export interface ModEnvelopeFolderLabels {
  readonly view: "labels";
  readonly primaryKind: ChatFolderPrimaryKind;
  /** `chat` for the managed folder, else the host folder's name. */
  readonly primaryLabel: string;
  /** Relative to the managed folder. */
  readonly scratch: ".tmp";
  readonly home: ".home";
  readonly attachments: readonly { readonly label: string; readonly mode: ChatFolderMode }[];
  readonly revision: number;
  readonly tainted?: true;
}

/** A chat's folder by label only, as a hook's envelope carries it; frozen, like the envelope it rides on. */
export function modFolderLabels(folder: ChatFolder): ModEnvelopeFolderLabels {
  const primaryLabel =
    folder.primaryKind === "managed"
      ? "chat"
      : (folder.primary
          .split("/")
          .filter((part) => part !== "")
          .pop() ?? "folder");
  return Object.freeze({
    view: "labels",
    primaryKind: folder.primaryKind,
    primaryLabel,
    scratch: ".tmp",
    home: ".home",
    attachments: Object.freeze(folder.attachments.map((attachment) => Object.freeze({ label: attachment.label, mode: attachment.mode }))),
    revision: folder.revision,
    ...(folder.tainted === true ? { tainted: true as const } : {}),
  });
}

/** One admission kind a turn can be: a cancel runs no turn. */
export type ModTurnKind = Exclude<AdmissionKind, "cancel">;

export interface TurnStartHookInput {
  readonly envelope: ModEnvelope;
  readonly kind: ModTurnKind;
}
export interface PromptSubmitHookInput {
  readonly envelope: ModEnvelope;
  readonly prompt: string;
  /** A steer folded into a running turn: it can gain context, never be dropped. */
  readonly steer: boolean;
}
export interface ModelStepHookInput {
  readonly envelope: ModEnvelope;
  readonly step: number;
  readonly model?: string;
}
/** A call's identity; `input` is absent for a sensitive call, which hooks never see. */
export interface ToolHookCall {
  readonly envelope: ModEnvelope;
  readonly tool: string;
  readonly callId: string;
  readonly input?: unknown;
  readonly sensitive?: true;
  /** Other tools whose matches cover this call, as its assessment's `ruleAliases` (`browser.batch` runs `browser.act`). */
  readonly aliases?: readonly string[];
}
export interface ToolCheckHookInput extends ToolHookCall {
  /** The gate's own decision, and why, before any hook. */
  readonly verdict: { readonly decision: ModCheckDecision; readonly reasons: readonly string[] };
}
export type ToolCallHookInput = ToolHookCall;
export interface ToolResultHookInput extends ToolHookCall {
  /** Masked by core first; absent for a sensitive call. */
  readonly output?: unknown;
  readonly isError: boolean;
  /** The output was cut to `PLUGIN_BOUNDS.maxHookOutputBytes` before the hook saw it. */
  readonly truncated?: true;
}
export type ModTurnOutcome = "completed" | "failed" | "waiting" | "cancelled";
export interface TurnCompleteHookInput {
  readonly envelope: ModEnvelope;
  readonly outcome: ModTurnOutcome;
  readonly usage?: ModelUsage;
  readonly toolCalls: number;
}

/**
 * A heartbeat check, once its record is written: why it ran, what
 * kind, how it ended and what it cost — never its signals, instructions or
 * memory. `now` and `timezone` because an envelope carries no time.
 */
export interface HeartbeatTickHookInput {
  readonly envelope: ModEnvelope;
  readonly now: string;
  readonly timezone: string;
  readonly wake: "interval" | "signal" | "event" | "manual" | "catch-up";
  readonly kind: "signal" | "deep" | "digest" | "window" | null;
  /** The gate that skipped or deferred it, when one did. */
  readonly gate?: string;
  readonly outcome: string;
  readonly itemsNow: number;
  readonly itemsLater: number;
  readonly usage?: { readonly tokens: number; readonly costUsd: number | null };
}

/** One heartbeat item, after dedup and mute and before it is told: what a mod may hold back or make wait. */
export interface HeartbeatItemHookInput {
  readonly envelope: ModEnvelope;
  readonly now: string;
  readonly timezone: string;
  readonly key: string;
  readonly urgency: "now" | "later";
  readonly title: string;
  readonly sources: readonly { readonly label: string; readonly ref?: string }[];
  readonly signalKeys: readonly string[];
}

/** Deliver it (`{}`), hold it back (`drop`), or make it wait for the summary (`urgency: "later"`): never more urgent, never rewritten. */
export const HeartbeatItemHookResultSchema = z.union([
  z.strictObject({ drop: z.string().trim().min(1).max(300) }),
  z.strictObject({ urgency: z.literal("later") }),
  z.strictObject({}),
]);

export const MOD_CHECK_DECISIONS = ["allow", "ask", "deny"] as const;
export type ModCheckDecision = (typeof MOD_CHECK_DECISIONS)[number];

/** A hook's answer, checked before it counts: a wrong shape is the hook's failure. */
export const ToolCheckHookResultSchema = z.discriminatedUnion("decision", [
  // Shown on the approval card, as a verdict's `risk.reasons` entry is.
  z.strictObject({ decision: z.literal("allow"), reason: z.string().trim().min(1).max(300).optional() }),
  z.strictObject({ decision: z.literal("ask"), reason: z.string().trim().min(1).max(300).optional() }),
  // What the model reads, as a verdict's deny `reason` is.
  z.strictObject({ decision: z.literal("deny"), reason: z.string().trim().min(1).max(500).optional() }),
]);
export const ToolCallHookResultSchema = z.strictObject({ deny: z.string().trim().min(1).max(500).optional() });
export const ToolResultHookResultSchema = z.union([
  z.strictObject({ output: z.unknown() }),
  z.strictObject({ withhold: z.string().trim().min(1).max(500) }),
]);
export const MAX_HOOK_CONTEXT_BLOCKS = 4;
export const MAX_HOOK_CONTEXT_CHARS = 4_000;
export const PromptSubmitHookResultSchema = z.union([
  z.strictObject({ context: z.array(z.string().trim().min(1).max(MAX_HOOK_CONTEXT_CHARS)).max(MAX_HOOK_CONTEXT_BLOCKS).optional() }),
  z.strictObject({ drop: z.string().trim().min(1).max(500) }),
]);
export const MAX_TURN_SUGGESTIONS = 3;
export const TURN_SUGGESTION_MAX_CHARS = 120;
export const TurnCompleteHookResultSchema = z.strictObject({
  suggestions: z.array(z.string().trim().min(1).max(TURN_SUGGESTION_MAX_CHARS)).max(MAX_TURN_SUGGESTIONS).optional(),
});

/** Each event's input and the answer a hook (and `next`) gives. Observers answer nothing. */
export interface ModEventTypes {
  readonly "turn.start": { readonly input: TurnStartHookInput; readonly result: void };
  readonly "prompt.submit": { readonly input: PromptSubmitHookInput; readonly result: z.infer<typeof PromptSubmitHookResultSchema> };
  readonly "model.step": { readonly input: ModelStepHookInput; readonly result: void };
  readonly "tool.check": { readonly input: ToolCheckHookInput; readonly result: z.infer<typeof ToolCheckHookResultSchema> };
  readonly "tool.call": { readonly input: ToolCallHookInput; readonly result: z.infer<typeof ToolCallHookResultSchema> };
  readonly "tool.result": { readonly input: ToolResultHookInput; readonly result: z.infer<typeof ToolResultHookResultSchema> };
  readonly "turn.complete": { readonly input: TurnCompleteHookInput; readonly result: z.infer<typeof TurnCompleteHookResultSchema> };
  readonly "heartbeat.tick": { readonly input: HeartbeatTickHookInput; readonly result: void };
  readonly "heartbeat.item": { readonly input: HeartbeatItemHookInput; readonly result: z.infer<typeof HeartbeatItemHookResultSchema> };
}
export type ModHookInput<E extends ModEvent> = ModEventTypes[E]["input"];
export type ModHookResult<E extends ModEvent> = ModEventTypes[E]["result"];

/** What runs beneath a hook: the hooks after it, then core. `signal` aborts when the dispatch is abandoned. */
export interface ModNext<E extends ModEvent> {
  /** What the hooks beneath and core answer; called with nothing, or anything, they are handed the original event. */
  (input?: ModHookInput<E>): Promise<ModHookResult<E>>;
  readonly signal: AbortSignal;
}

/** One hook: observe and `return next(e)`, or answer for itself (only ever stricter). */
/** What a hook answers: for `tool.call`, `prompt.submit`, `turn.complete` and `heartbeat.item`, nothing is an answer too (no change). */
export type ModHookAnswer<E extends ModEvent> = E extends "tool.call" | "prompt.submit" | "turn.complete" | "heartbeat.item"
  ? ModHookResult<E> | void
  : ModHookResult<E>;
export type ModHook<E extends ModEvent> = (input: ModHookInput<E>, next: ModNext<E>) => ModHookAnswer<E> | Promise<ModHookAnswer<E>>;

/** A dispatch's answer, and the plugin whose hook decided it when one changed core's answer. */
export interface ModDispatchOutcome<E extends ModEvent> {
  readonly result: ModHookResult<E>;
  readonly decidedBy?: string;
  /**
   * On `prompt.submit`: each context block with the plugin whose hook added it,
   * in order, and `trusted` when that hook's approved declaration says
   * `contextTrusted`.
   */
  readonly contextBy?: readonly { readonly pluginId: string; readonly text: string; readonly trusted?: true }[];
}

/**
 * The workflow's way into the hooks. Late-bound: the
 * adapter holds the port from before any plugin registers, and reads it on
 * every dispatch.
 */
export interface TurnHooksPort {
  /** Whether any hook would see this dispatch: the fast path for none. */
  has(event: ModEvent, envelope: ModEnvelope, tool?: string, aliases?: readonly string[]): boolean;
  /** Whether any hook is registered for `event` at all: checked before an envelope is built; absent, assumed so. */
  hasEvent?(event: ModEvent): boolean;
  /** Run the hooks for `event` around `core`, which answers when every hook passed it on. */
  dispatch<E extends ModEvent>(
    event: E,
    input: ModHookInput<E>,
    core: (input: ModHookInput<E>) => Promise<ModHookResult<E>>,
    signal?: AbortSignal,
  ): Promise<ModDispatchOutcome<E>>;
}

/** No plugin hooks anything: every dispatch is core's answer. */
export const NO_TURN_HOOKS: TurnHooksPort = {
  has: () => false,
  dispatch: async (_event, input, core) => ({ result: await core(input) }),
};

/**
 * Whether a `tool.result` hook's replacement keeps the output's shape:
 * a hook may rewrite string leaves only — every key, array length, number,
 * boolean and null stays as it was.
 */
export function sameOutputShape(before: unknown, after: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof before === "string") return typeof after === "string";
  if (Array.isArray(before))
    return (
      Array.isArray(after) &&
      before.length === after.length &&
      before.every((item, index) => sameOutputShape(item, after[index], depth + 1))
    );
  if (before !== null && typeof before === "object") {
    if (after === null || typeof after !== "object" || Array.isArray(after)) return false;
    const keys = Object.keys(before);
    const afterKeys = Object.keys(after);
    return (
      keys.length === afterKeys.length &&
      keys.every(
        (key) =>
          Object.hasOwn(after, key) &&
          sameOutputShape((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], depth + 1),
      )
    );
  }
  return Object.is(before, after);
}

/** What a command is handed when someone runs it: who, where, and what they typed after its name. */
export interface ModCommandInput {
  readonly envelope: ModEnvelope;
  readonly args: string;
  /** The language its answer is read in: the envelope's, `en` when it has none. The owner always sets it; absent only from an older one. */
  readonly locale?: Locale;
  /** Aborted when the command runs out of time, or its plugin stops: a command still running should stop. */
  readonly signal: AbortSignal;
}

/** Commands one person may run a second, on one front end or channel; more are refused, not counted as failures. */
export const MOD_COMMANDS_PER_SECOND = 4;
export const ModCommandResultSchema = z.strictObject({ text: z.string().max(MOD_COMMAND_TEXT_MAX_CHARS) });
export type ModCommandResult = z.infer<typeof ModCommandResultSchema>;

/** A command as a front end lists it: the name typed (`plugin:name` when two would clash), whose, and what it does. */
export interface PluginCommandView {
  readonly name: string;
  readonly pluginId: string;
  readonly description: string;
}

/** `plugin-commands` over IPC: the commands plugins added, and running one. */
export const PluginCommandsPayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.literal("run"),
    workspaceId: z.string().min(1).max(128).optional(),
    /** The chat it was typed in, when it was. */
    taskId: z.string().min(1).max(128).optional(),
    name: z.string().min(1).max(98),
    args: z.string().max(MOD_COMMAND_TEXT_MAX_CHARS).default(""),
  }),
]);
export type PluginCommandsPayload = z.infer<typeof PluginCommandsPayloadSchema>;
export type PluginCommandsAnswer = { readonly commands: readonly PluginCommandView[] } | ModCommandResult;

/**
 * `/name args` as typed — `name` as `commands()` lists it, `<plugin>:<name>`
 * included, and a Telegram `@bot` suffix allowed — or `undefined` when the
 * line is no slash command.
 */
export function parsePluginCommandLine(line: string): { readonly name: string; readonly args: string } | undefined {
  const match = /^\/([a-z0-9.:-]{1,98})(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(line.trim());
  const name = match?.[1]?.toLowerCase();
  return name === undefined ? undefined : { name, args: match?.[2]?.trim() ?? "" };
}
