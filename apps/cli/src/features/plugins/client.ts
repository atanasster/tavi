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
import { coreEnglish, isCoreKey, type CoreKey, type CoreT } from "@tavi/contracts/locales/core";
import { ownerWords, storeWords } from "../../shared/terminal-words.js";
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
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";
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
function describeModHook(hook: PluginModHookView, t: CoreT = coreEnglish): string {
  const match = [
    hook.match?.tools === undefined ? undefined : t("cli.plugins.hook.tools", { tools: hook.match.tools.join(",") }),
    hook.match?.sources === undefined ? undefined : t("cli.plugins.hook.from", { sources: hook.match.sources.join(",") }),
    hook.match?.channels === undefined ? undefined : t("cli.plugins.hook.on", { channels: hook.match.channels.join(",") }),
  ]
    .filter((part) => part !== undefined)
    .join("; ");
  // A prompt.submit hook whose context the manifest declares trusted says so at approval.
  return t("cli.plugins.hook.line", {
    event: hook.event,
    match: match === "" ? "" : ` [${match}]`,
    trusted: hook.contextTrusted === true ? t("cli.plugins.hook.trusted") : "",
    onFailure: hook.onFailure,
    disclosure: hook.disclosure,
    reads: hook.reads,
  });
}

/** Where an external plugin's code runs: `worker`, or `UNSANDBOXED` beside the owner (approved so, or before workers). */
function isolationTag(plugin: PluginView, t: CoreT): readonly string[] {
  if (plugin.kind !== "external" || !plugin.runsOwnerCode || (plugin.activeVersion === undefined && plugin.isolation === undefined))
    return [];
  return [t(plugin.isolation === "process" ? "cli.plugins.tag.worker" : "cli.plugins.tag.unsandboxed")];
}

/** Where one version's code runs and what it reaches, for `plugins show`: what `--format json` gives as its fields. */
function pluginVersionIsolationLines(version: PluginView["versions"][number], t: CoreT): readonly string[] {
  if (!version.runsOwnerCode || version.mcp !== undefined) return [];
  const where =
    version.isolation === "process"
      ? t("cli.plugins.version.worker")
      : version.isolation === "in-process"
        ? t("cli.plugins.version.inProcess")
        : version.reviewState === "approved"
          ? t("cli.plugins.version.legacy")
          : undefined;
  return [
    ...(where === undefined ? [] : [where]),
    ...(version.workerRefusal === undefined ? [] : [t("cli.plugins.version.workerRefusal", { reason: version.workerRefusal })]),
    ...(version.networkDomains === undefined
      ? []
      : [t("cli.plugins.version.networkDomains", { domains: version.networkDomains.join(", ") || t("cli.plugins.none") })]),
    ...(version.rawSecrets === undefined ? [] : [t("cli.plugins.version.rawSecrets", { names: version.rawSecrets.join(", ") })]),
  ];
}

/** A plugin's phase in `t`'s words; one this release does not know reads as it arrives. */
const PHASE_KEYS: Readonly<Record<NonNullable<PluginView["phase"]>, CoreKey>> = {
  registered: "cli.plugins.phase.registered",
  starting: "cli.plugins.phase.starting",
  ready: "cli.plugins.phase.ready",
  stopping: "cli.plugins.phase.stopping",
  stopped: "cli.plugins.phase.stopped",
  failed: "cli.plugins.phase.failed",
  not_composed: "cli.plugins.phase.notComposed",
  verified: "cli.plugins.phase.verified",
  degraded: "cli.plugins.phase.degraded",
};
const phaseWord = (phase: string, t: CoreT): string =>
  Object.hasOwn(PHASE_KEYS, phase) ? t(PHASE_KEYS[phase as keyof typeof PHASE_KEYS]) : phase;

/** The words of a code a key names (`cli.plugins.kind.builtin`), or the code itself when none does. */
const codeWord = (prefix: string, code: string, t: CoreT): string => {
  const key = `${prefix}.${code}`;
  return isCoreKey(key) ? t(key) : code;
};

/** A tool's effect as its badge says it; English the raw id, as before. */
const EFFECT_KEYS: Readonly<Record<string, CoreKey>> = {
  "read-only": "plugin.tool.effect.readOnly",
  mutating: "plugin.tool.effect.mutating",
  external: "plugin.tool.effect.external",
};
const effectWord = (effect: string, t: CoreT): string =>
  t === coreEnglish || !Object.hasOwn(EFFECT_KEYS, effect) ? effect : t(EFFECT_KEYS[effect] as CoreKey);

/** Text for one plugin row: id, kind, state, version, and the owner's phase when attached. */
function pluginLine(plugin: PluginView, t: CoreT = coreEnglish): string {
  const state = t(plugin.enabled ? "cli.plugins.state.enabled" : "cli.plugins.state.disabled");
  const version = plugin.kind === "builtin" ? t("cli.plugins.builtIn") : (plugin.activeVersion ?? plugin.versions.at(-1)?.version ?? "-");
  const pending = plugin.versions.filter((version) => version.reviewState === "proposed").map((version) => version.version);
  // Each field is cleaned on its own: terminalText strips control characters, tabs included.
  const fields = [
    plugin.id,
    `${codeWord("cli.plugins.kind", plugin.kind, t)}${plugin.core ? t("cli.plugins.list.core") : ""}${plugin.dev === true ? t("cli.plugins.list.dev") : ""}`,
    state,
    version,
    ...(plugin.phase === undefined ? [] : [phaseWord(plugin.phase, t)]),
    ...(pending.length === 0 ? [] : [t("cli.plugins.list.awaiting", { versions: pending.join(", ") })]),
    ...(plugin.error === undefined ? [] : [t("cli.plugins.error", { error: plugin.error })]),
    ...isolationTag(plugin, t),
  ];
  return `${fields.map(terminalText).join("\t")}\n`;
}

/** The owner's phase for `show`, in words: one not composed says whether a restart would load it. */
function phaseText(plugin: PluginView, t: CoreT): string {
  if (plugin.phase === undefined) return "";
  if (plugin.phase !== "not_composed") return t("cli.plugins.phase.running", { phase: phaseWord(plugin.phase, t) });
  return t(plugin.enabled ? "cli.plugins.phase.notLoadedYet" : "cli.plugins.phase.notLoaded");
}

/**
 * `tavi plugins show`'s text for one plugin, its long lines cut at spaces to the terminal's `columns` (80 in a pipe),
 * in `t`'s words.
 */
export function pluginDetail(plugin: PluginView, columns: number | undefined = undefined, t: CoreT = coreEnglish): string {
  const none = t("cli.plugins.none");
  const lines = [
    `${plugin.name} (${plugin.id})`,
    t("cli.plugins.show.kind", {
      kind: codeWord("cli.plugins.kind", plugin.kind, t),
      core: plugin.core ? t("cli.plugins.show.core") : "",
      dev: plugin.dev === true ? t("cli.plugins.show.dev") : "",
    }),
    t("cli.plugins.show.state", {
      state: t(plugin.enabled ? "cli.plugins.state.enabled" : "cli.plugins.state.disabled"),
      phase: phaseText(plugin, t),
    }),
  ];
  if (plugin.description !== "") lines.push(t("cli.plugins.show.description", { text: plugin.description }));
  if (plugin.error !== undefined) lines.push(t("cli.plugins.error", { error: plugin.error }));
  if (plugin.kind !== "builtin") {
    lines.push(t("cli.plugins.show.activeVersion", { version: plugin.activeVersion ?? none }));
    if (plugin.directory !== undefined)
      lines.push(t(plugin.dev === true ? "cli.plugins.show.files" : "cli.plugins.show.filesVersioned", { path: plugin.directory }));
    lines.push(t("cli.plugins.show.versions"));
    for (const version of plugin.versions) {
      // A dev plugin's folder is loaded as it is: nothing was installed, approved or reviewed.
      if (plugin.dev === true) {
        lines.push(
          `  ${version.version}\t${t("cli.plugins.version.dev")}\t${t("cli.plugins.version.loadedFrom", { folder: plugin.directory ?? t("cli.plugins.version.itsFolder") })}\t${t("cli.plugins.version.devUnsandboxed")}`,
        );
      } else {
        lines.push(
          `  ${version.version}\t${codeWord("cli.plugins.review", version.reviewState, t)}\tsha256 ${version.contentHash.slice(0, 16)}…\t${t("cli.plugins.version.installed", { at: minuteUtc(version.installedAt) })}`,
        );
        for (const line of pluginVersionIsolationLines(version, t)) lines.push(`    ${line}`);
      }
      for (const capability of version.capabilities ?? [])
        lines.push(
          `    ${t("cli.plugins.version.provider", { id: capability.id, kind: capability.kind, disclosure: capability.disclosure })}`,
        );
      // A channel's review: what it may do, and every address it reaches.
      for (const channel of version.channels ?? []) {
        lines.push(
          `    ${t("cli.plugins.version.channel", { id: channel.providerId, label: channel.label, kind: channel.kind, disclosure: channel.disclosure })}`,
        );
        for (const endpoint of channel.endpoints) lines.push(`      ${endpoint}`);
      }
      for (const pkg of version.provenance?.packages ?? [])
        lines.push(
          `    ${t("cli.plugins.version.package", { name: pkg.name, version: pkg.version, license: pkg.license, integrity: pkg.integrity })}`,
        );
      // An MCP server's launch spec: the exact command or address first.
      if (version.mcp !== undefined) for (const line of mcpBlockLines(version.mcp)) lines.push(`    mcp ${line}`);
      // Each version's own declarations: a review decides on these, not the running version's.
      if (version !== pluginRunningVersion(plugin)) {
        lines.push(
          `    ${t("cli.plugins.version.declares", {
            tools: version.tools.map((tool) => describePluginTool(tool, t)).join(", ") || none,
            settings: Object.keys(version.configFields).join(", ") || none,
          })}`,
        );
        for (const hook of version.mods ?? []) lines.push(`    ${t("cli.plugins.version.hook", { hook: describeModHook(hook, t) })}`);
        for (const command of version.commands ?? [])
          lines.push(`    ${t("cli.plugins.version.command", { name: command.name, description: command.description })}`);
        if (version.router !== undefined) lines.push(`    ${describeRouterDeclaration(version.router, t)}`);
        for (const line of describePluginHeartbeat(version, t)) lines.push(`    ${line}`);
        if (version.memory !== undefined) lines.push(`    ${describeMemoryDeclaration(version.memory, t)}`);
        if (version.ideas !== undefined) lines.push(`    ${describeIdeasDeclaration(version.ideas, t)}`);
        if (version.onboarding !== undefined) lines.push(`    ${describeOnboardingDeclaration(version.onboarding, t)}`);
        for (const contribution of version.ui?.contributions ?? [])
          lines.push(`    ${t("cli.plugins.version.ui", { contribution: describePluginUiContribution(contribution, t) })}`);
        for (const line of version.apps === undefined ? [] : describePluginApps(version.apps, t)) lines.push(`    ${line}`);
      }
    }
    const running = pluginRunningVersion(plugin);
    if (running?.router !== undefined) lines.push(describeRouterDeclaration(running.router, t));
    if (running !== undefined) lines.push(...describePluginHeartbeat(running, t));
    if (running?.memory !== undefined) lines.push(describeMemoryDeclaration(running.memory, t));
    if (running?.ideas !== undefined) lines.push(describeIdeasDeclaration(running.ideas, t));
    if (running?.onboarding !== undefined) lines.push(describeOnboardingDeclaration(running.onboarding, t));
    if (plugin.uiOnly === true) lines.push(t("cli.plugins.show.uiOnly"));
    if (plugin.kind === "mcp") lines.push(t("cli.plugins.show.mcpOnly"));
    lines.push(t(plugin.tools.length === 0 ? "cli.plugins.show.toolsNone" : "cli.plugins.show.tools"));
    for (const tool of plugin.tools)
      lines.push(
        `  ${tool.id}\t${effectWord(tool.effect, t)}${pluginToolOutputNote(tool.output, t)}${pluginToolDeclarationNote(tool, t)}\t${tool.description}`,
      );
    for (const instance of plugin.instances ?? [])
      lines.push(
        t("cli.plugins.show.instance", {
          id: instance.id,
          factory: instance.factory,
          workspace: instance.workspaceId,
          account: instance.accountId,
        }),
      );
    lines.push(t(Object.keys(plugin.configFields).length === 0 ? "cli.plugins.show.settingsNone" : "cli.plugins.show.settings"));
    for (const [key, field] of Object.entries(plugin.configFields)) {
      const value = plugin.config[key];
      lines.push(
        `  ${key}\t${field.type}${field.required === true ? t("cli.plugins.setting.required") : ""}\t${value === undefined ? t("cli.plugins.setting.unset") : JSON.stringify(value)}${field.description === undefined ? "" : `\t${field.description}`}`,
      );
    }
  }
  // A built-in's as an external's (tavi.guard): its commands, its hooks into the turn — what the author says each
  // does, and what Tavi says it can read — what they decided, and how long they take.
  if (plugin.commands !== undefined) {
    lines.push(t("cli.plugins.show.commands"));
    for (const command of plugin.commands) lines.push(`  /${command.name}\t${command.description}`);
  }
  if (plugin.mods !== undefined) {
    lines.push(t("cli.plugins.show.hooks"));
    for (const hook of plugin.mods) lines.push(`  ${describeModHook(hook, t)}`);
    for (const latency of plugin.hookLatency ?? [])
      lines.push(
        `  ${t("cli.plugins.show.latency", {
          event: latency.event,
          median: String(latency.medianMs),
          worst: String(latency.worstMs),
          count: latency.samples,
          n: String(latency.samples),
        })}`,
      );
  }
  // A plugin with commands only has activity too: its commands' failures.
  const activity = plugin.hookActivity;
  if (activity !== undefined) {
    lines.push(
      t("cli.plugins.show.activity", {
        decisions: t("cli.plugins.activity.decisions", { count: activity.decisions, n: String(activity.decisions) }),
        failures: t("cli.plugins.activity.failures", { count: activity.failures, n: String(activity.failures) }),
        pruned:
          activity.pruned === true
            ? t("cli.plugins.activity.pruned", {
                decisions: String(MAX_PLUGIN_HOOK_DECISIONS),
                failures: String(MAX_PLUGIN_HOOK_FAILURES),
              })
            : "",
      }),
    );
    for (const event of activity.recent)
      lines.push(
        `  ${minuteUtc(event.at)}\t${event.kind}\t${event.event}${event.tool === undefined ? "" : ` ${event.tool}`}\t${event.detail}`,
      );
  }
  // The web canvas contributions in effect, their channels and what they are told to disclose.
  if (plugin.ui !== undefined) {
    lines.push(t("cli.plugins.show.ui"));
    for (const contribution of plugin.ui.contributions) lines.push(`  ${describePluginUiContribution(contribution, t)}`);
  }
  // The prose lines (the description, every network domain) go on indented, not where the terminal breaks a word;
  // the rest (a path, a hook, a tool, a disclosure) stays one line, whole, for a reader to copy and a script to read.
  const width = pageWidth(columns);
  const prose = [t("cli.plugins.show.description", { text: "" }), t("cli.plugins.version.networkDomains", { domains: "" })];
  const wrapped = (line: string) => (prose.some((lead) => line.trimStart().startsWith(lead)) ? fittedText(line, width, "  ") : line);
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
  // `list` and `show` speak the default workspace's language in text; JSON and the other actions stay English.
  const worded = options.format !== "json" && (options.action === "list" || options.action === "show");
  const render = (answer: Exclude<PluginAnswer, PluginUiAnswer>, t: CoreT = coreEnglish): number => {
    if ("plugins" in answer) {
      print(answer, answer.plugins.map((plugin) => pluginLine(plugin, t)).join(""));
      return EXIT.ok;
    }
    if ("plugin" in answer) {
      print(answer.plugin, pluginDetail(answer.plugin, io.columns, t));
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
    render: async (result, client) =>
      render(result as Exclude<PluginAnswer, PluginUiAnswer>, worded ? await ownerWords(client) : coreEnglish),
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
        worded ? await storeWords(store) : coreEnglish,
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
