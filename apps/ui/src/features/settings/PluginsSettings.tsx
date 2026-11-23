import { Fragment, type ReactNode, useState } from "react";

import {
  describePluginApps,
  describePluginUiContribution,
  describeMemoryDeclaration,
  describeIdeasDeclaration,
  describeOnboardingDeclaration,
  describePluginHeartbeat,
  describePluginTool,
  describeRouterDeclaration,
  MAX_PLUGIN_HOOK_DECISIONS,
  MAX_PLUGIN_HOOK_FAILURES,
  pluginRunningVersion,
  type PluginView,
} from "@tavi/contracts";

import { pluginActions } from "./plugins-api.js";
import { translateCore, translateNow, useT } from "../../lib/i18n.js";
import { withParts } from "../../ui/with-parts.js";
import type { Outcome } from "../../lib/ipc.js";
import { Failure, LoadState, Notice, PageHead, PageNote, StatusBadge } from "../../ui/Parts.js";
import { CanvasPluginsSettings } from "./CanvasPluginsSettings.js";
import { AppLink } from "../shell/AppLink.js";
import { appsPath } from "../shell/route.js";
import { Confirm } from "../../ui/Confirm.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { RowAction } from "../../ui/RowAction.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { when } from "../../lib/time.js";
import { InstallPluginModal, PluginSettingsModal } from "./PluginModals.js";
import { Command } from "../../ui/Command.js";
import { codeLabel } from "../../lib/format.js";
import type { UiKey } from "../../locales/en.js";
import { LIVE_POLL_MS, usePoll } from "../../hooks/use-poll.js";

/** What a hook's failure does, as its line says it; a rule this page does not know reads as it arrives. */
const FAILURE_RULES: Readonly<Record<string, UiKey>> = {
  skip: "settings.plugins.failure.skip",
  drop: "settings.plugins.failure.drop",
  ask: "settings.plugins.failure.ask",
  deny: "settings.plugins.failure.deny",
  withhold: "settings.plugins.failure.withhold",
};

type PluginVersionView = PluginView["versions"][number];

/**
 * Where a version's code would run and what it reaches, for its review:
 * a confined worker's network domains and raw secrets, or why it cannot be one.
 * Empty for a version that runs no owner code (an MCP server's, a UI-only one).
 */
function isolationReview(version: PluginVersionView): string {
  if (!version.runsOwnerCode || version.mcp !== undefined) return "";
  const where =
    version.workerRefusal === undefined
      ? version.networkDomains === undefined || version.networkDomains.length === 0
        ? translateNow("settings.plugins.review.workerNoNetwork")
        : translateNow("settings.plugins.review.worker", { domains: version.networkDomains.join(", ") })
      : translateNow("settings.plugins.review.inProcess", { reason: version.workerRefusal });
  const raw =
    version.rawSecrets === undefined || version.rawSecrets.length === 0
      ? ""
      : ` ${translateNow("settings.plugins.review.rawSecrets", { secrets: version.rawSecrets.join(", ") })}`;
  return ` ${where}${raw}`;
}

/** What a version itself declares, a whole sentence for each case: tools or none, with its settings or without. */
function reviewDeclares(version: PluginVersionView): string {
  const settings = Object.keys(version.configFields);
  if (version.tools.length === 0)
    return settings.length === 0
      ? translateNow("settings.plugins.review.declaresNone", { version: version.version })
      : translateNow("settings.plugins.review.declaresNoneSettings", { version: version.version, settings: settings.join(", ") });
  const tools = version.tools.map((tool) => describePluginTool(tool, translateCore)).join(", ");
  return settings.length === 0
    ? translateNow("settings.plugins.review.declares", { version: version.version, tools })
    : translateNow("settings.plugins.review.declaresSettings", { version: version.version, tools, settings: settings.join(", ") });
}

/** A version only `tavi plugins approve --in-process` can approve: owner code that cannot be a confined worker. */
const needsTerminal = (version: PluginVersionView): boolean =>
  version.workerRefusal !== undefined && version.runsOwnerCode && version.mcp === undefined;

/** Text whose `backticked` spans (a tool id, as a hook's reads name it) are shown as code, not as backticks. */
function withCode(text: string): ReactNode {
  return text.split(/`([^`]+)`/).map((part, index) =>
    // Split on a captured group: every odd part was between backticks.
    index % 2 === 1 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>,
  );
}

/** A plugin that only adds to the canvas: no owner code and no hooks, so the owner never loads it. */
const canvasOnly = (plugin: PluginView): boolean => plugin.uiOnly === true && plugin.mods === undefined;

/** The row's tag for where an external plugin's code runs, as `tavi plugins list` shows it. */
function isolationBadge(plugin: PluginView): "worker" | "UNSANDBOXED" | undefined {
  if (plugin.kind !== "external" || !plugin.runsOwnerCode || (plugin.activeVersion === undefined && plugin.isolation === undefined))
    return undefined;
  return plugin.isolation === "process" ? "worker" : "UNSANDBOXED";
}

/**
 * What a plugin's hooks and commands did, as `show` reads it
 * from the newest audit rows: how many decisions and failures — of the kept
 * rows, once the oldest are pruned — the latest few, and each event's
 * own hook time in the running owner. Nothing while it is read, nor for a
 * plugin with none.
 */
function HookActivity({ pluginId }: { readonly pluginId: string }) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const { data, error } = useLoaded(() => pluginActions.show(client, pluginId, workspaceId));
  if (error !== undefined)
    return (
      <Failure as="span" alert={false}>
        {error}
      </Failure>
    );
  const raw = data?.plugin.hookActivity;
  const activity = raw === undefined || (raw.decisions === 0 && raw.failures === 0 && raw.recent.length === 0) ? undefined : raw;
  const latency = data?.plugin.hookLatency ?? [];
  if (activity === undefined && latency.length === 0) return null;
  // Spans, not a `<ul>`: the row's text is a span (`plugin-info`), which holds no block.
  return (
    <>
      {activity === undefined ? null : (
        <span className="muted">
          {t("settings.plugins.hooks.activity", {
            decisions: t("settings.plugins.hooks.decisions", { count: activity.decisions }),
            failures: t("settings.plugins.hooks.failures", { count: activity.failures }),
          })}
          {activity.pruned === true
            ? ` ${t("settings.plugins.hooks.pruned", { decisions: String(MAX_PLUGIN_HOOK_DECISIONS), failures: String(MAX_PLUGIN_HOOK_FAILURES) })}`
            : null}
        </span>
      )}
      {latency.length === 0 ? null : (
        <span className="plugin-info" role="list" aria-label={t("settings.plugins.hooks.timeLabel", { pluginId })}>
          {latency.map((row) => (
            <span key={row.event} role="listitem" className="muted">
              {t("settings.plugins.hooks.time", {
                event: row.event,
                median: String(row.medianMs),
                worst: String(row.worstMs),
                count: row.samples,
              })}
            </span>
          ))}
        </span>
      )}
      {activity === undefined || activity.recent.length === 0 ? null : (
        <span className="plugin-info" role="list" aria-label={t("settings.plugins.hooks.recentLabel", { pluginId })}>
          {activity.recent.map((row, index) => (
            <span key={`${row.at}:${index}`} role="listitem" className="muted">
              {when(row.at, timeZone)} {row.kind} {row.event}
              {row.tool === undefined ? "" : ` ${row.tool}`}: {row.detail}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

/**
 * The running state worth a badge beside the plugin's name. Not loaded is said only of an enabled plugin, as when it
 * loads; of a disabled or unreviewed one it would only repeat that. A plugin that only adds to the canvas is never
 * loaded by the owner: it applies at once, so it has no start to wait for.
 */
function phaseBadge(plugin: PluginView): string | undefined {
  if (plugin.phase === undefined || plugin.phase === "ready") return undefined;
  if (plugin.phase === "not_composed")
    return plugin.enabled && !canvasOnly(plugin) ? translateNow("settings.plugins.loadsNext") : undefined;
  return plugin.phase.replace("_", " ");
}

/** How many of a plugin's tools its row lists in a line; more are folded under their count. */
const PLUGIN_TOOLS_SHOWN = 3;

/**
 * Built-in and installed plugins: review, enable, configure, install
 * and remove. The owner decides every rule; this page only asks it.
 */
export function PluginsSettings({
  workspaceId,
  onPluginOff,
}: {
  readonly workspaceId?: string | undefined;
  /**
   * The owner disabled `pluginId`: the page takes its status lines off the
   * chats (a rejected proposal never ran, so it has none), since the clear it publishes
   * reaches no chat between turns.
   */
  readonly onPluginOff?: ((pluginId: string) => void) | undefined;
}) {
  const t = useT();
  const { client } = useWorkspace();
  const { data, error, loading, reload } = useLoaded(() => pluginActions.list(client, workspaceId));
  const { busy, note, tone, run, say } = useAction(reload);
  /** `work`, and once the owner accepted it, `pluginId`'s status lines off the chats. */
  const turnsOff =
    (pluginId: string, work: () => Promise<Outcome<string | undefined>>) => async (): Promise<Outcome<string | undefined>> => {
      const outcome = await work();
      if (outcome.ok) onPluginOff?.(pluginId);
      return outcome;
    };
  const [installing, setInstalling] = useState(false);
  const [configuring, setConfiguring] = useState<PluginView | undefined>();
  const [removing, setRemoving] = useState<PluginView | undefined>();
  // The plugins whose hook activity is shown: read with `show` when opened.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleActivity = (pluginId: string): void =>
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(pluginId)) next.add(pluginId);
      return next;
    });
  const plugins = data?.plugins ?? [];
  // A version that can only be approved in-process waits on the terminal: read again while one does, and on return to the page.
  const waitsOnTerminal = plugins.some((plugin) =>
    plugin.versions.some((version) => version.reviewState === "proposed" && needsTerminal(version)),
  );
  usePoll(reload, LIVE_POLL_MS, { enabled: waitsOnTerminal, visibility: true }, [reload]);
  // MCP servers are installed plugins too, with a section of their own.
  const external = plugins.filter((plugin) => plugin.kind !== "builtin" && plugin.kind !== "mcp");
  const builtin = plugins.filter((plugin) => plugin.kind === "builtin");
  // Core built-ins cannot be turned off: folded away, so the optional ones are what the page leads with.
  const optional = builtin.filter((plugin) => !plugin.core);
  const core = builtin.filter((plugin) => plugin.core);

  const row = (plugin: PluginView) => {
    const proposed = plugin.versions.filter((version) => version.reviewState === "proposed");
    const approved = plugin.versions.some((version) => version.reviewState === "approved");
    const awaitingReview = !plugin.enabled && !approved && proposed.length > 0;
    const phase = phaseBadge(plugin);
    const router = pluginRunningVersion(plugin)?.router;
    const runningVersion = pluginRunningVersion(plugin);

    return (
      <li key={plugin.id} id={`plugin-row-${plugin.id}`} className="row">
        <span className="plugin-info">
          <span>
            <strong>{plugin.name}</strong> {plugin.name === plugin.id ? null : <span className="muted">{plugin.id}</span>}{" "}
            {plugin.activeVersion === undefined ? null : <span className="muted">{plugin.activeVersion} </span>}
            {plugin.core ? <span className="badge">{t("settings.plugins.core")}</span> : null}
            {/* One badge says where it stands: a plugin nobody has approved yet awaits review, not "disabled". */}
            {awaitingReview ? (
              <span className="badge badge-warning">{t("settings.plugins.awaitsReview")}</span>
            ) : plugin.enabled ? null : (
              <StatusBadge status="disabled" />
            )}
            {/* A state, toned as a state is everywhere (muted, or a failure's colour): the kind tags beside it stay plain. */}
            {phase === undefined ? null : <StatusBadge status={phase} />}
            {isolationBadge(plugin) === undefined ? null : (
              <span
                className="badge"
                title={isolationBadge(plugin) === "worker" ? t("settings.plugins.workerTitle") : t("settings.plugins.inProcessTitle")}
              >
                {isolationBadge(plugin)}
              </span>
            )}
          </span>
          {plugin.description === "" ? null : <span className="settings-description">{withCode(plugin.description)}</span>}
          {plugin.tools.length === 0 ? null : plugin.tools.length <= PLUGIN_TOOLS_SHOWN ? (
            <span className="muted">
              {t("settings.plugins.tools", { tools: plugin.tools.map((tool) => describePluginTool(tool, translateCore)).join(", ") })}
            </span>
          ) : (
            // A long tool list is a wall of text: folded under its count, each tool on a line of its own.
            <details className="plugin-tools">
              <summary className="disclosure muted">{t("settings.plugins.toolsCount", { count: plugin.tools.length })}</summary>
              <ul className="muted">
                {plugin.tools.map((tool) => (
                  <li key={tool.id}>{describePluginTool(tool, translateCore)}</li>
                ))}
              </ul>
            </details>
          )}
          {router === undefined ? null : <span className="muted">{describeRouterDeclaration(router, translateCore)}</span>}
          {runningVersion === undefined
            ? null
            : describePluginHeartbeat(runningVersion, translateCore).map((line) => (
                <span key={line} className="muted">
                  {line}
                </span>
              ))}
          {runningVersion?.memory === undefined ? null : (
            <span className="muted">{describeMemoryDeclaration(runningVersion.memory, translateCore)}</span>
          )}
          {runningVersion?.ideas === undefined ? null : (
            <span className="muted">{describeIdeasDeclaration(runningVersion.ideas, translateCore)}</span>
          )}
          {runningVersion?.onboarding === undefined ? null : (
            <span className="muted">{describeOnboardingDeclaration(runningVersion.onboarding, translateCore)}</span>
          )}
          {/* Awaiting review, the version's own declaration below says it: not twice. */}
          {(awaitingReview ? [] : (plugin.ui?.contributions ?? [])).map((contribution) => (
            <span key={`ui:${contribution.id}`} className="muted">
              {t("settings.plugins.canvasLine", { what: describePluginUiContribution(contribution, translateCore) })}
            </span>
          ))}
          {(plugin.mods ?? []).map((hook, index) => (
            <span key={`hook:${index}`} className="muted">
              {t(hook.contextTrusted === true ? "settings.plugins.hookTrusted" : "settings.plugins.hook", {
                event: hook.event,
                onFailure: codeLabel(FAILURE_RULES, hook.onFailure),
              })}{" "}
              {withCode(hook.disclosure)} {withCode(hook.reads)}
            </span>
          ))}
          {(plugin.commands ?? []).map((command) => (
            <span key={`command:${command.name}`} className="muted">
              {t("settings.plugins.command", { name: command.name, description: command.description })}
            </span>
          ))}
          {plugin.mods === undefined && plugin.commands === undefined ? null : (
            <span>
              <Button
                variant="bare"
                className="disclosure muted"
                aria-expanded={expanded.has(plugin.id)}
                aria-label={t("settings.plugins.hookActivityLabel", { pluginId: plugin.id })}
                onClick={() => toggleActivity(plugin.id)}
              >
                {t("settings.plugins.hookActivity")}
              </Button>
            </span>
          )}
          {expanded.has(plugin.id) ? <HookActivity pluginId={plugin.id} /> : null}
          {plugin.error === undefined ? null : (
            <Failure as="span" alert={false}>
              {plugin.error}
            </Failure>
          )}
          {proposed.map((version) => (
            // What this version itself declares: the review decides on it, not on the version that runs.
            <Notice as="span" key={`review:${version.version}`}>
              {reviewDeclares(version)}
              {(version.capabilities ?? []).map((capability) => (
                <span key={capability.id}>
                  {" "}
                  {t("settings.plugins.review.provider", { id: capability.id, kind: capability.kind, disclosure: capability.disclosure })}
                </span>
              ))}
              {(version.provenance?.packages ?? []).map((pkg) => (
                <span key={`${pkg.name}@${pkg.version}`}>
                  {" "}
                  {pkg.name}@{pkg.version} ({pkg.license}).
                </span>
              ))}
              {version.router === undefined ? null : <> {describeRouterDeclaration(version.router, translateCore)}</>}
              {describePluginHeartbeat(version, translateCore).map((line) => (
                <span key={line}> {line}</span>
              ))}
              {version.memory === undefined ? null : <> {describeMemoryDeclaration(version.memory, translateCore)}</>}
              {version.ideas === undefined ? null : <> {describeIdeasDeclaration(version.ideas, translateCore)}</>}
              {version.onboarding === undefined ? null : <> {describeOnboardingDeclaration(version.onboarding, translateCore)}</>}
              {(version.channels ?? []).map((channel) => (
                <span key={channel.providerId}>
                  {" "}
                  {t("settings.plugins.review.channel", { label: channel.label, kind: channel.kind, disclosure: channel.disclosure })}
                  {channel.endpoints.length === 0
                    ? ""
                    : ` ${t("settings.plugins.review.reaches", { endpoints: channel.endpoints.join("; ") })}`}
                </span>
              ))}
              {(version.ui?.contributions ?? []).map((contribution) => (
                <span key={`ui:${contribution.id}`}>
                  {" "}
                  {t("settings.plugins.review.canvas", {
                    what: describePluginUiContribution(contribution, translateCore).replace(/\.+$/, ""),
                  })}
                </span>
              ))}
              {version.apps === undefined
                ? null
                : describePluginApps(version.apps, translateCore).map((line) => (
                    <span key={`app:${line}`} data-source="author">
                      {" "}
                      {line}.
                    </span>
                  ))}
              {(version.mods ?? []).map((hook, index) => (
                <span key={`hook:${index}`}>
                  {" "}
                  {t(hook.contextTrusted === true ? "settings.plugins.hookTrusted" : "settings.plugins.hook", {
                    event: hook.event,
                    onFailure: codeLabel(FAILURE_RULES, hook.onFailure),
                  })}{" "}
                  {withCode(hook.disclosure.replace(/\.+$/, ""))}. {withCode(hook.reads)}
                </span>
              ))}
              {(version.commands ?? []).map((command) => (
                <span key={`command:${command.name}`}>
                  {" "}
                  {t("settings.plugins.command", { name: command.name, description: command.description.replace(/\.+$/, "") })}.
                </span>
              ))}
              {isolationReview(version)}
              {plugin.directory === undefined ? null : (
                <>
                  {" "}
                  {withParts(t("settings.plugins.review.files"), {
                    path: (
                      <code>
                        {plugin.directory}/{version.version}
                      </code>
                    ),
                  })}
                </>
              )}
            </Notice>
          ))}
        </span>
        <span className="actions">
          {plugin.kind === "mcp"
            ? proposed.map((version) => (
                // An MCP server's approval decides each of its tools: the generic card cannot show them.
                <span key={version.version} className="note">
                  {withParts(t("settings.plugins.reviewWith", { version: version.version }), {
                    command: <Command>{`tavi mcp show ${plugin.id}`}</Command>,
                  })}
                </span>
              ))
            : proposed.map((version) => (
                // A cluster, so the terminal command keeps the actions' gap from Reject.
                <span key={version.version} className="cluster">
                  {/* A version that can be a worker is approved as one here; one that cannot is approved in-process from the terminal. */}
                  {version.workerRefusal === undefined ? (
                    <RowAction
                      tone="awaited"
                      // The visible words first, so a voice-control user saying them reaches it (WCAG 2.5.3).
                      aria-label={t("settings.plugins.approveLabel", { version: version.version, pluginId: plugin.id })}
                      disabled={busy !== undefined}
                      onClick={() => void run(`approve:${plugin.id}`, () => pluginActions.decide(client, plugin.id, version.version, true))}
                    >
                      {t("settings.plugins.approve", { version: version.version })}
                    </RowAction>
                  ) : null}
                  {needsTerminal(version) ? (
                    // In-process (unsandboxed) is approved from the terminal only, as MCP's weaker sandbox is: the owner refuses it from a page.
                    <span className="note">
                      {withParts(t("settings.plugins.approveInProcess", { version: version.version }), {
                        command: <Command>{`tavi plugins approve ${plugin.id} ${version.version} --in-process`}</Command>,
                      })}
                    </span>
                  ) : null}
                  <RowAction
                    tone="danger"
                    aria-label={t("settings.plugins.rejectLabel", { pluginId: plugin.id, version: version.version })}
                    disabled={busy !== undefined}
                    onClick={() => void run(`reject:${plugin.id}`, () => pluginActions.decide(client, plugin.id, version.version, false))}
                  >
                    {t("settings.plugins.reject")}
                  </RowAction>
                </span>
              ))}
          {plugin.core ? null : (
            <RowAction
              aria-label={t(plugin.enabled ? "settings.search.disableLabel" : "settings.search.enableLabel", { id: plugin.id })}
              disabled={busy !== undefined || (plugin.kind !== "builtin" && !plugin.enabled && !approved)}
              onClick={() =>
                void run(
                  `enable:${plugin.id}`,
                  plugin.enabled
                    ? turnsOff(plugin.id, () => pluginActions.setEnabled(client, plugin.id, false))
                    : () => pluginActions.setEnabled(client, plugin.id, true),
                )
              }
            >
              {plugin.enabled ? t("settings.action.disable") : t("settings.action.enable")}
            </RowAction>
          )}
          {Object.keys(plugin.configFields).length === 0 &&
          (pluginRunningVersion(plugin)?.capabilities?.length ?? 0) === 0 &&
          (plugin.instances?.length ?? 0) === 0 ? null : (
            <RowAction
              aria-label={t("settings.plugins.settingsLabel", { pluginId: plugin.id })}
              disabled={busy !== undefined}
              onClick={() => setConfiguring(plugin)}
            >
              {t("settings.plugins.settings")}
            </RowAction>
          )}
          {plugin.kind !== "builtin" ? (
            <RowAction
              tone="danger"
              aria-label={t("settings.search.removeLabel", { id: plugin.id })}
              disabled={busy !== undefined || plugin.enabled}
              // Why it cannot be pressed: an enabled plugin is turned off before it is removed.
              title={plugin.enabled ? t("settings.plugins.disableFirst") : undefined}
              onClick={() => setRemoving(plugin)}
            >
              {t("settings.action.remove")}
            </RowAction>
          ) : null}
        </span>
      </li>
    );
  };

  return (
    <section className="settings">
      <PageHead className="settings-head" title={t("settings.plugins.title")}>
        <Button variant="primary" disabled={busy !== undefined} onClick={() => setInstalling(true)}>
          {t("settings.plugins.install")}
        </Button>
      </PageHead>

      <Notice>{t("settings.plugins.intro")}</Notice>
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <PageNote tone={tone} note={note} />
      </LoadState>
      <h2 className="settings-section-title">{t("settings.plugins.installed")}</h2>
      {data !== undefined && external.length === 0 ? <Empty>{t("settings.plugins.empty")}</Empty> : null}
      <ul className="rows">{external.map(row)}</ul>
      {/* MCP servers are apps: Settings → Connected apps. */}
      <p className="muted">
        {withParts(t("settings.plugins.mcpElsewhere"), {
          link: (
            <AppLink href={appsPath()} onFollow={undefined}>
              {t("settings.plugins.connectedApps")}
            </AppLink>
          ),
        })}
      </p>
      {/* Tavi's own plugins are folded under their count: what you installed is what the page leads with. One you turned
          off, or one not ready, opens the fold, so its row is seen. */}
      <details
        className="plugins-builtin"
        open={optional.some((plugin) => !plugin.enabled || (plugin.phase !== undefined && plugin.phase !== "ready"))}
      >
        <summary className="disclosure settings-section-title">{t("settings.plugins.builtIn", { count: optional.length })}</summary>
        <ul className="rows">{optional.map(row)}</ul>
      </details>
      {core.length === 0 ? null : (
        // Opened while a core plugin is not ready: its phase badge is in its row, which a closed fold would hide.
        <details className="plugins-core" open={core.some((plugin) => plugin.phase !== undefined && plugin.phase !== "ready")}>
          <summary className="disclosure">{t("settings.plugins.coreCount", { count: core.length })}</summary>
          <ul className="rows">{core.map(row)}</ul>
        </details>
      )}
      {workspaceId === undefined || data === undefined ? null : (
        <>
          <h2 className="settings-section-title">{t("settings.plugins.canvas")}</h2>
          {/* Read again whenever a plugin is enabled, disabled, approved or rejected. */}
          <CanvasPluginsSettings
            key={`${workspaceId}:${plugins.map((plugin) => `${plugin.id}@${plugin.activeVersion ?? ""}:${plugin.enabled ? 1 : 0}:${plugin.versions.map((v) => v.reviewState).join(",")}`).join("|")}`}
            workspaceId={workspaceId}
          />
        </>
      )}

      {installing ? (
        <InstallPluginModal
          onClose={() => setInstalling(false)}
          install={async (path) => {
            const outcome = await pluginActions.install(client, path);
            if (outcome.ok) {
              say(outcome.value);
              reload();
            }
            return outcome;
          }}
        />
      ) : null}
      {configuring !== undefined ? (
        <PluginSettingsModal
          plugin={configuring}
          onClose={() => setConfiguring(undefined)}
          save={async (set, unset, instances) => {
            const outcome = await pluginActions.configure(client, configuring.id, set, unset, instances);
            if (outcome.ok) {
              say(outcome.value);
              reload();
            }
            return outcome;
          }}
        />
      ) : null}
      {removing !== undefined ? (
        <Confirm
          title={t("settings.search.removeTitle", { id: removing.name })}
          message={
            removing.versions.some((version) => (version.channels ?? []).some((channel) => channel.retention === "purge-on-remove"))
              ? t("settings.plugins.removePurge", { pluginId: removing.id })
              : t("settings.plugins.removeMessage", { pluginId: removing.id })
          }
          action={t("settings.action.remove")}
          onClose={() => setRemoving(undefined)}
          onConfirm={() => run(`remove:${removing.id}`, () => pluginActions.remove(client, removing.id))}
        />
      ) : null}
    </section>
  );
}
