import { BUILTIN_HEARTBEAT_PROVIDER_ID, HEARTBEAT_TELL_ME, type HeartbeatGetAnswer, type HeartbeatSettingsChange } from "@tavi/contracts";

import type { Translate } from "@tavi/contracts/i18n";

import { useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { localTime, whenLocal } from "../../lib/time.js";
import { Failure, LoadState, Notice, PageHead, StatusNote } from "../../ui/Parts.js";
import { Select } from "../../ui/Select.js";
import {
  LOG_FILTERS,
  changeHeartbeat,
  checkHeartbeatNow,
  heartbeatEstimate,
  logFilter,
  logLine,
  pauseHeartbeat,
  ranProvider,
  resumeHeartbeat,
  type LogFilter,
} from "./heartbeat-api.js";
import { TELL_LABELS, PAUSES, everyInterval, todaysFigures } from "./heartbeat-options.js";
import { HeartbeatItemCard, type HeartbeatItemView } from "./HeartbeatItem.js";
import { HeartbeatTargets } from "./HeartbeatTargets.js";
import { decimal, formatCount } from "../../lib/format.js";
import { Button } from "../../ui/Button.js";
import { EVERY_DAY, toggleDay } from "../../ui/cadence.js";
import { DayChips } from "../../ui/DayChips.js";
import { HeartbeatMore } from "./HeartbeatMore.js";
import { HeartbeatWatch } from "./HeartbeatWatch.js";
import { useHeartbeatPage } from "./use-heartbeat-page.js";

/**
 * Center → Heartbeat: the header (on/off,
 * Check now, Pause), the last and next check with today's figures, what it
 * keeps an eye on (edited in place, with its history and one-tap
 * suggestions), how often, when and how it tells you, the day's estimate,
 * *More* (deeper looks, daily limits, provider and what it receives, Forget),
 * and the log. Every change names the revision the page read.
 */

/** How often an open Center → Heartbeat reads the heartbeat again. */
const HEARTBEAT_REFRESH_MS = 2_000;

export function Heartbeat({
  onChanged,
  onDoIt,
  onChat,
  refreshMs = HEARTBEAT_REFRESH_MS,
}: {
  /** How often the open page reads the heartbeat again; 0 never. */
  readonly refreshMs?: number;
  /** A write landed: the rail's pill reads the heartbeat again. */
  readonly onChanged?: (() => void) | undefined;
  /** An item's *Do it* and *Chat about this*: turns in Home, or a new chat with Home off. */
  readonly onDoIt?: ((item: HeartbeatItemView) => void) | undefined;
  readonly onChat?: ((item: HeartbeatItemView) => void) | undefined;
}) {
  const t = useT();
  const {
    client,
    workspaceId,
    answer,
    ticks,
    error,
    logError,
    items,
    itemsError,
    revisionRef,
    configRef,
    panelSlot,
    failure,
    setFailure,
    note,
    setNote,
    loading,
    editing,
    setEditing,
    history,
    setHistory,
    filter,
    setFilter,
    confirmForget,
    setConfirmForget,
    ids,
    load,
    apply,
  } = useHeartbeatPage(refreshMs, onChanged);

  if (answer === undefined) {
    return (
      <section className="center-section heartbeat-page" aria-labelledby={`${ids}-title`}>
        <PageHead className="center-head" id={`${ids}-title`} title={t("center.heartbeat.title")} />
        <LoadState error={error} reload={() => void load()} loading={loading} />
      </section>
    );
  }

  const { config, revision, timezone } = answer;
  const change = (changes: HeartbeatSettingsChange, said?: string) =>
    apply((at) => changeHeartbeat(client, workspaceId, at, changes), said);
  /** A change worked out when its turn comes, from the config as the owner last answered it. */
  const changeFrom = (update: (current: HeartbeatGetAnswer["config"]) => HeartbeatSettingsChange, said?: string) =>
    apply((at) => changeHeartbeat(client, workspaceId, at, update(configRef.current ?? config)), said);
  const paused = config.paused;
  const lines = config.instructions
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const last = ticks.find((tick) => tick.kind !== "window");
  const figures = todaysFigures(ticks, timezone);
  const ran = ticks.filter(ranProvider);
  const estimate = heartbeatEstimate(config, ran.length === 0 ? undefined : ran.reduce((sum, tick) => sum + tick.tokens, 0) / ran.length);
  const shown = ticks.filter(logFilter(filter));
  const builtin = config.providerId === BUILTIN_HEARTBEAT_PROVIDER_ID;
  const selected = answer.providerDetails.find((provider) => provider.id === config.providerId);

  return (
    <section className="center-section heartbeat-page" aria-labelledby={`${ids}-title`}>
      <PageHead
        className="center-head"
        id={`${ids}-title`}
        title={t("center.heartbeat.title")}
        description={t("center.heartbeat.description")}
      >
        <div className="heartbeat-actions cluster">
          {/* A switch says its state by its look and its label, not by a button's word that could be an action. */}
          <span className="meta" aria-hidden="true">
            {config.enabled ? t("center.heartbeat.on") : t("center.heartbeat.off")}
          </span>
          <Button
            variant="bare"
            className="switch"
            role="switch"
            aria-checked={config.enabled}
            aria-label={t("center.heartbeat.title")}
            onClick={() =>
              void apply(
                (at) => changeHeartbeat(client, workspaceId, at, { enabled: !(configRef.current ?? config).enabled }),
                undefined,
              ).then((done) => {
                // Said from what the owner answered: two quick taps say where it ended.
                if (done) setNote(configRef.current?.enabled === true ? t("center.heartbeat.turnedOn") : t("center.heartbeat.turnedOff"));
              })
            }
          />
          {/* Checking and pausing are for a heartbeat that is on: off, the switch is the only control. */}
          {!config.enabled ? null : (
            <Button
              size="sm"
              disabled={paused !== undefined || !answer.hostRunning}
              title={answer.hostRunning ? undefined : t("center.heartbeat.runsInServe")}
              onClick={() =>
                void checkHeartbeatNow(client, workspaceId).then((outcome) => {
                  if (!outcome.ok) setFailure(outcome.message);
                  else {
                    setFailure(undefined);
                    setNote(outcome.value.status === "started" ? t("center.heartbeat.checkingNow") : t("center.heartbeat.checkQueued"));
                  }
                })
              }
            >
              {t("center.heartbeat.checkNow")}
            </Button>
          )}
          {!config.enabled && paused === undefined ? null : paused === undefined ? (
            <label className="heartbeat-pause">
              <span className="visually-hidden">{t("center.heartbeat.pause")}</span>
              <Select
                aria-label={t("center.heartbeat.pause")}
                value=""
                disabled={answer.state === undefined}
                onChange={(event) => {
                  const choice = PAUSES.find((pause) => pause.value === event.target.value);
                  if (choice !== undefined)
                    void apply(() => pauseHeartbeat(client, workspaceId, choice.forMs), t("center.heartbeat.paused"));
                }}
              >
                <option value="">{t("center.heartbeat.pauseMenu")}</option>
                {PAUSES.map((pause) => (
                  <option key={pause.value} value={pause.value}>
                    {t(pause.labelKey)}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <Button size="sm" onClick={() => void apply(() => resumeHeartbeat(client, workspaceId), t("center.heartbeat.resumed"))}>
              {t("center.heartbeat.resume")}
            </Button>
          )}
        </div>
      </PageHead>
      <Failure message={failure} />
      {/* What is shown is the last good read: a read that failed since says so, rather than passing stale figures for live ones. */}
      <Failure message={error === undefined ? undefined : t("center.heartbeat.couldNotRefresh", { error })} alert={false} />
      <StatusNote note={note} />
      {paused === undefined ? null : (
        <Notice>{pausedNotice(t, paused.reason, paused.until === undefined ? undefined : whenLocal(paused.until, timezone))}</Notice>
      )}
      {/* Said only when there is something to say: a heartbeat that is off and never checked has no figures. */}
      {logError === undefined && last === undefined && answer.state?.nextTickAt === undefined ? null : (
        <p className="meta-sm heartbeat-status">
          {logError !== undefined
            ? t("center.heartbeat.lastUnknown")
            : last === undefined
              ? t("center.heartbeat.lastNever")
              : t("center.heartbeat.lastAt", { time: localTime(last.createdAt, timezone), line: logLine(last).toLowerCase() })}
          {answer.state?.nextTickAt === undefined ? null : (
            <>
              {" · "}
              {t("center.heartbeat.next", { time: localTime(answer.state.nextTickAt, timezone) })}
            </>
          )}
          {figures.checks === 0 ? null : (
            <>
              {" · "}
              {t("center.heartbeat.today", {
                count: figures.checks,
                deep: figures.deep,
                tokens: formatCount(figures.tokens),
                cost: figures.usd === null ? t("center.heartbeat.costUnknown") : `$${decimal(figures.usd, 2)}`,
              })}
            </>
          )}
        </p>
      )}

      {items.length === 0 && itemsError === undefined ? null : (
        <section aria-labelledby={`${ids}-items`}>
          <h2 className="center-subhead" id={`${ids}-items`}>
            {t("center.heartbeat.itemsHeading")}
          </h2>
          <Failure
            message={itemsError === undefined ? undefined : t("center.heartbeat.itemsUnreadable", { error: itemsError })}
            alert={false}
          />
          <ul className="heartbeat-items list-reset">
            {items.map((item) => (
              <li key={item.itemId}>
                <HeartbeatItemCard itemId={item.itemId} initial={item} timeZone={timezone} onDoIt={onDoIt} onChat={onChat} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <HeartbeatWatch
        ids={ids}
        config={config}
        revision={revision}
        timezone={timezone}
        lines={lines}
        editing={editing}
        setEditing={setEditing}
        history={history}
        setHistory={setHistory}
        apply={apply}
        configRef={configRef}
        revisionRef={revisionRef}
        setFailure={setFailure}
      />

      <section aria-labelledby={`${ids}-settings`}>
        <h2 className="center-subhead" id={`${ids}-settings`}>
          {t("center.heartbeat.settingsHeading")}
        </h2>
        <div className="settings-fields">
          <label>
            {t("center.heartbeat.howOften")}{" "}
            <Select
              aria-label={t("center.heartbeat.howOften")}
              value={String(config.everyMs)}
              onChange={(event) => void change({ everyMs: Number(event.target.value) })}
            >
              {answer.options.every.map((ms) => (
                <option key={ms} value={String(ms)}>
                  {everyInterval(ms)}
                </option>
              ))}
            </Select>
          </label>
          {/* One range on one row: from and to side by side, its zone after them. */}
          <div className="heartbeat-hours" role="group" aria-label={t("center.heartbeat.activeHours")}>
            <label>
              {t("center.heartbeat.activeFrom")}{" "}
              <input
                type="time"
                value={config.activeHours.start}
                onChange={(event) => {
                  const start = event.target.value;
                  if (start !== "") void changeFrom((current) => ({ activeHours: { ...current.activeHours, start } }));
                }}
              />
            </label>
            <label>
              {t("center.heartbeat.activeTo")}{" "}
              <input
                type="time"
                value={config.activeHours.end}
                onChange={(event) => {
                  const end = event.target.value;
                  if (end !== "") void changeFrom((current) => ({ activeHours: { ...current.activeHours, end } }));
                }}
              />
            </label>
            <span className="meta-sm">{timezone}</span>
          </div>
          <DayChips
            days={config.daysOfWeek ?? EVERY_DAY}
            onToggle={(day) =>
              // Worked out from the days as the owner last answered them: two quick taps both count.
              void changeFrom((current) => ({ daysOfWeek: [...toggleDay(current.daysOfWeek ?? EVERY_DAY, day)] }))
            }
            onPreset={(days) => void change({ daysOfWeek: [...days] })}
          />
          <fieldset className="heartbeat-tell">
            <legend>{t("center.heartbeat.tellMe")}</legend>
            {HEARTBEAT_TELL_ME.map((mode) => (
              <label key={mode} className="heartbeat-radio">
                <input
                  type="radio"
                  name={`${ids}-tell`}
                  value={mode}
                  checked={config.tellMe === mode}
                  onChange={() => void change({ tellMe: mode })}
                />
                {t(TELL_LABELS[mode])}
              </label>
            ))}
          </fieldset>
          <HeartbeatTargets
            targets={config.targets}
            onChange={(update, said) => void changeFrom((current) => ({ targets: [...update(current.targets)] }), said)}
          />
        </div>
        <p className="meta-sm">
          {estimate.tokens === undefined
            ? t("center.heartbeat.estimateFirst", { count: estimate.checks })
            : t("center.heartbeat.estimate", { count: estimate.checks, tokens: formatCount(estimate.tokens) })}
        </p>
      </section>

      <HeartbeatMore
        answer={answer}
        change={change}
        changeFrom={changeFrom}
        apply={apply}
        configRef={configRef}
        builtin={builtin}
        selected={selected}
        panelSlot={panelSlot}
        confirmForget={confirmForget}
        setConfirmForget={setConfirmForget}
        setFailure={setFailure}
        setNote={setNote}
        onChanged={onChanged}
        load={load}
      />

      <section aria-labelledby={`${ids}-log`}>
        <h2 className="center-subhead" id={`${ids}-log`}>
          {t("center.heartbeat.logHeading")}
        </h2>
        <Failure message={logError === undefined ? undefined : t("center.heartbeat.logUnreadable", { error: logError })} alert={false} />
        <label>
          <span className="visually-hidden">{t("center.heartbeat.show")}</span>
          <Select aria-label={t("center.heartbeat.show")} value={filter} onChange={(event) => setFilter(event.target.value as LogFilter)}>
            {LOG_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </Select>
        </label>
        {logError !== undefined ? null : shown.length === 0 ? (
          <p className="muted">{ticks.length === 0 ? t("center.heartbeat.noChecks") : t("center.heartbeat.nothingMatches")}</p>
        ) : (
          <ol className="heartbeat-log list-reset">
            {shown.map((tick) => (
              <li key={tick.tickId}>
                <time dateTime={tick.createdAt} className="meta-sm">
                  {localTime(tick.createdAt, timezone)}
                </time>{" "}
                {logLine(tick)}
                {tick.tokens === 0 ? null : (
                  <span className="meta-sm">
                    {" · "}
                    {t("center.heartbeat.tickTokens", { tokens: formatCount(tick.tokens) })}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

/** Why the heartbeat is paused, and until when, in one sentence. */
function pausedNotice(t: Translate<UiKey>, reason: string, until: string | undefined): string {
  const keys: Readonly<Record<"user" | "budget" | "failures" | "provider", readonly [UiKey, UiKey]>> = {
    user: ["center.heartbeat.pausedByUser", "center.heartbeat.pausedByUserUntil"],
    budget: ["center.heartbeat.pausedBudget", "center.heartbeat.pausedBudgetUntil"],
    failures: ["center.heartbeat.pausedFailures", "center.heartbeat.pausedFailuresUntil"],
    provider: ["center.heartbeat.pausedProvider", "center.heartbeat.pausedProviderUntil"],
  };
  const [plain, timed] = keys[reason === "user" || reason === "budget" || reason === "failures" ? reason : "provider"];
  return until === undefined ? t(plain) : t(timed, { when: until });
}
