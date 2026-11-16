import type { McpNoticeKind, McpNoticeRecord, PostNoticeInput } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";

import type { McpActionContext } from "./actions.js";
import { serverLine } from "./results.js";

/**
 * MCP server notices: an
 * owner-wide queue, one open notice per server and kind, in Tavi's own words
 * only (a server's text never reaches a notice). Each is shown in Center and
 * `tavi mcp review`; posted in the operator's Home as a display-only `mcp`
 * notice, edited in place; and sent once a day at most to each of the
 * operator's delivery targets that is a direct chat bound to the operator, as
 * plain text with no buttons. It is decided in Center or the CLI only.
 */

type AsyncMcpRepository = McpActionContext["mcp"];

/** A channel message for one notice goes out at most this often (an update meanwhile edits only Home). */
const NOTICE_SEND_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface McpNoticeDeliveryDeps {
  readonly mcp: AsyncMcpRepository;
  /** The workspaces whose operator is told: those whose `mcp.servers` allows it, else the one it was added from. */
  readonly workspacesOf: (pluginId: string) => Promise<readonly string[]>;
  readonly operatorOf: (workspaceId: string) => string | undefined;
  /** The operator's Home chat, when it is on. */
  readonly homeOf: (workspaceId: string, principalId: string) => Promise<string | undefined>;
  readonly postNotice: (input: PostNoticeInput) => Promise<unknown>;
  /** The operator's delivery targets (the routines' targets reminders and the digest use). */
  readonly targets: (
    workspaceId: string,
    principalId: string,
  ) => Promise<readonly { readonly connectionId: string; readonly chatId: string }[]>;
  /** Who a channel's sender is bound to. */
  readonly boundTo: (
    connectionId: string,
    senderId: string,
  ) => Promise<{ readonly workspaceId: string; readonly principalId: string } | undefined>;
  readonly isLocalConnection: (connectionId: string) => boolean;
  /** Sends plain text to a direct chat; `effectId` makes a retry idempotent. */
  readonly send: (input: {
    readonly effectId: string;
    readonly workspaceId: string;
    readonly connectionId: string;
    readonly chatId: string;
    readonly text: string;
  }) => Promise<void>;
  readonly now: () => string;
  readonly log?: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
}

/** A notice in Tavi's words: what happened and what to do. */
export function noticeWords(notice: Pick<McpNoticeRecord, "pluginId" | "kind" | "detail">): {
  readonly title: string;
  readonly summary: string;
} {
  const detail = notice.detail;
  // Tool ids; one stored before ids, a server's name, is cleaned and cut like any of its text.
  const names = (key: string): readonly string[] =>
    Array.isArray(detail[key])
      ? (detail[key] as unknown[]).filter((name): name is string => typeof name === "string").map((name) => serverLine(name, 80))
      : [];
  switch (notice.kind) {
    case "drift": {
      const withheld = names("withheld");
      const added = names("added");
      const removed = names("removed");
      const parts = [
        withheld.length === 0
          ? undefined
          : `${String(withheld.length)} changed and withheld (${withheld.slice(0, 5).join(", ")}${withheld.length > 5 ? ", …" : ""})`,
        added.length === 0 ? undefined : `${String(added.length)} new, waiting for review`,
        removed.length === 0 ? undefined : `${String(removed.length)} removed`,
        detail["instructions"] === true ? "its instructions changed (nothing withheld; read them in the review)" : undefined,
      ].filter((part): part is string => part !== undefined);
      const rules = names("rules");
      return {
        title: `${notice.pluginId}: its tools changed`,
        summary: `${parts.join("; ")}.${rules.length === 0 ? "" : ` Allow rules still cover ${rules.join(", ")}.`} Review with \`tavi mcp review ${notice.pluginId}\`.`,
      };
    }
    case "failed":
      return {
        title: `${notice.pluginId} stopped after repeated failures`,
        summary: `Its tools are withdrawn. See \`tavi mcp logs ${notice.pluginId}\`, then probe it again once it is fixed.`,
      };
    case "budget":
      return {
        title: `${notice.pluginId}'s tools do not fit`,
        summary: "A workspace lists more MCP tools than fit beside the others. Set its exposure to search, or disable another server.",
      };
    case "login":
      // The cause is Tavi's words (`loginCause`), never the server's.
      return {
        title: `${notice.pluginId} needs you to sign in again`,
        summary: `${typeof detail["cause"] === "string" ? `${detail["cause"].charAt(0).toUpperCase()}${detail["cause"].slice(1)}. ` : ""}Its tools fail until you do: \`tavi mcp login ${notice.pluginId}\`.`,
      };
    case "scope":
      return {
        title: `${notice.pluginId} asks for more access`,
        summary: `A call needed a permission its sign-in was not granted. Nothing was asked for: sign in again with \`tavi mcp login ${notice.pluginId}\` to grant it.`,
      };
  }
}

/** The plain message a channel gets: no buttons, and where to decide it. */
export function noticeChannelText(notice: Pick<McpNoticeRecord, "pluginId" | "kind" | "detail">): string {
  const words = noticeWords(notice);
  return `${words.title}. ${words.summary}\nOpen in Tavi: Center → Waiting on you → Servers`;
}

/**
 * Raises (or updates) one server notice and tells the operator: Home edited
 * in place every time, channels once a day at most. A delivery failure is
 * logged; the notice stands in Center.
 */
export async function raiseMcpNotice(
  deps: McpNoticeDeliveryDeps,
  input: { readonly pluginId: string; readonly kind: McpNoticeKind; readonly detail: Readonly<Record<string, unknown>> },
): Promise<McpNoticeRecord> {
  const notice = await deps.mcp.upsertNotice({
    noticeId: prefixedId("mcpn"),
    pluginId: input.pluginId,
    kind: input.kind,
    detail: input.detail,
    now: deps.now(),
  });
  try {
    await deliverMcpNotice(deps, notice);
  } catch (error) {
    deps.log?.("an MCP notice could not be delivered; it waits in Center", {
      pluginId: input.pluginId,
      kind: input.kind,
      reason: errorMessage(error),
    });
  }
  return notice;
}

export async function deliverMcpNotice(deps: McpNoticeDeliveryDeps, notice: McpNoticeRecord): Promise<void> {
  const words = noticeWords(notice);
  const lastSent = typeof notice.delivered["sentAt"] === "string" ? Date.parse(notice.delivered["sentAt"]) : Number.NaN;
  const sendNow = Number.isNaN(lastSent) || Date.parse(deps.now()) - lastSent >= NOTICE_SEND_INTERVAL_MS;
  let sent = 0;
  for (const workspaceId of await deps.workspacesOf(notice.pluginId)) {
    const operator = deps.operatorOf(workspaceId);
    if (operator === undefined) continue;
    const home = await deps.homeOf(workspaceId, operator);
    if (home !== undefined) {
      await deps.postNotice({
        noticeId: prefixedId("notice"),
        taskId: home,
        kind: "mcp",
        sourceKey: `mcp:${notice.noticeId}`,
        title: words.title,
        summary: words.summary,
        createdAt: deps.now(),
        bump: true,
      });
    }
    if (!sendNow) continue;
    for (const target of await deps.targets(workspaceId, operator)) {
      if (deps.isLocalConnection(target.connectionId)) continue;
      // A direct chat with the operator only: the chat's sender is the chat itself, bound to the operator here. A group,
      // or a chat bound to someone else, gets nothing.
      const bound = await deps.boundTo(target.connectionId, target.chatId);
      if (bound === undefined || bound.workspaceId !== workspaceId || bound.principalId !== operator) continue;
      try {
        await deps.send({
          effectId: `mcp-notice:${notice.noticeId}:${String(Date.parse(deps.now()))}:${target.connectionId}:${target.chatId}`,
          workspaceId,
          connectionId: target.connectionId,
          chatId: target.chatId,
          text: noticeChannelText(notice),
        });
        sent += 1;
      } catch (error) {
        deps.log?.("an MCP notice could not be sent to a delivery target", {
          pluginId: notice.pluginId,
          connectionId: target.connectionId,
          reason: errorMessage(error),
        });
      }
    }
  }
  if (sendNow && sent > 0) await deps.mcp.setNoticeDelivered(notice.noticeId, { ...notice.delivered, sentAt: deps.now(), targets: sent });
}
