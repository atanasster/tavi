import { EXIT, refusalExit } from "../../cli/exit.js";
import { PluginRegistry, ChannelHost, PairingRegistry, createMessagingService, type DatabaseClient } from "@tavi/runtime";
import {
  SUPPORTED_CHANNEL_ABIS,
  ChannelsPayloadSchema,
  PluginManifestSchema,
  type ChannelsPayload,
  TaviErrorCodeSchema,
  TaviError,
  printable,
  triggerInWords,
  channelIdentity,
  type ChannelDescriptor,
  type ChannelsCatalogAnswer,
  type ChannelsIngressAnswer,
  type ChannelsShareClientAnswer,
  type ChannelsListAnswer,
  type ChannelsOAuthDisconnectAnswer,
  type ChannelsOAuthStartAnswer,
  type ChannelsOAuthStatusAnswer,
  type ChannelsDeleteAnswer,
  type ChannelsForgetSenderAnswer,
  type ChannelsGrantsAnswer,
  type ChannelsPairAnswer,
  type ChannelsPairingAnswer,
  type ChannelsPeopleAnswer,
  type ChannelsRemovePreviewAnswer,
  type ChannelsRoomsAnswer,
  type ChannelsSaveAnswer,
  type ChannelsTestAnswer,
} from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import {
  CHANNELS_SHARED_CLIENTS_SETTING,
  channelDescriptorOf,
  parseSharedClients,
  registerBuiltinChannelsOf,
  registerChannelDescriptor,
  setSharedClientBindings,
} from "./catalog.js";
import { channelsCommand, type ChannelsCommandDependencies } from "./owner.js";
import { type ChannelsCommandOptions, CHANNELS_USAGE, type ChannelsAction, FIXED_FLAGS } from "./parse.js";
import { BUILTIN_PLUGINS } from "../plugins/catalog.js";
import { readFile } from "node:fs/promises";
import { nowTimestamp, definedOnly } from "@tavi/contracts/util";
import { prefixedId, sleep } from "@tavi/node-kit";
import { join } from "node:path";
import { OAuthBroker } from "../oauth/broker.js";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import { confirmOnTerminal, type CliIo } from "../../cli/io.js";
import { CONFIG_TIMEOUT_MS } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStorePreservingOwnership } from "../../cli/store.js";
import { offlineSharedGrants } from "../mcp/offline-context.js";
import type { Server } from "node:http";
import { UsageError } from "../../cli/argv.js";
import { jsonText } from "../../cli/output.js";
import { ownerWords, yesNoHint } from "../../shared/terminal-words.js";
import { keptByNote } from "../apps/shared-grants.js";
import { relayOAuthCallbacks } from "../oauth/loopback.js";

/**
 * `tavi channels`: on the live owner when `tavi serve`
 * runs, so a change applies at once; else on the data directory, where no
 * connection is open — a test send, a pairing and the listener wait for one.
 */
export async function channelsCliCommand(options: ResolvedDataDirectory<ChannelsCommandOptions>, io: CliIo): Promise<number> {
  const report = (error: unknown): number => {
    return refusalExit(io, TaviError.from(error));
  };
  const client = await connectOwnerOrReport(options.dataDirectory, ["channels"], io, EXIT);
  if (typeof client === "number") return client;
  if (client !== undefined) {
    try {
      await runChannelsCli(
        options,
        async <T>(payload: ChannelsPayload): Promise<T> => {
          const response = await client.request("channels", { ...payload }, prefixedId("channels"), { timeoutMs: CONFIG_TIMEOUT_MS });
          if (!response.ok)
            throw new TaviError(
              TaviErrorCodeSchema.catch("UNAVAILABLE").parse(response.error?.code),
              response.error?.message ?? "tavi channels failed",
            );
          return response.result as T;
        },
        { ...io, words: async () => await ownerWords(client, options.workspaceId) },
      );
      return EXIT.ok;
    } catch (error) {
      return report(error);
    } finally {
      client.close();
    }
  }
  try {
    await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const repositories = store.asPort().repositories;
      const messaging = createMessagingService(store.asPort(), { now: nowTimestamp });
      await registerInstalledChannels(store, options.dataDirectory);
      const host = new ChannelHost({
        messaging,
        connections: repositories.messagingConnections,
        workspaceIds: [options.workspaceId],
        descriptorOf: channelDescriptorOf,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        now: nowTimestamp,
      });
      await host.load();
      const offline = (what: string) => async (): Promise<never> => {
        throw new TaviError("UNAVAILABLE", `${what} needs a running owner: start \`tavi serve\``);
      };
      const deps: ChannelsCommandDependencies = {
        dataDirectory: options.dataDirectory,
        repositories,
        channels: host,
        messaging,
        // Saved here, opened by the owner at its next start.
        reload: async () => {
          await host.reload();
          return { failed: [], purgeCancelled: [] };
        },
        // No owner runs a listener here: saved, it is applied at the owner's next start.
        applyIngress: async () => {
          throw new TaviError("UNAVAILABLE", "no owner is running; the listener moves when `tavi serve` next starts");
        },
        pairings: new PairingRegistry(),
        oauth: {
          start: offline("signing in"),
          startDevice: offline("signing in"),
          status: () => undefined,
          callback: offline("signing in"),
          finish: offline("signing in"),
          cancel: () => false,
        },
        // Signed out at the provider as the owner would, when the channel names a revocation address; the token is deleted either way.
        revokeToken: (connection, revokeOptions) =>
          new OAuthBroker({
            dataDirectory: options.dataDirectory,
            fetch: globalThis.fetch,
            now: () => Date.now(),
            descriptorOf: channelDescriptorOf,
            setAuthState: async () => undefined,
          }).revoke(connection, revokeOptions),
        // Weighed from the data directory as the owner's Connected apps would.
        sharedGrants: (workspaceId) => offlineSharedGrants(store, options.dataDirectory, workspaceId),
        // A removed connection's page choices are forgotten offline too.
        meta: { get: (key) => store.getMeta(key), set: async (key, value) => await store.setMeta(key, value, nowTimestamp()) },
        now: nowTimestamp,
      };
      await runChannelsCli(
        options,
        async <T>(payload: ChannelsPayload): Promise<T> => {
          if (payload.action === "test") return offline("a test send")();
          // Their chats' memory is the owner's to forget: never half done here.
          if (payload.action === "forget-sender") return offline("forgetting a sender")();
          if (payload.action === "pair" || payload.action === "oauth-start")
            return offline(payload.action === "pair" ? "pairing" : "signing in")();
          // The owner's own check of a request, here too: what it would refuse is not saved behind its back.
          const checked = ChannelsPayloadSchema.safeParse(payload);
          if (!checked.success) throw new TaviError("INVALID_INPUT", zodIssues(checked.error, "request").join("; "));
          return (await channelsCommand(deps, checked.data)).result as T;
        },
        io,
      );
    });
    return EXIT.ok;
  } catch (error) {
    return report(error);
  }
}

/**
 * The channels enabled plugins add, known offline as the owner knows them: from
 * each one's approved manifest (its descriptor is data, reviewed with it), so
 * `tavi channels` lists, adds and changes their connections with no owner
 * running. No plugin code runs; a manifest built for another channel contract
 * adds nothing, as the owner would refuse it.
 */
async function registerInstalledChannels(store: DatabaseClient, dataDirectory: string): Promise<void> {
  // The built-in channels first, as an owner's start installs them: each only while its plugin is enabled.
  await registerBuiltinChannelsOf(store.asPort().repositories);
  setSharedClientBindings(parseSharedClients(await store.getMeta(CHANNELS_SHARED_CLIENTS_SETTING)));
  const registry = new PluginRegistry({ client: store, directory: join(dataDirectory, "plugins"), builtins: BUILTIN_PLUGINS });
  for (const plugin of await registry.list()) {
    if (plugin.kind !== "external" || !plugin.enabled || plugin.activeVersion === undefined) continue;
    const version = plugin.versions.find((candidate) => candidate.version === plugin.activeVersion);
    if (version?.reviewState !== "approved" || (version.channels ?? []).length === 0) continue;
    try {
      const manifest = PluginManifestSchema.parse(
        JSON.parse(await readFile(join(dataDirectory, "plugins", plugin.id, plugin.activeVersion, "tavi-plugin.json"), "utf8")),
      );
      if (!SUPPORTED_CHANNEL_ABIS.includes(manifest.channelAbi ?? 0)) continue;
      for (const descriptor of manifest.channels)
        if (channelDescriptorOf(descriptor.providerId) === undefined)
          registerChannelDescriptor(descriptor, plugin.id, undefined, version.version);
    } catch {
      // An unreadable snapshot adds nothing here; the owner reports it when it starts.
    }
  }
}

/** How long `connect` waits for the browser's sign-in: as long as the owner keeps the flow. */
const CONNECT_WAIT_MS = 10 * 60_000;
const CONNECT_POLL_MS = 1_000;

/** A grants answer, one line per grant: its id, scope, tool and mode, and whether it is in force. */
function grantsText(answer: ChannelsGrantsAnswer): string {
  if (answer.grants.length === 0) return "no grants; add one with `tavi channels grant <connection> room|contact <id> <tool> allow|deny`\n";
  return `${answer.grants.map((grant) => [grant.grantId, `${grant.scopeKind} ${field(grant.scopeId)}`, grant.toolId, grant.mode, grant.inForce ? "" : grant.revokedAt !== undefined ? "revoked" : "expired", grant.expiresAt === undefined ? "" : `until ${grant.expiresAt}`].filter((part) => part !== "").join("\t")).join("\n")}\n`;
}

/** What removing a purging channel's connection erases, and how to keep a copy first. */
function removalWarning(connectionId: string, preview: ChannelsRemovePreviewAnswer): string {
  const lines = [
    `Removing ${connectionId} erases what it brought in 24 hours from now: ${String(preview.conversations)} conversation(s), ${String(preview.messages)} message(s), ${String(preview.files)} file(s), and ${preview.notes === undefined ? "the chat notes its chats taught" : `${String(preview.notes)} chat note(s) its chats taught`}. Its channel's terms require it.`,
    "Adding the same account back before then cancels it; disabling it instead keeps everything.",
  ];
  const lost: string[] = [];
  if (preview.routineTargets.length > 0) lost.push(`routine target(s) ${preview.routineTargets.map(field).join(", ")}`);
  if (preview.heartbeats > 0) lost.push(`${String(preview.heartbeats)} heartbeat target(s)`);
  if (lost.length > 0) lines.push(`Delivery targets on it go too: ${lost.join(" and ")}.`);
  if (preview.tasks.length > 0)
    lines.push(
      "To keep a copy, export each conversation first:",
      ...preview.tasks.map((taskId) => `  tavi tasks history ${taskId} export`),
    );
  if (preview.moreTasks > 0) lines.push(`  …and ${String(preview.moreTasks)} more: \`tavi tasks\` lists them.`);
  return lines.join("\n");
}

/** One field of a line: a platform's ids and names are untrusted, so no escape sequence, tab or line break of theirs reaches the terminal. */
const field = (text: string): string => printable(text).replace(/\s+/g, " ");

/** A rooms answer, one line per room and per room waiting. */
function roomsText(answer: ChannelsRoomsAnswer): string {
  const rooms = answer.rooms.map((room) => {
    const refused = answer.details?.[room.conversationId];
    return [
      field(room.conversationId),
      field(room.label),
      triggerInWords(room.trigger),
      room.members,
      ...(room.autoThread === true ? ["threads"] : []),
      ...(room.context === "recent" ? ["reads recent"] : []),
      ...(room.disabledAt === undefined ? [] : ["paused"]),
      ...(room.introState === "pending"
        ? ["introduction not sent"]
        : room.introState === "uncertain"
          ? ["introduction may not have been sent"]
          : []),
      ...(refused === undefined ? [] : [`last send refused: ${field(refused)}`]),
    ].join("\t");
  });
  const waiting = answer.waiting.map(
    (room) =>
      `waiting\t${field(room.conversationId)}\t${room.how === "added" ? `added by ${field(room.by)}` : `spoke while unlisted`}${room.roomName === undefined ? "" : ` (${field(room.roomName)})`}`,
  );
  const drops = Object.entries(answer.drops).map(([reason, count]) => `${reason} ${String(count)}`);
  return (
    [
      rooms.length === 0 ? "no rooms; add one with `tavi channels rooms <connection> add <id>`" : rooms.join("\n"),
      ...waiting,
      ...(drops.length === 0 ? [] : [`dropped: ${drops.join(", ")}`]),
    ].join("\n") + "\n"
  );
}

type SettingValue = string | number | boolean;

/** A setting as its field takes it: a number or a yes/no where the field is one; `undefined` (cleared) for an empty value. */
function typedSetting(descriptor: ChannelDescriptor, key: string, value: string): SettingValue | undefined {
  const field = descriptor.settings.find((candidate) => candidate.key === key);
  if (field === undefined)
    throw new TaviError("INVALID_INPUT", `${descriptor.label} has no setting ${key}; \`tavi channels types\` lists them`);
  if (value === "") return undefined;
  if (field.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TaviError("INVALID_INPUT", `${descriptor.label}'s ${field.label} must be a number`);
    return number;
  }
  if (field.type === "boolean") {
    if (["yes", "true", "on"].includes(value)) return true;
    if (["no", "false", "off"].includes(value)) return false;
    throw new TaviError("INVALID_INPUT", `${descriptor.label}'s ${field.label} must be yes or no`);
  }
  return value;
}

/** `given` applied over `current`: each typed by its field, an empty one clearing it. */
function settingsWith(
  descriptor: ChannelDescriptor,
  current: Readonly<Record<string, SettingValue>>,
  given: Readonly<Record<string, string>>,
): Record<string, SettingValue> {
  const next: Record<string, SettingValue> = { ...current };
  for (const [key, value] of Object.entries(given)) {
    const typed = typedSetting(descriptor, key, value);
    if (typed === undefined) delete next[key];
    else next[key] = typed;
  }
  return next;
}

/** A connection's stored settings the channel still declares: one its plugin no longer declares is not sent back. */
function declaredSettings(descriptor: ChannelDescriptor, settings: Readonly<Record<string, unknown>>): Record<string, SettingValue> {
  return Object.fromEntries(
    Object.entries(settings).filter(
      (entry): entry is [string, SettingValue] =>
        descriptor.settings.some((field) => field.key === entry[0]) && ["string", "number", "boolean"].includes(typeof entry[1]),
    ),
  );
}

async function secretFrom(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (value === "") throw new TaviError("INVALID_INPUT", `${path} is empty`);
  return value;
}

/** Whether a connection is enabled after `action`: `set` keeps what it was. */
function enabledAfter(action: ChannelsAction, enabled: boolean): boolean {
  if (action === "enable") return true;
  if (action === "disable") return false;
  return enabled;
}

function ingressNote(answer: ChannelsIngressAnswer): string {
  if (answer.notApplied !== undefined) return `saved; the listener could not move: ${answer.notApplied}`;
  return "saved and applied";
}

/** Sends one `channels` request: to the live owner, or answered here on the data directory. */
export type ChannelsAsk = <T>(payload: ChannelsPayload) => Promise<T>;

export interface ChannelsCliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  confirm?(question: string): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  /** The workspace's words, read only when a question is asked (a pairing's); English when absent. */
  words?(): Promise<CoreT>;
}

/** Runs `options` through `ask`, printing as `--format` says; a refusal is thrown for the caller to report. */
export async function runChannelsCli(options: ChannelsCommandOptions, ask: ChannelsAsk, io: ChannelsCliIo): Promise<void> {
  const print = (value: unknown, text: string): void => io.stdout(options.format === "json" ? jsonText(value) : text);
  const workspaceId = options.workspaceId;
  // The channels as the owner that applies the change has them.
  const descriptorOf = async (providerId: string): Promise<ChannelDescriptor> => {
    const found = (await ask<ChannelsCatalogAnswer>({ action: "catalog" })).channels.find(
      (descriptor) => descriptor.providerId === providerId,
    );
    if (found === undefined) throw new TaviError("NOT_FOUND", `No channel ${providerId} is installed (\`tavi channels types\`)`);
    return found;
  };
  const connectionOf = async (connectionId: string) => {
    const listed = await ask<ChannelsListAnswer>({ action: "list", workspaceId });
    const found = listed.connections.find((connection) => connection.connectionId === connectionId);
    if (found === undefined)
      throw new TaviError("NOT_FOUND", `No connection ${connectionId} in workspace ${workspaceId} (\`tavi channels list\`)`);
    const descriptor = await descriptorOf(found.providerId);
    // Its own name, when it has one other than its channel's: saving no name keeps none.
    const label = options.name ?? (found.label === descriptor.label ? undefined : found.label);
    return { connection: found, descriptor, current: declaredSettings(descriptor, found.settings), label };
  };
  /**
   * Resolves a connection by exact `connectionId`, by `providerId` when a single
   * connection of that provider exists in the workspace, or to the workspace's
   * single connection when `target` is omitted.
   */
  const resolveConnection = async (target: string | undefined) => {
    const listed = await ask<ChannelsListAnswer>({ action: "list", workspaceId });
    if (target !== undefined) {
      const exact = listed.connections.find((connection) => connection.connectionId === target);
      if (exact !== undefined) return exact;
      const byProvider = listed.connections.filter((connection) => connection.providerId === target);
      if (byProvider.length === 1) return byProvider[0]!;
      if (byProvider.length > 1)
        throw new TaviError(
          "INVALID_INPUT",
          `Multiple ${target} connections in workspace ${workspaceId}: ${byProvider.map((connection) => connection.connectionId).join(", ")} (\`tavi channels list\`)`,
        );
      throw new TaviError("NOT_FOUND", `No connection ${target} in workspace ${workspaceId} (\`tavi channels list\`)`);
    }
    if (listed.connections.length === 1) return listed.connections[0]!;
    if (listed.connections.length === 0)
      throw new TaviError("NOT_FOUND", `No connections in workspace ${workspaceId}; add one with \`tavi channels add <provider>\``);
    throw new TaviError(
      "INVALID_INPUT",
      `Name a connection (${listed.connections.map((connection) => connection.connectionId).join(", ")})`,
    );
  };
  /**
   * Signing in from a terminal: the owner runs the flow as
   * for Settings → Channels; the provider's redirect comes back to a listener
   * here on 127.0.0.1 (the port the channel's OAuth app takes, or any), which
   * hands it to the owner — or to the public address, for a channel signing in
   * through it.
   */
  const connect = async (connectionId: string): Promise<void> => {
    const { connection, descriptor } = await connectionOf(connectionId);
    if (descriptor.auth.kind !== "oauth2")
      throw new TaviError(
        "INVALID_INPUT",
        `${descriptor.label} does not sign in with OAuth: give its secrets with \`tavi channels secret\``,
      );
    const redirect = descriptor.auth.oauth.redirect;
    let server: Server | undefined;
    let origin: string | undefined;
    if (redirect !== "public") {
      // Any free port: the provider takes any loopback port back (RFC 8252 §7.3).
      const loopback = await relayOAuthCallbacks(
        0,
        (callback) => ask<{ readonly ok: boolean; readonly message: string }>({ action: "oauth-callback", ...callback }),
        "The owner did not answer; connect again.",
      );
      server = loopback.server;
      origin = loopback.origin;
    }
    try {
      const started = await ask<ChannelsOAuthStartAnswer>({
        action: "oauth-start",
        workspaceId,
        connectionId: connection.connectionId,
        ...(origin === undefined ? {} : { origin }),
      });
      io.stderr(`Open this address in a browser to sign in to ${descriptor.label}, then come back here:\n${started.authorizeUrl}\n`);
      const deadline = Date.now() + CONNECT_WAIT_MS;
      for (;;) {
        await sleep(CONNECT_POLL_MS);
        const status = await ask<ChannelsOAuthStatusAnswer>({ action: "oauth-status", workspaceId, flowId: started.flowId });
        if (status.state === "connected") {
          print(status, `connected ${connection.connectionId} as ${status.accountIdentity ?? descriptor.label}\n`);
          return;
        }
        if (status.state !== "pending")
          throw new TaviError(
            "UNAVAILABLE",
            status.detail ??
              (status.state === "expired" ? "The sign-in took too long; connect again." : "The sign-in did not finish; connect again."),
          );
        if (Date.now() > deadline) throw new TaviError("UNAVAILABLE", "The sign-in took too long; connect again.");
      }
    } finally {
      server?.close();
    }
  };
  const saved = (answer: ChannelsSaveAnswer): void => {
    print(answer, `${answer.connectionId}\n`);
    if (answer.notApplied !== undefined) io.stderr(`note: saved, but it could not open: ${answer.notApplied}\n`);
  };
  switch (options.action) {
    case "list": {
      const listed = await ask<ChannelsListAnswer>({ action: "list", workspaceId });
      const lines = listed.connections.map((connection) =>
        [
          connection.connectionId,
          connection.providerId,
          connection.label,
          connection.accountIdentity,
          connection.enabled ? connection.status.state : "disabled",
          connection.status.detail ?? "",
        ]
          .join("\t")
          .trimEnd(),
      );
      print(
        listed,
        `${lines.length === 0 ? "no connections; add one with `tavi channels add <provider>`" : lines.join("\n")}\nwebhooks: port ${listed.ingress.port}${listed.ingress.publicUrl === undefined ? "" : `, ${listed.ingress.publicUrl}`}${listed.trustedProxies === undefined ? "" : `, trusted proxies ${listed.trustedProxies.join(", ")}`}\n`,
      );
      return;
    }
    case "types": {
      const catalog = await ask<ChannelsCatalogAnswer>({ action: "catalog" });
      print(
        catalog,
        catalog.channels
          .map((descriptor) => {
            const secrets = descriptor.auth.kind === "none" ? [] : (descriptor.auth.fields ?? []);
            return [
              `${descriptor.providerId}\t${descriptor.label} (${descriptor.kind})`,
              ...descriptor.settings.map(
                (field) =>
                  `  ${FIXED_FLAGS.has(`--${field.key}`) ? `--set ${field.key}=<value>` : `--${field.key}`}\t${field.label}${field.required === true ? " (required)" : ""}${field.choices === undefined ? "" : `: ${field.choices.join(", ")}`}${field.default === undefined ? "" : ` (default ${String(field.default)})`}`,
              ),
              ...secrets.map((field) => `  --secret-file ${field.key}=<path>\t${field.label}`),
            ].join("\n");
          })
          .join("\n") + "\n",
      );
      return;
    }
    case "add": {
      const providerId = options.target ?? "";
      const descriptor = await descriptorOf(providerId);
      const settings = settingsWith(descriptor, {}, options.settings);
      const secrets = Object.fromEntries(
        await Promise.all(Object.entries(options.secretFiles).map(async ([key, path]) => [key, await secretFrom(path)] as const)),
      );
      saved(
        await ask<ChannelsSaveAnswer>({
          action: "save",
          workspaceId,
          providerId,
          enabled: options.disabled !== true,
          settings,
          ...(Object.keys(secrets).length === 0 ? {} : { secrets }),
          ...(options.name === undefined ? {} : { label: options.name }),
        }),
      );
      return;
    }
    case "set":
    case "enable":
    case "disable": {
      const { connection, descriptor, current, label } = await connectionOf(options.target ?? "");
      saved(
        await ask<ChannelsSaveAnswer>({
          action: "save",
          workspaceId,
          connectionId: connection.connectionId,
          providerId: connection.providerId,
          ...(label === undefined ? {} : { label }),
          enabled: enabledAfter(options.action, connection.enabled),
          settings: settingsWith(descriptor, current, options.settings),
        }),
      );
      return;
    }
    case "secret": {
      const { connection, current, label } = await connectionOf(options.target ?? "");
      saved(
        await ask<ChannelsSaveAnswer>({
          action: "save",
          workspaceId,
          connectionId: connection.connectionId,
          providerId: connection.providerId,
          ...(label === undefined ? {} : { label }),
          enabled: connection.enabled,
          settings: current,
          secrets: { [options.field ?? ""]: await secretFrom(options.file ?? "") },
        }),
      );
      return;
    }
    case "connect": {
      await connect(options.target ?? "");
      return;
    }
    case "disconnect": {
      const { connection, descriptor } = await connectionOf(options.target ?? "");
      const answer = await ask<ChannelsOAuthDisconnectAnswer>({
        action: "oauth-disconnect",
        workspaceId,
        connectionId: connection.connectionId,
      });
      print(answer, `signed ${connection.connectionId} out of ${descriptor.label}${keptByNote(answer.keptBy ?? [])}\n`);
      return;
    }
    case "people": {
      const targetConnectionId = options.target === undefined ? undefined : (await resolveConnection(options.target)).connectionId;
      const answer = await ask<ChannelsPeopleAnswer>({ action: "people", workspaceId });
      const people =
        targetConnectionId === undefined ? answer.people : answer.people.filter((person) => person.connectionId === targetConnectionId);
      const filtered: ChannelsPeopleAnswer = targetConnectionId === undefined ? answer : { ...answer, people };
      const lines = people.map((person) =>
        [
          field(person.connectionId),
          field(person.externalSenderId),
          field(person.principalId),
          person.displayName === undefined ? "" : field(person.displayName),
          person.trustUnverified ? "trust-unverified" : "",
        ]
          .filter((part) => part !== "")
          .join("\t"),
      );
      print(
        filtered,
        lines.length === 0 ? "no allowed people; link one with `tavi channels link [connection]`\n" : `${lines.join("\n")}\n`,
      );
      return;
    }
    case "link":
    case "pair": {
      const connection = await resolveConnection(options.target);
      const principalId =
        options.principalId ?? (await ask<ChannelsPeopleAnswer>({ action: "people", workspaceId })).operator ?? "operator";
      const started = await ask<ChannelsPairAnswer>({
        action: "pair",
        workspaceId,
        connectionId: connection.connectionId,
        principalId,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.trustUnverified === true ? { trustUnverified: true } : {}),
      });
      const code = started.code.length === 8 ? `${started.code.slice(0, 4)}-${started.code.slice(4)}` : started.code;
      // The instructions are said in the workspace's language; English reads its time as this machine writes one.
      const t = (await io.words?.()) ?? coreEnglish;
      const until = new Date(started.expiresAt).toLocaleTimeString(t === coreEnglish ? [] : "bg-BG", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const lines = [
        t("cli.channels.pair.code", { code: field(code), until }),
        t("cli.channels.pair.command", { code: field(code) }),
        ...(started.linkUrl === undefined ? [] : [`${field(started.openLabel ?? t("cli.channels.pair.link"))}: ${field(started.linkUrl)}`]),
        t("cli.channels.pair.send", {
          code: field(code),
          to: started.account === undefined ? connection.connectionId : `@${field(started.account)}`,
        }),
      ];
      io.stderr(`${lines.join("\n")}\n`);
      const wait = io.sleep ?? sleep;
      const confirm = io.confirm ?? confirmOnTerminal;
      const deadline = Date.now() + CONNECT_WAIT_MS;
      for (;;) {
        await wait(CONNECT_POLL_MS);
        const status = await ask<ChannelsPairingAnswer>({ action: "pairing", workspaceId, pairingId: started.pairingId });
        if (status.state === "claimed" && status.sender !== undefined) {
          const who = status.senderName === undefined ? field(status.sender) : `${field(status.senderName)} (${field(status.sender)})`;
          let approved = options.yes === true;
          if (!approved) {
            try {
              approved = await confirm(
                `${t("prompt.channels.allowPairing", { who, as: field(options.name ?? principalId) })} ${yesNoHint(false, t)} `,
              );
            } catch (error) {
              await ask<{ readonly ok: true }>({ action: "cancel-pair", workspaceId, pairingId: started.pairingId }).catch(() => undefined);
              throw error;
            }
          }
          if (!approved) {
            await ask<{ readonly ok: true }>({ action: "cancel-pair", workspaceId, pairingId: started.pairingId });
            throw new TaviError("CANCELLED", `Not linked: ${who} was not allowed on ${connection.connectionId}`);
          }
          await ask<{ readonly ok: true }>({ action: "confirm-pair", workspaceId, pairingId: started.pairingId });
          print(
            {
              ok: true,
              connectionId: connection.connectionId,
              sender: status.sender,
              ...(status.senderName === undefined ? {} : { senderName: status.senderName }),
              principalId,
            },
            `${t("cli.channels.pair.linked", { who, as: field(principalId), connection: connection.connectionId })}\n`,
          );
          return;
        }
        if (status.state === "gone" || status.state === "expired")
          throw new TaviError("UNAVAILABLE", "The link ID expired before anyone sent it; run `tavi channels link` again.");
        if (Date.now() > deadline) {
          await ask<{ readonly ok: true }>({ action: "cancel-pair", workspaceId, pairingId: started.pairingId }).catch(() => undefined);
          throw new TaviError("UNAVAILABLE", "The link ID expired before anyone sent it; run `tavi channels link` again.");
        }
      }
    }
    case "unlink":
    case "revoke": {
      const connection = await resolveConnection(options.target);
      const catalog = await ask<ChannelsCatalogAnswer>({ action: "catalog" }).catch(() => ({ channels: [] }));
      const descriptor = catalog.channels.find((candidate) => candidate.providerId === connection.providerId);
      const rawSender = options.sender ?? options.field ?? "";
      const sender = (descriptor === undefined ? undefined : channelIdentity(rawSender, descriptor.sender)) ?? rawSender.trim();
      const answer = await ask<{ readonly ok: true }>({
        action: "revoke",
        workspaceId,
        connectionId: connection.connectionId,
        sender,
      });
      print(answer, `revoked ${field(sender)} on ${connection.connectionId}\n`);
      return;
    }
    case "remove": {
      const connectionId = options.target ?? "";
      // A channel that erases what it brought in says what first, and goes on only with --yes.
      const preview = await ask<ChannelsRemovePreviewAnswer>({ action: "remove-preview", workspaceId, connectionId });
      if (preview.retention === "purge-on-remove" && options.yes !== true) {
        io.stderr(`${removalWarning(connectionId, preview)}\n`);
        throw new TaviError(
          "INVALID_INPUT",
          `run \`tavi channels remove ${connectionId} --yes\` to remove it and erase what it brought in`,
        );
      }
      const removed = await ask<ChannelsDeleteAnswer>({ action: "delete", workspaceId, connectionId });
      print(
        removed,
        `removed ${connectionId}${removed.purgeAfter === undefined ? "" : `; what it brought in is erased after ${removed.purgeAfter} unless the same account is added back before then`}\n`,
      );
      return;
    }
    case "test": {
      const tested = await ask<ChannelsTestAnswer>({
        action: "test",
        workspaceId,
        connectionId: options.target ?? "",
        to: options.to ?? "",
        ...(options.text === undefined ? {} : { text: options.text }),
      });
      const setup =
        tested.setup === undefined
          ? []
          : [
              ...tested.setup.lines.map(field),
              ...(tested.setup.link === undefined ? [] : [`${field(tested.setup.link.label)}: ${field(tested.setup.link.url)}`]),
            ];
      print(
        tested,
        `${tested.status}${tested.detail === undefined ? "" : `: ${tested.detail}`}\n${setup.map((line) => `${line}\n`).join("")}`,
      );
      if (tested.status !== "accepted") throw new TaviError("UNAVAILABLE", `the test message was ${tested.status}`);
      return;
    }
    case "rooms": {
      const answer = await ask<ChannelsRoomsAnswer>({
        action: "rooms",
        workspaceId,
        connectionId: options.target ?? "",
        op: options.roomOp ?? "list",
        ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.trigger === undefined ? {} : { trigger: [...options.trigger] }),
        ...definedOnly({
          members: options.members,
          autoThread: options.autoThread,
          context: options.context,
        }),
      });
      print(answer, roomsText(answer));
      if (answer.notApplied !== undefined) io.stderr(`note: the room is listed, but ${answer.notApplied}\n`);
      return;
    }
    case "grant": {
      if (options.grant === undefined) throw new UsageError("channels grant names its scope, tool and mode", CHANNELS_USAGE);
      const answer = await ask<ChannelsGrantsAnswer>({
        action: "grants",
        workspaceId,
        connectionId: options.target ?? "",
        op: "add",
        ...options.grant,
      });
      print(answer, grantsText(answer));
      return;
    }
    case "grants": {
      const answer = await ask<ChannelsGrantsAnswer>({
        action: "grants",
        workspaceId,
        connectionId: options.target ?? "",
        op: options.grantsOp ?? "list",
        ...(options.grantId === undefined ? {} : { grantId: options.grantId }),
      });
      print(answer, grantsText(answer));
      return;
    }
    case "forget-sender": {
      const connectionId = options.target ?? "";
      const sender = options.field ?? "";
      if (options.yes !== true) {
        io.stderr(
          `This erases what ${printable(sender)} sent on ${connectionId} — their messages and files, their words where others' messages quote them, their binding, and the notes and memory their own chats taught. Saved turns are not split by speaker, so it names the conversations that still hold their words.\n`,
        );
        throw new TaviError("INVALID_INPUT", `run \`tavi channels forget-sender ${connectionId} ${sender} --yes\` to go ahead`);
      }
      const answer = await ask<ChannelsForgetSenderAnswer>({ action: "forget-sender", workspaceId, connectionId, sender });
      const now = nowTimestamp();
      const lines = [
        `forgot ${printable(answer.sender)} on ${connectionId}: ${String(answer.messages)} message(s), ${String(answer.files)} file(s)${answer.quoted === 0 ? "" : `, their words in ${String(answer.quoted)} message(s) of others quoting them`}${answer.bindingRemoved ? ", their binding" : ""}, ${String(answer.notes)} note(s) and memories`,
        ...(answer.stillInTurns.length === 0
          ? []
          : [
              "their words are still in these conversations' saved turns; forget each to erase them:",
              ...answer.stillInTurns.flatMap((conversation) =>
                conversation.taskIds.map(
                  (taskId) =>
                    `  tavi tasks history ${taskId} forget --before ${now} --with-memory  (${printable(conversation.conversationId)})`,
                ),
              ),
            ]),
      ];
      print(answer, `${lines.join("\n")}\n`);
      return;
    }
    case "share-client": {
      const provider = options.target ?? "";
      const pluginId = options.field === "off" ? null : (options.field ?? "");
      const answer = await ask<ChannelsShareClientAnswer>({ action: "share-client", provider, pluginId });
      const signedOut = answer.sharedClient.signedOut ?? 0;
      print(
        answer,
        `${pluginId === null ? `no channel plugin shares the ${provider} client` : `${pluginId} signs in with the ${provider} client`}${signedOut === 0 ? "" : `; ${String(signedOut)} connection(s) signed out, to be connected again`}\n`,
      );
      return;
    }
    case "ingress": {
      const answer = await ask<ChannelsIngressAnswer>({
        action: "ingress",
        port: options.port ?? 0,
        ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
        ...(options.trustedProxies === undefined ? {} : { trustedProxies: [...options.trustedProxies] }),
      });
      print(answer, `${ingressNote(answer)}\n`);
      return;
    }
  }
}
