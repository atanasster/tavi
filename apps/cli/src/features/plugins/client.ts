import { jsonText } from "../../cli/output.js";
import { EXIT, reportCommandFailure } from "../../cli/exit.js";
import {
  PluginsPayloadSchema,
  describeRouterDeclaration,
  describePluginTool,
  pluginToolDeclarationNote,
  pluginToolOutputNote,
  describeMemoryDeclaration,
  describeIdeasDeclaration,
  describeOnboardingDeclaration,
  describePluginHeartbeat,
  describePluginApps,
  describePluginUiContribution,
  pluginRunningVersion,
  MAX_PLUGIN_HOOK_DECISIONS,
  MAX_PLUGIN_HOOK_FAILURES,
  type PluginModHookView,
  type PluginUiAnswer,
  type PluginsPayload,
  type PluginView,
  mcpBlockLines,
  TaviErrorCodeSchema,
  PluginUiAnswerSchema,
  WorkspaceSettingsAnswerSchema,
  TaviError,
  DEFAULT_WORKSPACE_ID,
} from "@tavi/contracts";
import { zodIssues } from "@tavi/contracts/zod-util";
import { PluginRegistry } from "@tavi/runtime";
import { pluginChannelPurgePreview, rememberedAccount, schedulePluginChannelPurges } from "../channels/purge.js";
import { BUILTIN_PLUGINS, builtinPluginsWithUi } from "./catalog.js";
import { renderPluginValidation, validatePlugin } from "./validate.js";
import { pluginUiEntries, runPluginAction, type PluginAnswer } from "./actions.js";
import { runPluginsUi, type PluginsUiAccess } from "./ui-client.js";
import { builtCanvasDirectory } from "../../canvas-directory.js";
import type { PluginsCommandOptions, PluginsUiOptions } from "./parse.js";
import { fittedText, pageWidth, terminalText } from "../../shared/terminal-text.js";
import { mcpRemovalDeps, removeMcpServer } from "../mcp/remove.js";
import { errorMessage, nowTimestamp, plural } from "@tavi/contracts/util";
import { minuteUtc } from "../../shared/minute-utc.js";
import { prefixedId } from "@tavi/node-kit";
import { join, resolve } from "node:path";
import { operatorActor } from "../../server/config-commands.js";
import { applyWorkspaceSetting, workspaceSettingsAnswerFor } from "../../server/workspace-settings-commands.js";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import type { CliIo } from "../../cli/io.js";
import { runFamily } from "../../cli/owner.js";
import { type ResolvedDataDirectory, withStorePreservingOwnership } from "../../cli/store.js";
import { offlineKeptBy } from "../mcp/offline-context.js";

/**
 * `tavi plugins ui list|set-role|place`: on a
 * live owner over IPC (`plugins ui`, `workspace-settings`), or on the data
 * directory — the same rules either way (`runPluginsUi`).
 */
export async function pluginsUiCommand(options: ResolvedDataDirectory<PluginsUiOptions>, io: CliIo): Promise<number> {
  const print = (result: { readonly text: string; readonly json: unknown }): number => {
    io.stdout(options.format === "json" ? jsonText(result.json) : result.text);
    return EXIT.ok;
  };
  const failed = (error: unknown): number => {
    const failure = TaviError.from(error);
    if (failure.code === "INVALID_INPUT" || failure.code === "NOT_FOUND" || failure.code === "CONFLICT") {
      io.stderr(`${terminalText(failure.message)}\n`);
      return EXIT.usage;
    }
    if (failure.code === "UNAVAILABLE") {
      io.stderr(`${terminalText(failure.message)}\n`);
      return EXIT.unavailable;
    }
    return reportCommandFailure(error, io, `tavi plugins ui ${options.action}`);
  };
  const client = await connectOwnerOrReport(options.dataDirectory, ["plugins", "workspace-settings"], io, EXIT);
  if (typeof client === "number") return client;
  if (client !== undefined) {
    try {
      const ask = async (command: string, payload: Record<string, unknown>): Promise<unknown> => {
        const answer = await client.request(command, payload, prefixedId("plugins-ui"));
        if (!answer.ok) {
          const code = TaviErrorCodeSchema.safeParse(answer.error?.code);
          throw new TaviError(code.success ? code.data : "UNAVAILABLE", answer.error?.message ?? `the owner refused ${command}`);
        }
        return answer.result;
      };
      const access: PluginsUiAccess = {
        entries: async () => PluginUiAnswerSchema.parse(await ask("plugins", { action: "ui" })).entries,
        settings: async () =>
          WorkspaceSettingsAnswerSchema.parse(await ask("workspace-settings", { action: "get", workspaceId: options.workspaceId })),
        write: async (key, value, expectedRevision) =>
          WorkspaceSettingsAnswerSchema.parse(
            await ask(
              "workspace-settings",
              value === undefined
                ? { action: "unset", workspaceId: options.workspaceId, key, expectedRevision }
                : { action: "set", workspaceId: options.workspaceId, key, value: JSON.stringify(value), expectedRevision },
            ),
          ),
      };
      return print(await runPluginsUi(options, access));
    } catch (error) {
      return failed(error);
    } finally {
      client.close();
    }
  }
  try {
    return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const registry = new PluginRegistry({
        client: store,
        directory: join(options.dataDirectory, "plugins"),
        builtins: builtinPluginsWithUi(builtCanvasDirectory()),
      });
      const settings = store.asPort().repositories.workspaceSettings;
      const access: PluginsUiAccess = {
        entries: async () => pluginUiEntries(await registry.list()),
        settings: () => workspaceSettingsAnswerFor(settings, options.workspaceId),
        write: async (key, value, expectedRevision) => {
          await applyWorkspaceSetting(settings, {
            workspaceId: options.workspaceId,
            key,
            value: value === undefined ? undefined : JSON.stringify(value),
            expectedRevision,
            actor: operatorActor(false),
            now: nowTimestamp(),
          });
          return workspaceSettingsAnswerFor(settings, options.workspaceId);
        },
      };
      return print(await runPluginsUi(options, access));
    });
  } catch (error) {
    return failed(error);
  }
}

/** One declared hook: its event and match, how it fails, the author's words and Tavi's own line. */
function describeModHook(hook: PluginModHookView): string {
  const match = [
    hook.match?.tools === undefined ? undefined : `tools ${hook.match.tools.join(",")}`,
    hook.match?.sources === undefined ? undefined : `from ${hook.match.sources.join(",")}`,
    hook.match?.channels === undefined ? undefined : `on ${hook.match.channels.join(",")}`,
  ]
    .filter((part) => part !== undefined)
    .join("; ");
  // A prompt.submit hook whose context the manifest declares trusted says so at approval.
  return `${hook.event}${match === "" ? "" : ` [${match}]`}${hook.contextTrusted === true ? " [trusted context]" : ""} (fails: ${hook.onFailure}): ${hook.disclosure} — ${hook.reads}`;
}

/** Where an external plugin's code runs: `worker`, or `UNSANDBOXED` beside the owner (approved so, or before workers). */
function isolationTag(plugin: PluginView): readonly string[] {
  if (plugin.kind !== "external" || !plugin.runsOwnerCode || (plugin.activeVersion === undefined && plugin.isolation === undefined))
    return [];
  return [plugin.isolation === "process" ? "worker" : "UNSANDBOXED"];
}

/** Where one version's code runs and what it reaches, for `plugins show`: what `--format json` gives as its fields. */
function pluginVersionIsolationLines(version: PluginView["versions"][number]): readonly string[] {
  if (!version.runsOwnerCode || version.mcp !== undefined) return [];
  const where =
    version.isolation === "process"
      ? "runs as a confined worker"
      : version.isolation === "in-process"
        ? "runs UNSANDBOXED in the owner's process (approved so)"
        : version.reviewState === "approved"
          ? "runs UNSANDBOXED in the owner's process (approved before workers; approve it again to choose)"
          : undefined;
  return [
    ...(where === undefined ? [] : [where]),
    ...(version.workerRefusal === undefined ? [] : [`cannot be a worker: ${version.workerRefusal}`]),
    ...(version.networkDomains === undefined ? [] : [`network domains: ${version.networkDomains.join(", ") || "none"}`]),
    ...(version.rawSecrets === undefined ? [] : [`raw secrets (a worker holds their real values): ${version.rawSecrets.join(", ")}`]),
  ];
}

/** Text for one plugin row: id, kind, state, version, and the owner's phase when attached. */
function pluginLine(plugin: PluginView): string {
  const state = plugin.enabled ? "enabled" : "disabled";
  const version = plugin.kind === "builtin" ? "built-in" : (plugin.activeVersion ?? plugin.versions.at(-1)?.version ?? "-");
  const pending = plugin.versions.filter((version) => version.reviewState === "proposed").map((version) => version.version);
  // Each field is cleaned on its own: terminalText strips control characters, tabs included.
  const fields = [
    plugin.id,
    `${plugin.kind}${plugin.core ? " (core)" : ""}${plugin.dev === true ? " (dev)" : ""}`,
    state,
    version,
    ...(plugin.phase === undefined ? [] : [plugin.phase]),
    ...(pending.length === 0 ? [] : [`awaiting review: ${pending.join(", ")}`]),
    ...(plugin.error === undefined ? [] : [`error: ${plugin.error}`]),
    ...isolationTag(plugin),
  ];
  return `${fields.map(terminalText).join("\t")}\n`;
}

/** The owner's phase for `show`, in words: one not composed says whether a restart would load it. */
function phaseText(plugin: PluginView): string {
  if (plugin.phase === undefined) return "";
  if (plugin.phase !== "not_composed") return `, ${plugin.phase} in the running owner`;
  return plugin.enabled ? ", not loaded yet (restart `tavi serve` to load it)" : ", not loaded in the running owner";
}

/** `tavi plugins show`'s text for one plugin, its long lines cut at spaces to the terminal's `columns` (80 in a pipe). */
export function pluginDetail(plugin: PluginView, columns: number | undefined = undefined): string {
  const lines = [
    `${plugin.name} (${plugin.id})`,
    `kind: ${plugin.kind}${plugin.core ? ", core" : ""}${plugin.dev === true ? ", dev: loaded unapproved by tavi serve --dev-plugin, reloaded on save" : ""}`,
    `state: ${plugin.enabled ? "enabled" : "disabled"}${phaseText(plugin)}`,
  ];
  if (plugin.description !== "") lines.push(`description: ${plugin.description}`);
  if (plugin.error !== undefined) lines.push(`error: ${plugin.error}`);
  if (plugin.kind !== "builtin") {
    lines.push(`active version: ${plugin.activeVersion ?? "none"}`);
    if (plugin.directory !== undefined)
      lines.push(plugin.dev === true ? `files: ${plugin.directory}` : `files: ${plugin.directory}/<version>`);
    lines.push("versions:");
    for (const version of plugin.versions) {
      // A dev plugin's folder is loaded as it is: nothing was installed, approved or reviewed.
      if (plugin.dev === true) {
        lines.push(
          `  ${version.version}\tdev\tloaded from ${plugin.directory ?? "its folder"}\truns UNSANDBOXED in the owner's process (--dev-plugin)`,
        );
      } else {
        lines.push(
          `  ${version.version}\t${version.reviewState}\tsha256 ${version.contentHash.slice(0, 16)}…\tinstalled ${minuteUtc(version.installedAt)}`,
        );
        for (const line of pluginVersionIsolationLines(version)) lines.push(`    ${line}`);
      }
      for (const capability of version.capabilities ?? [])
        lines.push(`    provider ${capability.id} (${capability.kind}): ${capability.disclosure}`);
      // A channel's review: what it may do, and every address it reaches.
      for (const channel of version.channels ?? []) {
        lines.push(`    channel ${channel.providerId} (${channel.label}, ${channel.kind}): ${channel.disclosure}`);
        for (const endpoint of channel.endpoints) lines.push(`      ${endpoint}`);
      }
      for (const pkg of version.provenance?.packages ?? [])
        lines.push(`    package ${pkg.name}@${pkg.version}, ${pkg.license}, ${pkg.integrity}`);
      // An MCP server's launch spec: the exact command or address first.
      if (version.mcp !== undefined) for (const line of mcpBlockLines(version.mcp)) lines.push(`    mcp ${line}`);
      // Each version's own declarations: a review decides on these, not the running version's.
      if (version !== pluginRunningVersion(plugin)) {
        lines.push(
          `    declares tools: ${version.tools.map(describePluginTool).join(", ") || "none"}; settings: ${Object.keys(version.configFields).join(", ") || "none"}`,
        );
        for (const hook of version.mods ?? []) lines.push(`    hook ${describeModHook(hook)}`);
        for (const command of version.commands ?? []) lines.push(`    command /${command.name}: ${command.description}`);
        if (version.router !== undefined) lines.push(`    ${describeRouterDeclaration(version.router)}`);
        for (const line of describePluginHeartbeat(version)) lines.push(`    ${line}`);
        if (version.memory !== undefined) lines.push(`    ${describeMemoryDeclaration(version.memory)}`);
        if (version.ideas !== undefined) lines.push(`    ${describeIdeasDeclaration(version.ideas)}`);
        if (version.onboarding !== undefined) lines.push(`    ${describeOnboardingDeclaration(version.onboarding)}`);
        for (const contribution of version.ui?.contributions ?? []) lines.push(`    ui ${describePluginUiContribution(contribution)}`);
        for (const line of version.apps === undefined ? [] : describePluginApps(version.apps)) lines.push(`    ${line}`);
      }
    }
    const running = pluginRunningVersion(plugin);
    if (running?.router !== undefined) lines.push(describeRouterDeclaration(running.router));
    if (running !== undefined) lines.push(...describePluginHeartbeat(running));
    if (running?.memory !== undefined) lines.push(describeMemoryDeclaration(running.memory));
    if (running?.ideas !== undefined) lines.push(describeIdeasDeclaration(running.ideas));
    if (running?.onboarding !== undefined) lines.push(describeOnboardingDeclaration(running.onboarding));
    if (plugin.uiOnly === true) lines.push("runs no owner code: it only adds to the web canvas");
    if (plugin.kind === "mcp") lines.push("runs no owner code: an MCP server, run out of process; its tools are reviewed with `tavi mcp`");
    lines.push(plugin.tools.length === 0 ? "tools: none" : "tools:");
    for (const tool of plugin.tools)
      lines.push(`  ${tool.id}\t${tool.effect}${pluginToolOutputNote(tool.output)}${pluginToolDeclarationNote(tool)}\t${tool.description}`);
    for (const instance of plugin.instances ?? [])
      lines.push(`instance ${instance.id}: ${instance.factory}, workspace ${instance.workspaceId}, account ${instance.accountId}`);
    lines.push(Object.keys(plugin.configFields).length === 0 ? "settings: none" : "settings:");
    for (const [key, field] of Object.entries(plugin.configFields)) {
      const value = plugin.config[key];
      lines.push(
        `  ${key}\t${field.type}${field.required === true ? ", required" : ""}\t${value === undefined ? "(unset)" : JSON.stringify(value)}${field.description === undefined ? "" : `\t${field.description}`}`,
      );
    }
  }
  // A built-in's as an external's (tavi.guard): its commands, its hooks into the turn — what the author says each
  // does, and what Tavi says it can read — what they decided, and how long they take.
  if (plugin.commands !== undefined) {
    lines.push("commands:");
    for (const command of plugin.commands) lines.push(`  /${command.name}\t${command.description}`);
  }
  if (plugin.mods !== undefined) {
    lines.push("hooks:");
    for (const hook of plugin.mods) lines.push(`  ${describeModHook(hook)}`);
    for (const latency of plugin.hookLatency ?? [])
      lines.push(
        `  ${latency.event}: median ${latency.medianMs} ms, worst ${latency.worstMs} ms over its last ${latency.samples === 1 ? "call" : `${String(latency.samples)} calls`}`,
      );
  }
  // A plugin with commands only has activity too: its commands' failures.
  const activity = plugin.hookActivity;
  if (activity !== undefined) {
    lines.push(
      `hook activity: ${plural(activity.decisions, "decision")}, ${plural(activity.failures, "failure")}${activity.pruned === true ? ` (older rows were pruned: only the newest ${MAX_PLUGIN_HOOK_DECISIONS} decisions and ${MAX_PLUGIN_HOOK_FAILURES} failures are kept)` : ""}`,
    );
    for (const event of activity.recent)
      lines.push(
        `  ${minuteUtc(event.at)}\t${event.kind}\t${event.event}${event.tool === undefined ? "" : ` ${event.tool}`}\t${event.detail}`,
      );
  }
  // The web canvas contributions in effect, their channels and what they are told to disclose.
  if (plugin.ui !== undefined) {
    lines.push("ui:");
    for (const contribution of plugin.ui.contributions) lines.push(`  ${describePluginUiContribution(contribution)}`);
  }
  // The prose lines (the description, every network domain) go on indented, not where the terminal breaks a word;
  // the rest (a path, a hook, a tool, a disclosure) stays one line, whole, for a reader to copy and a script to read.
  const width = pageWidth(columns);
  const wrapped = (line: string) => (/^\s*(description|network domains): /.test(line) ? fittedText(line, width, "  ") : line);
  return `${lines.map((line) => wrapped(line.split("\t").map(terminalText).join("\t"))).join("\n")}\n`;
}

/**
 * `tavi plugins`: on a live owner over IPC, otherwise on the data
 * directory. Both run `runPluginAction`, so the answers match.
 */
export async function pluginsCommand(options: ResolvedDataDirectory<PluginsCommandOptions>, io: CliIo): Promise<number> {
  const print = (value: unknown, text: string): void => io.stdout(options.format === "json" ? jsonText(value) : text);
  // Needs no owner and no data directory: it only reads the folder.
  if (options.action === "validate") {
    const directory = resolve(options.path ?? ".");
    const report = await validatePlugin(directory, { builtins: new Set(BUILTIN_PLUGINS.map((plugin) => plugin.id)) });
    // What the folder's code printed or threw is shown, so it is made safe for the terminal.
    print(report, terminalText(renderPluginValidation(directory, report)));
    return report.problems.length === 0 ? EXIT.ok : EXIT.taskFailed;
  }
  // The owner reads the path on its own machine, so send an absolute one.
  let instances: unknown;
  try {
    instances = options.instances === undefined ? undefined : JSON.parse(options.instances);
  } catch {
    io.stderr("Invalid plugin configuration; --instances must be a JSON array of provider instances.\n");
    return EXIT.usage;
  }
  const parsed = PluginsPayloadSchema.safeParse({
    action: options.action,
    ...(options.pluginId === undefined ? {} : { pluginId: options.pluginId }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.path === undefined ? {} : { path: resolve(options.path) }),
    ...(options.action === "config" ? { set: options.set, unset: options.unset, ...(instances === undefined ? {} : { instances }) } : {}),
    ...(options.action === "remove" && options.yes === true ? { yes: true } : {}),
    ...(options.action === "approve" && options.inProcess === true ? { inProcess: true } : {}),
  });
  if (!parsed.success) {
    io.stderr(`${terminalText(`Invalid plugin request: ${zodIssues(parsed.error).join("; ")}`)}\n`);
    return EXIT.usage;
  }
  const payload: PluginsPayload = parsed.data;
  // The CLI never sends `ui` (the bridge's own action), so its answer is never one.
  const render = (answer: Exclude<PluginAnswer, PluginUiAnswer>): number => {
    if ("plugins" in answer) {
      print(answer, answer.plugins.map(pluginLine).join(""));
      return EXIT.ok;
    }
    if ("plugin" in answer) {
      print(answer.plugin, pluginDetail(answer.plugin, io.columns));
      return EXIT.ok;
    }
    if ("audit" in answer) {
      const lines =
        answer.audit.length === 0
          ? ["No enabled plugin runs in the owner's process.\n"]
          : answer.audit.map((entry) =>
              [
                `${entry.pluginId}@${entry.version}\tUNSANDBOXED (in the owner's process)\n`,
                ...(entry.workerRefusal === undefined ? [] : [`  cannot be a worker: ${entry.workerRefusal}\n`]),
                ...(entry.findings.length === 0
                  ? ["  as a worker it would lose nothing its files show\n"]
                  : entry.findings.map((finding) => `  ${finding}\n`)),
              ].join(""),
            );
      print(answer, terminalText(lines.join("")));
      return EXIT.ok;
    }
    const written = answer.result as Record<string, unknown>;
    const summary =
      options.action === "install"
        ? `installed ${String(written["pluginId"])}@${String(written["version"])} (${String(written["reviewState"] ?? "proposed")}${written["created"] === false ? ", already installed" : ""}); approve it with \`tavi plugins approve ${String(written["pluginId"])} ${String(written["version"])}${written["inProcessOnly"] === true ? " --in-process` (it cannot run as a confined worker, so it runs unsandboxed in the owner's process)" : "`"}\n`
        : options.action === "remove"
          ? `removed ${options.pluginId} ${(written["removed"] as string[]).join(", ")}\n${mcpCleanupText(written["cleaned"])}`
          : options.action === "approve" || options.action === "reject"
            ? `${options.pluginId}@${options.version} ${String(written["reviewState"])}${written["isolation"] === "process" ? ", runs as a confined worker" : written["isolation"] === "in-process" ? ", runs UNSANDBOXED in the owner's process" : ""}\n`
            : `${options.pluginId} ${written["enabled"] === true ? "enabled" : "disabled"}${typeof written["activeVersion"] === "string" ? ` at ${written["activeVersion"]}` : ""}\n`;
    print(answer, terminalText(summary));
    if (answer.routingStopped === true)
      io.stderr(`note: routing through ${options.pluginId} stopped now; restart \`tavi serve\` to unload its code\n`);
    else if (answer.restartRequired)
      io.stderr("note: plugins compose when the owner starts; restart `tavi serve` to load the current configuration\n");
    if (answer.cleanupWarning !== undefined) io.stderr(`warning: ${terminalText(answer.cleanupWarning)}\n`);
    return EXIT.ok;
  };
  return runFamily(options.dataDirectory, "plugins", io, {
    label: `tavi plugins ${options.action}`,
    mutates: options.action !== "list" && options.action !== "show",
    build: () => payload,
    render: (result) => render(result as Exclude<PluginAnswer, PluginUiAnswer>),
    offline: async (store) => {
      const registry = new PluginRegistry({ client: store, directory: join(options.dataDirectory, "plugins"), builtins: BUILTIN_PLUGINS });
      return render(
        (await runPluginAction(registry, payload, "operator:cli", undefined, {
          workspaceSettings: store.asPort().repositories.workspaceSettings,
          // No owner names the workspaces: every one with stored settings, and the default.
          // Its grant revoked at the provider only when no other app keeps it, weighed before it goes.
          mcpRemove: async (pluginId, version) =>
            removeMcpServer(
              mcpRemovalDeps(
                registry,
                store.asPort().repositories,
                options.dataDirectory,
                [
                  ...new Set([
                    DEFAULT_WORKSPACE_ID,
                    ...(await store.asPort().repositories.workspaceSettings.list()).map((record) => record.workspaceId),
                  ]),
                ],
                nowTimestamp,
                (key, value) => store.setMeta(key, value, nowTimestamp()),
                undefined,
                (id) => offlineKeptBy(store, options.dataDirectory, id),
              ),
              pluginId,
              version,
              "operator:cli",
            ),
          // No connection is open offline: a purge names each account as the owner remembered it while it ran.
          channelPluginRemove: async (_pluginId, providerIds) =>
            await schedulePluginChannelPurges(
              { repositories: store.asPort().repositories, now: nowTimestamp },
              providerIds,
              async (connectionId) =>
                (await rememberedAccount({ get: (key) => store.getMeta(key), set: async () => undefined }, connectionId))?.accountRef,
            ),
          channelPluginPreview: async (providerIds) =>
            await pluginChannelPurgePreview({ repositories: store.asPort().repositories }, providerIds),
        })) as Exclude<PluginAnswer, PluginUiAnswer>,
      );
    },
    failed: (error) => {
      // As under an owner: a plugin or version that does not exist is exit 4.
      if (TaviError.from(error).code === "NOT_FOUND") {
        io.stderr(`tavi plugins ${options.action}: ${errorMessage(error)}\n`);
        return EXIT.unavailable;
      }
      return reportCommandFailure(error, io, `tavi plugins ${options.action}`);
    },
  });
}

/** What an MCP server's removal cleaned up, as text; empty for any other plugin. */
function mcpCleanupText(cleaned: unknown): string {
  if (cleaned === null || typeof cleaned !== "object") return "";
  const { credentials, grantsDeleted, noticesDeleted, workspaces, rules } = cleaned as {
    credentials: readonly string[];
    grantsDeleted: number;
    noticesDeleted: number;
    workspaces: readonly string[];
    rules: readonly string[];
  };
  const lines = [
    `  deleted its home, ${String(credentials.length)} credentials, ${String(noticesDeleted)} notices and ${String(grantsDeleted)} session approvals${workspaces.length === 0 ? "" : `; removed from ${workspaces.join(", ")}`}`,
  ];
  if (rules.length > 0)
    lines.push(`  allow rules still naming its tools: ${rules.join(", ")} (tavi permissions list, then tavi permissions rm)`);
  return `${lines.join("\n")}\n`;
}
