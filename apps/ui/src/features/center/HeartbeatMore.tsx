import {
  BUILTIN_HEARTBEAT_PROVIDER_ID,
  HEARTBEAT_LIMITS,
  formatHeartbeatInterval,
  type HeartbeatGetAnswer,
  type HeartbeatSettingsChange,
} from "@tavi/contracts";
import { Select } from "../../ui/Select.js";
import { ProviderPanel } from "../plugin-host/CenterHeartbeatSlot.js";
import { forgetHeartbeat, setHeartbeatEgress, setHeartbeatProvider, unmuteHeartbeat } from "./heartbeat-api.js";
import { EGRESS, SOURCE_LABELS } from "./heartbeat-options.js";
import { HeartbeatTurn } from "./HeartbeatTurn.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

import type { HeartbeatPage } from "./use-heartbeat-page.js";

/**
 * Heartbeat's *More*: deeper looks, its turn, daily limits, signal sources,
 * extra tools, mutes and sites, the provider and what it receives, and Forget.
 */
export function HeartbeatMore({
  answer,
  change,
  changeFrom,
  apply,
  configRef,
  builtin,
  selected,
  panelSlot,
  confirmForget,
  setConfirmForget,
  setFailure,
  setNote,
  onChanged,
  load,
}: {
  readonly answer: HeartbeatGetAnswer;
  readonly change: (changes: HeartbeatSettingsChange, said?: string) => Promise<boolean>;
  /** A change worked out when its turn comes, from the config as the owner last answered it. */
  readonly changeFrom: (update: (current: HeartbeatGetAnswer["config"]) => HeartbeatSettingsChange, said?: string) => Promise<boolean>;
  readonly apply: HeartbeatPage["apply"];
  readonly configRef: HeartbeatPage["configRef"];
  /** The provider is the built-in one. */
  readonly builtin: boolean;
  /** What the chosen provider declares, when it is loaded. */
  readonly selected: HeartbeatGetAnswer["providerDetails"][number] | undefined;
  readonly panelSlot: HeartbeatPage["panelSlot"];
  readonly confirmForget: boolean;
  readonly setConfirmForget: HeartbeatPage["setConfirmForget"];
  readonly setFailure: HeartbeatPage["setFailure"];
  readonly setNote: HeartbeatPage["setNote"];
  readonly onChanged: (() => void) | undefined;
  readonly load: HeartbeatPage["load"];
}) {
  const { client, workspaceId } = useWorkspace();
  const { config, revision } = answer;
  return (
    <details className="heartbeat-more">
      <summary className="disclosure">More</summary>
      <div className="settings-fields">
        <label>
          Look deeper{" "}
          <Select
            aria-label="Look deeper"
            value={String(config.deepCheckEveryMs)}
            onChange={(event) => void change({ deepCheckEveryMs: Number(event.target.value) })}
          >
            {answer.options.deepCheckEvery
              .filter((ms) => ms >= config.everyMs)
              .map((ms) => (
                <option key={ms} value={String(ms)}>
                  Every {formatHeartbeatInterval(ms)}
                </option>
              ))}
          </Select>
        </label>
        <HeartbeatTurn config={config} onChange={(changes, said) => void change(changes, said)} />
        {/* Keyed by the revision: a re-read resets the fields, so Save never writes back numbers it first loaded. */}
        <form
          key={revision}
          className="heartbeat-limits"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            // An empty dollar limit is none: only checks and tokens bound the day.
            const usd = String(data.get("usd") ?? "").trim();
            const { usdPerDay: _usd, ...budget } = config.budget;
            void change(
              {
                budget: {
                  ...budget,
                  modelTicksPerDay: Number(data.get("ticks")),
                  tokensPerDay: Number(data.get("tokens")),
                  ...(usd === "" ? {} : { usdPerDay: Number(usd) }),
                },
                maxNowPerHour: Number(data.get("hourly")),
              },
              "Limits saved.",
            );
          }}
        >
          <label>
            Checks a day <input name="ticks" type="number" min={1} defaultValue={config.budget.modelTicksPerDay} />
          </label>
          <label>
            Tokens a day{" "}
            <input
              name="tokens"
              type="number"
              min={Math.min(HEARTBEAT_LIMITS.minTokensPerDay, config.budget.tokensPerDay)}
              defaultValue={config.budget.tokensPerDay}
            />
          </label>
          <label>
            Dollars a day{" "}
            <input
              name="usd"
              type="number"
              min={0.01}
              max={10_000}
              step={0.01}
              placeholder="No limit"
              defaultValue={config.budget.usdPerDay ?? ""}
            />
          </label>
          <label>
            Urgent messages an hour <input name="hourly" type="number" required min={1} max={60} defaultValue={config.maxNowPerHour} />
          </label>
          <Button variant="ghost" size="sm" type="submit">
            Save limits
          </Button>
        </form>
        {answer.sources.length === 0 && config.disabledSources.length === 0 ? null : (
          <fieldset className="heartbeat-sources">
            <legend>Signal sources</legend>
            <p className="meta-sm">
              What it gathers to look at. One turned off is not read; what it found before is kept, not taken for resolved.
            </p>
            {/* One turned off and since uninstalled still shows, so it can be cleared. */}
            {[
              ...answer.sources,
              ...config.disabledSources
                .filter((id) => !answer.sources.some((source) => source.id === id))
                .map((id) => ({ id, kind: "gone" as const })),
            ].map((source) => {
              const on = !config.disabledSources.includes(source.id);
              return (
                <label key={source.id} className="heartbeat-radio">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={on && config.disabledSources.length >= HEARTBEAT_LIMITS.disabledSources}
                    onChange={() =>
                      void changeFrom(
                        (current) => ({
                          disabledSources: current.disabledSources.includes(source.id)
                            ? current.disabledSources.filter((id) => id !== source.id)
                            : [...current.disabledSources, source.id],
                        }),
                        on ? "Source turned off." : "Source turned on.",
                      )
                    }
                  />
                  <span>
                    {SOURCE_LABELS[source.id] ?? ("label" in source ? source.label : undefined) ?? source.id}
                    {source.kind === "plugin" ? (
                      <span className="meta-sm"> (plugin)</span>
                    ) : source.kind === "gone" ? (
                      <span className="meta-sm"> (not installed)</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        {answer.toolChoices.length === 0 && config.extraTools.length === 0 ? null : (
          <fieldset className="heartbeat-tools">
            <legend>Extra tools it may use</legend>
            <p className="meta-sm">Read-only tools your plugins and MCP servers add, for its checks to use as well.</p>
            {/* A tool chosen earlier and no longer offered still shows, so it can be taken off. */}
            {[
              ...answer.toolChoices,
              ...config.extraTools
                .filter((id) => !answer.toolChoices.some((tool) => tool.id === id))
                .map((id) => ({ id, description: "No longer offered by a loaded plugin or MCP server" })),
            ].map((tool) => {
              const on = config.extraTools.includes(tool.id);
              return (
                <label key={tool.id} className="heartbeat-radio">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && config.extraTools.length >= HEARTBEAT_LIMITS.extraTools}
                    onChange={() =>
                      void changeFrom(
                        (current) => ({
                          extraTools: current.extraTools.includes(tool.id)
                            ? current.extraTools.filter((id) => id !== tool.id)
                            : [...current.extraTools, tool.id],
                        }),
                        on ? "Tool removed." : "Tool added.",
                      )
                    }
                  />
                  <span>
                    {tool.id} <span className="meta-sm">{tool.description}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        {config.mutes.length === 0 ? null : (
          <fieldset className="heartbeat-mutes">
            <legend>Not told about</legend>
            <ul>
              {config.mutes.map((prefix) => (
                <li key={prefix}>
                  {prefix}{" "}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Tell me about ${prefix} again`}
                    onClick={() => void apply((revisionNow) => unmuteHeartbeat(client, workspaceId, revisionNow, prefix), "Unmuted.")}
                  >
                    Unmute
                  </Button>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        {/* Added when a watched page's line is saved; a site removed here is never read again. */}
        {config.fetchHosts.length === 0 ? null : (
          <fieldset className="heartbeat-sites">
            <legend>Sites it may read</legend>
            <ul>
              {config.fetchHosts.map((host) => (
                <li key={host}>
                  {host}{" "}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Stop reading ${host}`}
                    onClick={() =>
                      void changeFrom((current) => ({ fetchHosts: current.fetchHosts.filter((entry) => entry !== host) }), "Site removed.")
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <label>
          Provider{" "}
          <Select
            aria-label="Provider"
            value={config.providerId}
            onChange={(event) => {
              // Read now: the write waits its turn, and by then the select shows the current provider again.
              const providerId = event.target.value;
              void apply((at) => setHeartbeatProvider(client, workspaceId, at, providerId), "Provider changed.");
            }}
          >
            {[...new Set([BUILTIN_HEARTBEAT_PROVIDER_ID, ...answer.providers, config.providerId])]
              .filter((id) => id !== "off")
              .map((id) => (
                <option key={id} value={id}>
                  {id === BUILTIN_HEARTBEAT_PROVIDER_ID ? "Built in" : id}
                </option>
              ))}
            <option value="off">Off</option>
          </Select>
        </label>
        {builtin || config.providerId === "off" ? null : (
          <fieldset>
            <legend>What {config.providerId} may receive</legend>
            {selected?.disclosure === undefined ? null : <p className="heartbeat-disclosure">{selected.disclosure}</p>}
            {/* Only what its approved manifest asks for: a field it never declared is never sent, whatever the switch says. */}
            {selected === undefined ? (
              <p className="meta-sm">{config.providerId} is not loaded here: nothing can be switched on for it until it is.</p>
            ) : null}
            {/* Not loaded, what it declares cannot be read: only what is already on is shown, so it can be switched off. */}
            {EGRESS.filter((field) => (selected === undefined ? config.providerEgress[field] : selected.receives.includes(field))).map(
              (field) => (
                <label key={field}>
                  <input
                    type="checkbox"
                    checked={config.providerEgress[field]}
                    onChange={() =>
                      void apply((at) =>
                        setHeartbeatEgress(client, workspaceId, at, field, !(configRef.current ?? config).providerEgress[field]),
                      )
                    }
                  />
                  {field}
                </label>
              ),
            )}
          </fieldset>
        )}
        {panelSlot === undefined || builtin || config.providerId === "off" ? null : (
          <ProviderPanel slot={panelSlot} providerId={config.providerId} state={answer.providerState} />
        )}
        {confirmForget ? (
          <p>
            Delete its log, what it told you, its notes and its tasks? Its settings stay.{" "}
            <Button
              size="sm"
              onClick={() =>
                void forgetHeartbeat(client, workspaceId).then((outcome) => {
                  setConfirmForget(false);
                  if (!outcome.ok) setFailure(outcome.message);
                  else {
                    setFailure(undefined);
                    setNote("Forgotten.");
                    onChanged?.();
                    void load();
                  }
                })
              }
            >
              Forget everything
            </Button>{" "}
            <Button variant="ghost" size="sm" onClick={() => setConfirmForget(false)}>
              Cancel
            </Button>
          </p>
        ) : (
          <Button variant="ghost" size="sm" disabled={answer.state === undefined} onClick={() => setConfirmForget(true)}>
            Forget heartbeat history
          </Button>
        )}
      </div>
    </details>
  );
}
