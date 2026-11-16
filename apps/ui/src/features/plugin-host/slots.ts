import type { PluginUiPlacement, PluginUiSlot, ResolvedContribution } from "@tavi/contracts";

/**
 * Where the canvas shows UI plugin contributions. Which ones show at all is `resolveContributions` (`@tavi/contracts`),
 * shared with `tavi plugins ui`.
 */

export { resolveContributions, type ResolvedContribution, type RoleFallback } from "@tavi/contracts";

/** The contributions shown in `slot`, each with its placement there. */
export function contributionsForSlot(
  contributions: readonly ResolvedContribution[],
  slot: PluginUiSlot,
): readonly (ResolvedContribution & { readonly placement: PluginUiPlacement })[] {
  return contributions.flatMap((resolved) => {
    const placement = resolved.placements.find((candidate) => candidate.slot === slot);
    return placement === undefined ? [] : [{ ...resolved, placement }];
  });
}

/** A contribution's key: what `uiPlacements` and the chat panel's route (`plugin:<key>`) name it by. */
export function contributionKey(resolved: Pick<ResolvedContribution, "pluginId" | "contribution">): string {
  return `${resolved.pluginId}/${resolved.contribution.id}`;
}
