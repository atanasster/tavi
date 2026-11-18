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
import { plural } from "@tavi/contracts/util";

import { pluginActions } from "./plugins-api.js";
import type { Outcome } from "../../lib/ipc.js";
import { Failure, LoadState, Notice, PageHead, StatusNote } from "../../ui/Parts.js";
import { CanvasPluginsSettings } from "./CanvasPluginsSettings.js";
import { AppLink } from "../shell/AppLink.js";
import { appsPath } from "../shell/route.js";
import { Confirm } from "../../ui/Confirm.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { when } from "../../lib/time.js";
import { InstallPluginModal, PluginSettingsModal } from "./PluginModals.js";
import { Command } from "../../ui/Command.js";

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
      ? `Approved, it runs as a confined worker, reaching ${version.networkDomains === undefined || version.networkDomains.length === 0 ? "no network" : `only ${version.networkDomains.join(", ")}`}.`
      : `It cannot run as a confined worker: ${version.workerRefusal}. Approving it runs it UNSANDBOXED in the owner's process, with its privileges.`;
  const raw =
    version.rawSecrets === undefined || version.rawSecrets.length === 0
      ? ""
      : ` It holds the real values of ${version.rawSecrets.join(", ")} (raw secrets), not placeholders.`;
  return ` ${where}${raw}`;
}

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
  const { client } = useWorkspace();
  const timeZone = useTimeZone();
  const { data, error } = useLoaded(() => pluginActions.show(client, pluginId));
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
          Hook activity: {activity.decisions} {activity.decisions === 1 ? "decision" : "decisions"}, {activity.failures}{" "}
          {activity.failures === 1 ? "failure" : "failures"}.
          {activity.pruned === true
            ? ` Older rows were pruned: only the newest ${MAX_PLUGIN_HOOK_DECISIONS} decisions and ${MAX_PLUGIN_HOOK_FAILURES} failures are kept, and counted.`
            : null}
        </span>
      )}
      {latency.length === 0 ? null : (
        <span className="plugin-info" role="list" aria-label={`Hook time for ${pluginId}`}>
          {latency.map((row) => (
            <span key={row.event} role="listitem" className="muted">
              {row.event}: median {row.medianMs} ms, worst {row.worstMs} ms over its last{" "}
              {row.samples === 1 ? "call" : plural(row.samples, "call")}
            </span>
          ))}
        </span>
      )}
      {activity === undefined || activity.recent.length === 0 ? null : (
        <span className="plugin-info" role="list" aria-label={`Recent hook activity for ${pluginId}`}>
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
  if (plugin.phase === "not_composed") return plugin.enabled && !canvasOnly(plugin) ? "loads at next start" : undefined;
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
  const { client } = useWorkspace();
  const { data, error, loading, reload } = useLoaded(() => pluginActions.list(client));
  const { busy, note, run, say } = useAction(reload);
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
  // A version the operator chose to approve in the owner's process: asked once more, saying what that grants.
  const [unsandboxing, setUnsandboxing] = useState<{ readonly plugin: PluginView; readonly version: PluginVersionView } | undefined>();
  // The plugins whose hook activity is shown: read with `show` when opened.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleActivity = (pluginId: string): void =>
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(pluginId)) next.add(pluginId);
      return next;
    });
  const plugins = data?.plugins ?? [];
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
            {plugin.core ? <span className="badge">core</span> : null}
            {/* One badge says where it stands: a plugin nobody has approved yet awaits review, not "disabled". */}
            {awaitingReview ? (
              <span className="badge badge-warning">awaits review</span>
            ) : plugin.enabled ? null : (
              <span className="badge">disabled</span>
            )}
            {phase === undefined ? null : <span className="badge">{phase}</span>}
            {isolationBadge(plugin) === undefined ? null : (
              <span
                className="badge"
                title={
                  isolationBadge(plugin) === "worker" ? "Runs as a confined worker" : "Runs in the owner's process, with its privileges"
                }
              >
                {isolationBadge(plugin)}
              </span>
            )}
          </span>
          {plugin.description === "" ? null : <span className="settings-description">{plugin.description}</span>}
          {plugin.tools.length === 0 ? null : plugin.tools.length <= PLUGIN_TOOLS_SHOWN ? (
            <span className="muted">Tools: {plugin.tools.map(describePluginTool).join(", ")}</span>
          ) : (
            // A long tool list is a wall of text: folded under its count, each tool on a line of its own.
            <details className="plugin-tools">
              <summary className="disclosure muted">Tools · {plugin.tools.length}</summary>
              <ul className="muted">
                {plugin.tools.map((tool) => (
                  <li key={describePluginTool(tool)}>{describePluginTool(tool)}</li>
                ))}
              </ul>
            </details>
          )}
          {router === undefined ? null : <span className="muted">{describeRouterDeclaration(router)}</span>}
          {runningVersion === undefined
            ? null
            : describePluginHeartbeat(runningVersion).map((line) => (
                <span key={line} className="muted">
                  {line}
                </span>
              ))}
          {runningVersion?.memory === undefined ? null : <span className="muted">{describeMemoryDeclaration(runningVersion.memory)}</span>}
          {runningVersion?.ideas === undefined ? null : <span className="muted">{describeIdeasDeclaration(runningVersion.ideas)}</span>}
          {runningVersion?.onboarding === undefined ? null : (
            <span className="muted">{describeOnboardingDeclaration(runningVersion.onboarding)}</span>
          )}
          {/* Awaiting review, the version's own declaration below says it: not twice. */}
          {(awaitingReview ? [] : (plugin.ui?.contributions ?? [])).map((contribution) => (
            <span key={`ui:${contribution.id}`} className="muted">
              Canvas: {describePluginUiContribution(contribution)}
            </span>
          ))}
          {(plugin.mods ?? []).map((hook, index) => (
            <span key={`hook:${index}`} className="muted">
              Hook {hook.event}
              {hook.contextTrusted === true ? " (trusted context)" : ""} (fails: {hook.onFailure}): {withCode(hook.disclosure)}{" "}
              {withCode(hook.reads)}
            </span>
          ))}
          {(plugin.commands ?? []).map((command) => (
            <span key={`command:${command.name}`} className="muted">
              Command /{command.name}: {command.description}
            </span>
          ))}
          {plugin.mods === undefined && plugin.commands === undefined ? null : (
            <span>
              <Button
                variant="bare"
                className="disclosure muted"
                aria-expanded={expanded.has(plugin.id)}
                aria-label={`Hook activity for ${plugin.id}`}
                onClick={() => toggleActivity(plugin.id)}
              >
                Hook activity
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
              {version.version} awaits review. It declares{" "}
              {version.tools.length === 0 ? "no tools" : version.tools.map(describePluginTool).join(", ")}
              {Object.keys(version.configFields).length === 0 ? "" : `, settings ${Object.keys(version.configFields).join(", ")}`}.
              {(version.capabilities ?? []).map((capability) => (
                <span key={capability.id}>
                  {" "}
                  Provider {capability.id} ({capability.kind}): {capability.disclosure}
                </span>
              ))}
              {(version.provenance?.packages ?? []).map((pkg) => (
                <span key={`${pkg.name}@${pkg.version}`}>
                  {" "}
                  {pkg.name}@{pkg.version} ({pkg.license}).
                </span>
              ))}
              {version.router === undefined ? null : <> {describeRouterDeclaration(version.router)}</>}
              {describePluginHeartbeat(version).map((line) => (
                <span key={line}> {line}</span>
              ))}
              {version.memory === undefined ? null : <> {describeMemoryDeclaration(version.memory)}</>}
              {version.ideas === undefined ? null : <> {describeIdeasDeclaration(version.ideas)}</>}
              {version.onboarding === undefined ? null : <> {describeOnboardingDeclaration(version.onboarding)}</>}
              {(version.channels ?? []).map((channel) => (
                <span key={channel.providerId}>
                  {" "}
                  Channel {channel.label} ({channel.kind}): {channel.disclosure}.
                  {channel.endpoints.length === 0 ? "" : ` Reaches ${channel.endpoints.join("; ")}.`}
                </span>
              ))}
              {(version.ui?.contributions ?? []).map((contribution) => (
                <span key={`ui:${contribution.id}`}> Canvas {describePluginUiContribution(contribution).replace(/\.+$/, "")}.</span>
              ))}
              {version.apps === undefined
                ? null
                : describePluginApps(version.apps).map((line) => (
                    <span key={`app:${line}`} data-source="author">
                      {" "}
                      {line}.
                    </span>
                  ))}
              {(version.mods ?? []).map((hook, index) => (
                <span key={`hook:${index}`}>
                  {" "}
                  Hook {hook.event}
                  {hook.contextTrusted === true ? " (trusted context)" : ""} (fails: {hook.onFailure}):{" "}
                  {withCode(hook.disclosure.replace(/\.+$/, ""))}. {withCode(hook.reads)}
                </span>
              ))}
              {(version.commands ?? []).map((command) => (
                <span key={`command:${command.name}`}>
                  {" "}
                  Command /{command.name}: {command.description.replace(/\.+$/, "")}.
                </span>
              ))}
              {isolationReview(version)}
              {plugin.directory === undefined ? null : (
                <>
                  {" "}
                  Its files are in{" "}
                  <code>
                    {plugin.directory}/{version.version}
                  </code>
                  .
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
                  Review {version.version} with <Command>{`tavi mcp show ${plugin.id}`}</Command>
                </span>
              ))
            : proposed.map((version) => (
                <span key={version.version}>
                  {/* A version that cannot be a worker is approved only in-process, after a confirmation; one that can is a worker unless the operator chooses otherwise. */}
                  {version.workerRefusal === undefined ? (
                    <Button
                      size="sm"
                      // The visible words first, so a voice-control user saying them reaches it (WCAG 2.5.3).
                      aria-label={`Approve ${version.version} of ${plugin.id}`}
                      disabled={busy !== undefined}
                      onClick={() => void run(`approve:${plugin.id}`, () => pluginActions.decide(client, plugin.id, version.version, true))}
                    >
                      Approve {version.version}
                    </Button>
                  ) : null}
                  {version.runsOwnerCode && version.mcp === undefined ? (
                    <Button
                      size="sm"
                      variant={version.workerRefusal === undefined ? "ghost" : undefined}
                      aria-label={
                        version.workerRefusal === undefined
                          ? `Approve in-process: ${plugin.id} ${version.version}`
                          : `Approve ${version.version} in-process: ${plugin.id}`
                      }
                      disabled={busy !== undefined}
                      onClick={() => setUnsandboxing({ plugin, version })}
                    >
                      {version.workerRefusal === undefined ? "Approve in-process…" : `Approve ${version.version} in-process…`}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={`Reject ${plugin.id} ${version.version}`}
                    disabled={busy !== undefined}
                    onClick={() => void run(`reject:${plugin.id}`, () => pluginActions.decide(client, plugin.id, version.version, false))}
                  >
                    Reject
                  </Button>
                </span>
              ))}
          {plugin.core ? null : (
            <Button
              size="sm"
              aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.id}`}
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
              {plugin.enabled ? "Disable" : "Enable"}
            </Button>
          )}
          {Object.keys(plugin.configFields).length === 0 &&
          (pluginRunningVersion(plugin)?.capabilities?.length ?? 0) === 0 &&
          (plugin.instances?.length ?? 0) === 0 ? null : (
            <Button size="sm" aria-label={`Settings for ${plugin.id}`} disabled={busy !== undefined} onClick={() => setConfiguring(plugin)}>
              Settings
            </Button>
          )}
          {plugin.kind !== "builtin" ? (
            <Button
              size="sm"
              variant="danger"
              aria-label={`Remove ${plugin.id}`}
              disabled={busy !== undefined || plugin.enabled}
              onClick={() => setRemoving(plugin)}
            >
              Remove
            </Button>
          ) : null}
        </span>
      </li>
    );
  };

  return (
    <section className="settings">
      <PageHead className="settings-head" title="Plugins">
        <Button variant="primary" disabled={busy !== undefined} onClick={() => setInstalling(true)}>
          Install plugin
        </Button>
      </PageHead>

      <Notice>
        An installed plugin runs once you approve and enable it, as a confined worker that reaches only its own folder and the network
        domains its manifest names; only one you approve to run in the owner's process gets the owner's privileges. Either way, approve only
        code you trust. Enable and settings changes take effect when the owner next starts, except for a plugin that only adds to the
        canvas, which applies at once. Disabling a loaded external plugin stops its calls immediately.
      </Notice>
      <LoadState error={error} reload={reload} loading={loading && data === undefined}>
        <StatusNote note={note} />
      </LoadState>
      <h2 className="settings-section-title">Installed</h2>
      {data !== undefined && external.length === 0 ? <Empty>No plugin is installed.</Empty> : null}
      <ul className="rows">{external.map(row)}</ul>
      {/* MCP servers are apps: Settings → Connected apps. */}
      <p className="muted">
        MCP servers and the accounts Tavi connects to are in{" "}
        <AppLink href={appsPath()} onFollow={undefined}>
          Connected apps
        </AppLink>
        .
      </p>
      {/* Tavi's own plugins are folded under their count: what you installed is what the page leads with. One you turned
          off, or one not ready, opens the fold, so its row is seen. */}
      <details
        className="plugins-builtin"
        open={optional.some((plugin) => !plugin.enabled || (plugin.phase !== undefined && plugin.phase !== "ready"))}
      >
        <summary className="disclosure settings-section-title">Built in · {optional.length}</summary>
        <ul className="rows">{optional.map(row)}</ul>
      </details>
      {core.length === 0 ? null : (
        // Opened while a core plugin is not ready: its phase badge is in its row, which a closed fold would hide.
        <details className="plugins-core" open={core.some((plugin) => plugin.phase !== undefined && plugin.phase !== "ready")}>
          <summary className="disclosure">Core (always on) · {core.length}</summary>
          <ul className="rows">{core.map(row)}</ul>
        </details>
      )}
      {workspaceId === undefined || data === undefined ? null : (
        <>
          <h2 className="settings-section-title">Canvas</h2>
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
      {unsandboxing !== undefined ? (
        <Confirm
          title={`Approve ${unsandboxing.plugin.id} ${unsandboxing.version.version} in-process (unsandboxed)?`}
          message={`${unsandboxing.version.workerRefusal === undefined ? "It could run as a confined worker. " : `It cannot run as a confined worker: ${unsandboxing.version.workerRefusal}. `}Approved in-process, its code runs in the owner's process with the owner's privileges: it can read the data directory, reach the network and anything else the owner can. This is tavi plugins approve --in-process. Each new version asks again.`}
          action="Approve in-process (unsandboxed)"
          onClose={() => setUnsandboxing(undefined)}
          onConfirm={() =>
            run(`approve:${unsandboxing.plugin.id}`, () =>
              pluginActions.decide(client, unsandboxing.plugin.id, unsandboxing.version.version, true, true),
            )
          }
        />
      ) : null}
      {removing !== undefined ? (
        <Confirm
          title={`Remove ${removing.name}?`}
          message={
            removing.versions.some((version) => (version.channels ?? []).some((channel) => channel.retention === "purge-on-remove"))
              ? `Every installed version of ${removing.id} and its settings are deleted. Its channel's connections are closed, and in 24 hours what they brought in is erased — conversations, messages, files and the chat notes they taught — as the channel's terms require. Installing it again before then cancels that; disable it instead to keep everything.`
              : `Every installed version of ${removing.id} and its settings are deleted.`
          }
          action="Remove"
          onClose={() => setRemoving(undefined)}
          onConfirm={() => run(`remove:${removing.id}`, () => pluginActions.remove(client, removing.id))}
        />
      ) : null}
    </section>
  );
}
