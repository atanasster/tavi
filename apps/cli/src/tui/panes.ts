import {
  describeMemoryDeclaration,
  describePluginHeartbeat,
  describeRouterDeclaration,
  pluginRunningVersion,
  type AgentsListResult,
  type ApprovalsListResult,
  type NeedsAnswer,
  type ModelRoleBinding,
  type ModelWorkspaceDefault,
  type PluginView,
  type SchedulesListResult,
  type TaskListResult,
} from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

import { GLYPHS, divider } from "./theme.js";

/**
 * `tavi chat`'s status panes: agents and the followed task's
 * mailbox, schedules, and the workspace's pending approvals — and, beside the
 * forms that write them, stored credentials and model connections.
 * Each is a snapshot, read from the owner when asked and printed into the
 * transcript — the live region stays a few rows so Ink never clears the scrollback, and a
 * pane scrolls away like any other output.
 */

export const PANES = ["needs", "agents", "schedules", "approvals", "credentials", "models", "plugins"] as const;
export type Pane = (typeof PANES)[number];

/** How far `iso` is from `now`, in the largest whole unit: "in 3h", "5m ago". */
export function relative(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((at - now) / 1000);
  const magnitude = Math.abs(seconds);
  const span =
    magnitude < 60
      ? `${magnitude}s`
      : magnitude < 3600
        ? `${Math.floor(magnitude / 60)}m`
        : magnitude < 86_400
          ? `${Math.floor(magnitude / 3600)}h`
          : `${Math.floor(magnitude / 86_400)}d`;
  if (magnitude < 1) return "now";
  return seconds > 0 ? `in ${span}` : `${span} ago`;
}

/** A wait's length: `relative`'s span, never "in" or "now". */
const waitedFor = (since: number, now: number): string => {
  const span = relative(new Date(since).toISOString(), now);
  return span === "now" ? "0s" : span.replace(/ ago$/, "");
};

const header = (title: string, workspaceId: string): string => divider(`${title} (workspace ${workspaceId})`);

/**
 * The workspace's agents, then the mailbox of the task followed here: absent
 * from `result` when no task is followed, or when `followed` — the task the
 * chat follows — is not in this workspace.
 */
export function agentsPane(result: AgentsListResult, workspaceId: string, now: number, followed?: string): string[] {
  const lines = [header("agents", workspaceId)];
  if (result.agents.length === 0) lines.push("  none defined (`tavi agents add` defines one)");
  for (const agent of result.agents) {
    const description = agent.description === undefined ? "" : ` · ${agent.description}`;
    lines.push(
      `  ${agent.enabled ? GLYPHS.on : GLYPHS.off} ${agent.agentId} — ${agent.name}${description}${agent.enabled ? "" : " (disabled)"}`,
    );
  }
  if (result.truncated) lines.push(`  ${GLYPHS.more} more exist: \`tavi agents list\` shows every one`);
  if (result.unreadable !== undefined && result.unreadable.length > 0) {
    lines.push(`  ${GLYPHS.warning} unreadable, not shown: ${result.unreadable.join(", ")} (\`tavi doctor\`)`);
  }
  const mailbox = result.mailbox;
  if (mailbox === undefined) {
    lines.push(
      followed === undefined
        ? "  mailbox: no task followed here"
        : `  mailbox of task ${followed}: not shown, the task is not in workspace ${workspaceId}`,
    );
    return lines;
  }
  const count = `${mailbox.pending.length}${mailbox.truncated ? "+" : ""}`;
  lines.push(
    mailbox.pending.length === 0
      ? `  mailbox of task ${mailbox.taskId}: empty`
      : `  mailbox of task ${mailbox.taskId}: ${count} waiting to be received`,
  );
  for (const envelope of mailbox.pending) {
    // Undelivered past its expiry: listed still, and said to be expired.
    const expired = envelope.expiresAt !== undefined && Date.parse(envelope.expiresAt) <= now;
    const expires = envelope.expiresAt === undefined ? "" : `, ${expired ? "expired" : "expires"} ${relative(envelope.expiresAt, now)}`;
    lines.push(
      `    ${envelope.kind} from ${envelope.senderAgentId} (task ${envelope.senderTaskId}), ${relative(envelope.createdAt, now)}${expires}`,
    );
  }
  if (mailbox.truncated) lines.push(`    ${GLYPHS.more} and more`);
  return lines;
}

/** Each schedule with its next fire, or why there is none, and its last fire's outcome. */
export function schedulesPane(result: SchedulesListResult, workspaceId: string, now: number): string[] {
  const lines = [header("schedules", workspaceId)];
  if (result.schedules.length === 0) lines.push("  none (`tavi schedules add` creates one)");
  for (const schedule of result.schedules) {
    const next = !schedule.enabled ? "disabled" : schedule.nextRunAt === null ? "not armed" : `next ${relative(schedule.nextRunAt, now)}`;
    const agent = schedule.agentId === undefined ? "" : ` as ${schedule.agentId}`;
    lines.push(`  ${schedule.enabled ? GLYPHS.on : GLYPHS.off} ${schedule.name}${agent} — ${next}`);
    if (schedule.lastRunAt !== null) {
      const outcome = schedule.lastOutcome === null ? "" : `: ${schedule.lastOutcome}`;
      const task = schedule.lastRunTaskId === null ? "" : ` (task ${schedule.lastRunTaskId})`;
      lines.push(`    last ${relative(schedule.lastRunAt, now)}${outcome}${task}`);
    }
    if (schedule.consecutiveFailures > 0) {
      lines.push(`    ${GLYPHS.warning} ${plural(schedule.consecutiveFailures, "failure")} in a row`);
    }
  }
  if (result.truncated) lines.push(`  ${GLYPHS.more} more exist: \`tavi schedules list\` shows every one`);
  return lines;
}

/**
 * Everything waiting on the operator: each question
 * with its options and how long it still waits, and where to answer it — here,
 * for the task followed; `tavi answer` otherwise — then approvals and reviews.
 */
export function needsPane(result: NeedsAnswer, workspaceId: string, followed: string | undefined, now: number): string[] {
  const lines = [header("needs you", workspaceId)];
  if (result.needs.length === 0) {
    lines.push("  nothing");
    return lines;
  }
  for (const need of result.needs) {
    const due =
      need.deadlineAt === undefined ? "" : ` — ${Date.parse(need.deadlineAt) > now ? `due ${relative(need.deadlineAt, now)}` : "past due"}`;
    if (need.kind === "question") {
      const options = need.question.choices?.options.map((option, index) => `${index + 1}. ${option.label}`).join("  ");
      lines.push(
        `  ? task ${need.taskId}${need.question.originLabel === undefined ? "" : ` (${need.question.originLabel})`}: ${need.question.question}${due}`,
      );
      if (options !== undefined) lines.push(`    ${options}`);
      lines.push(need.taskId === followed ? "    type the answer here" : `    \`tavi answer ${need.taskId} <answer>\``);
    } else if (need.kind === "approval") {
      lines.push(
        `  ! task ${need.taskId}: ${need.approval.toolId}${need.approval.summary === undefined ? "" : ` ${need.approval.summary}`}${due}`,
      );
      // Decided here when it is the chat shown (its round's keys), else from any terminal.
      lines.push(
        need.taskId === followed
          ? "    decide it here, with the keys its card names"
          : `    \`tavi approvals approve|reject ${need.taskId}\``,
      );
    } else if (need.kind === "connect") {
      lines.push(`  ${GLYPHS.key} task ${need.taskId}: sign in to ${need.connect.appName} again — \`tavi apps connect\`${due}`);
    } else {
      lines.push(
        `  ${GLYPHS.notice} task ${need.taskId}: ${plural(need.review.artifactCount, "result")} to review — \`tavi artifacts list\``,
      );
    }
  }
  if (result.truncated) lines.push(`  ${GLYPHS.more} more are waiting: \`tavi needs\` shows them`);
  return lines;
}

/**
 * Pending approvals, a round to a line — the unit they are decided in —
 * each naming where it is decided: for the followed task, what the chat knows
 * (`decidedWhere`: its card, or the owner, or a schedule's fire); with
 * `--attach` or `tavi approvals` otherwise. A round cut by the listing's bound
 * is left out rather than shown with part of its calls.
 */
export function approvalsPane(
  result: ApprovalsListResult,
  workspaceId: string,
  followed: { readonly taskId: string; readonly decidedWhere: string } | undefined,
  now: number,
): string[] {
  const lines = [header("pending approvals", workspaceId)];
  if (result.rows.length === 0) {
    lines.push("  none");
    return lines;
  }
  const rounds = new Map<string, { readonly taskId: string; readonly steps: number; readonly tools: string[]; since: string }>();
  let lastKey: string | undefined;
  for (const row of result.rows) {
    const key = `${row.record.taskId}:${row.record.steps}`;
    const round = rounds.get(key) ?? { taskId: row.record.taskId, steps: row.record.steps, tools: [], since: row.record.createdAt };
    round.tools.push(row.record.toolId);
    if (row.record.createdAt < round.since) round.since = row.record.createdAt;
    rounds.set(key, round);
    lastKey = key;
  }
  // The listing stopped mid-round, maybe: its last round may miss calls.
  if (result.truncated && lastKey !== undefined && rounds.size > 1) rounds.delete(lastKey);
  for (const round of rounds.values()) {
    const which = `round ${round.steps}`;
    const where =
      round.taskId === followed?.taskId
        ? `the task followed here: ${followed.decidedWhere}`
        : `\`tavi chat --attach ${round.taskId}\` or \`tavi approvals approve|reject ${round.taskId}\``;
    // An owner's clock a little ahead of this one is no negative wait.
    const waited = Math.min(Date.parse(round.since), now);
    lines.push(
      `  task ${round.taskId}, ${which}: ${round.tools.join(", ")} — waiting ${Number.isNaN(waited) ? round.since : waitedFor(waited, now)}`,
    );
    lines.push(`    ${where}`);
  }
  if (result.truncated) lines.push(`  ${GLYPHS.more} more are pending: \`tavi approvals list\` shows every one`);
  return lines;
}

/** The credential references the owner's store holds — names only: a value is never read back. */
export function credentialsPane(result: { readonly credentials: readonly string[]; readonly unusable?: readonly string[] }): string[] {
  const lines = [divider("credentials (the owner's store)")];
  lines.push(result.credentials.length === 0 ? "  none stored" : `  ${result.credentials.join(", ")}`);
  if (result.unusable !== undefined && result.unusable.length > 0)
    lines.push(`  ${GLYPHS.warning} unusable, not a valid reference: ${result.unusable.join(", ")}`);
  lines.push("  /credentials set <reference> stores one, its value typed hidden");
  return lines;
}

/** A stored connection, as `models list` summarises it. */
export interface ConnectionSummary {
  readonly connectionId: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly credentialRef: string;
  readonly localOnly?: boolean;
  readonly defaultModel: string | null;
}

/** What `models roles` says one role resolves to: a target and where it came from, or nothing. */
export interface ResolvedRole {
  readonly role: string;
  readonly source: string | null;
  readonly target?: { readonly connectionId: string; readonly model: string };
}

/**
 * Model connections — every workspace's: they are not scoped — then this
 * workspace's default, its role bindings, and what each unbound role resolves
 * to. Roles are configuration: the owner's own runs run the default.
 */
export function modelsPane(
  connections: readonly ConnectionSummary[],
  roles: {
    readonly workspaceDefault: ModelWorkspaceDefault | null;
    readonly roles: readonly ModelRoleBinding[];
    /** Absent when the owner does not report it. */
    readonly resolved?: readonly ResolvedRole[];
  },
  workspaceId: string,
  /** What the last lifecycle sync says of the models in use; absent from an owner that does not report it. */
  lifecycle?:
    | {
        readonly checkedAt: string | null;
        readonly stale?: boolean;
        readonly unchecked?: readonly string[];
        readonly warnings: readonly {
          readonly connectionId: string;
          readonly model: string;
          readonly level: string;
          readonly says: readonly string[];
        }[];
        readonly hint?: string;
      }
    | { readonly problem: string },
): string[] {
  const lines = [header("models", workspaceId), "  connections (shared by every workspace):"];
  if (connections.length === 0) lines.push("    none (/models add adds one)");
  for (const connection of connections) {
    const model = connection.defaultModel === null ? "" : `, default ${connection.defaultModel}`;
    lines.push(
      `    ${connection.connectionId} — ${connection.baseUrl}, credential ${connection.credentialRef}${model}${connection.localOnly === true ? " (local only)" : ""}`,
    );
  }
  const target = (value: { readonly connectionId: string; readonly model: string }): string => `${value.connectionId}/${value.model}`;
  lines.push(`  default: ${roles.workspaceDefault === null ? "none (/models set-default)" : target(roles.workspaceDefault.target)}`);
  for (const binding of roles.roles) {
    const fallback = binding.fallback.length === 0 ? "" : `, then ${binding.fallback.map(target).join(", ")}`;
    lines.push(`  role ${binding.role}: ${target(binding.target)}${fallback}`);
  }
  const unbound = (roles.resolved ?? []).filter((entry) => !roles.roles.some((binding) => binding.role === entry.role));
  if (unbound.length > 0) {
    const onDefault = unbound.filter((entry) => entry.source === "workspace-default").map((entry) => entry.role);
    const nowhere = unbound.filter((entry) => entry.source === null).map((entry) => entry.role);
    if (onDefault.length > 0) lines.push(`  unbound, on the default: ${onDefault.join(", ")}`);
    if (nowhere.length > 0) lines.push(`  unbound, resolving to nothing: ${nowhere.join(", ")}`);
  }
  if (roles.roles.length > 0) lines.push("  (role bindings are configuration: the owner's own runs use the default)");
  if (lifecycle !== undefined) lines.push(...lifecycleLines(lifecycle));
  return lines;
}

/**
 * The models pane's lifecycle lines, as doctor says them: a gap (stale, not
 * yet checked) before any all-clear, and a mere notice (a deprecation with no
 * date) left to doctor, as the canvas leaves it.
 */
function lifecycleLines(lifecycle: NonNullable<Parameters<typeof modelsPane>[3]>): string[] {
  if ("problem" in lifecycle) return [`  lifecycle: could not be read (${lifecycle.problem})`];
  if (lifecycle.checkedAt === null) return [`  lifecycle: not checked${lifecycle.hint === undefined ? "" : ` (${lifecycle.hint})`}`];
  const shown = lifecycle.warnings.filter((warning) => warning.level !== "info");
  const unchecked = lifecycle.unchecked ?? [];
  const gaps = [
    ...(lifecycle.stale === true ? ["  lifecycle: stale, the daily sync has not run (tavi models sync)"] : []),
    ...(unchecked.length === 0 ? [] : [`  lifecycle: not yet checked: ${unchecked.join(", ")}`]),
  ];
  if (shown.length === 0 && gaps.length === 0)
    return [`  lifecycle: no model in use is retiring or redirected (checked ${lifecycle.checkedAt.slice(0, 10)})`];
  return [
    ...gaps,
    ...shown.map(
      (warning) =>
        `  ${warning.level === "error" ? GLYPHS.failed : GLYPHS.flagged} ${warning.connectionId}/${warning.model} ${warning.says.join("; ")}`,
    ),
  ];
}

/** The owner's plugins: each one's state there, and what awaits review. Changes are `tavi plugins` or the canvas's. */
export function pluginsPane(result: { readonly plugins: readonly PluginView[] }): string[] {
  const lines = [divider("plugins (the owner's)")];
  for (const plugin of result.plugins) {
    const pending = plugin.versions.filter((version) => version.reviewState === "proposed").map((version) => version.version);
    lines.push(
      `  ${plugin.id}${plugin.kind !== "builtin" ? ` ${plugin.activeVersion ?? ""}`.trimEnd() : ""}  ${plugin.enabled ? "enabled" : "disabled"}${plugin.phase === undefined ? "" : `, ${plugin.phase}`}${plugin.core ? " (core)" : ""}` +
        `${pending.length === 0 ? "" : `  ${GLYPHS.flagged} awaiting review: ${pending.join(", ")}`}${plugin.error === undefined ? "" : `  ${GLYPHS.failed} ${plugin.error}`}`,
    );
    const running = pluginRunningVersion(plugin);
    if (running?.router !== undefined) lines.push(`    ${describeRouterDeclaration(running.router)}`);
    for (const line of running === undefined ? [] : describePluginHeartbeat(running)) lines.push(`    ${line}`);
    if (running?.memory !== undefined) lines.push(`    ${describeMemoryDeclaration(running.memory)}`);
  }
  lines.push("  tavi plugins (or the canvas's Plugins view) installs, reviews, enables and configures them");
  return lines;
}

/**
 * `/chats`: the recent chats, the person's own Home first, each with
 * its task id, its kind, its status and its title; the one followed here is
 * marked. Workers are not chats and are not asked for.
 */
export function chatsPane(
  result: TaskListResult,
  workspaceId: string,
  reader: { readonly principalId: string; readonly homeOn: boolean; readonly followed?: string },
): string[] {
  const lines = [header("chats", workspaceId)];
  const mine = (row: TaskListResult["rows"][number]): boolean => row.chatKind === "home" && row.principalId === reader.principalId;
  // Another person's Home is a chat like any other here; with Home off, so is the reader's.
  const rows = reader.homeOn ? [...result.rows.filter(mine), ...result.rows.filter((row) => !mine(row))] : result.rows;
  if (rows.length === 0) lines.push(reader.homeOn ? "  none yet: your first message begins Home" : "  none yet");
  for (const row of rows) {
    // A channel conversation's Home says which kind it is.
    const kind =
      reader.homeOn && mine(row)
        ? "Home"
        : row.conversationHome !== undefined
          ? row.conversationHome.kind === "group"
            ? "group"
            : "dm"
          : row.chatKind === undefined || row.chatKind === "home"
            ? "chat"
            : row.chatKind;
    const title = row.title ?? row.promptPreview ?? "";
    const clipped = title.length > 60 ? `${title.slice(0, 59)}${GLYPHS.more}` : title;
    // A private chat is marked: nothing in it is remembered.
    const marked = row.memoryMode === "private" ? `private · ${clipped}` : clipped;
    lines.push(
      `  ${row.taskId === reader.followed ? GLYPHS.prompt : " "} ${row.taskId}  ${kind.padEnd(4)}  ${row.status.padEnd(14)}  ${marked}`.trimEnd(),
    );
  }
  if (result.truncated || result.nextCursor !== undefined) lines.push(`  ${GLYPHS.more} older chats too: \`tavi tasks\` lists every one`);
  lines.push(reader.homeOn ? "  /open <task-id> continues one; /home goes back to Home" : "  /open <task-id> continues one");
  return lines;
}
