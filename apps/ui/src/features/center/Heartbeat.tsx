import {
  BUILTIN_HEARTBEAT_PROVIDER_ID,
  HEARTBEAT_TELL_ME,
  formatHeartbeatInterval,
  type HeartbeatGetAnswer,
  type HeartbeatSettingsChange,
} from "@tavi/contracts";

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
import { TELL_LABELS, PAUSES, todaysFigures } from "./heartbeat-options.js";
import { HeartbeatItemCard, type HeartbeatItemView } from "./HeartbeatItem.js";
import { HeartbeatTargets } from "./HeartbeatTargets.js";
import { formatCount } from "../../lib/format.js";
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
        <PageHead className="center-head" id={`${ids}-title`} title="Heartbeat" />
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
        title="Heartbeat"
        description="Checks, inside the hours you allow, whether anything needs you, and tells you only then."
      >
        <div className="heartbeat-actions cluster">
          {/* A switch says its state by its look and its label, not by a button's word that could be an action. */}
          <span className="meta" aria-hidden="true">
            {config.enabled ? "On" : "Off"}
          </span>
          <Button
            variant="bare"
            className="switch"
            role="switch"
            aria-checked={config.enabled}
            aria-label="Heartbeat"
            onClick={() =>
              void apply(
                (at) => changeHeartbeat(client, workspaceId, at, { enabled: !(configRef.current ?? config).enabled }),
                undefined,
              ).then((done) => {
                // Said from what the owner answered: two quick taps say where it ended.
                if (done) setNote(configRef.current?.enabled === true ? "Turned on." : "Turned off.");
              })
            }
          />
          <Button
            size="sm"
            disabled={!config.enabled || paused !== undefined || !answer.hostRunning}
            title={answer.hostRunning ? undefined : "The heartbeat runs in tavi serve"}
            onClick={() =>
              void checkHeartbeatNow(client, workspaceId).then((outcome) => {
                if (!outcome.ok) setFailure(outcome.message);
                else {
                  setFailure(undefined);
                  setNote(outcome.value.status === "started" ? "Checking now." : "A check is running; this one follows it.");
                }
              })
            }
          >
            Check now
          </Button>
          {paused === undefined ? (
            <label className="heartbeat-pause">
              <span className="visually-hidden">Pause</span>
              <Select
                aria-label="Pause"
                value=""
                disabled={answer.state === undefined}
                onChange={(event) => {
                  const choice = PAUSES.find((pause) => pause.value === event.target.value);
                  if (choice !== undefined) void apply(() => pauseHeartbeat(client, workspaceId, choice.forMs), "Paused.");
                }}
              >
                <option value="">Pause…</option>
                {PAUSES.map((pause) => (
                  <option key={pause.value} value={pause.value}>
                    {pause.label}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <Button size="sm" onClick={() => void apply(() => resumeHeartbeat(client, workspaceId), "Resumed.")}>
              Resume
            </Button>
          )}
        </div>
      </PageHead>
      <Failure message={failure} />
      {/* What is shown is the last good read: a read that failed since says so, rather than passing stale figures for live ones. */}
      <Failure message={error === undefined ? undefined : `Could not refresh: ${error}`} alert={false} />
      <StatusNote note={note} />
      {paused === undefined ? null : (
        <Notice>
          Paused (
          {paused.reason === "user"
            ? "by you"
            : paused.reason === "budget"
              ? "today's limit was reached"
              : paused.reason === "failures"
                ? "it failed repeatedly"
                : "its provider is unavailable"}
          ){paused.until === undefined ? "" : ` until ${whenLocal(paused.until, timezone)}`}.
        </Notice>
      )}
      <p className="meta-sm heartbeat-status">
        Last check{" "}
        {logError !== undefined
          ? "unknown"
          : last === undefined
            ? "never"
            : `${localTime(last.createdAt, timezone)} · ${logLine(last).toLowerCase()}`}
        {" · "}next {answer.state?.nextTickAt === undefined ? "none" : localTime(answer.state.nextTickAt, timezone)}
        {" · "}today {figures.checks} checks · {figures.deep} looked deeper · {formatCount(figures.tokens)} tokens ·{" "}
        {figures.usd === null ? "cost unknown" : `$${figures.usd.toFixed(2)}`}
      </p>

      {items.length === 0 && itemsError === undefined ? null : (
        <section aria-labelledby={`${ids}-items`}>
          <h2 className="center-subhead" id={`${ids}-items`}>
            What it told you
          </h2>
          <Failure message={itemsError === undefined ? undefined : `What it told you could not be read: ${itemsError}`} alert={false} />
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
          When and how
        </h2>
        <div className="settings-fields">
          <label>
            How often{" "}
            <Select
              aria-label="How often"
              value={String(config.everyMs)}
              onChange={(event) => void change({ everyMs: Number(event.target.value) })}
            >
              {answer.options.every.map((ms) => (
                <option key={ms} value={String(ms)}>
                  Every {formatHeartbeatInterval(ms)}
                </option>
              ))}
            </Select>
          </label>
          {/* One range on one row: from and to side by side, its zone after them. */}
          <div className="heartbeat-hours" role="group" aria-label="Active hours">
            <label>
              Active from{" "}
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
              to{" "}
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
            <legend>Tell me</legend>
            {HEARTBEAT_TELL_ME.map((mode) => (
              <label key={mode} className="heartbeat-radio">
                <input
                  type="radio"
                  name={`${ids}-tell`}
                  value={mode}
                  checked={config.tellMe === mode}
                  onChange={() => void change({ tellMe: mode })}
                />
                {TELL_LABELS[mode]}
              </label>
            ))}
          </fieldset>
          <HeartbeatTargets
            targets={config.targets}
            onChange={(update, said) => void changeFrom((current) => ({ targets: [...update(current.targets)] }), said)}
          />
        </div>
        <p className="meta-sm">
          Estimated: up to {estimate.checks} checks a day
          {estimate.tokens === undefined ? "" : ` · ~${formatCount(estimate.tokens)} tokens`}
          {ran.length === 0 ? " (tokens are estimated once it has run)" : ""}.
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
          Log
        </h2>
        <Failure message={logError === undefined ? undefined : `The log could not be read: ${logError}`} alert={false} />
        <label>
          <span className="visually-hidden">Show</span>
          <Select aria-label="Show" value={filter} onChange={(event) => setFilter(event.target.value as LogFilter)}>
            {LOG_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        {logError !== undefined ? null : shown.length === 0 ? (
          <p className="muted">{ticks.length === 0 ? "No checks yet." : "Nothing matches."}</p>
        ) : (
          <ol className="heartbeat-log list-reset">
            {shown.map((tick) => (
              <li key={tick.tickId}>
                <time dateTime={tick.createdAt} className="meta-sm">
                  {localTime(tick.createdAt, timezone)}
                </time>{" "}
                {logLine(tick)}
                {tick.tokens === 0 ? null : <span className="meta-sm"> · {formatCount(tick.tokens)} tokens</span>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
