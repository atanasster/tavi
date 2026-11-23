import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { findExecutable, launchCommand } from "@tavi/node-kit";

import {
  TaviError,
  formatHeartbeatInterval,
  heartbeatHookDecisions,
  heartbeatTickContext,
  type HeartbeatForgetAnswer,
  type HeartbeatGetAnswer,
  type HeartbeatLogAnswer,
  type HeartbeatOptions,
  type HeartbeatPayload,
  type HeartbeatRunNowAnswer,
  type HeartbeatTickRecord,
} from "@tavi/contracts";

import { coreEnglish, type CoreKey, type CoreT } from "@tavi/contracts/locales/core";

import { paddedCell } from "../../shared/terminal-text.js";
import { parseHeartbeatDuration, type HeartbeatCommandOptions } from "./parse.js";

/**
 * `tavi heartbeat`: the `heartbeat`
 * payload each action sends — the same on the owner and offline — and what
 * the terminal prints.
 */

/**
 * The allowed interval nearest a duration: a duration outside the
 * choices' range is refused rather than stretched to fit.
 */
export function nearestHeartbeatInterval(ms: number, choices: readonly number[]): number | undefined {
  const sorted = [...choices].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined || ms < first || ms > last) return undefined;
  return sorted.reduce((best, choice) => (Math.abs(Math.log(choice / ms)) < Math.abs(Math.log(best / ms)) ? choice : best), first);
}

/**
 * The payload for an action; `choices` are the owner's intervals, and for
 * `edit` the edited text and the revision it was read at — written over only
 * if nothing changed while the editor was open.
 */
export function heartbeatPayload(
  options: HeartbeatCommandOptions,
  context: { readonly choices: HeartbeatOptions; readonly instructions?: string; readonly readRevision?: number },
): HeartbeatPayload {
  const scope = { workspaceId: options.workspaceId };
  const revision = options.revision === undefined ? {} : { revision: options.revision };
  const argument = options.argument ?? "";
  switch (options.action) {
    case "status":
      return { action: "get", ...scope };
    case "on":
    case "off":
      return { action: "set", ...scope, ...revision, changes: { enabled: options.action === "on" } };
    case "pause":
      return { action: "pause", ...scope, ...(options.forMs === undefined ? {} : { forMs: options.forMs }) };
    case "resume":
      return { action: "resume", ...scope };
    case "every": {
      const asked = parseHeartbeatDuration(argument);
      const everyMs = asked === undefined ? undefined : nearestHeartbeatInterval(asked, context.choices.every);
      if (everyMs === undefined)
        throw new TaviError(
          "INVALID_INPUT",
          `${argument} is outside the choices: ${context.choices.every.map(formatHeartbeatInterval).join(", ")}`,
        );
      return { action: "set", ...scope, ...revision, changes: { everyMs } };
    }
    case "hours": {
      const [start = "", end = ""] = argument.split("-");
      return {
        action: "set",
        ...scope,
        ...revision,
        changes: { activeHours: { start, end }, ...(options.days === undefined ? {} : { daysOfWeek: [...options.days] }) },
      };
    }
    case "tell":
      return { action: "set", ...scope, ...revision, changes: { tellMe: argument as "urgent-now" | "everything-now" | "digest-only" } };
    case "edit": {
      // Held to the revision read, 0 included: a first save made while the editor was open is refused, never overwritten.
      const readAt = options.revision ?? context.readRevision;
      return {
        action: "set-instructions",
        ...scope,
        ...(readAt === undefined ? {} : { revision: readAt }),
        text: context.instructions ?? "",
      };
    }
    case "run-now":
      return { action: "run-now", ...scope };
    case "log":
      return {
        action: "log",
        ...scope,
        ...(options.since === undefined ? {} : { since: options.since }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      };
    case "set-provider":
      return { action: "set-provider", ...scope, ...revision, providerId: argument };
    case "egress":
      return {
        action: "egress",
        ...scope,
        ...revision,
        field: argument as "instructions" | "signals" | "ledger" | "memory",
        on: options.on === true,
      };
    case "mute":
    case "unmute":
      return { action: options.action, ...scope, ...revision, prefix: argument };
    case "forget":
      return { action: "forget", ...scope };
  }
}

/**
 * `$VISUAL` or `$EDITOR` as words: it may carry its own arguments
 * (`code --wait`), split on spaces outside double or single quotes
 * (`"C:\\Program Files\\Editor\\edit.exe" -w`).
 */
export function editorWords(editor: string): readonly string[] {
  return [...editor.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/**
 * The instructions `edit` sends: read from `--file` (`-` is standard input),
 * or edited in `$VISUAL`/`$EDITOR` from the current text. Undefined when the
 * editor left them unchanged, so nothing is written.
 */
export function editedInstructions(
  options: Pick<HeartbeatCommandOptions, "file">,
  current: string,
  io: { readonly readStdin: () => string; readonly editor?: string },
): string | undefined {
  if (options.file !== undefined) return options.file === "-" ? io.readStdin() : readFileSync(options.file, "utf8");
  const editor = io.editor ?? process.env["VISUAL"] ?? process.env["EDITOR"] ?? (process.platform === "win32" ? "notepad" : "vi");
  const directory = mkdtempSync(join(tmpdir(), "tavi-heartbeat-"));
  const path = join(directory, "instructions.md");
  try {
    writeFileSync(path, current, { mode: 0o600 });
    // No shell: the editor's own words, then the path, as arguments (a `.cmd` editor through `launchCommand`).
    const [command = editor, ...flags] = editorWords(editor);
    const launch = launchCommand(isAbsolute(command) ? command : (findExecutable(command) ?? command), [...flags, path]);
    const ran = spawnSync(launch.command, launch.args, {
      stdio: "inherit",
      ...(launch.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: true }),
    });
    if (ran.error !== undefined) throw new Error(`the editor (${editor}) could not be started: ${ran.error.message}; nothing was saved`);
    if (ran.status !== 0) throw new Error(`the editor (${editor}) exited with ${ran.status ?? "a signal"}; nothing was saved`);
    const edited = readFileSync(path, "utf8");
    return edited === current ? undefined : edited;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const TELL: Readonly<Record<string, CoreKey>> = {
  "urgent-now": "cli.heartbeat.tell.urgentNow",
  "everything-now": "cli.heartbeat.tell.everythingNow",
  "digest-only": "cli.heartbeat.tell.digestOnly",
};

/** An interval as the status says it: `30m`, `2h`, `45s` in English (`30 мин` in Bulgarian). */
function intervalWords(ms: number, t: CoreT): string {
  const said = formatHeartbeatInterval(ms);
  const unit = said.at(-1);
  const n = said.slice(0, -1);
  return t(unit === "h" ? "cli.heartbeat.interval.h" : unit === "m" ? "cli.heartbeat.interval.m" : "cli.heartbeat.interval.s", { n });
}

/** A weekday as the status lists it: `mon`, `tue` in English (`пн`, `вт` in Bulgarian). */
const SHORT_DAYS: readonly CoreKey[] = [
  "date.weekdayShort.0",
  "date.weekdayShort.1",
  "date.weekdayShort.2",
  "date.weekdayShort.3",
  "date.weekdayShort.4",
  "date.weekdayShort.5",
  "date.weekdayShort.6",
];

/** A heartbeat's settings and state, for `status` and after every change. */
export function heartbeatStatusText(answer: HeartbeatGetAnswer, t: CoreT = coreEnglish): string {
  const config = answer.config;
  const none = t("cli.heartbeat.none");
  const listOrNone = (list: readonly string[]): string => (list.length === 0 ? none : list.join(", "));
  const paused =
    config.paused === undefined
      ? ""
      : config.paused.until === undefined
        ? t("cli.heartbeat.paused", { reason: config.paused.reason })
        : t("cli.heartbeat.pausedUntil", { reason: config.paused.reason, until: config.paused.until });
  const dayName = (day: number): string => {
    const key = SHORT_DAYS[day];
    return key === undefined ? String(day) : t(key).toLowerCase();
  };
  const days = config.daysOfWeek === undefined ? "" : `, ${config.daysOfWeek.map(dayName).join(",")}`;
  const instructionLines = config.instructions.split("\n").filter((line) => line.trim() !== "").length;
  const tell = TELL[config.tellMe];
  const lines = [
    t("cli.heartbeat.state", {
      state: t(config.enabled ? "cli.heartbeat.on" : "cli.heartbeat.off"),
      paused,
      defaults: answer.state === undefined ? t("cli.heartbeat.defaults") : "",
    }),
    t("cli.heartbeat.checks", {
      every: intervalWords(config.everyMs, t),
      start: config.activeHours.start,
      end: config.activeHours.end,
      timezone: answer.timezone,
      days,
      deep: intervalWords(config.deepCheckEveryMs, t),
    }),
    t("cli.heartbeat.tells", { how: tell === undefined ? config.tellMe : t(tell), n: String(config.maxNowPerHour) }),
    t("cli.heartbeat.targets", {
      targets:
        config.targets.length === 0
          ? t("cli.heartbeat.homeOnly")
          : config.targets.map((target) => `${target.connectionId} → ${target.to}`).join(", "),
    }),
    t("cli.heartbeat.provider", {
      provider: config.providerId,
      missing:
        answer.providers.length === 0 || config.providerId === "off" || answer.providers.includes(config.providerId)
          ? ""
          : t("cli.heartbeat.notInstalled"),
    }),
    ...providerLines(answer, t),
    t("cli.heartbeat.model", {
      model: config.model === undefined ? t("cli.heartbeat.fastModel") : `${config.model.connectionId}/${config.model.model}`,
      persona: config.agentId ?? none,
    }),
    t("cli.heartbeat.limits", {
      checks: String(config.budget.modelTicksPerDay),
      tokens: String(config.budget.tokensPerDay),
      usd: config.budget.usdPerDay === undefined ? "" : `, $${config.budget.usdPerDay}`,
    }),
    t("cli.heartbeat.tools", { list: listOrNone(config.extraTools) }),
    t("cli.heartbeat.sites", { list: listOrNone(config.fetchHosts) }),
    t("cli.heartbeat.sourcesOff", { list: listOrNone(config.disabledSources) }),
    t("cli.heartbeat.notes", {
      notes:
        answer.state?.memo === undefined
          ? none
          : t("cli.heartbeat.bytes", { n: String(new TextEncoder().encode(answer.state.memo).length) }),
    }),
    t("cli.heartbeat.instructions", {
      instructions:
        config.instructions.trim() === ""
          ? t("cli.heartbeat.noInstructions")
          : t("cli.heartbeat.lines", { n: String(instructionLines), count: instructionLines }),
    }),
    t("cli.heartbeat.mutes", { list: listOrNone(config.mutes) }),
    t("cli.heartbeat.next", {
      next: answer.state?.nextTickAt ?? t("cli.heartbeat.noneScheduled"),
      last: answer.state?.lastTickAt ?? t("cli.heartbeat.never"),
    }),
    t("cli.heartbeat.host", { host: t(answer.hostRunning ? "cli.heartbeat.hostHere" : "cli.heartbeat.hostElsewhere") }),
    t("cli.heartbeat.revision", { revision: String(answer.revision) }),
  ];
  return lines.join("\n");
}

/** A plugin provider's disclosure and what its egress switches let it receive; nothing for the built-in. */
function providerLines(answer: HeartbeatGetAnswer, t: CoreT): readonly string[] {
  const detail = answer.providerDetails.find((provider) => provider.id === answer.config.providerId);
  if (detail === undefined || detail.kind === "builtin") return [];
  const on = detail.receives.filter((field) => answer.config.providerEgress[field]);
  const off = detail.receives.filter((field) => !on.includes(field));
  return [
    ...(detail.disclosure === undefined ? [] : [`  ${detail.disclosure}`]),
    `  ${t("cli.heartbeat.receives", {
      fields: on.length === 0 ? t("cli.heartbeat.receivesNothing") : on.join(", "),
      off: off.length === 0 ? "" : t("cli.heartbeat.receivesOff", { fields: off.join(", ") }),
    })}`,
  ];
}

/** One log row: when, what kind, what came of it, and what it cost. */
export function heartbeatLogLine(tick: HeartbeatTickRecord, t: CoreT = coreEnglish): string {
  const kind = tick.kind ?? "-";
  const outcome = tick.reason === null ? tick.outcome : `${tick.outcome} (${tick.reason})`;
  const counts = { now: String(tick.itemsNow), later: String(tick.itemsLater), resolved: String(tick.itemsRetracted) };
  const items =
    tick.itemsNow + tick.itemsLater + tick.itemsRetracted === 0
      ? ""
      : ` · ${t(tick.itemsRetracted === 0 ? "cli.heartbeat.log.items" : "cli.heartbeat.log.itemsResolved", counts)}`;
  const cost =
    tick.tokens === 0
      ? ""
      : ` · ${t("cli.heartbeat.log.tokens", { n: String(tick.tokens) })}${tick.costUsd === null ? "" : `, $${tick.costUsd.toFixed(4)}`}`;
  const context = heartbeatTickContext(tick, t)
    .map((part) => ` · ${part}`)
    .join("");
  const decided = heartbeatHookDecisions(tick.hookDecisions)
    .map(
      (decision) => ` · ${decision.by} ${decision.action} ${decision.key}${decision.reason === undefined ? "" : ` (${decision.reason})`}`,
    )
    .join("");
  return `${tick.createdAt}  ${paddedCell(kind, 6)} ${outcome}${items}${cost}${context}${tick.error === null ? "" : ` · ${tick.error}`}${decided}`;
}

/** What an action prints. */
export function heartbeatResultText(options: Pick<HeartbeatCommandOptions, "action">, result: unknown, t: CoreT = coreEnglish): string {
  switch (options.action) {
    case "log": {
      const ticks = (result as HeartbeatLogAnswer).ticks;
      return ticks.length === 0 ? t("cli.heartbeat.log.none") : ticks.map((tick) => heartbeatLogLine(tick, t)).join("\n");
    }
    case "run-now":
      return t((result as HeartbeatRunNowAnswer).status === "started" ? "cli.heartbeat.checking" : "cli.heartbeat.checkQueued");
    case "forget": {
      const removed = (result as HeartbeatForgetAnswer).removed;
      return t("cli.heartbeat.forgot", { ticks: String(removed.ticks), items: String(removed.items), tasks: String(removed.tasks) });
    }
    default:
      return heartbeatStatusText(result as HeartbeatGetAnswer, t);
  }
}
