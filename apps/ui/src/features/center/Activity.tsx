import type { AgentTreeNode, CenterSummaryAnswer, TaskListRow } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useSearchQuery } from "../../hooks/page.js";
import { useOpenError } from "../../hooks/use-action.js";
import { useLazyLoad, useSerialRead } from "../../hooks/use-loaded.js";
import { IconButton } from "../../ui/IconButton.js";
import { appendPage, refreshFirstPage, useOlderPage, type Paged } from "../../lib/paging.js";
import { Disclosure, Failure, FilterChip, LoadMore, LoadState, Notice, PageHead, PersonChips, SearchField } from "../../ui/Parts.js";
import { loadAgentTree, useSettledRevision, workerLabel } from "../workers/WorkerView.js";
import { listActivity, loadTaskPrompts, type ActivityFilters } from "./api.js";
import { ChannelIcon, useChannelNames } from "../shell/ChannelNames.js";
import {
  followUpsLabel,
  manyPeople,
  personName,
  previewText,
  ROW_MARK_LABELS,
  rowMark,
  rowTitle,
  SOURCE_LABELS,
  sourceChip,
  sourceLabel,
  sourceOf,
  tasksInWindow,
  tasksToday,
  type SourceKind,
} from "./model.js";
import { dayEnd, dayHeading, groupByDay, instantLabel, localDate, localTime, shortDay, todayIn } from "../../lib/time.js";
import { Empty, EmptyState } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";
import { ACTIVITY_BAR_MIN_PERCENT } from "../../lib/layout.js";
import { useWorkspace } from "../shell/Workspace.js";
import { formatCount } from "../../lib/format.js";
import { currentLocale, useT } from "../../lib/i18n.js";
import { withParts } from "../../ui/with-parts.js";

/**
 * What the owner is asked for: the search, one person, one source (its
 * channel kind — "Other", rows with no channel, cannot be asked for, so the
 * page filters those itself), and the day to list back from.
 */
function activityFilters(
  query: string,
  principalId: string | undefined,
  origin: SourceKind | "all",
  from: string | undefined,
  timeZone: string | undefined,
): ActivityFilters {
  return {
    query,
    ...(principalId === undefined ? {} : { principalId }),
    ...(origin === "all" || origin === "other" ? {} : { channelKinds: [origin] }),
    ...(from === undefined ? {} : { until: dayEnd(from, timeZone) }),
  };
}

const taskKey = (row: TaskListRow): string => row.taskId;
const askedAt = (row: TaskListRow): string => row.createdAt;

/**
 * Activity: every top-level task, newest
 * first, grouped under the day it was asked in the workspace zone. Delegated
 * workers are counted on their root's row, listed only when that count is
 * expanded, each opening its view-only transcript. Opening a row opens the
 * task in Chat. The search, the source and the person are asked of the owner,
 * so a page holds only what matches; a day strip bar for a day not loaded
 * lists back from that day.
 */
export function Activity({
  summary,
  revision,
  onOpen,
  onOpenWithPanel,
  onOpenWorker,
}: {
  /** The feed's summary: the zone, today, the day strip and people's names. */
  readonly summary: CenterSummaryAnswer | undefined;
  /** Moves when the feed reports `task`: the first page is read again. */
  readonly revision: number;
  readonly onOpen: (taskId: string) => Promise<void>;
  /** Open the task in the chat with its panel open; absent, rows offer only Open. */
  readonly onOpenWithPanel?: ((taskId: string) => Promise<void>) | undefined;
  /** Open a delegated worker's view-only transcript beside its root chat; absent, the list only names them. */
  readonly onOpenWorker?: ((rootTaskId: string, worker: { readonly taskId: string; readonly label: string }) => Promise<void>) | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const channels = useChannelNames();
  const [search, setSearch] = useState("");
  const query = useSearchQuery(search);
  const [listed, setListed] = useState<Paged<TaskListRow>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const { openError, open } = useOpenError();
  const [origin, setOrigin] = useState<SourceKind | "all">("all");
  const [person, setPerson] = useState<string>("all");
  /** The day the list reads back from (a strip bar for a day not loaded), or the newest. */
  const [from, setFrom] = useState<string>();
  /** A day whose group the page scrolls to once it is listed, and the read it waits for (a generation after `after`). */
  const jump = useRef<{ readonly day: string; readonly after: number } | undefined>(undefined);
  /** Every source a listed row carried: its chip stays while another source filters the list. */
  const [sources, setSources] = useState<ReadonlySet<SourceKind>>(new Set());
  const [attempt, setAttempt] = useState(0);
  /** The read whose answer counts; an older one's answer is dropped. */
  const generation = useRef(0);
  const older = useOlderPage(generation);
  /** The filters the held rows answer, so a refresh knows it may lay a page over them. */
  const heldQuery = useRef<string | undefined>(undefined);

  const timeZone = summary?.timezone;
  const people = summary?.people ?? {};
  const many = manyPeople(people);
  const principalId = many && person !== "all" ? person : undefined;
  const filters = activityFilters(query, principalId, origin, from, timeZone);

  const seeSources = (rows: readonly TaskListRow[]): void =>
    setSources((held) => {
      const fresh = rows.map(sourceOf).filter((kind) => !held.has(kind));
      return fresh.length === 0 ? held : new Set([...held, ...fresh]);
    });

  useEffect(() => {
    const current = ++generation.current;
    const asked = activityFilters(query, principalId, origin, from, timeZone);
    const key = JSON.stringify(asked);
    setLoading(true);
    void listActivity(client, workspaceId, asked).then((outcome) => {
      if (current !== generation.current) return;
      setLoading(false);
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      setError(undefined);
      const same = heldQuery.current === key;
      heldQuery.current = key;
      seeSources(outcome.value.rows);
      setListed((held) =>
        refreshFirstPage(same ? held : undefined, { items: outcome.value.rows, nextCursor: outcome.value.nextCursor }, taskKey, askedAt),
      );
    });
  }, [client, workspaceId, query, principalId, origin, from, timeZone, revision, attempt]);

  // A day picked on the strip is scrolled to once its group is on the page;
  // a read for it that answers without it (no task matches there) ends the wait.
  useEffect(() => {
    const pending = jump.current;
    if (pending === undefined || listed === undefined) return;
    const group = document.getElementById(`center-day-${pending.day}`);
    if (group !== null) {
      jump.current = undefined;
      group.scrollIntoView?.({ block: "start" });
      return;
    }
    if (!loading && generation.current > pending.after) jump.current = undefined;
  }, [listed, loading]);
  // Another search, source or person is another list: a day asked for before is not waited for.
  useEffect(() => {
    jump.current = undefined;
  }, [query, origin, person]);

  const loadOlder = (): void =>
    older.load(
      listed?.nextCursor,
      (cursor) => listActivity(client, workspaceId, { ...filters, cursor }),
      (page) => {
        setError(undefined);
        seeSources(page.rows);
        setListed((held) => appendPage(held, { items: page.rows, nextCursor: page.nextCursor }, taskKey));
      },
      setError,
    );

  const today = summary?.today ?? todayIn(timeZone);
  const rows = listed?.items ?? [];
  // Chips for every source a listed row carried, in one fixed order — the named sources first, then any
  // other channel's in name order — so picking one does not take the others away.
  const origins = useMemo(() => {
    const named = Object.keys(SOURCE_LABELS).filter((kind) => sources.has(kind));
    const frontEnds: readonly string[] = named.filter((kind) => kind === "web" || kind === "terminal");
    // Each channel by its name, after the front ends.
    const channelKinds = [...sources]
      .filter((kind) => !(kind in SOURCE_LABELS))
      .sort((left, right) => sourceLabel(left, channels.label).localeCompare(sourceLabel(right, channels.label), currentLocale()));
    return [...frontEnds, ...channelKinds, ...named.filter((kind) => !frontEnds.includes(kind))];
  }, [sources, channels]);
  // The picked source keeps its chip while it filters, even once no loaded row carries it.
  const originChips = origin === "all" || origins.includes(origin) ? origins : [...origins, origin];
  // The owner filtered by source and person; "Other", which it cannot be asked for, is filtered here.
  const shown = rows.filter(
    (row) => (origin === "all" || sourceOf(row) === origin) && (!many || person === "all" || row.principalId === person),
  );
  const days = groupByDay(shown, (row) => row.createdAt, timeZone);
  const filtered = origin !== "all" || (many && person !== "all") || query !== "";
  /** A strip bar: its group when listed, else the list read back from that day (today: the newest again). */
  const pickDay = (date: string): void => {
    if (days.some((day) => day.date === date)) {
      document.getElementById(`center-day-${date}`)?.scrollIntoView?.({ block: "start" });
      return;
    }
    const next = date === today ? undefined : date;
    // Today, already listing the newest: there is nothing more to read.
    if (next === from) return;
    jump.current = { day: date, after: generation.current };
    setFrom(next);
  };

  return (
    <section className="center-section" aria-labelledby="center-activity-title">
      <PageHead
        className="center-head"
        id="center-activity-title"
        title={t("center.activity.title")}
        description={t("center.activity.description")}
      >
        <SearchField
          value={search}
          placeholder={t("center.activity.searchPlaceholder")}
          label={t("center.activity.searchLabel")}
          onChange={setSearch}
        />
      </PageHead>

      {summary?.health === undefined ? null : (
        // The owner's own sustained growth (memory, open files, child processes): a leak a restart clears.
        <Notice as="div" className="center-health" role="status">
          {summary.health.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </Notice>
      )}
      {summary === undefined ? null : <DayStrip summary={summary} loaded={new Set(days.map((day) => day.date))} onPick={pickDay} />}
      {from === undefined ? null : (
        <Notice className="center-from" role="status">
          {t("center.activity.showingFrom", { day: shortDay(from, today) })}{" "}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              jump.current = undefined;
              setFrom(undefined);
            }}
          >
            {t("center.activity.backToNewest")}
          </Button>
        </Notice>
      )}

      {origin !== "all" || origins.length > 1 ? (
        <div className="center-chips" role="group" aria-label={t("center.activity.filterBySource")}>
          <FilterChip pressed={origin === "all"} onPick={() => setOrigin("all")}>
            {t("center.activity.allSources")}
          </FilterChip>
          {originChips.map((group) => (
            <FilterChip key={group} pressed={origin === group} onPick={() => setOrigin(group)}>
              {sourceLabel(group, channels.label)}
            </FilterChip>
          ))}
        </div>
      ) : null}
      {many ? <PersonChips people={people} person={person} onPick={setPerson} /> : null}

      <LoadState
        error={error}
        reload={() => setAttempt((value) => value + 1)}
        loading={loading && listed === undefined}
        label={t("center.activity.loading")}
        status
      >
        <Failure message={openError} alert={false} />
      </LoadState>

      {listed !== undefined && rows.length === 0 && !filtered && from === undefined ? (
        <EmptyState title={t("center.activity.emptyTitle")}>
          <p>{t("center.activity.emptyBody")}</p>
        </EmptyState>
      ) : null}
      {listed !== undefined && days.length === 0 && filtered ? (
        <Empty>{t("center.activity.noMatch")}</Empty>
      ) : listed !== undefined && days.length === 0 && from !== undefined ? (
        <Empty>{t("center.activity.noneBefore", { day: shortDay(from, today) })}</Empty>
      ) : null}

      {days.map((day) => {
        const heading = dayHeading(day.date, today);
        return (
          <section key={day.date} className="center-day" id={`center-day-${day.date}`} aria-label={`${heading.title}, ${heading.detail}`}>
            <h2 className="center-day-head">
              {heading.title}
              <span>{t("center.activity.dayDetail", { detail: heading.detail, count: day.items.length })}</span>
            </h2>
            <ul className="center-rows list-reset">
              {day.items.map((row) => (
                <ActivityRow
                  key={row.taskId}
                  row={row}
                  timeZone={timeZone}
                  person={personName(people, row.principalId)}
                  onOpen={() => open(t("center.activity.openTask", { id: row.taskId }), () => onOpen(row.taskId))}
                  onOpenWithPanel={
                    onOpenWithPanel === undefined
                      ? undefined
                      : () => open(t("center.activity.openTask", { id: row.taskId }), () => onOpenWithPanel(row.taskId))
                  }
                  revision={revision}
                  onOpenWorker={
                    onOpenWorker === undefined
                      ? undefined
                      : (worker) => open(t("center.activity.openWorker", { label: worker.label }), () => onOpenWorker(row.taskId, worker))
                  }
                />
              ))}
            </ul>
          </section>
        );
      })}

      {listed?.nextCursor === undefined ? null : <LoadMore busy={older.busy} onLoad={loadOlder} />}
    </section>
  );
}

/**
 * Turns per day over the summary's window (a day's work is its turns),
 * bars scaled to the busiest day.
 * A bar jumps to its day's group, loading that day first when the list does
 * not hold it.
 */
function DayStrip({
  summary,
  loaded,
  onPick,
}: {
  readonly summary: CenterSummaryAnswer;
  readonly loaded: ReadonlySet<string>;
  readonly onPick: (date: string) => void;
}) {
  const t = useT();
  const max = Math.max(1, ...summary.perDay.map((day) => day.tasks));
  const total = tasksInWindow(summary);
  const todays = tasksToday(summary);
  const columns = { "--center-days": summary.perDay.length } as CSSProperties;
  return (
    <div className="center-strip-card card-flat">
      <div className="center-strip-cap">
        <span>{t("center.activity.stripTitle", { count: summary.perDay.length })}</span>
        <span>
          {withParts(t("center.activity.stripTotals", { count: total }), {
            total: <b>{formatCount(total)}</b>,
            today: <b>{formatCount(todays)}</b>,
          })}
        </span>
      </div>
      <div className="center-strip" style={columns}>
        {summary.perDay.map((day) => {
          const label = t("center.activity.stripDay", { count: day.tasks, day: shortDay(day.date, summary.today) });
          return (
            <Button
              key={day.date}
              variant="bare"
              className={[day.date === summary.today ? "today" : "", day.tasks === 0 ? "none" : ""].filter(Boolean).join(" ")}
              style={day.tasks === 0 ? undefined : { height: `${Math.max(ACTIVITY_BAR_MIN_PERCENT, (day.tasks / max) * 100)}%` }}
              aria-label={loaded.has(day.date) ? label : t("center.activity.stripDayLoads", { label })}
              title={label}
              onClick={() => onPick(day.date)}
            />
          );
        })}
      </div>
      <div className="center-strip-axis" style={columns} aria-hidden="true">
        {summary.perDay.map((day) => (
          <span key={day.date}>{Number(day.date.slice(8))}</span>
        ))}
      </div>
    </div>
  );
}

function ActivityRow({
  row,
  timeZone,
  person,
  onOpen,
  onOpenWithPanel,
  revision,
  onOpenWorker,
}: {
  readonly row: TaskListRow;
  readonly timeZone: string | undefined;
  readonly person: string | undefined;
  readonly onOpen: () => void;
  readonly onOpenWithPanel?: (() => void) | undefined;
  readonly revision: number;
  readonly onOpenWorker?: ((worker: { readonly taskId: string; readonly label: string }) => void) | undefined;
}) {
  const t = useT();
  const channels = useChannelNames();
  const source = sourceChip(row, channels.label);
  const mark = rowMark(row);
  const tools = row.counts.tools;
  const followUps = followUpsLabel(row.followUps);
  const detail = previewText(row.summary || row.lastText || "");
  return (
    <li>
      <div className="center-row-wrap">
        <Button variant="bare" className={onOpenWithPanel === undefined ? "center-row" : "center-row with-panel"} onClick={onOpen}>
          <time dateTime={row.createdAt}>{localTime(row.createdAt, timeZone)}</time>
          <span className="center-row-main">
            <span className="center-row-title">{rowTitle(row)}</span>
            {detail ? <span className="center-row-text meta-base truncate">{detail}</span> : null}
            <span className="center-row-meta">
              <span
                className={
                  channels.descriptor(source.kind) === undefined
                    ? `center-origin center-origin-${source.kind}`
                    : "center-origin center-origin-channel"
                }
                title={source.title}
              >
                <ChannelIcon providerId={source.kind} />
                {source.text}
              </span>
              {person === undefined ? null : <span>{person}</span>}
              {tools === null || tools === 0 ? null : <span>{t("center.activity.toolCalls", { count: tools })}</span>}
            </span>
          </span>
          <span className={`center-mark center-mark-${mark}`}>
            {mark === "working" ? <span className="center-pulse" aria-hidden="true" /> : null}
            {ROW_MARK_LABELS[mark]}
          </span>
        </Button>
        {onOpenWithPanel === undefined ? null : (
          <IconButton
            icon="panel-right-open"
            size="sm"
            label={t("center.activity.openWithPanelLabel", { title: rowTitle(row) })}
            tooltip={t("center.activity.openWithPanel")}
            onClick={onOpenWithPanel}
          />
        )}
      </div>
      {followUps === undefined ? null : (
        <FollowUps
          key={row.taskId}
          taskId={row.taskId}
          count={row.followUps ?? 0}
          label={followUps}
          createdAt={row.createdAt}
          timeZone={timeZone}
        />
      )}
      {row.delegated !== undefined && row.delegated > 0 ? (
        <Delegated
          key={`${row.taskId}:delegated`}
          taskId={row.taskId}
          count={row.delegated}
          revision={revision}
          onOpenWorker={onOpenWorker}
        />
      ) : null}
    </li>
  );
}

/**
 * A row's follow-up prompts, read from the owner only when first expanded
 * (`tasks prompts`): each with its time, and its day when that is not the
 * day the task was asked. A live refresh that changes the count keeps the
 * list open and reads it again; a closed list is read when next opened.
 */
function FollowUps({
  taskId,
  count,
  label,
  createdAt,
  timeZone,
}: {
  readonly taskId: string;
  readonly count: number;
  readonly label: string;
  readonly createdAt: string;
  readonly timeZone: string | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const { open, loaded, error, loading, load, toggle } = useLazyLoad(() => loadTaskPrompts(client, workspaceId, taskId), count);
  const day = localDate(createdAt, timeZone);
  return (
    <Disclosure
      className="center-followups"
      id={`center-followups-${taskId}`}
      label={label}
      open={open}
      onToggle={toggle}
      loading={loading}
      loadingLabel={t("center.activity.loadingFollowUps")}
      error={error}
      reload={load}
    >
      {loaded === undefined ? null : (
        <ol className="center-followups-list">
          {loaded.items.map((item, index) => (
            <li key={`${item.at}-${index}`}>
              <time dateTime={item.at}>{instantLabel(item.at, timeZone, day)}</time>
              <span>{item.text}</span>
            </li>
          ))}
          {loaded.truncated ? <li className="muted">{t("center.activity.laterFollowUps")}</li> : null}
        </ol>
      )}
    </Disclosure>
  );
}

/**
 * A row's delegated workers: "+N delegated", expandable into
 * each worker's name and status, read from the owner (`agents tree`) only
 * when first expanded and again while open as the feed reports a task change.
 * Each opens the worker's view-only transcript beside its root chat.
 */
function Delegated({
  taskId,
  count,
  revision,
  onOpenWorker,
}: {
  readonly taskId: string;
  readonly count: number;
  readonly revision: number;
  readonly onOpenWorker?: ((worker: { readonly taskId: string; readonly label: string }) => void) | undefined;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [workers, setWorkers] = useState<readonly AgentTreeNode[]>();
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // The feed's moves of a second are one read; the list asks for names and statuses only.
  const settled = useSettledRevision(revision);
  const serial = useSerialRead();
  useEffect(() => {
    if (!open) return;
    if (!serial.begin()) return;
    let current = true;
    setError(undefined);
    loadAgentTree(client, workspaceId, taskId, false)
      .then((tree) => {
        if (!current) return;
        setWorkers(tree.nodes.filter((node) => node.taskId !== taskId));
        setTruncated(tree.truncated);
      })
      .catch((failure: unknown) => {
        if (current) setError(errorMessage(failure));
      })
      // A read asked for while this one was out runs now.
      .finally(() => serial.end(() => setAttempt((before) => before + 1)));
    return () => {
      current = false;
    };
  }, [client, workspaceId, taskId, open, settled, attempt, serial]);
  return (
    <Disclosure
      className="center-followups center-delegated"
      id={`center-delegated-${taskId}`}
      label={t("center.activity.delegated", { count })}
      open={open}
      onToggle={() => setOpen((before) => !before)}
      loading={workers === undefined && error === undefined}
      loadingLabel={t("center.activity.loadingWorkers")}
      error={error}
      reload={() => setAttempt((before) => before + 1)}
    >
      {workers === undefined ? null : (
        <ul className="center-followups-list">
          {workers.map((node) => {
            const label = workerLabel(node);
            return (
              <li key={node.taskId}>
                <span className="badge">{node.status}</span>
                {onOpenWorker === undefined ? (
                  <span>{label}</span>
                ) : (
                  <Button variant="bare" className="center-delegated-open" onClick={() => onOpenWorker({ taskId: node.taskId, label })}>
                    {label}
                  </Button>
                )}
              </li>
            );
          })}
          {truncated ? <li className="muted">{t("center.activity.moreWorkers")}</li> : null}
        </ul>
      )}
    </Disclosure>
  );
}
