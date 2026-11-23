import {
  MCP_PRESET_IDS,
  TaviError,
  type AppAuth,
  type AppClientSetupStep,
  type AppPresentation,
  type McpBlock,
  type McpPresetId,
  type PluginConfigField,
} from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";

import type { PresetRules } from "../review.js";

import { GOOGLE_MAPS_PRESET, googleMapsPreset } from "./google-maps.js";
import { HOMEASSISTANT_PRESET, homeAssistantPreset } from "./homeassistant.js";
import { HOSTED_PRESETS, hostedPresets } from "./hosted.js";
import { TODOIST_PRESET, TODOIST_TOKEN_PRESET, todoistPreset, todoistTokenPreset } from "./todoist.js";

/**
 * Presets: reviewed templates for a vendor's own server, shipped only while
 * its terms allow a generic client, it works with Tavi's strict client, it was
 * tested end to end, its defaults are read-only and its template was reviewed.
 * A preset fills
 * the manifest `tavi mcp add --preset` writes, and its floors join each
 * tool's suggestion at approval; nothing about it is trusted at run time
 * beyond what the review approved.
 */
export interface McpPreset extends PresetRules {
  readonly id: McpPresetId;
  /** The date its template and annotations were last checked; a release re-checks it (its test fails past 180 days). */
  readonly checked: string;
  /** What withdraws it (its removal trigger), as docs/MCP.md says it. */
  readonly withdrawnIf: string;
  readonly name: string;
  readonly description: string;
  readonly config: Readonly<Record<string, PluginConfigField>>;
  readonly block: Omit<Partial<McpBlock>, "abi" | "preset">;
  /**
   * An OAuth server's login: parameters its authorization request adds
   * (Google's `access_type=offline` for a refresh token), and the scope asked
   * for in place of every scope the server lists.
   */
  readonly login?: { readonly authorizeParams?: Readonly<Record<string, string>>; readonly scope?: string };
  /**
   * How the server presents in Connected apps: Tavi's own words for its
   * scopes and tools, its data class, and how its accounts sign in. Instances of one preset group into one app.
   */
  readonly app?: AppPresentation & { readonly auth?: AppAuth };
  /** A keyed server's steps for getting its key, shown beside the key's field. */
  readonly keySteps?: readonly AppClientSetupStep[];
  /** Its server lists its tools without checking the key, so a test cannot tell a wrong key: it shows when a tool is first used. */
  readonly keyCheckedOnUse?: true;
  /**
   * The server it is one way into, when another preset reaches the same one (Todoist's sign-in and its API token): Tavi
   * keeps one of them, so adding the other switches the server already added, never adds a second.
   */
  readonly wayInto?: string;
}

const PRESETS: Readonly<Partial<Record<McpPresetId, McpPreset>>> = {
  homeassistant: HOMEASSISTANT_PRESET,
  "google-maps": GOOGLE_MAPS_PRESET,
  todoist: TODOIST_PRESET,
  "todoist-token": TODOIST_TOKEN_PRESET,
  ...Object.fromEntries(HOSTED_PRESETS.map((preset) => [preset.id, preset])),
};

/** The presets this build ships (the manifest may name a later one). */
export const AVAILABLE_PRESETS: readonly McpPresetId[] = MCP_PRESET_IDS.filter((id) => PRESETS[id] !== undefined);

/**
 * A preset, its words a person reads (summary, tools, settings, key steps) in `t`'s language: English, the reviewed
 * template a manifest is written from, without one. What the model reads of a server is never a preset's words.
 */
export function presetOf(id: McpPresetId | undefined, t: CoreT = coreEnglish): McpPreset | undefined {
  if (id === undefined) return undefined;
  if (t === coreEnglish || PRESETS[id] === undefined) return PRESETS[id];
  return presetsIn(t)[id];
}

function presetsIn(t: CoreT): Readonly<Partial<Record<McpPresetId, McpPreset>>> {
  return {
    homeassistant: homeAssistantPreset(t),
    "google-maps": googleMapsPreset(t),
    todoist: todoistPreset(t),
    "todoist-token": todoistTokenPreset(t),
    ...Object.fromEntries(hostedPresets(t).map((preset) => [preset.id, preset])),
  };
}

/** The other presets that are ways into the same server as this one: adding this one switches a server added by them. */
export function otherWaysIn(id: string | undefined): readonly McpPresetId[] {
  const server = presetOf(AVAILABLE_PRESETS.find((candidate) => candidate === id))?.wayInto;
  return server === undefined ? [] : AVAILABLE_PRESETS.filter((candidate) => candidate !== id && PRESETS[candidate]?.wayInto === server);
}

/**
 * One server per way in: adding a preset beside a server its other way in added (Todoist's sign-in or its token) is
 * refused, naming the switch `tavi apps add` makes, which removes the server's old sign-in or key with it.
 */
export function otherWayInRefusal(
  added: readonly { readonly id: string; readonly name: string; readonly mcp?: { readonly preset?: string | undefined } | undefined }[],
  preset: McpPresetId,
): TaviError | undefined {
  const others: readonly string[] = otherWaysIn(preset);
  const server = added.find((view) => view.mcp?.preset !== undefined && others.includes(view.mcp.preset));
  return server === undefined
    ? undefined
    : new TaviError(
        "CONFLICT",
        `${server.id} is already added as ${server.name}, another way into the same server: Tavi keeps one. Switch it with \`tavi apps add ${preset} --switch\` while Tavi runs, or remove it first (\`tavi plugins remove ${server.id}\`)`,
      );
}
