import {
  HEARTBEAT_PAUSE_MAX_MS,
  daysOfWeekText,
  formatHeartbeatInterval,
  type HeartbeatGetAnswer,
  type HeartbeatPauseReason,
  type ModCommandDeclaration,
  type ModCommandInput,
  type ModCommandResult,
  navPath,
  renderTextRef,
} from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

import { channelWords, workspaceLocaleOf, zonedClock } from "../channels/channel-words.js";

import { parseHeartbeatDuration } from "./parse.js";
import { heartbeatCommand, type HeartbeatCommandDependencies } from "./owner.js";

/**
 * `/heartbeat`: the first built-in mods
 * command, so it reaches the terminal, the canvas and channels alike — the
 * operator's status, `pause [2h]`, `resume` and `now`. `now` queues a check and
 * answers at once, within the command budget. It only narrows or checks:
 * settings change in Center → Heartbeat, `tavi heartbeat`, or by asking.
 */

export const HEARTBEAT_COMMANDS: readonly ModCommandDeclaration[] = [
  { name: "heartbeat", description: "Your heartbeat: its status, pause [2h], resume, or now to check at once." },
];

/** How `/heartbeat` is used, and where its settings change. */
const usage = (t: CoreT): string =>
  t("channel.heartbeat.usage", { path: renderTextRef(navPath("nav.route.center", "nav.center.heartbeat"), t) ?? "" });

/** Why it is paused, as Center → Heartbeat says it (HEARTBEAT.md). */
const PAUSED_WHY = {
  user: "channel.heartbeat.paused.user",
  budget: "channel.heartbeat.paused.budget",
  failures: "channel.heartbeat.paused.failures",
  provider: "channel.heartbeat.paused.provider",
} as const satisfies Readonly<Record<HeartbeatPauseReason, string>>;

/** A check interval in `t`'s words: "30m", "2h" (`formatHeartbeatInterval`'s). */
function intervalText(ms: number, t: CoreT): string {
  if (t === coreEnglish) return formatHeartbeatInterval(ms);
  const said = formatHeartbeatInterval(ms);
  const unit = said.slice(-1);
  const n = said.slice(0, -1);
  return t(unit === "h" ? "channel.heartbeat.interval.h" : unit === "m" ? "channel.heartbeat.interval.m" : "channel.heartbeat.interval.s", {
    n,
  });
}

/** "on · next 14:32" and the rest of the status line. */
function statusLine(result: HeartbeatGetAnswer, t: CoreT = coreEnglish): string {
  const clock = (iso: string): string => zonedClock(new Date(iso), result.timezone);
  const { config } = result;
  const paused =
    config.paused === undefined
      ? undefined
      : config.paused.until === undefined
        ? t(PAUSED_WHY[config.paused.reason])
        : t("channel.heartbeat.pausedUntil", { why: t(PAUSED_WHY[config.paused.reason]), time: clock(config.paused.until) });
  // Off and paused: said, so turning it on later does not find it still paused unawares.
  if (!config.enabled) return paused === undefined ? t("channel.heartbeat.off") : t("channel.heartbeat.offPaused", { paused });
  // The days as `tavi heartbeat hours` sets them: none said when it checks every day.
  const days = daysOfWeekText(config.daysOfWeek, t);
  const window = t(days === undefined ? "channel.heartbeat.window" : "channel.heartbeat.windowDays", {
    every: intervalText(config.everyMs, t),
    days: days ?? "",
    start: config.activeHours.start,
    end: config.activeHours.end,
    zone: result.timezone,
  });
  if (paused !== undefined) return t("channel.heartbeat.statusPaused", { paused, window });
  const next = result.state?.nextTickAt === undefined ? "" : t("channel.heartbeat.next", { time: clock(result.state.nextTickAt) });
  const last = result.state?.lastTickAt === undefined ? "" : t("channel.heartbeat.last", { time: clock(result.state.lastTickAt) });
  return t("channel.heartbeat.on", { next, last, window });
}

export function heartbeatSlashCommand(deps: HeartbeatCommandDependencies): (input: ModCommandInput) => Promise<ModCommandResult> {
  return async ({ envelope, args }) => {
    const t = await channelWords(workspaceLocaleOf(deps.repositories.workspaceSettings), envelope.workspaceId, deps.onDiagnostic);
    const USAGE = usage(t);
    if (deps.principalOf(envelope.workspaceId) !== envelope.principalId) return { text: t("channel.heartbeat.operatorOnly") };
    const [verb = "status", amount, ...extra] = args
      .trim()
      .split(/\s+/)
      .filter((part) => part !== "");
    const scope = { workspaceId: envelope.workspaceId, principalId: envelope.principalId };
    if (extra.length > 0) return { text: USAGE };
    /** The heartbeat after an action, as one line, or the owner's refusal in its words. */
    const said = (answer: Awaited<ReturnType<typeof heartbeatCommand>>): ModCommandResult => {
      if (!answer.ok) return { text: answer.error.message };
      return "config" in answer.result ? { text: statusLine(answer.result, t) } : { text: USAGE };
    };
    switch (verb) {
      case "status":
        return amount === undefined ? said(await heartbeatCommand(deps, { action: "get", ...scope })) : { text: USAGE };
      case "pause": {
        const forMs = amount === undefined ? undefined : parseHeartbeatDuration(amount);
        if (amount !== undefined && (forMs === undefined || forMs > HEARTBEAT_PAUSE_MAX_MS))
          return { text: t("channel.heartbeat.pauseUsage") };
        return said(await heartbeatCommand(deps, { action: "pause", ...scope, ...(forMs === undefined ? {} : { forMs }) }));
      }
      case "resume":
        return amount === undefined ? said(await heartbeatCommand(deps, { action: "resume", ...scope })) : { text: USAGE };
      case "now": {
        if (amount !== undefined) return { text: USAGE };
        const answer = await heartbeatCommand(deps, { action: "run-now", ...scope });
        if (!answer.ok) return { text: answer.error.message };
        return {
          text:
            "status" in answer.result && answer.result.status === "started"
              ? t("channel.heartbeat.checking")
              : t("channel.heartbeat.queued"),
        };
      }
      default:
        return { text: USAGE };
    }
  };
}
