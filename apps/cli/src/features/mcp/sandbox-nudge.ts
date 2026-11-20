import type { McpSandboxState, McpVersionRecord, SandboxStatus } from "@tavi/contracts";

import type { TaviRuntime } from "../../runtime/types.js";

/**
 * A server approved to run weaker than this host now confines: `--unsandboxed`
 * or `--nested` chosen while the sandbox could not run, kept after it was
 * fixed. Said at `tavi serve` start and by `tavi doctor`, never acted on: an
 * approved version keeps its sandbox state, and the server might break under
 * a stronger one, so the operator moves it with a new version.
 */
export interface WeakerSandboxServer {
  readonly pluginId: string;
  readonly version: string;
  readonly sandboxState: Exclude<McpSandboxState, "srt">;
  /** The state this host confines in now. */
  readonly available: "srt" | "nested";
  readonly warning: string;
}

const STRENGTH: Readonly<Record<McpSandboxState, number>> = {
  none: 0,
  nested: 1,
  srt: 2,
};

/** The strongest state a stdio server could run in on a host with this status; none when nothing confines. */
function availableState(status: SandboxStatus): "srt" | "nested" | undefined {
  if (status.tier === "full") return "srt";
  if (status.tier === "nested") return "nested";
  return undefined;
}

/** Each approved stdio server whose recorded state is weaker than `status` allows, with what to run. */
export function weakerSandboxServers(
  status: SandboxStatus,
  records: readonly Pick<McpVersionRecord, "pluginId" | "version" | "sandboxState" | "transport">[],
): WeakerSandboxServer[] {
  const available = availableState(status);
  if (available === undefined) return [];
  const weaker: WeakerSandboxServer[] = [];
  for (const record of records) {
    if (record.transport !== "stdio" || record.sandboxState === "srt") continue;
    if (STRENGTH[record.sandboxState] >= STRENGTH[available]) continue;
    const runs = record.sandboxState === "none" ? "runs unsandboxed" : "runs in the weaker nested sandbox";
    const now = available === "srt" ? "this host's sandbox now works" : "the nested sandbox now works here";
    const flag = available === "nested" ? " --nested" : "";
    weaker.push({
      pluginId: record.pluginId,
      version: record.version,
      sandboxState: record.sandboxState,
      available,
      warning:
        `${record.pluginId}@${record.version} ${runs}, but ${now}: to confine it, \`tavi mcp add\` it again with a new --version` +
        `${flag} (its probe runs ${available === "srt" ? "in the sandbox" : "nested"}), then review and approve that version; ` +
        `it keeps its approved state until you do`,
    });
  }
  return weaker;
}

/**
 * The owner's approved, active MCP servers' version records, then {@link weakerSandboxServers} over them.
 * `status` is asked for only when a server runs weaker than `srt`: on most hosts no probe runs for this.
 */
export async function weakerSandboxServersOf(
  runtime: TaviRuntime,
  status: () => Promise<SandboxStatus> | SandboxStatus,
): Promise<WeakerSandboxServer[]> {
  const mcp = runtime.store.asPort().repositories.mcp;
  const records: McpVersionRecord[] = [];
  for (const view of await runtime.plugins.registry.list()) {
    if (view.kind !== "mcp" || view.activeVersion === undefined) continue;
    const active = view.versions.find((candidate) => candidate.version === view.activeVersion);
    if (active?.reviewState !== "approved") continue;
    const record = await mcp.getVersion(view.id, view.activeVersion);
    if (record !== undefined && record.transport === "stdio" && record.sandboxState !== "srt") records.push(record);
  }
  return records.length === 0 ? [] : weakerSandboxServers(await status(), records);
}
