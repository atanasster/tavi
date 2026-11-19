import type { McpArgFloor, RiskLevel, ToolEffect } from "@tavi/contracts";

import type { McpPreset } from "./index.js";

/**
 * Home Assistant's official MCP server (`<ha>/api/mcp`, Streamable HTTP).
 * A long-lived access token as a credential, usually on a private address (`lan`).
 *
 * Its tools follow the entities exposed to Assist and are annotated (since
 * 2026-09-24), every default emitted, and named `<api>__<intent>`
 * (`intent__HassTurnOn`, `script__goodnight`; checked against Home Assistant
 * 2026.10.1, mcp_server 1.28.1). Exposing an entity can add an intent (a
 * cover adds `HassSetPosition`), so the floors are an allowlist and fail
 * closed:
 * - the targeting intents (`HassTurnOn`, `HassTurnOff`, `HassToggle`) take
 *   `name`, `area`, `floor`, `domain[]` and `device_class[]` — a device by name
 *   or area alone, with no domain — so they are `critical` unless every domain
 *   and device class the call names is safe, and it names one (unlocking is a
 *   lock's off);
 * - a reviewed list of writes that reach no lock, alarm, cover, valve or
 *   garage keeps its suggestion;
 * - every other write — a script, an intent not reviewed here — is `critical`.
 * A critical call asks every time, once only, with a PIN on an email link.
 */

/** Domains a targeting call may name without a `critical` floor. A scene is not one: it can unlock a door or open a cover. */
const HOMEASSISTANT_SAFE_DOMAINS = ["light", "switch", "fan", "media_player", "climate"] as const;
/** Device classes that stay safe beside them (a `switch` of class `garage` or `door` does not). */
const HOMEASSISTANT_SAFE_DEVICE_CLASSES = ["tv", "speaker", "receiver", "projector", "outlet"] as const;

/** The intents that address a target by name, area, domain or device class. */
const TARGETING_INTENTS: ReadonlySet<string> = new Set(["HassTurnOn", "HassTurnOff", "HassToggle"]);
/** Writes reviewed to reach none of a lock, an alarm, a cover, a valve or a garage: they keep their suggestion. */
const REVIEWED_WRITES: ReadonlySet<string> = new Set([
  "HassLightSet",
  "HassBroadcast",
  "HassStartTimer",
  "HassCancelTimer",
  "HassCancelAllTimers",
  "HassIncreaseTimer",
  "HassDecreaseTimer",
  "HassPauseTimer",
  "HassUnpauseTimer",
  "HassListAddItem",
  "HassListCompleteItem",
  "HassListRemoveItem",
  "HassMediaPause",
  "HassMediaUnpause",
  "HassMediaNext",
  "HassMediaPrevious",
  "HassSetVolume",
]);

const TURN_FLOOR: McpArgFloor = {
  risk: "critical",
  identify: ["domain", "device_class"],
  safe: [...HOMEASSISTANT_SAFE_DOMAINS, ...HOMEASSISTANT_SAFE_DEVICE_CLASSES],
};

/** A tool's intent or script name, without Home Assistant's `<api>__` prefix. */
const baseName = (name: string): string => name.slice(name.lastIndexOf("__") + 2);

export const HOMEASSISTANT_PRESET: McpPreset = {
  id: "homeassistant",
  /** When the template and its annotations were last checked against Home Assistant; the end-to-end run is in docs/MCP.md. */
  checked: "2026-10-14",
  withdrawnIf:
    "Home Assistant removes or renames its Model Context Protocol Server integration, its address or token handling changes, or its tools' names no longer carry the domains the floors read",
  name: "Home Assistant",
  description: "Control exposed entities through Home Assistant's MCP server.",
  config: {
    url: {
      type: "string",
      required: true,
      label: "Its MCP address",
      description: "e.g. http://homeassistant.local:8123/api/mcp",
    },
    token: {
      type: "credential",
      required: true,
      label: "A long-lived access token",
      description: "A long-lived access token (Profile → Security)",
    },
  },
  block: {
    transport: "http",
    url: { setting: "url" },
    headers: { Authorization: { prefix: "Bearer ", setting: "token" } },
    network: { lan: true },
    auth: "headers",
    exposure: "auto",
  },
  app: {
    id: "homeassistant",
    name: "Home Assistant",
    summary: "Ask about and control the devices you expose to Assist.",
    category: "home",
    publisher: "Home Assistant",
    accountScope: "owner",
    scopes: [],
    tools: {
      intent__HassTurnOn: { title: "Turn on", says: "Asked every time unless it is a light, a switch, a fan, media or climate" },
      intent__HassTurnOff: { title: "Turn off", says: "Asked every time unless it is a light, a switch, a fan, media or climate" },
      intent__HassToggle: { title: "Toggle" },
      intent__GetLiveContext: { title: "Read device states" },
    },
  },
  floors: (tool: {
    readonly name: string;
    readonly effect: ToolEffect;
  }): { readonly minRisk?: RiskLevel; readonly argFloors?: readonly McpArgFloor[] } | undefined => {
    if (tool.effect === "read-only") return undefined;
    const intent = baseName(tool.name);
    if (tool.name.startsWith("intent__") && TARGETING_INTENTS.has(intent)) return { argFloors: [TURN_FLOOR] };
    if (REVIEWED_WRITES.has(intent) && !tool.name.startsWith("script__")) return undefined;
    // A script runs whatever it was written to; an intent not reviewed here may reach a cover, a valve or a lock.
    return { minRisk: "critical" };
  },
};
