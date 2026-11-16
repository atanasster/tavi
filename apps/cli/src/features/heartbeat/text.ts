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

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const TELL: Readonly<Record<string, string>> = {
  "urgent-now": "urgent things right away, the rest in a summary when the next window opens",
  "everything-now": "everything as it happens (at most the hourly limit)",
  "digest-only": "only in the summary when the next window opens",
};

/** A heartbeat's settings and state, for `status` and after every change. */
export function heartbeatStatusText(answer: HeartbeatGetAnswer): string {
  const config = answer.config;
  const paused =
    config.paused === undefined
      ? ""
      : ` (paused: ${config.paused.reason}${config.paused.until === undefined ? "" : `, until ${config.paused.until}`})`;
  const days = config.daysOfWeek === undefined ? "" : `, ${config.daysOfWeek.map((day) => DAY_NAMES[day] ?? String(day)).join(",")}`;
  const lines = [
    `Heartbeat: ${config.enabled ? "on" : "off"}${paused}${answer.state === undefined ? " (never saved; these are the defaults)" : ""}`,
    `Checks every ${formatHeartbeatInterval(config.everyMs)}, ${config.activeHours.start}–${config.activeHours.end} ${answer.timezone}${days}; looks deeper every ${formatHeartbeatInterval(config.deepCheckEveryMs)}`,
    `Tells you: ${TELL[config.tellMe] ?? config.tellMe}; at most ${config.maxNowPerHour} urgent an hour`,
    `Targets: ${config.targets.length === 0 ? "Home only" : config.targets.map((target) => `${target.connectionId} → ${target.to}`).join(", ")}`,
    `Provider: ${config.providerId}${answer.providers.length === 0 || config.providerId === "off" || answer.providers.includes(config.providerId) ? "" : " (not installed here)"}`,
    ...providerLines(answer),
    `Model: ${config.model === undefined ? "the workspace's fast model" : `${config.model.connectionId}/${config.model.model}`}; persona: ${config.agentId ?? "none"}`,
    `Limits: ${config.budget.modelTicksPerDay} checks, ${config.budget.tokensPerDay} tokens${config.budget.usdPerDay === undefined ? "" : `, $${config.budget.usdPerDay}`} a day`,
    `Extra tools: ${config.extraTools.length === 0 ? "none" : config.extraTools.join(", ")}`,
    `Sites it may read: ${config.fetchHosts.length === 0 ? "none" : config.fetchHosts.join(", ")}`,
    `Sources turned off: ${config.disabledSources.length === 0 ? "none" : config.disabledSources.join(", ")}`,
    `Provider notes: ${answer.state?.memo === undefined ? "none" : `${new TextEncoder().encode(answer.state.memo).length} bytes`}`,
    `Instructions: ${config.instructions.trim() === "" ? "none yet (tavi heartbeat edit)" : `${config.instructions.split("\n").filter((line) => line.trim() !== "").length} line(s)`}`,
    `Mutes: ${config.mutes.length === 0 ? "none" : config.mutes.join(", ")}`,
    `Next check: ${answer.state?.nextTickAt ?? "none scheduled"}; last check: ${answer.state?.lastTickAt ?? "never"}`,
    `Host: ${answer.hostRunning ? "running here" : "not running here (it runs in tavi serve)"}`,
    `Revision: ${answer.revision}`,
  ];
  return lines.join("\n");
}

/** A plugin provider's disclosure and what its egress switches let it receive; nothing for the built-in. */
function providerLines(answer: HeartbeatGetAnswer): readonly string[] {
  const detail = answer.providerDetails.find((provider) => provider.id === answer.config.providerId);
  if (detail === undefined || detail.kind === "builtin") return [];
  const on = detail.receives.filter((field) => answer.config.providerEgress[field]);
  return [
    ...(detail.disclosure === undefined ? [] : [`  ${detail.disclosure}`]),
    `  Receives: ${on.length === 0 ? "nothing yet (tavi heartbeat egress <field> on)" : on.join(", ")}${detail.receives.length > on.length ? ` (off: ${detail.receives.filter((field) => !on.includes(field)).join(", ")})` : ""}`,
  ];
}

/** One log row: when, what kind, what came of it, and what it cost. */
export function heartbeatLogLine(tick: HeartbeatTickRecord): string {
  const kind = tick.kind ?? "-";
  const outcome = tick.reason === null ? tick.outcome : `${tick.outcome} (${tick.reason})`;
  const items =
    tick.itemsNow + tick.itemsLater + tick.itemsRetracted === 0
      ? ""
      : ` · ${tick.itemsNow} now, ${tick.itemsLater} later${tick.itemsRetracted === 0 ? "" : `, ${tick.itemsRetracted} resolved`}`;
  const cost = tick.tokens === 0 ? "" : ` · ${tick.tokens} tokens${tick.costUsd === null ? "" : `, $${tick.costUsd.toFixed(4)}`}`;
  const context = heartbeatTickContext(tick)
    .map((part) => ` · ${part}`)
    .join("");
  const decided = heartbeatHookDecisions(tick.hookDecisions)
    .map(
      (decision) => ` · ${decision.by} ${decision.action} ${decision.key}${decision.reason === undefined ? "" : ` (${decision.reason})`}`,
    )
    .join("");
  return `${tick.createdAt}  ${kind.padEnd(6)} ${outcome}${items}${cost}${context}${tick.error === null ? "" : ` · ${tick.error}`}${decided}`;
}

/** What an action prints. */
export function heartbeatResultText(options: Pick<HeartbeatCommandOptions, "action">, result: unknown): string {
  switch (options.action) {
    case "log": {
      const ticks = (result as HeartbeatLogAnswer).ticks;
      return ticks.length === 0 ? "No checks yet." : ticks.map(heartbeatLogLine).join("\n");
    }
    case "run-now":
      return (result as HeartbeatRunNowAnswer).status === "started"
        ? "Checking now."
        : "A check is in progress; this one runs right after it.";
    case "forget": {
      const removed = (result as HeartbeatForgetAnswer).removed;
      return `Forgot ${removed.ticks} log row(s), ${removed.items} item(s) and ${removed.tasks} task(s). Its settings stay.`;
    }
    default:
      return heartbeatStatusText(result as HeartbeatGetAnswer);
  }
}
