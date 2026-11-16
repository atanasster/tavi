import {
  OWNER_WIDE_RULE_PREFIX,
  TaviError,
  toolPatternMatches,
  type AppPermissionTarget,
  type AppToolView,
  type RiskLevel,
  type ToolEffect,
  type ToolRule,
} from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";

/**
 * Per-tool Allow / Ask / Block on the app's page. The person picks a target; the owner makes the smallest change
 * to the page's own rule, one per tool and owner-wide. A page tightens
 * freely, undoes only its own tightening back to the default, and never adds
 * an allow: allowing a write without asking stays the approval card's
 * scopes and `tavi permissions add`.
 */

/** The page's own rule for a tool: deterministic, so there is at most one. */
export function pageRuleId(toolId: string): string {
  return `${OWNER_WIDE_RULE_PREFIX}${sha256Hex(toolId).slice(0, 32)}`;
}

export interface ToolPolicyInput {
  readonly toolId: string;
  readonly effect: ToolEffect;
  readonly floor?: RiskLevel | undefined;
  /** An MCP tool, which the approval card never offers `always`. */
  readonly mcp: boolean;
}

type Decision = Pick<AppToolView, "decision" | "because">;

/**
 * The decision a tool's calls start from, before taint and arguments: the
 * rules that apply to every call of it in every chat (no argument matcher, no
 * front-end scope), deny before ask before allow, else its effect's default.
 */
function staticDecision(rules: readonly ToolRule[], tool: ToolPolicyInput): Decision {
  const applying = rules.filter(
    (rule) => rule.argMatcher === undefined && rule.origin === undefined && toolPatternMatches(rule.toolPattern, tool.toolId),
  );
  const critical = tool.floor === "critical";
  if (applying.some((rule) => rule.decision === "deny")) return { decision: "block", because: ["rule"] };
  if (applying.some((rule) => rule.decision === "ask")) return { decision: "ask", because: ["rule"] };
  const allow = applying.find((rule) => rule.decision === "allow");
  if (allow !== undefined) {
    // A critical call is asked even when a rule allows it.
    if (critical) return { decision: "ask", because: ["critical"] };
    return { decision: "allow", because: allow.ruleId === pageRuleId(tool.toolId) ? ["rule"] : ["rule", "set-in-cli"] };
  }
  if (critical) return { decision: "ask", because: ["critical"] };
  if (tool.effect === "read-only") return { decision: "allow", because: ["default-read"] };
  return { decision: "ask", because: tool.mcp ? ["default-write", "never-always"] : ["default-write"] };
}

/** What the page shows for a tool: the decision, why, and which targets it may pick. */
export function toolPolicy(rules: readonly ToolRule[], tool: ToolPolicyInput): Decision & Pick<AppToolView, "canSetHere"> {
  return { ...staticDecision(rules, tool), canSetHere: settableTargets([rules], tool) };
}

/**
 * The targets the page may pick for a tool, held against every workspace's rules (`ruleSets`), as
 * `resolvePermission` decides them: under a deny made elsewhere in any, only Block; Allow only where the tool
 * runs unasked without the page's rule in all of them.
 */
export function settableTargets(ruleSets: readonly (readonly ToolRule[])[], tool: ToolPolicyInput): AppPermissionTarget[] {
  const page = pageRuleId(tool.toolId);
  const bases = ruleSets.map(
    (rules) =>
      staticDecision(
        rules.filter((rule) => rule.ruleId !== page),
        tool,
      ).decision,
  );
  if (bases.includes("block")) return ["block"];
  return bases.every((base) => base === "allow") ? ["allow", "ask", "block"] : ["ask", "block"];
}

export type PermissionChange =
  | { readonly kind: "put"; readonly rule: ToolRule }
  | { readonly kind: "delete"; readonly ruleId: string }
  | { readonly kind: "none" };

/**
 * The one change that reaches `target` in every workspace, or a refusal when
 * only an allow rule would. The page's rule is owner-wide, so it is decided
 * against each workspace's rules (`ruleSets`), each read with the owner-wide ones.
 */
export function resolvePermission(
  ruleSets: readonly (readonly ToolRule[])[],
  tool: ToolPolicyInput,
  target: AppPermissionTarget,
  by: { readonly actor: string; readonly now: string },
): PermissionChange {
  const page = pageRuleId(tool.toolId);
  const own = ruleSets.flat().find((rule) => rule.ruleId === page);
  const bases = ruleSets.map(
    (rules) =>
      staticDecision(
        rules.filter((rule) => rule.ruleId !== page),
        tool,
      ).decision,
  );
  if (target === "block") return own?.decision === "deny" ? { kind: "none" } : { kind: "put", rule: pageRule(page, tool, "deny", by) };
  // A deny made elsewhere wins over anything the page could add.
  if (bases.includes("block"))
    throw new TaviError("NOT_AUTHORIZED", `${tool.toolId} is blocked by a rule made in the CLI; remove it with \`tavi permissions rm\``);
  // Back to what the tool does without the page's rule, in every workspace: the page's own tightening undone.
  if (bases.every((base) => base === target)) return own === undefined ? { kind: "none" } : { kind: "delete", ruleId: page };
  if (target === "allow") {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `a page cannot allow ${tool.toolId} without asking${tool.mcp && tool.effect !== "read-only" ? ": an MCP tool that changes or sends is approved one chat at a time from the approval card" : ""}; use \`tavi permissions add --tool ${tool.toolId} --decision allow\``,
    );
  }
  // Ask somewhere it would otherwise run unasked: an ask rule, which wins over an allow.
  return own?.decision === "ask" ? { kind: "none" } : { kind: "put", rule: pageRule(page, tool, "ask", by) };
}

function pageRule(
  ruleId: string,
  tool: ToolPolicyInput,
  decision: "deny" | "ask",
  by: { readonly actor: string; readonly now: string },
): ToolRule {
  return {
    ruleId,
    workspaceId: "*",
    toolPattern: tool.toolId,
    decision,
    source: "operator",
    createdBy: by.actor,
    createdVia: "bridge",
    createdAt: by.now,
    note: decision === "deny" ? "Blocked on its app's page in Connected apps" : "Asked about on its app's page in Connected apps",
  };
}
