import {
  MCP_PRESET_IDS,
  signsIn,
  keyedError,
  TaviError,
  TaviErrorCodeSchema,
  type AppsConnectAnswer,
  type AppsPayload,
  type ChannelsOAuthDeviceStartAnswer,
  type ChannelsOAuthStartAnswer,
  type ChannelsSaveAnswer,
  type ConnectableApp,
  type McpPresetId,
} from "@tavi/contracts";

import { createLocalCredentialStore, plainCredentialValue, serializeCredentialAction } from "../credentials/store.js";
import { refusalFrom, type IpcAnswer } from "../../shared/ipc-decisions.js";
import { noSuchAccount } from "./accounts.js";
import { appActivity, type ActivityAccount } from "./activity.js";
import { approvedVersionOf, channelPresentationOf } from "./builtin.js";
import { channelPluginOf } from "../channels/catalog.js";
import { mailboxToolSlug } from "./mailbox-catalog.js";
import { appsCatalog, projectApps, resultOf, type AppsContext } from "./registry.js";
import { sharedProviderOf } from "../channels/oauth.js";
import { parseClientFile, saveSharedOAuthClient } from "./oauth-clients.js";
import { pageRuleId, resolvePermission } from "./permissions.js";
import { otherWaysIn, presetOf } from "../mcp/presets/index.js";
import {
  APPS_CALENDAR_SETTING,
  APPS_MAILBOX_SETTING,
  APPS_REFUSED_SETTING,
  APPS_SHARING_SETTING,
  APPS_SITES_SETTING,
  parseCalendar,
  configPrint,
  parseMailbox,
  parseRefused,
  parseSharing,
  parseSites,
  withSharing,
} from "./sharing.js";

/**
 * `apps`: Connected apps' one
 * command, a façade over the sources' own. Adding, configuring, testing and
 * removing go through `mcp` and `plugins`, so a page meets the refusals it
 * meets there; the only rules it writes are its own, never an allow.
 */

/** The plugin slug each preset is added under (`mcp.<slug>`); another account of it takes the next free one (`todoist2` …). */
export const PRESET_SLUGS: Readonly<Record<string, string>> = {
  "google-maps": "gmaps",
  homeassistant: "homeassistant",
  todoist: "todoist",
  "todoist-token": "todoist",
  linear: "linear",
  notion: "notion",
  sentry: "sentry",
  stripe: "stripe",
  figma: "figma",
};

export function nextSlug(base: string, taken: ReadonlySet<string>): string {
  const stem =
    base
      .replace(/[^a-z0-9]/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 16) || "app";
  if (!taken.has(`mcp.${stem}`)) return stem;
  for (let n = 2; n < 1000; n += 1) {
    const slug = `${stem}${String(n)}`;
    if (!taken.has(`mcp.${slug}`)) return slug;
  }
  throw new TaviError("CONFLICT", `no free server name for ${stem}`);
}

async function appOf(context: AppsContext, appId: string, workspaceId: string): Promise<ConnectableApp> {
  const app = (await projectApps(context, workspaceId)).find((candidate) => candidate.appId === appId);
  if (app === undefined) throw keyedError("NOT_FOUND", "error.apps.notFound", { appId });
  return app;
}

/** Records, or clears, that a server refused the key it holds at its test, with the settings it held then. */
async function noteRefusal(context: AppsContext, pluginId: string, refused: boolean): Promise<void> {
  const before = parseRefused(await context.getMeta(APPS_REFUSED_SETTING));
  if (!refused && before[pluginId] === undefined) return;
  const { [pluginId]: _gone, ...others } = before;
  const view = (await context.views()).find((candidate) => candidate.id === pluginId);
  const after = refused && view !== undefined ? { ...others, [pluginId]: { at: context.now(), config: configPrint(view.config) } } : others;
  await context.setMeta(APPS_REFUSED_SETTING, JSON.stringify(after));
}

/** The site note ids of a plugin's approved version: one awaiting review switches no note on. */
async function approvedSiteNoteIds(context: AppsContext, pluginId: string): Promise<readonly string[]> {
  const view = (await context.views()).find((candidate) => candidate.id === pluginId);
  const approved = view === undefined ? undefined : approvedVersionOf(view);
  return approved === undefined ? [] : (context.siteNotesOf?.(pluginId, approved) ?? []);
}

function accountOf(app: ConnectableApp, accountId: string | undefined): ConnectableApp["accounts"][number] {
  const account = accountId === undefined ? app.accounts[0] : app.accounts.find((candidate) => candidate.accountId === accountId);
  if (account === undefined)
    throw accountId === undefined ? keyedError("NOT_FOUND", "error.apps.noAccount", { app: app.name }) : noSuchAccount(app, accountId);
  return account;
}

/**
 * An MCP app goes whole: its servers (with their credentials and sign-ins, as `plugins remove` takes them), the page's own
 * rules for its tools (rules made elsewhere stay where they were made), who may use each account, and its sites (a
 * reinstalled app starts with every site off).
 */
async function removeApp(context: AppsContext, app: ConnectableApp): Promise<void> {
  for (const pluginId of app.source.pluginIds) resultOf(await context.plugins({ action: "remove", pluginId }));
  for (const tool of app.tools) await context.rules.remove("*", pageRuleId(tool.toolId));
  const overrides = { ...parseSharing(await context.getMeta(APPS_SHARING_SETTING)) };
  for (const account of app.accounts) delete overrides[account.accountId];
  await context.setMeta(APPS_SHARING_SETTING, JSON.stringify(overrides));
  const sites = { ...parseSites(await context.getMeta(APPS_SITES_SETTING)) };
  if (app.source.pluginIds.some((pluginId) => sites[pluginId] !== undefined)) {
    for (const pluginId of app.source.pluginIds) delete sites[pluginId];
    await context.setMeta(APPS_SITES_SETTING, JSON.stringify(sites));
  }
}

/** The app a preset's other way into the same server added (Todoist's sign-in for its token, or the reverse), if any. */
async function otherWayIn(context: AppsContext, preset: McpPresetId, workspaceId: string): Promise<ConnectableApp | undefined> {
  const others: readonly string[] = otherWaysIn(preset);
  if (others.length === 0) return undefined;
  return (await projectApps(context, workspaceId)).find(
    (app) => app.source.kind === "mcp" && app.source.preset !== undefined && others.includes(app.source.preset),
  );
}

/** How an app is reached, in words: "by signing in", or "with your Todoist API token". */
function wayInWords(app: ConnectableApp): { readonly how: string; readonly what: string } {
  if (app.auth.kind !== "api-key") return { how: "by signing in", what: "its sign-in is removed" };
  const key = (app.auth.fields[0]?.label ?? "its key").replace(/^Your /, "your ");
  return { how: `with ${key}`, what: `${key.replace(/^your /, "the ")} is deleted` };
}

/** The refusal that offers the switch: one server per way in, so the person chooses to replace it. */
function switchOffer(app: ConnectableApp, preset: McpPresetId): TaviError {
  const toName = presetOf(preset)?.name ?? preset;
  const { how, what } = wayInWords(app);
  return new TaviError(
    "CONFLICT",
    `${app.source.pluginIds.join(", ")} ${app.source.pluginIds.length === 1 ? "is" : "are"} already added as ${app.name}, which reaches the same server ${how}: Tavi keeps one. Switch it to ${toName} with \`tavi apps add ${preset} --switch\`: ${what} and its tools are reviewed again`,
    { details: { switch: { appId: app.appId, name: app.name, pluginIds: app.source.pluginIds, to: preset, toName } } },
  );
}

async function run(context: AppsContext, input: AppsPayload): Promise<unknown> {
  switch (input.action) {
    case "list":
      return { apps: await projectApps(context, input.workspaceId) };
    case "show":
      return { app: await appOf(context, input.appId, input.workspaceId) };
    case "catalog":
      return { catalog: await appsCatalog(context, input) };
    case "add": {
      const { entry } = input;
      if (entry.kind === "installed") {
        const app = (await projectApps(context, input.workspaceId)).find((candidate) =>
          candidate.source.pluginIds.includes(entry.pluginId),
        );
        if (app === undefined) throw keyedError("NOT_FOUND", "error.apps.notInstalled", { pluginId: entry.pluginId });
        return { added: { appId: app.appId, pluginId: entry.pluginId } };
      }
      if (entry.kind === "channel") return { added: await addChannelAccount(context, entry.providerId, input.workspaceId) };
      // Another way into a server already added (Todoist's sign-in or its token) switches that server, once asked to.
      const other = entry.kind === "preset" ? await otherWayIn(context, entry.id, input.workspaceId) : undefined;
      if (other !== undefined && entry.kind === "preset") {
        if (input.switch !== true) throw switchOffer(other, entry.id);
        await removeApp(context, other);
      }
      const gone = new Set(other?.source.pluginIds ?? []);
      const taken = new Set((await context.views()).map((view) => view.id).filter((id) => !gone.has(id)));
      const base = entry.kind === "preset" ? (PRESET_SLUGS[entry.id] ?? entry.id) : (entry.name.split(/[/.]/).at(-1) ?? entry.name);
      const slug = nextSlug(base, taken);
      const answer = await context.mcp({
        action: "add",
        slug,
        form:
          entry.kind === "preset"
            ? { kind: "preset", preset: entry.id }
            : { kind: "registry", name: entry.name, version: entry.version, option: entry.option },
      });
      if (!answer.ok && other !== undefined)
        throw new TaviError(
          TaviErrorCodeSchema.catch("UNAVAILABLE").parse(answer.error.code),
          `${other.name} was removed, but ${slug} could not be added: ${answer.error.message}`,
        );
      const added = resultOf<{ readonly added: { readonly pluginId: string; readonly version: string } }>(answer);
      const app = (await projectApps(context, input.workspaceId)).find((candidate) =>
        candidate.source.pluginIds.includes(added.added.pluginId),
      );
      return {
        added: {
          appId: app?.appId ?? added.added.pluginId,
          pluginId: added.added.pluginId,
          version: added.added.version,
          ...(other === undefined ? {} : { switched: { from: other.appId, pluginIds: other.source.pluginIds } }),
        },
      };
    }
    case "configure": {
      const app = await appOf(context, input.appId, input.workspaceId);
      const account = accountOf(app, input.accountId);
      // A shared client's id and secret are the provider's, not one plugin's.
      const provider = app.auth.kind === "oauth" ? app.auth.provider : undefined;
      // A channel's settings stay in Channels; its provider's shared client is every app's, so any of them sets it.
      const clientOnly =
        provider !== undefined &&
        (input.clientFile !== undefined ||
          (input.values?.["clientId"] !== undefined &&
            Object.keys(input.values).every((key) => key === "clientId" || key === "clientSecret")));
      if (app.source.kind === "channel" ? !clientOnly : account.readOnly)
        throw keyedError("UNSUPPORTED", "error.apps.configureInChannels", { app: app.name });
      const values = { ...input.values };
      if (input.clientFile !== undefined && provider === undefined)
        throw keyedError("INVALID_INPUT", "error.apps.noSharedClient", { app: app.name });
      // The client file the provider's console downloads, read for its id and secret.
      const file = input.clientFile === undefined ? undefined : parseClientFile(input.clientFile);
      if (file !== undefined && (values["clientId"] !== undefined || values["clientSecret"] !== undefined))
        throw keyedError("INVALID_INPUT", "error.apps.clientFileOrId");
      const sharedId = provider === undefined ? undefined : (file?.clientId ?? values["clientId"]);
      const sharedSecret = provider === undefined ? undefined : (file?.clientSecret ?? values["clientSecret"]);
      if (provider !== undefined) {
        if (sharedId !== undefined && (typeof sharedId !== "string" || sharedId.trim() === ""))
          throw keyedError("INVALID_INPUT", "error.apps.clientIdEmpty");
        if (sharedSecret !== undefined && typeof sharedSecret !== "string") throw new TaviError("INVALID_INPUT", "clientSecret is text");
        if (sharedSecret !== undefined && sharedId === undefined) throw keyedError("INVALID_INPUT", "error.apps.secretWithoutId");
        delete values["clientId"];
        delete values["clientSecret"];
      }
      // Everything is checked before anything is written, so a refused request changes nothing.
      const fields = new Map(app.settings.map((field) => [field.key, field]));
      const plain: Record<string, string | number | boolean> = {};
      const secrets: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        const field = fields.get(key);
        if (field === undefined) throw keyedError("INVALID_INPUT", "error.apps.notASetting", { key, app: app.name });
        if (field.type === "credential") {
          if (typeof value !== "string") throw new TaviError("INVALID_INPUT", `${key} is text`);
          secrets[key] = plainCredentialValue(key, value);
        } else if (
          (field.type === "number" && typeof value !== "number") ||
          (field.type === "boolean" && typeof value !== "boolean") ||
          (field.type !== "number" && field.type !== "boolean" && typeof value !== "string")
        ) {
          throw new TaviError(
            "INVALID_INPUT",
            `${key} must be a ${field.type === "number" || field.type === "boolean" ? field.type : "string"}`,
          );
        } else plain[key] = value;
      }
      if (typeof sharedId === "string" && provider !== undefined) {
        await saveSharedClient(context, provider, {
          clientId: sharedId.trim(),
          ...(typeof sharedSecret === "string" && sharedSecret.trim() !== ""
            ? { clientSecret: plainCredentialValue("clientSecret", sharedSecret) }
            : {}),
        });
      }
      // A secret goes to the credential store, and the setting names it there; it is never kept in settings.
      const set: Record<string, string | number | boolean> = { ...plain };
      for (const [key, value] of Object.entries(secrets)) {
        const reference = `plugins.${account.accountId}.${key}`;
        await serializeCredentialAction(context.dataDirectory, () =>
          createLocalCredentialStore(context.dataDirectory).setSecret(reference, value),
        );
        set[key] = reference;
      }
      if (Object.keys(set).length > 0) resultOf(await context.plugins({ action: "config", pluginId: account.accountId, set, unset: [] }));
      // A key given again is not the one refused.
      if (Object.keys(secrets).length > 0) await noteRefusal(context, account.accountId, false);
      return { configured: { appId: app.appId, accountId: account.accountId } };
    }
    case "test": {
      const app = await appOf(context, input.appId, input.workspaceId);
      const account = accountOf(app, input.accountId);
      if (app.source.kind !== "mcp")
        throw app.source.kind === "channel"
          ? keyedError("UNSUPPORTED", "error.apps.testInChannels")
          : keyedError("UNSUPPORTED", "error.apps.noTest", { app: app.name });
      const probed = await context.mcp({ action: "probe", pluginId: account.accountId, workspaceId: input.workspaceId });
      // A key its server refused is set up again, not reviewed: its version cannot be probed with it. A test that
      // failed otherwise (the server down) says nothing of the key.
      const refused = !probed.ok && probed.error.details?.["mcpFailure"] === "auth";
      if (app.auth.kind === "api-key" && (probed.ok || refused)) await noteRefusal(context, account.accountId, refused);
      resultOf(probed);
      // A server that lists its tools without the key answered, but did not check the key.
      const unchecked = presetOf(MCP_PRESET_IDS.find((id) => id === app.source.preset))?.keyCheckedOnUse === true;
      return { tested: { appId: app.appId, accountId: account.accountId, ok: true, ...(unchecked ? { keyChecked: false } : {}) } };
    }
    case "permission": {
      const app = await appOf(context, input.appId, input.workspaceId);
      const tool = app.tools.find((candidate) => candidate.toolId === input.toolId);
      if (tool === undefined) throw keyedError("NOT_FOUND", "error.apps.noTool", { app: app.name, toolId: input.toolId });
      if (tool.state === "disabled") throw keyedError("INVALID_INPUT", "error.apps.toolLeftOut", { tool: tool.title });
      // A tool new or changed since its review starts from its reviewed default.
      if (tool.state !== "offered") throw keyedError("INVALID_INPUT", "error.apps.toolUnreviewed", { tool: tool.title });
      // Owner-wide: the change must hold against every workspace's rules.
      const ruleSets = await Promise.all(
        [...new Set([input.workspaceId, ...context.workspaceIds()])].map((workspaceId) => context.rules.inForce(workspaceId)),
      );
      const change = resolvePermission(
        ruleSets,
        { toolId: tool.toolId, effect: tool.effect, floor: tool.floor, mcp: app.source.kind === "mcp" },
        input.target,
        { actor: context.actor, now: context.now() },
      );
      if (change.kind === "put") await context.rules.put(change.rule);
      else if (change.kind === "delete") await context.rules.remove("*", change.ruleId);
      return { permission: { appId: app.appId, toolId: tool.toolId, target: input.target } };
    }
    case "sharing": {
      const app = await appOf(context, input.appId, input.workspaceId);
      const account = accountOf(app, input.accountId);
      const overrides = withSharing(parseSharing(await context.getMeta(APPS_SHARING_SETTING)), account.accountId, input.sharing);
      await context.setMeta(APPS_SHARING_SETTING, JSON.stringify(overrides));
      return { sharing: { appId: app.appId, accountId: account.accountId, sharing: input.sharing } };
    }
    case "decline-connect": {
      if (context.declineConnect === undefined) throw new TaviError("UNSUPPORTED", "this owner runs no tasks to decline for");
      await context.declineConnect(input.waitId, input.workspaceId);
      return { declined: { waitId: input.waitId } };
    }
    case "mailbox": {
      const app = await appOf(context, input.appId, input.workspaceId);
      const account = accountOf(app, input.accountId);
      if (account.mailbox === undefined) throw keyedError("UNSUPPORTED", "error.apps.notMailbox", { app: app.name });
      const access = { ...parseMailbox(await context.getMeta(APPS_MAILBOX_SETTING)) };
      if (input.mailbox === "off") delete access[account.accountId];
      else access[account.accountId] = input.mailbox;
      await context.setMeta(APPS_MAILBOX_SETTING, JSON.stringify(access));
      // Its tools need Gmail's access: an account signed in without it asks for the sign-in now.
      if (input.mailbox !== "off") await context.checkMailConsent?.(account.accountId);
      return { mailbox: { appId: app.appId, accountId: account.accountId, mailbox: input.mailbox } };
    }
    case "receive": {
      const app = await appOf(context, input.appId, input.workspaceId);
      const account = accountOf(app, input.accountId);
      if (account.receives === undefined) throw keyedError("UNSUPPORTED", "error.apps.alwaysReceives", { app: app.name });
      if (context.channels === undefined) throw new TaviError("UNSUPPORTED", "this owner has no channels to change");
      const record = (await context.connections(input.workspaceId)).find((candidate) => candidate.connectionId === account.accountId);
      if (record === undefined) throw keyedError("NOT_FOUND", "error.apps.noAccountId", { app: app.name, accountId: account.accountId });
      resultOf(
        await context.channels({
          action: "save",
          workspaceId: input.workspaceId,
          connectionId: record.connectionId,
          providerId: record.providerId,
          ...(record.label === undefined ? {} : { label: record.label }),
          enabled: record.enabled,
          settings: { ...record.settings, receive: input.on },
        }),
      );
      return { receive: { appId: app.appId, accountId: account.accountId, on: input.on } };
    }
    case "calendar": {
      const app = await appOf(context, input.appId, input.workspaceId);
      const account = accountOf(app, input.accountId);
      if (account.calendar === undefined) throw keyedError("UNSUPPORTED", "error.apps.noCalendar", { app: app.name });
      const on = new Set(parseCalendar(await context.getMeta(APPS_CALENDAR_SETTING)));
      if (input.on) on.add(account.accountId);
      else on.delete(account.accountId);
      await context.setMeta(APPS_CALENDAR_SETTING, JSON.stringify(Object.fromEntries([...on].sort().map((id) => [id, true]))));
      return { calendar: { appId: app.appId, accountId: account.accountId, on: input.on } };
    }
    case "sites": {
      const app = await appOf(context, input.appId, input.workspaceId);
      const [pluginId] = app.source.pluginIds;
      // A site profile's id, or a site note's: a plugin may ship notes with no profile of the same id.
      const siteId =
        app.sites?.find((candidate) => candidate.siteId === input.siteId)?.siteId ??
        (pluginId !== undefined && (await approvedSiteNoteIds(context, pluginId)).includes(input.siteId) ? input.siteId : undefined);
      if (siteId === undefined || pluginId === undefined)
        throw keyedError("NOT_FOUND", "error.apps.noSite", { app: app.name, siteId: input.siteId });
      const sites = { ...parseSites(await context.getMeta(APPS_SITES_SETTING)) };
      const on = new Set(sites[pluginId] ?? []);
      if (input.on) on.add(siteId);
      else on.delete(siteId);
      if (on.size === 0) delete sites[pluginId];
      else sites[pluginId] = [...on].sort();
      await context.setMeta(APPS_SITES_SETTING, JSON.stringify(sites));
      return { sites: { appId: app.appId, siteId, on: input.on } };
    }
    case "remove": {
      const app = await appOf(context, input.appId, input.workspaceId);
      if (app.source.kind === "channel") throw keyedError("UNSUPPORTED", "error.apps.removeInChannels");
      await removeApp(context, app);
      return { removed: { appId: app.appId, pluginIds: app.source.pluginIds } };
    }
    case "connect": {
      const app = await appOf(context, input.appId, input.workspaceId);
      if (app.source.kind === "channel") return { connect: await connectChannel(context, app, input) };
      if (app.source.kind !== "mcp") throw keyedError("UNSUPPORTED", "error.apps.signsInWithSettings", { app: app.name });
      if (app.auth.kind !== "oauth") throw keyedError("INVALID_INPUT", "error.apps.signsInWithKey", { app: app.name });
      if (input.via !== "public" && input.origin === undefined) throw keyedError("INVALID_INPUT", "error.apps.needsPageAddress");
      let accountId: string;
      let added: string | undefined;
      if (input.addAccount) {
        // Another account of a preset is another instance of it; it is reviewed after it signs in.
        const preset = MCP_PRESET_IDS.find((id) => id === app.source.preset);
        if (preset === undefined) throw keyedError("UNSUPPORTED", "error.apps.oneAccount", { app: app.name });
        const taken = new Set((await context.views()).map((view) => view.id));
        added = resultOf<{ readonly added: { readonly pluginId: string } }>(
          await context.mcp({ action: "add", slug: nextSlug(PRESET_SLUGS[preset] ?? preset, taken), form: { kind: "preset", preset } }),
        ).added.pluginId;
        accountId = added;
      } else accountId = accountOf(app, input.accountId).accountId;
      const started = await context.mcp(
        input.via === "public"
          ? { action: "login", pluginId: accountId, via: "public" }
          : { action: "login", pluginId: accountId, origin: input.origin as string, via: "loopback" },
      );
      // A new account that could not start signing in is not left behind, empty.
      if (!started.ok && added !== undefined) await context.plugins({ action: "remove", pluginId: added });
      const login = resultOf<{ readonly login: { readonly flowId: string; readonly authorizeUrl: string; readonly redirect: string } }>(
        started,
      );
      return {
        connect: {
          flowId: login.login.flowId,
          authorizeUrl: login.login.authorizeUrl,
          redirectUri: login.login.redirect,
          via: input.via,
          accountId,
        },
      };
    }
    case "connect-status": {
      const channel = await channelFlow(context, input.flowId, input.workspaceId);
      if (channel !== undefined) return { status: channel };
      const status = resultOf<{
        readonly loginStatus: {
          readonly state: "pending" | "connected" | "failed" | "expired";
          readonly pluginId: string;
          readonly detail?: string;
          readonly identity?: string;
        };
      }>(await context.mcp({ action: "login-status", flowId: input.flowId })).loginStatus;
      return {
        status: {
          state: status.state === "connected" ? "done" : status.state,
          accountId: status.pluginId,
          ...(status.detail === undefined ? {} : { message: status.detail.slice(0, 500) }),
          ...(status.identity === undefined ? {} : { identity: status.identity }),
        },
      };
    }
    case "connect-finish": {
      if (
        input.workspaceId !== undefined &&
        context.channels !== undefined &&
        (await channelFlow(context, input.flowId, input.workspaceId)) !== undefined
      ) {
        const finished = resultOf<{ readonly ok: boolean; readonly message: string }>(
          await context.channels({ action: "oauth-finish", workspaceId: input.workspaceId, flowId: input.flowId, address: input.address }),
        );
        if (!finished.ok) throw new TaviError("INVALID_INPUT", finished.message);
        return { finished: { flowId: input.flowId } };
      }
      resultOf(await context.mcp({ action: "login-finish", flowId: input.flowId, address: input.address }));
      return { finished: { flowId: input.flowId } };
    }
    case "connect-cancel":
      if (
        input.workspaceId !== undefined &&
        context.channels !== undefined &&
        (await channelFlow(context, input.flowId, input.workspaceId)) !== undefined
      ) {
        resultOf(await context.channels({ action: "oauth-cancel", workspaceId: input.workspaceId, flowId: input.flowId }));
        return { cancelled: { flowId: input.flowId } };
      }
      resultOf(await context.mcp({ action: "login-cancel", flowId: input.flowId }));
      return { cancelled: { flowId: input.flowId } };
    case "disconnect": {
      const app = await appOf(context, input.appId, input.workspaceId);
      const account = accountOf(app, input.accountId);
      if (account.readOnly) throw keyedError("UNSUPPORTED", "error.apps.disconnectInChannels", { app: app.name });
      // Another app signed in with the same project and account keeps the provider's grant: only this one's token goes.
      const upstream = (account.keptBy ?? []).length === 0;
      if (app.source.kind === "channel") {
        if (context.channels === undefined) throw keyedError("UNSUPPORTED", "error.apps.disconnectInChannels", { app: app.name });
        resultOf(
          await context.channels({
            action: "oauth-disconnect",
            workspaceId: account.workspaces[0] ?? input.workspaceId,
            connectionId: account.accountId,
            ...(upstream ? {} : { upstream: false }),
          }),
        );
        // Revoked at the provider only where it offers revocation, and not confirmed: said as forgotten here.
        return {
          disconnected: { appId: app.appId, accountId: account.accountId, revoked: false, removed: false, keptBy: account.keptBy ?? [] },
        };
      }
      if (app.source.kind !== "mcp") throw keyedError("UNSUPPORTED", "error.apps.nothingToDisconnect", { app: app.name });
      const out =
        app.auth.kind === "oauth"
          ? resultOf<{ readonly loggedOut: { readonly hadGrant: boolean; readonly confirmed: boolean } }>(
              await context.mcp({ action: "logout", pluginId: account.accountId, ...(upstream ? {} : { upstream: false }) }),
            ).loggedOut
          : { hadGrant: false, confirmed: false };
      // A second account goes with its sign-in when asked, leaving no empty instance; the first one never does.
      const removing = input.remove && app.accounts.length > 1 && app.accounts[0]?.accountId !== account.accountId;
      if (removing) {
        resultOf(await context.plugins({ action: "remove", pluginId: account.accountId }));
        for (const tool of app.tools.filter((candidate) => candidate.toolId.startsWith(`${account.accountId}.`)))
          await context.rules.remove("*", pageRuleId(tool.toolId));
        const overrides = { ...parseSharing(await context.getMeta(APPS_SHARING_SETTING)) };
        delete overrides[account.accountId];
        await context.setMeta(APPS_SHARING_SETTING, JSON.stringify(overrides));
      }
      return {
        disconnected: {
          appId: app.appId,
          accountId: account.accountId,
          revoked: out.confirmed,
          removed: removing,
          keptBy: account.keptBy ?? [],
        },
      };
    }
    case "activity": {
      if (context.activity === undefined) throw new TaviError("UNSUPPORTED", "this owner keeps no activity to show");
      const app = await appOf(context, input.appId, input.workspaceId);
      return {
        activity: await appActivity(context.activity, app, input, app.source.kind === "channel" ? channelToolAccounts(app) : undefined),
      };
    }
  }
}

/**
 * A channel's accounts whose mailbox has tools, each with the prefix its tools' ids share: read from
 * the tools the projection listed, so it holds whatever the app's id is.
 */
function channelToolAccounts(app: ConnectableApp): ActivityAccount[] {
  return app.accounts.flatMap((account) => {
    const slug = `.${mailboxToolSlug(account.accountId)}.`;
    const tool = app.tools.find((candidate) => candidate.toolId.includes(slug));
    return tool === undefined
      ? []
      : [{ accountId: account.accountId, prefix: tool.toolId.slice(0, tool.toolId.indexOf(slug) + slug.length) }];
  });
}

/**
 * Saves a provider's shared client. With a channel of that provider, through
 * the channels command, which signs out its connections made with another
 * client first (a refresh token is its client's alone); else directly.
 */
async function saveSharedClient(
  context: AppsContext,
  provider: string,
  client: { readonly clientId: string; readonly clientSecret?: string },
): Promise<void> {
  const channel = context.descriptors().find((descriptor) => sharedProviderOf(descriptor.providerId) === provider);
  if (channel === undefined || context.channels === undefined) {
    await saveSharedOAuthClient(context.dataDirectory, provider, client);
    return;
  }
  resultOf(
    await context.channels({
      action: "oauth-client",
      providerId: channel.providerId,
      clientId: client.clientId,
      ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
    }),
  );
}

/**
 * A channel connection signs in through the channels command's own flow:
 * back to the page, to the owner's https address, or by paste. A
 * second account is a second connection of the channel, added here and
 * removed again if its sign-in cannot start.
 */
async function connectChannel(
  context: AppsContext,
  app: ConnectableApp,
  input: Extract<AppsPayload, { readonly action: "connect" }>,
): Promise<AppsConnectAnswer> {
  if (context.channels === undefined) throw keyedError("UNSUPPORTED", "error.apps.connectInChannels", { app: app.name });
  if (!signsIn(app.auth)) throw keyedError("UNSUPPORTED", "error.apps.keysInChannels", { app: app.name });
  // A code is entered on any device, so it needs no address to come back to.
  const device = app.auth.kind === "device";
  if (!device && input.via !== "public" && input.origin === undefined) throw keyedError("INVALID_INPUT", "error.apps.needsPageAddress");
  let connectionId: string;
  let workspaceId: string;
  let added = false;
  if (input.addAccount) {
    const providerId = context.descriptors().find((descriptor) => descriptor.providerId === app.appId)?.providerId;
    if (providerId === undefined) throw keyedError("NOT_FOUND", "error.apps.channelNotInstalled", { app: app.name });
    workspaceId = input.workspaceId;
    connectionId = resultOf<{ readonly connectionId: string }>(
      await context.channels({ action: "save", workspaceId, providerId, enabled: true, settings: {} }),
    ).connectionId;
    added = true;
  } else {
    const account = accountOf(app, input.accountId);
    connectionId = account.accountId;
    workspaceId = account.workspaces[0] ?? input.workspaceId;
  }
  const channels = context.channels;
  let started: ChannelsOAuthStartAnswer | ChannelsOAuthDeviceStartAnswer;
  try {
    started = resultOf(
      await channels({
        action: "oauth-start",
        workspaceId,
        connectionId,
        ...(device ? { device: true } : input.via === "public" ? { public: true } : { origin: input.origin as string }),
      }),
    );
  } catch (error) {
    // A new account that could not start signing in is not left behind, empty.
    if (added) await channels({ action: "delete", workspaceId, connectionId });
    throw error;
  }
  if ("userCode" in started) {
    return {
      flowId: started.flowId,
      authorizeUrl: started.verificationUriComplete ?? started.verificationUri,
      redirectUri: "",
      via: input.via,
      accountId: connectionId,
      device: { userCode: started.userCode, verificationUri: started.verificationUri, expiresAt: started.expiresAt },
    };
  }
  return {
    flowId: started.flowId,
    authorizeUrl: started.authorizeUrl,
    redirectUri: redirectOf(started.authorizeUrl),
    via: input.via,
    accountId: connectionId,
  };
}

/** The redirect the provider was asked to come back to, as its authorize address names it. */
function redirectOf(authorizeUrl: string): string {
  try {
    return new URL(authorizeUrl).searchParams.get("redirect_uri") ?? "";
  } catch {
    return "";
  }
}

/** A channel's sign-in by its flow, as Connected apps reports one; undefined when it is not a channel's. */
async function channelFlow(
  context: AppsContext,
  flowId: string,
  workspaceId: string | undefined,
): Promise<
  { readonly state: "pending" | "done" | "failed" | "expired"; readonly message?: string; readonly identity?: string } | undefined
> {
  if (workspaceId === undefined || context.channels === undefined || !UUID.test(flowId)) return undefined;
  const status = resultOf<{ readonly state: string; readonly accountIdentity?: string; readonly detail?: string }>(
    await context.channels({ action: "oauth-status", workspaceId, flowId }),
  );
  if (status.state === "gone") return undefined;
  const state =
    status.state === "connected"
      ? "done"
      : status.state === "pending" || status.state === "failed" || status.state === "expired"
        ? status.state
        : "failed";
  return {
    state,
    ...(status.detail === undefined ? {} : { message: status.detail.slice(0, 500) }),
    ...(status.accountIdentity === undefined ? {} : { identity: status.accountIdentity.slice(0, 254) }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs one `apps` action; a thrown refusal is answered as its code. */
export async function appsCommand(context: AppsContext, input: AppsPayload): Promise<IpcAnswer<unknown>> {
  try {
    return { ok: true, result: await run(context, input) };
  } catch (error) {
    const failure = TaviError.from(error);
    // A sign-in that needs the person's own client: the connect sheet asks for it, with the redirect it registers.
    const redirect = failure.details?.["redirect"];
    // A second way into a server already added: the page offers the switch from these facts.
    const offer = failure.details?.["switch"];
    if (failure.code === "CONFLICT" && offer !== undefined) return refusalFrom(failure, { switch: offer });
    return failure.details?.["needsClient"] === true && typeof redirect === "string"
      ? refusalFrom(failure, { needsClient: true, redirect })
      : refusalFrom(failure);
  }
}

/**
 * A new account of a channel that signs in (Google's), added from Discover: a connection with its settings'
 * defaults, made through the channels command, to sign in from its connect sheet. A channel set up with keys is
 * added in Discover's channel sheet instead, where its keys are entered.
 */
async function addChannelAccount(
  context: AppsContext,
  providerId: string,
  workspaceId: string,
): Promise<{ readonly appId: string; readonly pluginId: string; readonly accountId: string }> {
  const descriptor = context.descriptors().find((candidate) => candidate.providerId === providerId);
  if (descriptor === undefined) throw keyedError("NOT_FOUND", "error.apps.noChannel", { providerId });
  if (descriptor.auth.kind !== "oauth2" || context.channels === undefined)
    throw keyedError("UNSUPPORTED", "error.apps.addInChannels", { channel: descriptor.label });
  const settings = Object.fromEntries(
    descriptor.settings.flatMap((field) => (field.default === undefined ? [] : [[field.key, field.default]])),
  );
  const saved = resultOf<ChannelsSaveAnswer>(await context.channels({ action: "save", workspaceId, providerId, enabled: true, settings }));
  return {
    appId: channelPresentationOf(descriptor)?.id ?? providerId,
    pluginId: channelPluginOf(providerId) ?? providerId,
    accountId: saved.connectionId,
  };
}
