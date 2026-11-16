import {
  TaviError,
  type PermissionsGrantsResult,
  type PermissionsPayload,
  type PermissionsRulesResult,
  type PersistencePort,
  type ToolRule,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";

import type { ChatGrants } from "./chat-grants.js";
import type { IpcAnswer } from "../../shared/ipc-decisions.js";

/**
 * `permissions`: the tool rules in force and the session grants, over
 * IPC and offline alike. A page (the `tavi ui` bridge) may list, revoke, and
 * remove an allow rule — each only narrows what runs unasked — but never add a
 * rule or remove a deny or ask one: its standing rules come from approvals a
 * person made on it, each matching exactly what was shown (a
 * page cannot widen what the owner holds).
 */
export interface PermissionsDependencies {
  readonly repositories: Pick<PersistencePort["repositories"], "toolPolicy" | "tasks">;
  /** Every rule the gate evaluates in a workspace, shipped and flag rules included. */
  readonly rulesInForce: (workspaceId: string) => Promise<readonly ToolRule[]>;
  readonly now: () => string;
  /**
   * The grants in force, each with when it ends: a grant made before
   * ends existed in a chat that never ends shows — and lapses at — a day after
   * it was made, read on the owner's clock.
   */
  readonly chatGrants: Pick<ChatGrants, "listInForce">;
  /** The request came through the `tavi ui` bridge. */
  readonly fromBridge: boolean;
  /** How the change is recorded: `cli` offline, `ipc` or `bridge` on an owner. */
  readonly via: ToolRule["createdVia"];
}

export type PermissionsAnswer = IpcAnswer<
  | PermissionsRulesResult
  | PermissionsGrantsResult
  | { readonly rule: ToolRule }
  | { readonly removed: boolean; readonly rule?: ToolRule }
  | { readonly revoked: boolean }
>;

const refuse = (code: string, message: string): PermissionsAnswer => ({ ok: false, error: { code, message } });

export async function permissionsCommand(deps: PermissionsDependencies, payload: PermissionsPayload): Promise<PermissionsAnswer> {
  const policy = deps.repositories.toolPolicy;
  switch (payload.action) {
    case "rules":
      return { ok: true, result: { rules: await deps.rulesInForce(payload.workspaceId) } };
    case "add": {
      if (deps.fromBridge)
        return refuse("NOT_AUTHORIZED", "a page cannot add a tool rule: approve a call with `always` to save one for exactly that call");
      // As `serve --allow '*'` is: easy to type without meaning it.
      if (payload.decision === "allow" && payload.toolPattern === "*" && payload.argMatcher === undefined) {
        return refuse("INVALID_INPUT", "an allow rule for every tool is refused; name the tool, e.g. web_search");
      }
      try {
        const rule = await policy.putRule({
          ruleId: prefixedId("rule"),
          workspaceId: payload.workspaceId,
          toolPattern: payload.toolPattern,
          ...(payload.argMatcher === undefined ? {} : { argMatcher: payload.argMatcher }),
          decision: payload.decision,
          source: "operator",
          createdBy: payload.createdBy,
          createdVia: deps.via,
          createdAt: deps.now(),
          ...(payload.note === undefined ? {} : { note: payload.note }),
          ...(payload.matchUnparsed === true ? { matchUnparsed: true as const } : {}),
        });
        return { ok: true, result: { rule } };
      } catch (error) {
        return refuse(error instanceof TaviError ? error.code : "INVALID_INPUT", errorMessage(error));
      }
    }
    case "remove": {
      // A shipped or flag rule is not stored: it is changed where it lives.
      const known = (await deps.rulesInForce(payload.workspaceId)).find((rule) => rule.ruleId === payload.ruleId);
      // Removing a deny or ask rule widens what runs unasked, so a page may
      // remove only an allow rule — which narrows it.
      if (deps.fromBridge && known?.decision !== "allow") {
        return refuse("NOT_AUTHORIZED", "a page can remove only an allow rule; remove a deny or ask rule with `tavi permissions rm`");
      }
      if (known !== undefined && known.source !== "operator") {
        return refuse(
          "INVALID_INPUT",
          `rule ${payload.ruleId} is ${known.source === "shipped" ? "shipped with tavi; override it with a deny or ask rule" : "a serve --allow flag; restart without it"}`,
        );
      }
      const removed = await policy.deleteRule(payload.workspaceId, payload.ruleId);
      // The rule is named in the answer, as `add` names the one it stored.
      return removed
        ? { ok: true, result: { removed, ...(known === undefined ? {} : { rule: known }) } }
        : refuse("NOT_FOUND", `no rule ${payload.ruleId} in workspace ${payload.workspaceId}`);
    }
    case "grants": {
      // A grant past its time is not listed: it no longer allows anything.
      const grants = await deps.chatGrants.listInForce(payload.workspaceId, payload.taskId);
      // Each names its chat as the reader knows it: by its title, when it has one.
      const titles = new Map<string, string | undefined>();
      for (const grant of grants) {
        if (!titles.has(grant.taskId)) titles.set(grant.taskId, (await deps.repositories.tasks.get(grant.taskId))?.title ?? undefined);
      }
      return {
        ok: true,
        result: {
          grants: grants.map((grant) => {
            const taskTitle = titles.get(grant.taskId);
            return taskTitle === undefined || taskTitle === "" ? grant : { ...grant, taskTitle };
          }),
        },
      };
    }
    case "revoke": {
      // One decision is revoked whole: a browser decision granted every browser
      // tool, and revoking only `browser.navigate` would leave
      // `browser.create_session` opening any site.
      const grant = (await policy.listSessionGrantsForWorkspace(payload.workspaceId)).find((entry) => entry.grantId === payload.grantId);
      if (grant === undefined) return refuse("NOT_FOUND", `no session grant ${payload.grantId} in workspace ${payload.workspaceId}`);
      const siblings = (await policy.listSessionGrants(grant.taskId)).filter(
        (entry) => entry.workspaceId === payload.workspaceId && entry.approvalId === grant.approvalId,
      );
      for (const sibling of siblings) await policy.revokeSessionGrant(payload.workspaceId, sibling.grantId);
      return { ok: true, result: { revoked: true } };
    }
  }
}
