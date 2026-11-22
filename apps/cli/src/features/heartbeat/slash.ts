import {
  HEARTBEAT_PAUSE_MAX_MS,
  daysOfWeekText,
  formatHeartbeatInterval,
  type HeartbeatGetAnswer,
  type HeartbeatPauseReason,
  type ModCommandDeclaration,
  type ModCommandInput,
  type ModCommandResult,
  englishOf,
  navPath,
} from "@tavi/contracts";

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

const USAGE = `Usage: /heartbeat [status | pause [30m|2h|1d] | resume | now]. Change its settings in ${englishOf(navPath("nav.route.center", "nav.center.heartbeat"))}, with tavi heartbeat, or by asking.`;

/** Why it is paused, as Center → Heartbeat says it (HEARTBEAT.md). */
const PAUSED_WHY: Readonly<Record<HeartbeatPauseReason, string>> = {
  user: "by you",
  budget: "(today's limit was reached)",
  failures: "(it failed repeatedly)",
  provider: "(its provider is unavailable)",
};

/** "on · next 14:32" and the rest of the status line. */
function statusLine(result: HeartbeatGetAnswer): string {
  const clock = (iso: string): string =>
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: result.timezone }).format(
      new Date(iso),
    );
  const { config } = result;
  const paused =
    config.paused === undefined
      ? undefined
      : `paused ${PAUSED_WHY[config.paused.reason]}${config.paused.until === undefined ? "" : ` until ${clock(config.paused.until)}`}`;
  // Off and paused: said, so turning it on later does not find it still paused unawares.
  if (!config.enabled) return paused === undefined ? "Heartbeat off." : `Heartbeat off (and ${paused}).`;
  // The days as `tavi heartbeat hours` sets them: none said when it checks every day.
  const days = daysOfWeekText(config.daysOfWeek);
  const window = `every ${formatHeartbeatInterval(config.everyMs)}, ${days === undefined ? "" : `${days} `}${config.activeHours.start}–${config.activeHours.end} ${result.timezone}`;
  if (paused !== undefined) return `Heartbeat ${paused} · ${window}.`;
  const next = result.state?.nextTickAt === undefined ? "" : ` · next check ${clock(result.state.nextTickAt)}`;
  const last = result.state?.lastTickAt === undefined ? "" : ` · last ${clock(result.state.lastTickAt)}`;
  return `Heartbeat on${next}${last} · ${window}.`;
}

export function heartbeatSlashCommand(deps: HeartbeatCommandDependencies): (input: ModCommandInput) => Promise<ModCommandResult> {
  return async ({ envelope, args }) => {
    if (deps.principalOf(envelope.workspaceId) !== envelope.principalId) return { text: "/heartbeat is the workspace operator's." };
    const [verb = "status", amount, ...extra] = args
      .trim()
      .split(/\s+/)
      .filter((part) => part !== "");
    const scope = { workspaceId: envelope.workspaceId, principalId: envelope.principalId };
    if (extra.length > 0) return { text: USAGE };
    /** The heartbeat after an action, as one line, or the owner's refusal in its words. */
    const said = (answer: Awaited<ReturnType<typeof heartbeatCommand>>): ModCommandResult => {
      if (!answer.ok) return { text: answer.error.message };
      return "config" in answer.result ? { text: statusLine(answer.result) } : { text: USAGE };
    };
    switch (verb) {
      case "status":
        return amount === undefined ? said(await heartbeatCommand(deps, { action: "get", ...scope })) : { text: USAGE };
      case "pause": {
        const forMs = amount === undefined ? undefined : parseHeartbeatDuration(amount);
        if (amount !== undefined && (forMs === undefined || forMs > HEARTBEAT_PAUSE_MAX_MS))
          return { text: "Pause for a duration such as 30m, 2h or 1d (at most 7d), or with none until you resume." };
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
            "status" in answer.result && answer.result.status === "started" ? "Checking now." : "A check is running; this one follows it.",
        };
      }
      default:
        return { text: USAGE };
    }
  };
}
