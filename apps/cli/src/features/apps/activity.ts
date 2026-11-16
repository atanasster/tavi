import { z } from "zod";

import {
  TaviError,
  type AppActivityRow,
  type AppsActivityAnswer,
  type ApprovalHistoryInput,
  type ApprovalsHistoryResult,
  type ConnectableApp,
  type EffectActivity,
  type EffectActivityQuery,
  type ToolCallActivity,
  type ToolCallActivityQuery,
} from "@tavi/contracts";

import { noSuchAccount } from "./accounts.js";

/**
 * An app's Recent activity: what its
 * tools changed or sent (the effect ledger) and what you were asked about
 * them (the approval history), and its read-only tools' calls (as
 * recorded from then on, whatever came of each), newest first. A changing or
 * sending tool's call shows as its effect, so it is not listed twice.
 */

/** Rows a page of activity holds. */
export const ACTIVITY_PAGE = 50;

/** Where the activity reads from: the workspace's effects, approvals and recorded calls. */
export interface AppsActivitySources {
  readonly effects: (query: EffectActivityQuery) => Promise<readonly EffectActivity[]>;
  readonly approvals: (input: ApprovalHistoryInput) => Promise<ApprovalsHistoryResult>;
  readonly calls: (query: ToolCallActivityQuery) => Promise<readonly ToolCallActivity[]>;
}

/** The last row each source gave a page: the next page starts after it, in that source's order. */
const CursorSchema = z.strictObject({
  effect: z.strictObject({ at: z.string().max(64), key: z.string().max(512) }).optional(),
  approval: z.strictObject({ at: z.string().max(64), id: z.string().max(128) }).optional(),
  read: z.strictObject({ at: z.string().max(64), key: z.string().max(512) }).optional(),
});
type Cursor = z.infer<typeof CursorSchema>;

function decodeCursor(cursor: string | undefined): Cursor {
  if (cursor === undefined) return {};
  try {
    return CursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new TaviError("INVALID_INPUT", "the activity cursor is not one this owner gave");
  }
}

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

/** After the cursor's row, in `(at DESC, id DESC)` order. */
const after = (at: string, id: string, last: { readonly at: string; readonly id: string } | undefined): boolean =>
  last === undefined || at < last.at || (at === last.at && id < last.id);

/** An account and the prefix its tools' ids share: a plugin's own id, or a channel mailbox's tools. */
export interface ActivityAccount {
  readonly accountId: string;
  readonly prefix: string;
}

export async function appActivity(
  sources: AppsActivitySources,
  app: ConnectableApp,
  input: { readonly accountId?: string | undefined; readonly cursor?: string | undefined; readonly workspaceId: string },
  accountTools?: readonly ActivityAccount[],
): Promise<AppsActivityAnswer> {
  const all = accountTools ?? app.source.pluginIds.map((pluginId) => ({ accountId: pluginId, prefix: `${pluginId}.` }));
  const known = new Set([...all.map((account) => account.accountId), ...app.accounts.map((account) => account.accountId)]);
  if (input.accountId !== undefined && !known.has(input.accountId)) throw noSuchAccount(app, input.accountId);
  const accounts = input.accountId === undefined ? all : all.filter((account) => account.accountId === input.accountId);
  // An account with no tools of its own (a channel connection whose mailbox is off) has no activity here.
  if (accounts.length === 0) return { rows: [], readsListed: true };
  const prefixes = accounts.map((account) => account.prefix);
  const cursor = decodeCursor(input.cursor);
  const accountOf = (toolId: string): string => accounts.find((account) => toolId.startsWith(account.prefix))?.accountId ?? toolId;
  const titleOf = (toolId: string, taskTitle: string | undefined): string => {
    const tool = app.tools.find((candidate) => candidate.toolId === toolId)?.title ?? toolId;
    return (taskTitle === undefined ? tool : `${tool} · ${taskTitle}`).slice(0, 300);
  };

  const effects = await sources.effects({
    workspaceId: input.workspaceId,
    prefixes,
    limit: ACTIVITY_PAGE + 1,
    ...(cursor.effect === undefined ? {} : { before: { at: cursor.effect.at, effectKey: cursor.effect.key } }),
  });
  // The history's own cursor names its last item, not one a merged page stopped at: read from the time, and drop what was shown.
  const history = await sources.approvals({
    workspaceId: input.workspaceId,
    toolPrefixes: prefixes,
    kinds: ["approval"],
    limit: ACTIVITY_PAGE * 2,
    ...(cursor.approval === undefined ? {} : { until: cursor.approval.at }),
  });
  const approvals = history.items.flatMap((item) =>
    item.kind === "approval" && after(item.decidedAt, item.approvalId, cursor.approval) ? [item] : [],
  );
  // Only its read-only tools' calls, of the accounts asked for: a changing or sending one shows as its effect.
  const readOnly = app.tools
    .filter((tool) => tool.effect === "read-only" && prefixes.some((prefix) => tool.toolId.startsWith(prefix)))
    .map((tool) => tool.toolId);
  const reads =
    readOnly.length === 0
      ? []
      : await sources.calls({
          workspaceId: input.workspaceId,
          toolIds: readOnly,
          limit: ACTIVITY_PAGE + 1,
          ...(cursor.read === undefined ? {} : { before: { at: cursor.read.at, callKey: cursor.read.key } }),
        });

  type Merged = { readonly row: AppActivityRow; readonly source: "effect" | "approval" | "read"; readonly id: string };
  const merged: Merged[] = [
    ...effects.map(
      (effect): Merged => ({
        source: "effect",
        id: effect.effectKey,
        row: {
          id: effect.effectKey,
          at: effect.createdAt,
          taskId: effect.taskId,
          toolId: effect.toolId,
          accountId: accountOf(effect.toolId),
          kind: "effect",
          state: effect.state,
          title: titleOf(effect.toolId, effect.taskTitle),
        },
      }),
    ),
    ...approvals.map(
      (item): Merged => ({
        source: "approval",
        id: item.approvalId,
        row: {
          id: item.approvalId,
          at: item.decidedAt,
          taskId: item.taskId,
          toolId: item.toolId,
          accountId: accountOf(item.toolId),
          kind: "approval",
          state: item.state,
          title: titleOf(item.toolId, item.taskTitle),
        },
      }),
    ),
    ...reads.map(
      (call): Merged => ({
        source: "read",
        id: call.callKey,
        row: {
          id: call.callKey,
          at: call.at,
          taskId: call.taskId,
          toolId: call.toolId,
          accountId: accountOf(call.toolId),
          kind: "read",
          state: "called",
          title: titleOf(call.toolId, call.taskTitle),
        },
      }),
    ),
  ].sort((a, b) => (a.row.at === b.row.at ? 0 : a.row.at < b.row.at ? 1 : -1));
  const page = merged.slice(0, ACTIVITY_PAGE);
  const more = merged.length > ACTIVITY_PAGE || history.nextCursor !== undefined;
  if (!more) return { rows: page.map((each) => each.row), readsListed: true };
  const lastEffect = page.filter((each) => each.source === "effect").at(-1);
  const lastApproval = page.filter((each) => each.source === "approval").at(-1);
  const lastRead = page.filter((each) => each.source === "read").at(-1);
  const next: Cursor = {
    ...(lastEffect === undefined
      ? cursor.effect === undefined
        ? {}
        : { effect: cursor.effect }
      : { effect: { at: lastEffect.row.at, key: lastEffect.id } }),
    ...(lastApproval === undefined
      ? cursor.approval === undefined
        ? {}
        : { approval: cursor.approval }
      : { approval: { at: lastApproval.row.at, id: lastApproval.id } }),
    ...(lastRead === undefined
      ? cursor.read === undefined
        ? {}
        : { read: cursor.read }
      : { read: { at: lastRead.row.at, key: lastRead.id } }),
  };
  return { rows: page.map((each) => each.row), cursor: encodeCursor(next), readsListed: true };
}
