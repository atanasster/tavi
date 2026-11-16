import { MCP_MAX_TOOLS, mcpSlugOf, toolPatternMatches, type McpToolRecord, type ToolRule } from "@tavi/contracts";
import { sha256Hex } from "@tavi/node-kit";
import type { PluginRegistry } from "@tavi/runtime";

import type { McpActionContext } from "./actions.js";
import type { McpBridge } from "./bridge.js";
import { observeTools } from "./review.js";
import type { McpSupervisor } from "./supervisor.js";

/**
 * Drift: the running server's
 * tools listed again and compared with what was approved. A changed
 * definition is withheld and withdrawn at once (calls in flight finish) and
 * its session grants deleted; a new tool waits for review; a removed one is
 * withdrawn; more than 128 makes the server `failed`. Every change folds into
 * one `drift` notice per server, which names the allow rules still covering a
 * withheld tool.
 */

type AsyncMcpRepository = McpActionContext["mcp"];

export interface McpDriftDeps {
  readonly registry: PluginRegistry;
  readonly mcp: AsyncMcpRepository;
  readonly supervisor: McpSupervisor;
  readonly bridge: McpBridge;
  /** Tool ids already registered, which a new tool's id must not take. */
  readonly registeredToolIds: () => ReadonlySet<string>;
  readonly deleteSessionGrants: (toolIds: readonly string[]) => Promise<number>;
  /** Every workspace's stored rules. */
  readonly rules: () => Promise<readonly ToolRule[]>;
  readonly raise: (pluginId: string, detail: Readonly<Record<string, unknown>>) => Promise<void>;
}

export interface McpDrift {
  readonly version: string;
  readonly withheld: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Allow rules that still cover a withheld or removed tool, as `<workspace>:<ruleId>`. */
  readonly rules: readonly string[];
  readonly grantsDeleted: number;
  /** Its instructions changed (shown in the review; nothing withheld). */
  readonly instructionsChanged: boolean;
}

/**
 * What changed between two listings of one version's tools, by Tavi's tool
 * id — never the server's own name, which is its text (a
 * notice carries counts and tool ids only).
 */
export function driftBetween(
  before: readonly McpToolRecord[],
  after: readonly McpToolRecord[],
): Pick<McpDrift, "withheld" | "added" | "removed"> {
  const earlier = new Map(before.map((tool) => [tool.name, tool]));
  return {
    withheld: after.filter((tool) => tool.state === "withheld" && earlier.get(tool.name)?.state === "approved").map((tool) => tool.toolId),
    added: after
      .filter((tool) => tool.state === "pending" && (earlier.get(tool.name) === undefined || earlier.get(tool.name)?.state === "removed"))
      .map((tool) => tool.toolId),
    removed: after.filter((tool) => tool.state === "removed" && earlier.get(tool.name)?.state !== "removed").map((tool) => tool.toolId),
  };
}

/** Lists the server's tools afresh and applies any drift; undefined when nothing changed. */
export async function checkDrift(deps: McpDriftDeps, pluginId: string): Promise<McpDrift | undefined> {
  const slug = mcpSlugOf(pluginId);
  if (slug === undefined) return undefined;
  const view = (await deps.registry.list()).find((candidate) => candidate.id === pluginId);
  if (view === undefined || view.kind !== "mcp" || view.activeVersion === undefined) return undefined;
  const version = view.activeVersion;
  const listed = await deps.supervisor.list(pluginId);
  if (listed.length > MCP_MAX_TOOLS) {
    deps.bridge.withdraw(pluginId);
    await deps.supervisor.markFailed(
      pluginId,
      `it now offers ${String(listed.length)} tools; a server may offer at most ${String(MCP_MAX_TOOLS)}`,
    );
    return undefined;
  }
  // Changed instructions are shown in the review, and named on the notice; nothing is withheld for them.
  const instructionsChanged = await checkInstructions(deps, pluginId, version);
  const before = await deps.mcp.listTools(pluginId, version);
  const known = new Map(before.map((tool) => [tool.name, tool.toolId]));
  const after = await deps.mcp.putObservedTools(
    pluginId,
    version,
    observeTools(pluginId, version, slug, listed, deps.registeredToolIds(), known),
  );
  const change = driftBetween(before, after);
  if (change.withheld.length === 0 && change.added.length === 0 && change.removed.length === 0) {
    if (!instructionsChanged) return undefined;
    const drift: McpDrift = { version, ...change, rules: [], grantsDeleted: 0, instructionsChanged };
    await deps.raise(pluginId, { version, withheld: [], added: [], removed: [], rules: [], instructions: true });
    return drift;
  }
  // Withdrawn at once: the bridge registers only what is approved now.
  await deps.bridge.reconcile(pluginId);
  const gone = [...change.withheld, ...change.removed];
  const grantsDeleted = gone.length === 0 ? 0 : await deps.deleteSessionGrants(gone);
  const rules = (await deps.rules())
    .filter((rule) => rule.decision === "allow" && gone.some((toolId) => toolPatternMatches(rule.toolPattern, toolId)))
    .map((rule) => `${rule.workspaceId}:${rule.ruleId}`);
  const drift: McpDrift = { version, ...change, rules, grantsDeleted, instructionsChanged };
  await deps.raise(pluginId, {
    version,
    withheld: drift.withheld,
    added: drift.added,
    removed: drift.removed,
    rules,
    ...(instructionsChanged ? { instructions: true } : {}),
  });
  return drift;
}

/** Whether the server's instructions changed since its probe: the new text stored for the review, when it did. */
async function checkInstructions(deps: McpDriftDeps, pluginId: string, version: string): Promise<boolean> {
  const record = await deps.mcp.getVersion(pluginId, version);
  if (record === undefined) return false;
  let now: string | undefined;
  try {
    now = await deps.supervisor.read(pluginId, (connection, signal) => connection.instructions(signal));
  } catch {
    // Not known now: nothing to compare.
    return false;
  }
  const hash = now === undefined ? undefined : sha256Hex(now);
  if (hash === record.instructionsHash) return false;
  // Read again after the server answered: what a probe, an approval or a new era wrote meanwhile is kept.
  const latest = await deps.mcp.getVersion(pluginId, version);
  if (latest === undefined || latest.instructionsHash === hash) return false;
  const { instructions: _was, instructionsHash: _wasHash, ...rest } = latest;
  await deps.mcp.putVersion({ ...rest, ...(now === undefined || hash === undefined ? {} : { instructions: now, instructionsHash: hash }) });
  return true;
}
