import {
  channelDisclosure,
  BUILTIN_ROLE_PLUGINS,
  PLUGIN_UI_SLOTS,
  TaviError,
  UiContributionKeySchema,
  resolveContributions,
  uiPlacementsFor,
  type PluginUiEntry,
  type PluginUiRole,
  type PluginUiSlot,
  type UiPlacementsSetting,
  type UiRolesSetting,
  type WorkspaceSettingsAnswer,
} from "@tavi/contracts";
import { csvList } from "@tavi/contracts/util";

import type { PluginsUiOptions } from "./parse.js";
import { terminalText } from "../../shared/terminal-text.js";

/**
 * `tavi plugins ui list|set-role|place`: which UI plugin fills each role, and where contributions are
 * shown, as the workspace's `uiRoles` and `uiPlacements`. The same rules as
 * the canvas (`resolveContributions`):
 *
 * - **A role** takes only a plugin that is enabled, approved and declares it;
 *   `builtin` goes back to the built-in, `off` shows none. A plugin that
 *   receives a channel (the live browser view's pages) is chosen only with
 *   `--yes`, after its disclosure is shown: approving a plugin is not consent
 *   to let it watch the browser.
 * - **A placement** is a contribution's slots instead of its manifest's,
 *   `hidden`, or `default` (its manifest's again).
 *
 * Writes are a compare-and-set on the revision just read, so a concurrent
 * change is a conflict, never undone. Nothing needs a restart.
 */

/** What the command needs: the loadable contributions and the settings document, on an owner or the data directory. */
export interface PluginsUiAccess {
  entries(): Promise<readonly PluginUiEntry[]>;
  settings(): Promise<WorkspaceSettingsAnswer>;
  /** Writes one key (`undefined` clears it) against `expectedRevision`. */
  write(
    key: "uiRoles" | "uiPlacements",
    value: UiRolesSetting | UiPlacementsSetting | undefined,
    expectedRevision: number,
  ): Promise<WorkspaceSettingsAnswer>;
}

/** What the command prints, and its exit. */
export interface PluginsUiResult {
  readonly text: string;
  readonly json: unknown;
}

const roleChoice = (roles: UiRolesSetting | undefined, role: PluginUiRole): string => {
  const chosen = roles?.[role];
  return chosen === undefined ? `${BUILTIN_ROLE_PLUGINS[role]} (built-in)` : chosen === "off" ? "off" : chosen;
};

function listing(entries: readonly PluginUiEntry[], settings: WorkspaceSettingsAnswer): PluginsUiResult {
  const { contributions, fallbacks } = resolveContributions(entries, settings.settings);
  const shown = new Set(contributions.map((resolved) => `${resolved.pluginId}/${resolved.contribution.id}`));
  const lines: string[] = [];
  for (const role of Object.keys(BUILTIN_ROLE_PLUGINS) as PluginUiRole[]) {
    lines.push(terminalText(`role ${role}: ${roleChoice(settings.settings.uiRoles, role)}`));
  }
  for (const fallback of fallbacks) {
    lines.push(
      terminalText(
        `warning: ${fallback.wanted} cannot fill ${fallback.role} (not enabled and approved, or it does not declare the role); ${fallback.using === undefined ? "nothing fills it" : `${fallback.using} does instead`}`,
      ),
    );
  }
  const rows = entries.flatMap((entry) =>
    entry.ui.contributions.map((contribution) => {
      const key = `${entry.pluginId}/${contribution.id}`;
      const override = settings.settings.uiPlacements?.[key];
      const resolved = contributions.find((candidate) => `${candidate.pluginId}/${candidate.contribution.id}` === key);
      const slots = (resolved?.placements ?? contribution.placements).map((placement) => placement.slot);
      return {
        key,
        kind: entry.kind,
        ...(contribution.role === undefined ? {} : { role: contribution.role }),
        shown: shown.has(key),
        slots,
        placement: override === undefined ? "manifest" : override === "hidden" ? "hidden" : "chosen",
        channels: contribution.channels,
        ...(contribution.disclosure === undefined ? {} : { disclosure: contribution.disclosure }),
      };
    }),
  );
  // Each field cleaned on its own: terminalText strips control characters, tabs included.
  lines.push(
    ...rows.map((row) =>
      [
        row.key,
        row.shown ? "shown" : "not shown",
        `${row.slots.join(",") || "-"}${row.placement === "manifest" ? "" : ` (${row.placement})`}`,
        row.channels.join(",") || "no channels",
      ]
        .map(terminalText)
        .join("\t"),
    ),
  );
  if (rows.length === 0) lines.push("No UI plugin contributions are enabled.");
  return {
    text: `${lines.join("\n")}\n`,
    json: { roles: settings.settings.uiRoles ?? {}, placements: settings.settings.uiPlacements ?? {}, fallbacks, contributions: rows },
  };
}

export async function runPluginsUi(options: PluginsUiOptions, access: PluginsUiAccess): Promise<PluginsUiResult> {
  const entries = await access.entries();
  const settings = await access.settings();
  if (options.action === "list") return listing(entries, settings);

  if (options.action === "set-role") {
    const role = options.role;
    const choice = options.plugin;
    if (role === undefined || choice === undefined)
      throw new TaviError("INVALID_INPUT", "plugins ui set-role needs a role and a plugin (or builtin, or off)");
    const roles: Record<string, string> = { ...(settings.settings.uiRoles ?? {}) };
    let note = "";
    if (choice === "builtin" || choice === BUILTIN_ROLE_PLUGINS[role]) delete roles[role];
    else if (choice === "off") roles[role] = "off";
    else {
      const filling = entries
        .find((entry) => entry.pluginId === choice)
        ?.ui.contributions.find((contribution) => contribution.role === role);
      if (filling === undefined) {
        throw new TaviError(
          "INVALID_INPUT",
          `${choice} cannot fill ${role}: only an enabled plugin with an approved version that declares the role can (see tavi plugins list)`,
        );
      }
      if (filling.channels.length > 0) {
        note = `${choice} receives ${filling.channels.join(", ")}: ${channelDisclosure(filling.channels, filling.disclosure)}`;
        if (!options.yes) throw new TaviError("INVALID_INPUT", `${note}\nRe-run with --yes to let it, for this workspace.`);
      }
      roles[role] = choice;
    }
    const next = Object.keys(roles).length === 0 ? undefined : (roles as UiRolesSetting);
    const written = await access.write("uiRoles", next, settings.revision);
    const result = listing(entries, written);
    return {
      text: `${note === "" ? "" : `${terminalText(note)}\n`}${role} is now ${roleChoice(written.settings.uiRoles, role)}\n${result.text}`,
      json: result.json,
    };
  }

  const key = options.key;
  if (key === undefined || !UiContributionKeySchema.safeParse(key).success)
    throw new TaviError("INVALID_INPUT", "plugins ui place needs a contribution as <plugin-id>/<contribution-id>");
  const [pluginId, contributionId] = key.split("/") as [string, string];
  const contribution = entries
    .find((entry) => entry.pluginId === pluginId)
    ?.ui.contributions.find((candidate) => candidate.id === contributionId);
  if (contribution === undefined) throw new TaviError("NOT_FOUND", `no enabled UI contribution ${key} (see tavi plugins ui list)`);
  const placements: Record<string, UiPlacementsSetting[string]> = { ...(settings.settings.uiPlacements ?? {}) };
  const where = options.slots;
  if (where === undefined) throw new TaviError("INVALID_INPUT", "plugins ui place needs slots, hidden or default");
  if (where === "default") delete placements[key];
  else if (where === "hidden") placements[key] = "hidden";
  else placements[key] = { slots: uiPlacementsFor(where, contribution.placements, options.show) };
  const next = Object.keys(placements).length === 0 ? undefined : (placements as UiPlacementsSetting);
  const written = await access.write("uiPlacements", next, settings.revision);
  return listing(entries, written);
}

/** A slot list as typed: comma-separated slot names, `hidden` or `default`; `undefined` when one is not a slot. */
export function parseSlots(value: string): readonly PluginUiSlot[] | "hidden" | "default" | undefined {
  if (value === "hidden" || value === "default") return value;
  const slots = csvList(value);
  if (slots.length === 0 || slots.some((slot) => !(PLUGIN_UI_SLOTS as readonly string[]).includes(slot))) return undefined;
  return [...new Set(slots)] as PluginUiSlot[];
}
