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
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import stringWidth from "string-width";

import { replacementsInWords, type ModelReplacements } from "../features/models/replacements.js";
import { paddedCell } from "../shared/terminal-text.js";
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

/** `seconds` in the largest whole unit: "3h", "5m". */
function spanOf(magnitude: number, t: CoreT): string {
  return magnitude < 60
    ? t("tui.time.seconds", { n: String(magnitude) })
    : magnitude < 3600
      ? t("tui.time.minutes", { n: String(Math.floor(magnitude / 60)) })
      : magnitude < 86_400
        ? t("tui.time.hours", { n: String(Math.floor(magnitude / 3600)) })
        : t("tui.time.days", { n: String(Math.floor(magnitude / 86_400)) });
}

/** How far `iso` is from `now`, in the largest whole unit: "in 3h", "5m ago". */
export function relative(iso: string, now: number, t: CoreT = coreEnglish): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((at - now) / 1000);
  const magnitude = Math.abs(seconds);
  if (magnitude < 1) return t("tui.time.now");
  const span = spanOf(magnitude, t);
  return seconds > 0 ? t("tui.time.in", { span }) : t("tui.time.ago", { span });
}

/** A wait's length: `relative`'s span, never "in" or "now". */
const waitedFor = (since: number, now: number, t: CoreT): string => spanOf(Math.abs(Math.round((since - now) / 1000)), t);

const header = (title: string, workspaceId: string, t: CoreT): string => divider(t("tui.pane.header", { title, workspace: workspaceId }));

/** A mailbox message's kind in the chat's language. */
const MAILBOX_KINDS = {
  message: "tui.pane.mailbox.kind.message",
  request: "tui.pane.mailbox.kind.request",
  reply: "tui.pane.mailbox.kind.reply",
  progress: "tui.pane.mailbox.kind.progress",
  result: "tui.pane.mailbox.kind.result",
} as const;

/**
 * The workspace's agents, then the mailbox of the task followed here: absent
 * from `result` when no task is followed, or when `followed` — the task the
 * chat follows — is not in this workspace.
 */
export function agentsPane(
  result: AgentsListResult,
  workspaceId: string,
  now: number,
  followed?: string,
  t: CoreT = coreEnglish,
): string[] {
  const lines = [header(t("tui.pane.agents"), workspaceId, t)];
  if (result.agents.length === 0) lines.push(t("tui.pane.agents.none"));
  for (const agent of result.agents) {
    const description = agent.description === undefined ? "" : ` · ${agent.description}`;
    lines.push(
      `  ${agent.enabled ? GLYPHS.on : GLYPHS.off} ${agent.agentId} — ${agent.name}${description}${agent.enabled ? "" : t("tui.pane.agents.disabled")}`,
    );
  }
  if (result.truncated) lines.push(t("tui.pane.agents.more", { mark: GLYPHS.more }));
  if (result.unreadable !== undefined && result.unreadable.length > 0) {
    lines.push(t("tui.pane.agents.unreadable", { mark: GLYPHS.warning, ids: result.unreadable.join(", ") }));
  }
  const mailbox = result.mailbox;
  if (mailbox === undefined) {
    lines.push(
      followed === undefined ? t("tui.pane.mailbox.none") : t("tui.pane.mailbox.elsewhere", { task: followed, workspace: workspaceId }),
    );
    return lines;
  }
  const count = `${mailbox.pending.length}${mailbox.truncated ? "+" : ""}`;
  lines.push(
    mailbox.pending.length === 0
      ? t("tui.pane.mailbox.empty", { task: mailbox.taskId })
      : t("tui.pane.mailbox.waiting", { task: mailbox.taskId, count }),
  );
  for (const envelope of mailbox.pending) {
    // Undelivered past its expiry: listed still, and said to be expired.
    const expired = envelope.expiresAt !== undefined && Date.parse(envelope.expiresAt) <= now;
    const expires =
      envelope.expiresAt === undefined
        ? ""
        : t(expired ? "tui.pane.mailbox.expired" : "tui.pane.mailbox.expires", { when: relative(envelope.expiresAt, now, t) });
    lines.push(
      t("tui.pane.mailbox.envelope", {
        kind: t(MAILBOX_KINDS[envelope.kind]),
        sender: envelope.senderAgentId,
        task: envelope.senderTaskId,
        when: relative(envelope.createdAt, now, t),
        expires,
      }),
    );
  }
  if (mailbox.truncated) lines.push(t("tui.pane.mailbox.more", { mark: GLYPHS.more }));
  return lines;
}

/** Each schedule with its next fire, or why there is none, and its last fire's outcome. */
export function schedulesPane(result: SchedulesListResult, workspaceId: string, now: number, t: CoreT = coreEnglish): string[] {
  const lines = [header(t("tui.pane.schedules"), workspaceId, t)];
  if (result.schedules.length === 0) lines.push(t("tui.pane.schedules.none"));
  for (const schedule of result.schedules) {
    const next = !schedule.enabled
      ? t("tui.pane.schedules.disabled")
      : schedule.nextRunAt === null
        ? t("tui.pane.schedules.notArmed")
        : t("tui.pane.schedules.next", { when: relative(schedule.nextRunAt, now, t) });
    const agent = schedule.agentId === undefined ? "" : t("tui.pane.schedules.as", { agent: schedule.agentId });
    lines.push(`  ${schedule.enabled ? GLYPHS.on : GLYPHS.off} ${schedule.name}${agent} — ${next}`);
    if (schedule.lastRunAt !== null) {
      const outcome = schedule.lastOutcome === null ? "" : `: ${schedule.lastOutcome}`;
      const task = schedule.lastRunTaskId === null ? "" : t("tui.pane.schedules.task", { task: schedule.lastRunTaskId });
      lines.push(t("tui.pane.schedules.last", { when: relative(schedule.lastRunAt, now, t), outcome, task }));
    }
    if (schedule.consecutiveFailures > 0) {
      lines.push(
        t("tui.pane.schedules.failures", {
          mark: GLYPHS.warning,
          count: schedule.consecutiveFailures,
          n: String(schedule.consecutiveFailures),
        }),
      );
    }
  }
  if (result.truncated) lines.push(t("tui.pane.schedules.more", { mark: GLYPHS.more }));
  return lines;
}

/**
 * Everything waiting on the operator: each question
 * with its options and how long it still waits, and where to answer it — here,
 * for the task followed; `tavi answer` otherwise — then approvals and reviews.
 */
export function needsPane(
  result: NeedsAnswer,
  workspaceId: string,
  followed: string | undefined,
  now: number,
  t: CoreT = coreEnglish,
): string[] {
  const lines = [header(t("tui.pane.needs"), workspaceId, t)];
  if (result.needs.length === 0) {
    lines.push(t("tui.pane.needs.nothing"));
    return lines;
  }
  for (const need of result.needs) {
    const due =
      need.deadlineAt === undefined
        ? ""
        : ` — ${Date.parse(need.deadlineAt) > now ? t("tui.pane.needs.due", { when: relative(need.deadlineAt, now, t) }) : t("tui.pane.needs.pastDue")}`;
    if (need.kind === "question") {
      const options = need.question.choices?.options.map((option, index) => `${index + 1}. ${option.label}`).join("  ");
      lines.push(
        t("tui.pane.needs.question", {
          task: need.taskId,
          origin: need.question.originLabel === undefined ? "" : ` (${need.question.originLabel})`,
          question: need.question.question,
          due,
        }),
      );
      if (options !== undefined) lines.push(`    ${options}`);
      lines.push(need.taskId === followed ? t("tui.pane.needs.answerHere") : `    \`tavi answer ${need.taskId} <answer>\``);
    } else if (need.kind === "approval") {
      lines.push(
        t("tui.pane.needs.approval", {
          task: need.taskId,
          tool: need.approval.toolId,
          summary: need.approval.summary === undefined ? "" : ` ${need.approval.summary}`,
          due,
        }),
      );
      // Decided here when it is the chat shown (its round's keys), else from any terminal.
      lines.push(need.taskId === followed ? t("tui.pane.needs.decideHere") : `    \`tavi approvals approve|reject ${need.taskId}\``);
    } else if (need.kind === "connect") {
      lines.push(t("tui.pane.needs.connect", { mark: GLYPHS.key, task: need.taskId, app: need.connect.appName, due }));
    } else {
      lines.push(
        t("tui.pane.needs.review", {
          mark: GLYPHS.notice,
          task: need.taskId,
          count: need.review.artifactCount,
          n: String(need.review.artifactCount),
        }),
      );
    }
  }
  if (result.truncated) lines.push(t("tui.pane.needs.more", { mark: GLYPHS.more }));
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
  t: CoreT = coreEnglish,
): string[] {
  const lines = [header(t("tui.pane.approvals"), workspaceId, t)];
  if (result.rows.length === 0) {
    lines.push(t("tui.pane.approvals.none"));
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
    const where =
      round.taskId === followed?.taskId
        ? t("tui.pane.approvals.followed", { where: followed.decidedWhere })
        : t("tui.pane.approvals.elsewhere", { task: round.taskId });
    // An owner's clock a little ahead of this one is no negative wait.
    const waited = Math.min(Date.parse(round.since), now);
    lines.push(
      t("tui.pane.approvals.round", {
        task: round.taskId,
        steps: String(round.steps),
        tools: round.tools.join(", "),
        waited: Number.isNaN(waited) ? round.since : waitedFor(waited, now, t),
      }),
    );
    lines.push(`    ${where}`);
  }
  if (result.truncated) lines.push(t("tui.pane.approvals.more", { mark: GLYPHS.more }));
  return lines;
}

/** The credential references the owner's store holds — names only: a value is never read back. */
export function credentialsPane(
  result: { readonly credentials: readonly string[]; readonly unusable?: readonly string[] },
  t: CoreT = coreEnglish,
): string[] {
  const lines = [divider(t("tui.pane.credentials"))];
  lines.push(result.credentials.length === 0 ? t("tui.pane.credentials.none") : `  ${result.credentials.join(", ")}`);
  if (result.unusable !== undefined && result.unusable.length > 0)
    lines.push(t("tui.pane.credentials.unusable", { mark: GLYPHS.warning, names: result.unusable.join(", ") }));
  lines.push(t("tui.pane.credentials.how"));
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
          readonly replacements?: ModelReplacements;
        }[];
        readonly hint?: string;
      }
    | { readonly problem: string },
  t: CoreT = coreEnglish,
): string[] {
  const lines = [header(t("tui.pane.models"), workspaceId, t), t("tui.pane.models.connections")];
  if (connections.length === 0) lines.push(t("tui.pane.models.noConnections"));
  for (const connection of connections) {
    lines.push(
      t("tui.pane.models.connection", {
        connection: connection.connectionId,
        baseUrl: connection.baseUrl,
        credential: connection.credentialRef,
        model: connection.defaultModel === null ? "" : t("tui.pane.models.connectionDefault", { model: connection.defaultModel }),
        local: connection.localOnly === true ? t("tui.pane.models.localOnly") : "",
      }),
    );
  }
  const target = (value: { readonly connectionId: string; readonly model: string }): string => `${value.connectionId}/${value.model}`;
  lines.push(
    t("tui.pane.models.default", {
      target: roles.workspaceDefault === null ? t("tui.pane.models.noDefault") : target(roles.workspaceDefault.target),
    }),
  );
  for (const binding of roles.roles) {
    const fallback = binding.fallback.length === 0 ? "" : t("tui.pane.models.then", { targets: binding.fallback.map(target).join(", ") });
    lines.push(t("tui.pane.models.role", { role: binding.role, target: target(binding.target), fallback }));
  }
  const unbound = (roles.resolved ?? []).filter((entry) => !roles.roles.some((binding) => binding.role === entry.role));
  if (unbound.length > 0) {
    const onDefault = unbound.filter((entry) => entry.source === "workspace-default").map((entry) => entry.role);
    const nowhere = unbound.filter((entry) => entry.source === null).map((entry) => entry.role);
    if (onDefault.length > 0) lines.push(t("tui.pane.models.onDefault", { roles: onDefault.join(", ") }));
    if (nowhere.length > 0) lines.push(t("tui.pane.models.nowhere", { roles: nowhere.join(", ") }));
  }
  if (roles.roles.length > 0) lines.push(t("tui.pane.models.rolesNote"));
  if (lifecycle !== undefined) lines.push(...lifecycleLines(lifecycle, t));
  return lines;
}

/**
 * The models pane's lifecycle lines, as doctor says them: a gap (stale, not
 * yet checked) before any all-clear, and a mere notice (a deprecation with no
 * date) left to doctor, as the canvas leaves it.
 */
function lifecycleLines(lifecycle: NonNullable<Parameters<typeof modelsPane>[3]>, t: CoreT): string[] {
  if ("problem" in lifecycle) return [t("tui.pane.lifecycle.problem", { problem: lifecycle.problem })];
  if (lifecycle.checkedAt === null)
    return [
      lifecycle.hint === undefined ? t("tui.pane.lifecycle.notChecked") : t("tui.pane.lifecycle.notCheckedHint", { hint: lifecycle.hint }),
    ];
  const shown = lifecycle.warnings.filter((warning) => warning.level !== "info");
  const unchecked = lifecycle.unchecked ?? [];
  const gaps = [
    ...(lifecycle.stale === true ? [t("tui.pane.lifecycle.stale")] : []),
    ...(unchecked.length === 0 ? [] : [t("tui.pane.lifecycle.unchecked", { models: unchecked.join(", ") })]),
  ];
  if (shown.length === 0 && gaps.length === 0) return [t("tui.pane.lifecycle.clear", { date: lifecycle.checkedAt.slice(0, 10) })];
  return [
    ...gaps,
    ...shown.flatMap((warning) => {
      const replace = replacementsInWords(warning.replacements);
      return [
        `  ${warning.level === "error" ? GLYPHS.failed : GLYPHS.flagged} ${warning.connectionId}/${warning.model} ${warning.says.join("; ")}`,
        ...(replace === undefined ? [] : [`      ${replace}`]),
      ];
    }),
  ];
}

/** The owner's plugins: each one's state there, and what awaits review. Changes are `tavi plugins` or the canvas's. */
export function pluginsPane(result: { readonly plugins: readonly PluginView[] }, t: CoreT = coreEnglish): string[] {
  const lines = [divider(t("tui.pane.plugins"))];
  for (const plugin of result.plugins) {
    const pending = plugin.versions.filter((version) => version.reviewState === "proposed").map((version) => version.version);
    lines.push(
      `  ${plugin.id}${plugin.kind !== "builtin" ? ` ${plugin.activeVersion ?? ""}`.trimEnd() : ""}  ${t(plugin.enabled ? "tui.pane.plugins.enabled" : "tui.pane.plugins.disabled")}${plugin.phase === undefined ? "" : `, ${plugin.phase}`}${plugin.core ? t("tui.pane.plugins.core") : ""}` +
        `${pending.length === 0 ? "" : t("tui.pane.plugins.awaiting", { mark: GLYPHS.flagged, versions: pending.join(", ") })}${plugin.error === undefined ? "" : `  ${GLYPHS.failed} ${plugin.error}`}`,
    );
    const running = pluginRunningVersion(plugin);
    if (running?.router !== undefined) lines.push(`    ${describeRouterDeclaration(running.router, t)}`);
    for (const line of running === undefined ? [] : describePluginHeartbeat(running, t)) lines.push(`    ${line}`);
    if (running?.memory !== undefined) lines.push(`    ${describeMemoryDeclaration(running.memory, t)}`);
  }
  lines.push(t("tui.pane.plugins.how"));
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
  t: CoreT = coreEnglish,
): string[] {
  const lines = [header(t("tui.pane.chats"), workspaceId, t)];
  const mine = (row: TaskListResult["rows"][number]): boolean => row.chatKind === "home" && row.principalId === reader.principalId;
  // Another person's Home is a chat like any other here; with Home off, so is the reader's.
  const rows = reader.homeOn ? [...result.rows.filter(mine), ...result.rows.filter((row) => !mine(row))] : result.rows;
  if (rows.length === 0) lines.push(t(reader.homeOn ? "tui.pane.chats.noneHome" : "tui.pane.chats.none"));
  // The kind's column fits the widest of Home, dm and chat in this language (4 in English); a group's
  // name, rarer, may run one past it, as it always has. The status is a code: its column is 14 wide, or as
  // wide as the widest status listed (`awaiting_approval`), so the titles after it line up.
  const kindWidth = Math.max(
    4,
    ...(
      [
        "tui.pane.chats.kind.home",
        "tui.pane.chats.kind.dm",
        "tui.pane.chats.kind.chat",
        "tui.pane.chats.kind.side",
        "tui.pane.chats.kind.run",
      ] as const
    ).map((key) => stringWidth(t(key))),
  );
  const statusWidth = Math.max(14, ...rows.map((row) => stringWidth(row.status)));
  for (const row of rows) {
    // A channel conversation's Home says which kind it is.
    const kind =
      reader.homeOn && mine(row)
        ? t("tui.pane.chats.kind.home")
        : row.conversationHome !== undefined
          ? row.conversationHome.kind === "group"
            ? t("tui.pane.chats.kind.group")
            : t("tui.pane.chats.kind.dm")
          : row.chatKind === undefined || row.chatKind === "home"
            ? t("tui.pane.chats.kind.chat")
            : row.chatKind === "side"
              ? t("tui.pane.chats.kind.side")
              : row.chatKind === "run"
                ? t("tui.pane.chats.kind.run")
                : row.chatKind;
    const title = row.title ?? row.promptPreview ?? "";
    const clipped = title.length > 60 ? `${title.slice(0, 59)}${GLYPHS.more}` : title;
    // A private chat is marked: nothing in it is remembered.
    const marked = row.memoryMode === "private" ? t("tui.pane.chats.private", { title: clipped }) : clipped;
    lines.push(
      `  ${row.taskId === reader.followed ? GLYPHS.prompt : " "} ${row.taskId}  ${paddedCell(kind, kindWidth)}  ${paddedCell(row.status, statusWidth)}  ${marked}`.trimEnd(),
    );
  }
  if (result.truncated || result.nextCursor !== undefined) lines.push(t("tui.pane.chats.older", { mark: GLYPHS.more }));
  lines.push(t(reader.homeOn ? "tui.pane.chats.howHome" : "tui.pane.chats.how"));
  return lines;
}
