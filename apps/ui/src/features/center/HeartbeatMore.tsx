import { BUILTIN_HEARTBEAT_PROVIDER_ID, HEARTBEAT_LIMITS, type HeartbeatGetAnswer, type HeartbeatSettingsChange } from "@tavi/contracts";
import { useT } from "../../lib/i18n.js";
import { Select } from "../../ui/Select.js";
import { ProviderPanel } from "../plugin-host/CenterHeartbeatSlot.js";
import { forgetHeartbeat, setHeartbeatEgress, setHeartbeatProvider, unmuteHeartbeat } from "./heartbeat-api.js";
import { EGRESS, everyInterval, sourceLabel } from "./heartbeat-options.js";
import { HeartbeatTurn } from "./HeartbeatTurn.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

import type { UiKey } from "../../locales/en.js";
import type { HeartbeatPage } from "./use-heartbeat-page.js";

/** What a provider may receive, by field. */
const EGRESS_LABELS: Readonly<Record<(typeof EGRESS)[number], UiKey>> = {
  instructions: "center.heartbeatMore.egress.instructions",
  signals: "center.heartbeatMore.egress.signals",
  ledger: "center.heartbeatMore.egress.ledger",
  memory: "center.heartbeatMore.egress.memory",
};

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
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const { config, revision } = answer;
  return (
    <details className="heartbeat-more">
      <summary className="disclosure">{t("center.heartbeatMore.more")}</summary>
      <div className="settings-fields">
        <label>
          {t("center.heartbeatMore.lookDeeper")}{" "}
          <Select
            aria-label={t("center.heartbeatMore.lookDeeper")}
            value={String(config.deepCheckEveryMs)}
            onChange={(event) => void change({ deepCheckEveryMs: Number(event.target.value) })}
          >
            {answer.options.deepCheckEvery
              .filter((ms) => ms >= config.everyMs)
              .map((ms) => (
                <option key={ms} value={String(ms)}>
                  {everyInterval(ms)}
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
              t("center.heartbeatMore.limitsSaved"),
            );
          }}
        >
          <label>
            {t("center.heartbeatMore.checksADay")}{" "}
            <input name="ticks" type="number" min={1} defaultValue={config.budget.modelTicksPerDay} />
          </label>
          <label>
            {t("center.heartbeatMore.tokensADay")}{" "}
            <input
              name="tokens"
              type="number"
              min={Math.min(HEARTBEAT_LIMITS.minTokensPerDay, config.budget.tokensPerDay)}
              defaultValue={config.budget.tokensPerDay}
            />
          </label>
          <label>
            {t("center.heartbeatMore.dollarsADay")}{" "}
            <input
              name="usd"
              type="number"
              min={0.01}
              max={10_000}
              step={0.01}
              placeholder={t("center.heartbeatMore.noLimit")}
              defaultValue={config.budget.usdPerDay ?? ""}
            />
          </label>
          <label>
            {t("center.heartbeatMore.urgentAnHour")}{" "}
            <input name="hourly" type="number" required min={1} max={60} defaultValue={config.maxNowPerHour} />
          </label>
          <Button size="sm" type="submit">
            {t("center.heartbeatMore.saveLimits")}
          </Button>
        </form>
        {answer.sources.length === 0 && config.disabledSources.length === 0 ? null : (
          <fieldset className="heartbeat-sources">
            <legend>{t("center.heartbeatMore.sources")}</legend>
            <p className="meta-sm">{t("center.heartbeatMore.sourcesHint")}</p>
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
                        on ? t("center.heartbeatMore.sourceOff") : t("center.heartbeatMore.sourceOn"),
                      )
                    }
                  />
                  <span>
                    {sourceLabel(source.id) ?? ("label" in source ? source.label : undefined) ?? source.id}
                    {source.kind === "plugin" ? (
                      <span className="meta-sm"> {t("center.heartbeatMore.plugin")}</span>
                    ) : source.kind === "gone" ? (
                      <span className="meta-sm"> {t("center.heartbeatMore.notInstalled")}</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
        {answer.toolChoices.length === 0 && config.extraTools.length === 0 ? null : (
          <fieldset className="heartbeat-tools">
            <legend>{t("center.heartbeatMore.tools")}</legend>
            <p className="meta-sm">{t("center.heartbeatMore.toolsHint")}</p>
            {/* A tool chosen earlier and no longer offered still shows, so it can be taken off. */}
            {[
              ...answer.toolChoices,
              ...config.extraTools
                .filter((id) => !answer.toolChoices.some((tool) => tool.id === id))
                .map((id) => ({ id, description: t("center.heartbeatMore.toolGone") })),
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
                        on ? t("center.heartbeatMore.toolRemoved") : t("center.heartbeatMore.toolAdded"),
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
            <legend>{t("center.heartbeatMore.mutes")}</legend>
            <ul>
              {config.mutes.map((prefix) => (
                <li key={prefix}>
                  {prefix}{" "}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("center.heartbeatMore.unmuteLabel", { prefix })}
                    onClick={() =>
                      void apply(
                        (revisionNow) => unmuteHeartbeat(client, workspaceId, revisionNow, prefix),
                        t("center.heartbeatMore.unmuted"),
                      )
                    }
                  >
                    {t("center.heartbeatMore.unmute")}
                  </Button>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        {/* Added when a watched page's line is saved; a site removed here is never read again. */}
        {config.fetchHosts.length === 0 ? null : (
          <fieldset className="heartbeat-sites">
            <legend>{t("center.heartbeatMore.sites")}</legend>
            <ul>
              {config.fetchHosts.map((host) => (
                <li key={host}>
                  {host}{" "}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("center.heartbeatMore.stopReading", { host })}
                    onClick={() =>
                      void changeFrom(
                        (current) => ({ fetchHosts: current.fetchHosts.filter((entry) => entry !== host) }),
                        t("center.heartbeatMore.siteRemoved"),
                      )
                    }
                  >
                    {t("center.heartbeatMore.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <label>
          {t("center.heartbeatMore.provider")}{" "}
          <Select
            aria-label={t("center.heartbeatMore.provider")}
            value={config.providerId}
            onChange={(event) => {
              // Read now: the write waits its turn, and by then the select shows the current provider again.
              const providerId = event.target.value;
              void apply((at) => setHeartbeatProvider(client, workspaceId, at, providerId), t("center.heartbeatMore.providerChanged"));
            }}
          >
            {[...new Set([BUILTIN_HEARTBEAT_PROVIDER_ID, ...answer.providers, config.providerId])]
              .filter((id) => id !== "off")
              .map((id) => (
                <option key={id} value={id}>
                  {id === BUILTIN_HEARTBEAT_PROVIDER_ID ? t("center.heartbeatMore.builtIn") : id}
                </option>
              ))}
            <option value="off">{t("center.heartbeatMore.off")}</option>
          </Select>
        </label>
        {builtin || config.providerId === "off" ? null : (
          <fieldset>
            <legend>{t("center.heartbeatMore.mayReceive", { provider: config.providerId })}</legend>
            {selected?.disclosure === undefined ? null : <p className="heartbeat-disclosure">{selected.disclosure}</p>}
            {/* Only what its approved manifest asks for: a field it never declared is never sent, whatever the switch says. */}
            {selected === undefined ? (
              <p className="meta-sm">{t("center.heartbeatMore.notLoaded", { provider: config.providerId })}</p>
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
                  {t(EGRESS_LABELS[field])}
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
            {t("center.heartbeatMore.forgetQuestion")}{" "}
            <Button
              size="sm"
              onClick={() =>
                void forgetHeartbeat(client, workspaceId).then((outcome) => {
                  setConfirmForget(false);
                  if (!outcome.ok) setFailure(outcome.message);
                  else {
                    setFailure(undefined);
                    setNote(t("center.heartbeatMore.forgotten"));
                    onChanged?.();
                    void load();
                  }
                })
              }
            >
              {t("center.heartbeatMore.forgetEverything")}
            </Button>{" "}
            <Button variant="ghost" size="sm" onClick={() => setConfirmForget(false)}>
              {t("ui.confirm.cancel")}
            </Button>
          </p>
        ) : (
          <Button
            variant="danger-ghost"
            size="sm"
            className="heartbeat-forget"
            disabled={answer.state === undefined}
            onClick={() => setConfirmForget(true)}
          >
            {t("center.heartbeatMore.forgetHistory")}
          </Button>
        )}
      </div>
    </details>
  );
}
