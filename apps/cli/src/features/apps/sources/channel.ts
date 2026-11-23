import {
  appSettingFromChannelField,
  worseHealth,
  type AppAuth,
  type AppRepair,
  type AppScope,
  type AppToolView,
  type ChannelDescriptor,
  type ConnectableApp,
  type MessagingConnectionRecord,
  type MessagingSetup,
  type ToolRule,
} from "@tavi/contracts";
import type { CoreT } from "@tavi/contracts/locales/core";
import { hostAllowed } from "@tavi/runtime";

import { signsInByCode } from "../../channels/oauth.js";
import { clientSetupOf } from "../client-setup.js";
import { channelGrantsOf, channelPluginOf, mailboxKitOf } from "../../channels/catalog.js";
import { channelPresentationOf } from "../builtin.js";
import { oauthClientCredentialRefs } from "../oauth-clients.js";
import { channelAccountHealth, channelAccountRepair, type ChannelRunningStatus } from "../health.js";
import { CALENDAR_TOOLS } from "../calendar-catalog.js";
import { MAILBOX_TOOLS, mailboxCan, mailboxToolPrefix } from "../mailbox-catalog.js";
import { toolPolicy } from "../permissions.js";
import { sharingOf, type SharingOverrides } from "../sharing.js";
import { accessOf } from "./mcp.js";

/**
 * Channel connections as app accounts.
 * One that signs in (OAuth) is connected, reconnected and disconnected from
 * its app's page; one with keys, and every channel's settings, stay
 * in Settings → Channels.
 */

export interface ChannelSourceInput {
  readonly connections: readonly MessagingConnectionRecord[];
  readonly descriptorOf: (providerId: string) => ChannelDescriptor | undefined;
  readonly sharing: SharingOverrides;
  /** A running connection's state and the repair its connector names, when the owner runs it. */
  readonly statusOf?: (connectionId: string) => ChannelRunningStatus | undefined;
  /** Credential references the store holds (names only): a channel's own OAuth client, and its provider's shared one. */
  readonly credentialRefs?: ReadonlySet<string>;
  /** Each mailbox account's opt-in, by connection id. */
  readonly mailbox?: Readonly<Record<string, "read" | "send">>;
  /** The accounts whose calendar is on, by connection id. */
  readonly calendar?: ReadonlySet<string>;
  /** The rules in force, for each mailbox tool's decision. */
  readonly rules?: readonly ToolRule[];
  /** A running connection's setup notes, from its last probe. */
  readonly setupOf?: (connectionId: string) => MessagingSetup | undefined;
  /** The workspace's words: Tavi's steps for a provider's shared client are said in them (English without). */
  readonly t?: CoreT;
}

/**
 * A connection's setup notes as its account shows them: the link only when
 * its host is one the channel declares, so a plugin's page cannot send the
 * operator elsewhere; its lines either way.
 */
export function accountSetup(
  setup: MessagingSetup | undefined,
  hosts: readonly string[],
): { readonly setup?: { readonly lines: string[]; readonly link?: { readonly label: string; readonly url: string } } } {
  if (setup === undefined) return {};
  const lines = setup.lines.slice(0, 6).map((line) => line.slice(0, 200));
  let link: { readonly label: string; readonly url: string } | undefined;
  try {
    const url = setup.link === undefined ? undefined : new URL(setup.link.url);
    if (
      url !== undefined &&
      setup.link !== undefined &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      hostAllowed(url.host, hosts)
    )
      link = { label: setup.link.label.slice(0, 60), url: url.href.slice(0, 512) };
  } catch {
    link = undefined;
  }
  return lines.length === 0 && link === undefined ? {} : { setup: { lines, ...(link === undefined ? {} : { link }) } };
}

/** A tool an account's opt-in adds, as its catalog names it. */
interface AccountTool {
  readonly name: string;
  readonly title: string;
  readonly effect: AppToolView["effect"];
  readonly sink: AppToolView["sink"];
}

/** The tools each account's opt-ins add, each named by its account when there are several. */
function accountToolViews(
  providerId: string,
  records: readonly MessagingConnectionRecord[],
  input: ChannelSourceInput,
  toolsOf: (record: MessagingConnectionRecord) => readonly AccountTool[],
): AppToolView[] {
  return records.flatMap((record) =>
    toolsOf(record).map((tool): AppToolView => {
      const toolId = `${mailboxToolPrefix(providerId, record.connectionId)}${tool.name}`;
      const policy = toolPolicy(input.rules ?? [], { toolId, effect: tool.effect, mcp: false });
      return {
        toolId,
        title: (records.length > 1 ? `${tool.title} (${record.accountIdentity})` : tool.title).slice(0, 256),
        access: accessOf(tool.effect),
        effect: tool.effect,
        sink: tool.sink,
        state: "offered",
        decision: policy.decision,
        because: [...policy.because],
        canSetHere: [...policy.canSetHere],
      };
    }),
  );
}

/** An opted-in mailbox's tools: only those its mailbox implements, and sending only with its second opt-in. */
function mailboxToolViews(providerId: string, records: readonly MessagingConnectionRecord[], input: ChannelSourceInput): AppToolView[] {
  const can = mailboxCan(mailboxKitOf(providerId));
  const listed = MAILBOX_TOOLS.filter((tool) => !("method" in tool) || can[tool.method]);
  return accountToolViews(providerId, records, input, (record) => {
    const access = input.mailbox?.[record.connectionId];
    return access === undefined ? [] : listed.filter((tool) => tool.needs === "read" || access === "send");
  });
}

/** The tools an account whose calendar is on adds. */
function calendarToolViews(providerId: string, records: readonly MessagingConnectionRecord[], input: ChannelSourceInput): AppToolView[] {
  return accountToolViews(providerId, records, input, (record) =>
    input.calendar?.has(record.connectionId) === true ? CALENDAR_TOOLS : [],
  );
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function authOf(descriptor: ChannelDescriptor, provider: string | undefined, scopes: readonly AppScope[]): AppAuth {
  const declared = (): AppScope[] =>
    scopes.length > 0
      ? [...scopes]
      : descriptor.auth.kind === "oauth2"
        ? descriptor.auth.oauth.scopes.map((scope) => ({ scope, says: scope, access: "send" as const, optional: false }))
        : [];
  // A channel that signs in with a code (RFC 8628): no redirect, no client step on the page.
  if (descriptor.auth.kind === "oauth2" && signsInByCode(descriptor)) return { kind: "device", scopes: declared() };
  if (descriptor.auth.kind === "oauth2") {
    return {
      kind: "oauth",
      client: descriptor.auth.oauth.client.source === "operator" ? (provider === undefined ? "own" : "shared-provider") : "own",
      ...(provider === undefined ? {} : { provider }),
      scopes: declared(),
      stepUp: [],
      redirect: descriptor.auth.oauth.redirect,
    };
  }
  if (descriptor.auth.kind === "secrets") {
    return {
      kind: "api-key",
      fields: descriptor.auth.fields.slice(0, 4).map((field) => ({
        key: field.key,
        label: field.label,
        ...(field.help === undefined ? {} : { help: field.help.slice(0, 300) }),
        type: "credential" as const,
        required: true,
        advanced: false,
      })),
    };
  }
  return { kind: "none" };
}

/** One app per channel provider that has a connection in the workspace. */
export function channelApps(input: ChannelSourceInput): ConnectableApp[] {
  const byProvider = new Map<string, MessagingConnectionRecord[]>();
  for (const record of input.connections) {
    if (record.deletedAt !== undefined) continue;
    byProvider.set(record.providerId, [...(byProvider.get(record.providerId) ?? []), record]);
  }
  const apps: ConnectableApp[] = [];
  for (const [providerId, records] of byProvider) {
    const descriptor = input.descriptorOf(providerId);
    if (descriptor === undefined) continue;
    const presentation = channelPresentationOf(descriptor);
    const appId = presentation?.id ?? providerId;
    const name = presentation?.name ?? descriptor.label;
    const auth = authOf(descriptor, presentation?.provider, presentation?.scopes ?? []);
    const oauth = descriptor.auth.kind === "oauth2";
    const repairs: AppRepair[] = [];
    const provider = presentation?.provider;
    const setup = provider === undefined || !oauth ? undefined : clientSetupOf(provider, input.t);
    const receiveSetting = descriptor.settings.some((field) => field.key === "receive" && field.type === "boolean");
    const accounts = records.map((record) => {
      const health = channelAccountHealth(record, oauth, input.statusOf?.(record.connectionId));
      const repair = channelAccountRepair(
        name,
        health,
        record.connectionId,
        descriptor.auth.kind === "secrets" ? descriptor.auth.fields[0]?.key : undefined,
      );
      if (repair !== undefined) repairs.push(repair);
      return {
        accountId: record.connectionId,
        label: (record.label ?? record.accountIdentity).slice(0, 120),
        ...(record.accountIdentity === "" ? {} : { identity: record.accountIdentity.slice(0, 254) }),
        owner: { kind: "owner" as const },
        health,
        grantedScopes: [],
        missingScopes: [],
        expiresWeekly: false,
        workspaces: [record.workspaceId],
        people: false,
        sharing: sharingOf(input.sharing, record.connectionId, presentation?.dataClass),
        readOnly: !oauth,
        ...(presentation?.mailbox === true ? { mailbox: input.mailbox?.[record.connectionId] ?? ("off" as const) } : {}),
        ...(presentation?.calendar === true ? { calendar: input.calendar?.has(record.connectionId) === true } : {}),
        // A channel whose accounts may stop taking messages in has a boolean `receive` setting, on by default.
        ...(receiveSetting ? { receives: record.settings["receive"] !== false } : {}),
        ...accountSetup(input.setupOf?.(record.connectionId), descriptor.hosts ?? []),
      };
    });
    // What it reaches: its OAuth token host and the hosts its descriptor declares.
    const tokenHost = descriptor.auth.kind === "oauth2" ? hostOf(descriptor.auth.oauth.tokenUrl) : undefined;
    const hosts = [...new Set([...(tokenHost === undefined ? [] : [tokenHost]), ...(descriptor.hosts ?? [])])];
    const pluginId = channelPluginOf(providerId);
    apps.push({
      appId,
      name,
      summary: presentation?.summary ?? descriptor.description.slice(0, 500),
      category: presentation?.category ?? (descriptor.kind === "email" ? "email" : "chat"),
      ...(presentation?.publisher === undefined ? {} : { publisher: presentation.publisher }),
      source: {
        kind: "channel",
        pluginIds: pluginId === undefined ? [] : [pluginId],
        verified: channelGrantsOf(providerId)?.verified ?? "reviewed",
        isolation: "in-process",
      },
      auth,
      channel: { kinds: [descriptor.kind], receives: true, sends: true },
      tools: [
        ...(presentation?.mailbox === true ? mailboxToolViews(providerId, records, input) : []),
        ...(presentation?.calendar === true ? calendarToolViews(providerId, records, input) : []),
      ],
      egress: { hosts, lan: false, anyNetwork: false },
      credentials:
        descriptor.auth.kind === "none"
          ? []
          : [
              ...(descriptor.auth.fields ?? []).map((field) => ({ name: field.key, raw: false })),
              ...(oauth ? [{ name: "sign-in", raw: false }] : []),
            ],
      settings: descriptor.settings.map(appSettingFromChannelField),
      trust: {
        output: "untrusted",
        source: descriptor.kind === "email" ? "email" : "chat-other",
        confidentiality: presentation?.dataClass ?? "personal",
      },
      accounts,
      health: accounts.reduce((worst, account) => worseHealth(worst, account.health), "ready" as ConnectableApp["health"]),
      repairs,
      warnings: [],
      ...(setup === undefined || provider === undefined
        ? {}
        : {
            clientSetup: {
              provider,
              title: setup.title,
              steps: [...setup.steps].slice(0, 8),
              ready: input.credentialRefs?.has(oauthClientCredentialRefs(provider).id) === true,
            },
          }),
    });
  }
  return apps;
}
