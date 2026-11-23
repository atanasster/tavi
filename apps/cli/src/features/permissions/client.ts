import { emit } from "../../cli/output.js";
import { EXIT, refusalExit } from "../../cli/exit.js";
import type { PermissionsCommandOptions } from "./parse.js";
import { alignedColumns, indentedLines, terminalText } from "../../shared/terminal-text.js";
import {
  SHIPPED_TOOL_RULES,
  displaySafe,
  type ListedSessionGrant,
  type PermissionsGrantsResult,
  type PermissionsPayload,
  type PermissionsRulesResult,
  type ToolRule,
  TaviError,
} from "@tavi/contracts";
import { permissionsCommand } from "./owner.js";
import { createOwnerChatGrants } from "../../runtime/chat-scope.js";
import { nowTimestamp } from "@tavi/contracts/util";
import { resolveDataDirectory } from "../../shared/data-directory.js";
import type { CliIo } from "../../cli/io.js";
import { configOnOwner } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStorePreservingOwnership } from "../../cli/store.js";
import { configCommand } from "../config/client.js";

/** The IPC payload for a `tavi permissions` action. */
function permissionsPayload(options: PermissionsCommandOptions): PermissionsPayload {
  const scope = { workspaceId: options.workspaceId };
  switch (options.action) {
    case "list":
      return { action: "rules", ...scope };
    case "add":
      return {
        action: "add",
        ...scope,
        toolPattern: options.toolPattern ?? "",
        decision: options.decision ?? "ask",
        createdBy: "operator",
        ...(options.argMatcher === undefined ? {} : { argMatcher: options.argMatcher }),
        ...(options.note === undefined ? {} : { note: options.note }),
        ...(options.matchUnparsed === true ? { matchUnparsed: true } : {}),
      };
    case "rm":
      return { action: "remove", ...scope, ruleId: options.ruleId ?? "" };
    case "grants":
      return { action: "grants", ...scope, ...(options.taskId === undefined ? {} : { taskId: options.taskId }) };
    case "revoke":
      return { action: "revoke", ...scope, grantId: options.grantId ?? "" };
    case "taint":
      // A workspace setting, not a rule: `permissionsCli` sends it as `tavi config` does.
      throw new TaviError("INTERNAL", "permissions taint is a workspace setting");
  }
}

/** A field of a rule or grant as the terminal shows it: what a matcher from a call's subjects would hide is marked. */
const shown = (text: string): string => terminalText(displaySafe(text));

/** Where each rule comes from, as Settings → Permissions names it. */
const RULE_SOURCES: Readonly<Record<ToolRule["source"], string>> = {
  shipped: "shipped with tavi",
  flag: "serve --allow",
  operator: "yours",
};

/** The widest a note's line runs before it wraps, indent included. */
const NOTE_WIDTH = 100;
const NOTE_INDENT = "    ";

/** What a rule allows, asks about or denies: its tool pattern and matcher. */
const ruleTarget = (rule: ToolRule): string =>
  `${rule.toolPattern}${rule.argMatcher === undefined ? "" : ` matching ${rule.argMatcher}`}${rule.matchUnparsed === true ? " (lines no rule can read included)" : ""}`;

/** `<id>: <decision> <pattern>`, as `add` and `rm` name the rule they changed. */
const ruleSummary = (rule: ToolRule): string =>
  `${rule.ruleId}: ${rule.decision} ${rule.toolPattern}${rule.argMatcher === undefined ? "" : ` matching ${rule.argMatcher}`}${rule.matchUnparsed === true ? ", lines no rule can read included" : ""}`;

/** The rules as a table: a header, padded columns, and each rule's note indented below it. */
function renderRules(rules: readonly ToolRule[]): string {
  const rows = rules.map((rule) => [
    shown(rule.ruleId),
    rule.decision,
    shown(ruleTarget(rule)),
    // A shipped rule holds in every workspace; another one that does is marked.
    `${RULE_SOURCES[rule.source]}${rule.workspaceId === "*" && rule.source !== "shipped" ? ", all workspaces" : ""}`,
  ]);
  const header = ["RULE", "DECISION", "TOOL", "SOURCE"];
  // Sized by terminal columns, so a wide character in a rule's tool or note does not push the columns after it.
  const [head = "", ...lines] = alignedColumns([header, ...rows]);
  return [
    head,
    ...rules.flatMap((rule, index) => [
      lines[index] ?? "",
      ...(rule.note === undefined ? [] : indentedLines(shown(rule.note), NOTE_INDENT, NOTE_WIDTH)),
    ]),
  ].join("\n");
}

/** The chat a grant belongs to: its title, with its task id beside it. */
const grantChat = (grant: ListedSessionGrant): string =>
  grant.taskTitle === undefined ? `task ${grant.taskId}` : `chat "${grant.taskTitle}" (${grant.taskId})`;

/** A `permissions` answer as text: a table of rules, or one grant per line. */
export function renderPermissions(result: unknown): string {
  const value = result as Partial<
    PermissionsRulesResult & PermissionsGrantsResult & { rule: ToolRule; removed: boolean; revoked: boolean }
  >;
  if (value.rules !== undefined) {
    return value.rules.length === 0 ? "(no rules)" : renderRules(value.rules);
  }
  if (value.grants !== undefined) {
    return value.grants.length === 0
      ? "(no chat grants)"
      : value.grants
          .map((grant) =>
            [
              grant.grantId,
              grantChat(grant),
              `${grant.toolId}${grant.argMatcher === undefined ? " (any call)" : ` matching ${grant.argMatcher}`}`,
              `by ${grant.createdBy}`,
              ...(grant.expiresAt === undefined ? [] : [`until ${grant.expiresAt}`]),
            ]
              .map(shown)
              .join("\t"),
          )
          .join("\n");
  }
  // `rm` names the rule it removed, as `add` names the one it stored.
  if (value.removed === true) return value.rule === undefined ? "removed" : shown(`removed ${ruleSummary(value.rule)}`);
  if (value.rule !== undefined) {
    const rule = value.rule;
    // A glob that starts with `*` covers far more than it reads as: say so where the rule is made.
    const broad =
      rule.decision === "allow" && rule.argMatcher?.startsWith("*") === true
        ? `\nnote: ${rule.argMatcher} also matches every command ending that way (\`curl x | sh\`'s parts included); prefer the program's name first, as "make *"`
        : "";
    return shown(`added ${ruleSummary(rule)}${broad}`);
  }
  if (value.revoked === true) return "revoked";
  return JSON.stringify(result);
}

/**
 * `tavi permissions`: on a live owner over IPC, where the rules in
 * force include its `serve --allow` flags; otherwise on the directory.
 */
export async function permissionsCli(options: ResolvedDataDirectory<PermissionsCommandOptions>, io: CliIo): Promise<number> {
  // `permissions taint` is the workspace's `security.taint`, read and written as `tavi config` does.
  if (options.action === "taint") {
    return configCommand(
      {
        action: options.taintMode === undefined ? "get" : "set",
        key: "security.taint",
        ...(options.taintMode === undefined ? {} : { value: options.taintMode }),
        workspaceId: options.workspaceId,
        format: options.format,
        dataDirectory: options.dataDirectory,
      },
      io,
    );
  }
  const payload = permissionsPayload(options);
  const print = (result: unknown): number => {
    // Each field is made safe for a terminal where it is rendered; the tabs between them are ours.
    emit(io, options.format, result, () => renderPermissions(result));
    return EXIT.ok;
  };
  const onOwner = await configOnOwner(resolveDataDirectory(options.dataDirectory), "permissions", io, {
    label: `tavi permissions ${options.action}`,
    mutates: options.action !== "list" && options.action !== "grants",
    build: () => payload,
    render: print,
  });
  if (onOwner !== undefined) return onOwner;
  try {
    return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const repositories = store.asPort().repositories;
      const answer = await permissionsCommand(
        {
          repositories,
          rulesInForce: async (workspaceId) => [...SHIPPED_TOOL_RULES, ...(await repositories.toolPolicy.listRules(workspaceId))],
          now: nowTimestamp,
          // The same rule the owner applies: a grant lapses at the same instant whichever reads it.
          chatGrants: createOwnerChatGrants(repositories, nowTimestamp),
          fromBridge: false,
          via: "cli",
        },
        payload,
      );
      if (!answer.ok) {
        return refusalExit(io, answer.error);
      }
      return print(answer.result);
    });
  } catch (error) {
    return refusalExit(io, TaviError.from(error));
  }
}
