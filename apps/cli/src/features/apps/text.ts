import {
  MCP_PRESET_IDS,
  type AppsActivityAnswer,
  type AppsCatalogAnswer,
  type AppsPayload,
  type ConnectableApp,
  type McpPresetId,
  englishOf,
  navPath,
} from "@tavi/contracts";
import { keptByNote } from "./shared-grants.js";
import { channelDescriptorOf } from "../channels/catalog.js";
import { BUILTIN_CHANNELS } from "../plugins/catalog.js";
import { presetOf } from "../mcp/presets/index.js";

/** What Connected apps calls a channel's app (Gmail's is "Google"), else its id. */
const appNameOf = (appId: string): string =>
  (channelDescriptorOf(appId) ?? BUILTIN_CHANNELS.find((channel) => channel.descriptor.providerId === appId)?.descriptor)?.app?.name ??
  appId;

const HEALTH_WORDS: Readonly<Record<ConnectableApp["health"], string>> = {
  ready: "connected",
  "needs-sign-in": "needs sign-in",
  "needs-access": "needs more access",
  "needs-review": "review",
  "not-set-up": "not set up",
  paused: "paused",
  off: "off",
  error: "not working",
};

/** One line per app, its fix and the command for it beneath; with `needsYou`, only the apps that need you. */
export function appsListText(apps: readonly ConnectableApp[], needsYou = false): string {
  // As the page's *Needs you only*: every app that is not connected.
  const shown = needsYou ? apps.filter((app) => app.health !== "ready") : apps;
  if (shown.length === 0) return needsYou ? "No app needs you.\n" : "No apps yet: tavi apps catalog lists what to add.\n";
  return shown
    .map((app) => {
      const accounts = app.accounts.map((account) => account.identity ?? account.label).join(", ");
      const head = `${app.appId}  ${app.name}: ${HEALTH_WORDS[app.health]}${accounts === "" ? "" : ` (${accounts})`}`;
      const fix = app.repairs[0];
      return fix === undefined ? head : `${head}\n  ${fix.title}: ${fix.detail}\n  ${fix.cli}`;
    })
    .join("\n")
    .concat("\n");
}

function appText(app: ConnectableApp): string {
  // "Email (Mailgun)" already names its id: said once, not "Email (Mailgun) (mailgun)" (QA 2092).
  const named = app.name.toLowerCase().includes(`(${app.appId.toLowerCase()})`) ? app.name : `${app.name} (${app.appId})`;
  const lines = [`${named}: ${HEALTH_WORDS[app.health]}`, app.summary];
  for (const account of app.accounts)
    lines.push(
      `  account ${account.accountId}: ${account.identity ?? account.label}, ${HEALTH_WORDS[account.health]}, ${account.sharing}${account.signedInAt === undefined ? "" : `, signed in ${account.signedInAt.slice(0, 10)}`}${account.nextSignInBy === undefined ? "" : `, next sign-in by ${account.nextSignInBy.slice(0, 10)}`}`,
    );
  for (const tool of app.tools)
    lines.push(`  tool ${tool.toolId}: ${tool.access}, ${tool.decision}${tool.state === "offered" ? "" : ` (${tool.state})`}`);
  lines.push(
    `  calls go to: ${app.egress.anyNetwork ? "any network" : app.egress.hosts.length === 0 ? "nowhere off this computer" : app.egress.hosts.join(", ")}`,
  );
  lines.push(`  what it returns: ${app.trust.output}${app.trust.confidentiality === "personal" ? ", personal data" : ""}`);
  for (const repair of app.repairs) lines.push(`  fix: ${repair.title}: ${repair.cli}`);
  for (const warning of app.warnings) lines.push(`  note: ${warning}`);
  return `${lines.filter((line) => line !== "").join("\n")}\n`;
}

function catalogText(catalog: AppsCatalogAnswer): string {
  const lines = catalog.sections.flatMap((section) =>
    section.entries.length === 0
      ? []
      : [
          `${section.section}:`,
          ...section.entries.map((entry) => {
            const add =
              entry.ref.kind === "preset"
                ? `tavi apps add ${entry.ref.id}`
                : entry.ref.kind === "registry"
                  ? `tavi apps add ${entry.ref.name}@${entry.ref.version} --option ${entry.ref.option}`
                  : entry.ref.kind === "channel"
                    ? `tavi channels connect`
                    : entry.appId === undefined
                      ? ""
                      : `tavi apps connect ${entry.appId}`;
            return `  ${entry.name}${entry.installed ? " (added)" : ""}: ${entry.summary}${add === "" ? "" : `\n    ${add}`}`;
          }),
        ],
  );
  if (catalog.registryNote !== undefined) lines.push(catalog.registryNote);
  if (catalog.cursor !== undefined) lines.push(`more: tavi apps catalog … --cursor ${catalog.cursor}`);
  return lines.length === 0 ? "Nothing matches.\n" : `${lines.join("\n")}\n`;
}

const ACTIVITY_VERBS: Readonly<Record<AppsActivityAnswer["rows"][number]["kind"], string>> = {
  effect: "did",
  approval: "asked",
  read: "read",
};

function activityText(activity: AppsActivityAnswer, appId: string): string {
  const lines = activity.rows.map((row) => `${row.at}  ${ACTIVITY_VERBS[row.kind]}  ${row.state}  ${row.title}  (chat ${row.taskId})`);
  if (lines.length === 0) lines.push("Nothing yet.");
  if (activity.cursor !== undefined) lines.push(`more: tavi apps activity ${appId} --cursor ${activity.cursor}`);
  lines.push("Calls that only read are listed from when Tavi began recording them; older ones are not.");
  return `${lines.join("\n")}\n`;
}

/**
 * What to do after an app is added: sign in for one that signs in; set its settings for one that takes a key or token
 * (its credentials stored first, then named in its config), as Connected apps' sheet asks for them.
 */
function addedText(appId: string, pluginId: string): string {
  const preset = (MCP_PRESET_IDS as readonly string[]).includes(appId) ? presetOf(appId as McpPresetId) : undefined;
  const fields = Object.entries(preset?.config ?? {}).filter(([, field]) => field.required === true);
  if (preset === undefined || preset.block.auth === "oauth" || fields.length === 0)
    return `added ${appId} (${pluginId}); connect it: tavi apps connect ${appId}\n`;
  const credentials = fields.filter(([, field]) => field.type === "credential");
  const sets = fields.map(([key, field]) => `${key}=${field.type === "credential" ? `plugins.${pluginId}.${key}` : "<value>"}`);
  return [
    `added ${appId} (${pluginId}); give it ${fields.map(([, field]) => (field.label ?? "its setting").replace(/^Your /, "your ")).join(" and ")} in ${englishOf(navPath("nav.route.settings", "nav.settings.apps"))}, or:`,
    ...credentials.map(([key]) => `  tavi credentials set plugins.${pluginId}.${key} --file <file>`),
    `  tavi plugins config ${pluginId} ${sets.map((set) => `--set ${set}`).join(" ")}`,
    "",
  ].join("\n");
}

/** An `apps` answer in words, for the payload that asked it. */
export function appsAnswerText(payload: AppsPayload, result: unknown, options: { readonly needsYou?: boolean } = {}): string {
  const answer = result as Readonly<Record<string, unknown>>;
  switch (payload.action) {
    case "list":
      return appsListText(answer["apps"] as readonly ConnectableApp[], options.needsYou === true);
    case "show":
      return appText(answer["app"] as ConnectableApp);
    case "catalog":
      return catalogText(answer["catalog"] as AppsCatalogAnswer);
    case "activity":
      return activityText(answer["activity"] as AppsActivityAnswer, payload.appId);
    case "add": {
      const added = answer["added"] as { readonly appId: string; readonly pluginId: string };
      return addedText(added.appId, added.pluginId);
    }
    case "permission":
      return `${payload.toolId}: ${payload.target === "allow" ? "allowed" : payload.target === "ask" ? "asks first" : "blocked"}\n`;
    case "sharing":
      return payload.sharing === "personal"
        ? `${payload.accountId} is Personal: only your own one-to-one chats use it\n`
        : `${payload.accountId} is Shared: people you allowed may use it\n`;
    case "disconnect": {
      const out = answer["disconnected"] as {
        readonly accountId: string;
        readonly revoked: boolean;
        readonly removed: boolean;
        readonly keptBy?: readonly string[];
      };
      const kept = out.keptBy ?? [];
      const how = out.revoked
        ? ": its sign-in revoked at the provider"
        : kept.length > 0
          ? keptByNote(kept)
          : ": its sign-in forgotten here (revoke Tavi's access in the provider's own settings)";
      return `${out.accountId} disconnected${how}${out.removed ? ", and removed" : ""}\n`;
    }
    case "remove":
      return `${payload.appId} removed\n`;
    case "mailbox":
      return payload.mailbox === "off"
        ? `the agent no longer reads ${payload.accountId}\n`
        : payload.mailbox === "read"
          ? `the agent may read and draft in ${payload.accountId}; it never sends\n`
          : `the agent may also send drafts you approve from ${payload.accountId}, each one shown before it goes\n`;
    case "receive":
      return payload.on
        ? `${payload.accountId} takes messages in; sign in again if its provider asks for the access\n`
        : `${payload.accountId} takes no messages in: it only carries its mailbox's and calendar's tools\n`;
    case "calendar":
      return payload.on
        ? `the agent may use ${payload.accountId}'s calendar, asking before it adds or changes an event; sign in again if Google asks for the calendar's access\n`
        : `the agent no longer uses ${payload.accountId}'s calendar\n`;
    case "sites":
      return payload.on
        ? `the agent may browse ${payload.siteId} for ${payload.appId}, within its profile's rules and budgets\n`
        : `${payload.siteId} is off: the agent does not browse it for ${payload.appId}\n`;
    case "configure":
      return `${appNameOf(payload.appId)}'s OAuth client is saved\n`;
    default:
      return `${JSON.stringify(result)}\n`;
  }
}
