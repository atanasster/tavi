import { formatBrowserDuration, type BrowserSessionView, type CenterSummaryAnswer } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { AppLink } from "../shell/AppLink.js";
import { LIVE_POLL_MS, MINUTE_TICK_MS, useNow } from "../../hooks/use-poll.js";
import { useOpenError } from "../../hooks/use-action.js";
import { useLazyLoad } from "../../hooks/use-loaded.js";
import { useNearViewport } from "../../hooks/use-near-viewport.js";
import { taskPath } from "../shell/route.js";
import type { Outcome, SettingsClient } from "../../lib/ipc.js";
import { appendPage, refreshFirstPage, useOlderPage, type Paged } from "../../lib/paging.js";
import { Disclosure, Failure, LoadMore, LoadState, PageHead } from "../../ui/Parts.js";
import { listBrowserSessions, loadBrowserVisits, readThumbnail } from "./browser-api.js";
import { useThrottledRevision } from "./feed.js";
import { useCloseBrowser } from "./use-close-browser.js";
import { useTakeover } from "../takeover/context.js";
import { CENTER_LIVE_TILES, LiveTile, useCenterBrowserSlot } from "../plugin-host/CenterBrowserSlot.js";
import { personName } from "./model.js";
import { localDate, localTime, nearDay, shortDay, todayIn } from "../../lib/time.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * Browser: one card per browser session a
 * task opened in the last 30 days — the live ones under "Open now", the rest
 * under "Earlier", newest first. A card shows the last page's thumbnail (or
 * its host's first letter), the task, the host and page title, and how many
 * pages for how long; expanding it lists the visits. Opening it opens the
 * task at the call that started the session, when the owner recorded it. URLs are as stored: host and
 * path, never a query string.
 */

/** The fewest milliseconds between two reads of the lists while the agent browses. */
export const BROWSER_REFRESH_MS = LIVE_POLL_MS;
/** How often a live card's duration moves. */
export const BROWSER_TICK_MS = MINUTE_TICK_MS;
/** Thumbnails kept in memory, by artifact id (a new capture is a new id, so one never goes stale). */
const THUMBNAIL_CACHE_MAX = 120;

// ---- Pure helpers ---------------------------------------------------------------

/** A stored URL as a visit line shows it: host and path ("example.com/docs/guide"); anything else as stored. */
export function hostPath(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return `${parsed.host}${parsed.pathname}`;
  } catch {
    // Not a URL this browser parses: shown as stored.
  }
  return url;
}

/** The letter a card without a thumbnail shows: the host's first, past a leading `www.`. */
export function hostLetter(host: string | null): string {
  const name = (host ?? "").replace(/^www\./i, "");
  const letter = [...name].find((character) => /\p{L}|\p{N}/u.test(character));
  return letter === undefined ? "?" : letter.toUpperCase();
}

const sessionKey = (item: BrowserSessionView): string => item.sessionId;
const openedAt = (item: BrowserSessionView): string => item.openedAt;

// ---- Thumbnails -----------------------------------------------------------------

const thumbnails = new Map<string, Promise<Outcome<string>>>();

/** Forget every cached thumbnail (a test's fresh start). */
export function clearThumbnailCache(): void {
  thumbnails.clear();
}

/** A thumbnail's `data:` URL, read once per workspace and artifact; a failed read is not kept. */
function cachedThumbnail(client: SettingsClient, workspaceId: string, artifactId: string): Promise<Outcome<string>> {
  const key = `${workspaceId}\u0000${artifactId}`;
  const held = thumbnails.get(key);
  if (held !== undefined) {
    // Most recently used last, so the oldest is the one dropped.
    thumbnails.delete(key);
    thumbnails.set(key, held);
    return held;
  }
  const reading = readThumbnail(client, workspaceId, artifactId).then((outcome) => {
    if (!outcome.ok) thumbnails.delete(key);
    return outcome;
  });
  thumbnails.set(key, reading);
  while (thumbnails.size > THUMBNAIL_CACHE_MAX) {
    const oldest = thumbnails.keys().next().value;
    if (oldest === undefined) break;
    thumbnails.delete(oldest);
  }
  return reading;
}

/**
 * The card's image: read when the card first comes near the viewport (at once
 * where there is no `IntersectionObserver`), and the host's letter until then,
 * without one, or when the read fails. A new capture keeps the old image up
 * until it has loaded.
 */
function Thumbnail({ artifactId, host }: { readonly artifactId: string | undefined; readonly host: string | null }) {
  const { client, workspaceId } = useWorkspace();
  const [src, setSrc] = useState<string>();
  const [near, frame] = useNearViewport<HTMLDivElement>();
  useEffect(() => {
    if (artifactId === undefined) {
      setSrc(undefined);
      return;
    }
    if (!near) return;
    let alive = true;
    void cachedThumbnail(client, workspaceId, artifactId).then((outcome) => {
      if (!alive) return;
      if (outcome.ok) setSrc(outcome.value);
      else setSrc(undefined);
    });
    return () => {
      alive = false;
    };
  }, [client, workspaceId, artifactId, near]);
  return (
    <div className="browser-thumb-image" ref={frame}>
      {src === undefined ? (
        <span className="browser-letter" aria-hidden="true">
          {hostLetter(host)}
        </span>
      ) : (
        <img src={src} alt="" loading="lazy" decoding="async" />
      )}
    </div>
  );
}

// ---- The section ----------------------------------------------------------------

export function Browser({
  summary,
  revision,
  onOpenTask,
}: {
  /** The zone, today and people's names. */
  readonly summary: CenterSummaryAnswer | undefined;
  /** Moves when the feed reports `browser`; the lists are read again at most every `BROWSER_REFRESH_MS`. */
  readonly revision: number;
  /** Open a card's task, at the call that opened its session when the owner recorded it. */
  readonly onOpenTask: (taskId: string, openedByCallId: string | undefined) => Promise<void>;
}) {
  const { client, workspaceId } = useWorkspace();
  const throttled = useThrottledRevision(revision, BROWSER_REFRESH_MS);
  /** The newest live sessions, when they were read, and whether more are open than one read lists. */
  const [live, setLive] = useState<{ readonly items: readonly BrowserSessionView[]; readonly at: number; readonly truncated: boolean }>();
  const [earlier, setEarlier] = useState<Paged<BrowserSessionView>>();
  const [error, setError] = useState<string>();
  const { openError, open: follow } = useOpenError();
  const [attempt, setAttempt] = useState(0);
  /** The read whose answers count; an older one's are dropped. */
  const generation = useRef(0);
  const older = useOlderPage(generation);

  useEffect(() => {
    const current = ++generation.current;
    void Promise.all([
      listBrowserSessions(client, workspaceId, { open: true }),
      listBrowserSessions(client, workspaceId, { open: false }),
    ]).then(([open, closed]) => {
      if (current !== generation.current) return;
      const failed = [open, closed].find((outcome) => !outcome.ok);
      setError(failed === undefined || failed.ok ? undefined : failed.message);
      if (open.ok) setLive({ items: open.value.items, at: Date.now(), truncated: open.value.nextCursor !== undefined });
      if (closed.ok) setEarlier((held) => refreshFirstPage(held, closed.value, sessionKey, openedAt));
    });
  }, [client, workspaceId, throttled, attempt]);

  const loadOlder = (): void =>
    older.load(
      earlier?.nextCursor,
      (cursor) => listBrowserSessions(client, workspaceId, { open: false, cursor }),
      (page) => setEarlier((held) => appendPage(held, page, sessionKey)),
      setError,
    );

  const now = useNow(BROWSER_TICK_MS, (live?.items.length ?? 0) > 0);
  const timeZone = summary?.timezone;
  const today = summary?.today ?? todayIn(timeZone, now);
  const people = summary?.people ?? {};
  const closed = earlier?.items ?? [];
  // A session that closed between the two reads is shown once, as closed.
  const closedIds = new Set(closed.map((item) => item.sessionId));
  const open = (live?.items ?? []).filter((item) => !closedIds.has(item.sessionId));
  const loaded = live !== undefined && earlier !== undefined;
  // More sessions open than one read lists: the summary counts the live ones (not those whose task ended).
  const moreLive =
    live?.truncated === true ? Math.max(0, (summary?.counts.liveBrowserSessions ?? 0) - open.filter((item) => item.live).length) : 0;

  const openTask = (item: BrowserSessionView): void => follow(`Task ${item.taskId}`, () => onOpenTask(item.taskId, item.openedByCallId));
  const slot = useCenterBrowserSlot();
  // A live tile on the newest live cards only: each is a watch on the connection every tab shares.
  const tiles = new Set(
    slot === undefined
      ? []
      : (live?.items ?? [])
          .filter((item) => item.live)
          .slice(0, CENTER_LIVE_TILES)
          .map((item) => item.sessionId),
  );
  const card = (item: BrowserSessionView) => (
    <BrowserCard
      key={item.sessionId}
      item={item}
      tile={
        slot !== undefined && tiles.has(item.sessionId) ? (
          <LiveTile slot={slot} taskId={item.taskId} sessionId={item.sessionId} />
        ) : undefined
      }
      timeZone={timeZone}
      today={today}
      // A live card's duration grows from the owner's figure by the time since it was read.
      durationMs={item.live && live !== undefined ? item.durationMs + Math.max(0, now - live.at) : item.durationMs}
      person={personName(people, item.principalId)}
      onOpen={() => openTask(item)}
    />
  );

  return (
    <section className="center-section" aria-labelledby="center-browser-title">
      <PageHead
        className="center-head"
        id="center-browser-title"
        title="Browser"
        description="Sites the agent has open or visited, by task. Kept 30 days; addresses are stored without query strings."
      />
      <LoadState
        error={error}
        reload={() => setAttempt((value) => value + 1)}
        loading={!loaded && error === undefined}
        label="Loading browser history…"
        status
      >
        <Failure message={openError} alert={false} />
      </LoadState>
      {loaded && open.length === 0 && closed.length === 0 ? (
        <div className="empty-state">
          <p>Nothing browsed in the last 30 days.</p>
        </div>
      ) : null}
      {open.length === 0 ? null : (
        <section className="browser-group" aria-labelledby="browser-open-title">
          <h2 id="browser-open-title" className="center-day-head">
            Open now<span>{open.filter((item) => item.live).length} live</span>
          </h2>
          <ul className="browser-grid list-reset">{open.map(card)}</ul>
          {live?.truncated === true ? (
            <p className="muted browser-more">
              {moreLive > 0 ? `And ${moreLive} more live` : "More are open"}; the newest {open.length} are shown.
            </p>
          ) : null}
        </section>
      )}
      {closed.length === 0 ? null : (
        <section className="browser-group" aria-labelledby="browser-earlier-title">
          <h2 id="browser-earlier-title" className="center-day-head">
            Earlier
          </h2>
          <ul className="browser-grid list-reset">{closed.map(card)}</ul>
        </section>
      )}
      {earlier?.nextCursor === undefined ? null : <LoadMore busy={older.busy} onLoad={loadOlder} />}
    </section>
  );
}

function BrowserCard({
  item,
  tile,
  timeZone,
  today,
  durationMs,
  person,
  onOpen,
}: {
  readonly item: BrowserSessionView;
  /** The live tile shown in place of the thumbnail (`center.browser`), outside the card's link. */
  readonly tile?: ReactNode;
  readonly timeZone: string | undefined;
  readonly today: string;
  readonly durationMs: number;
  readonly person: string | undefined;
  readonly onOpen: () => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const { state: closeState, failure: closeError, close } = useCloseBrowser(client, workspaceId, item.sessionId);
  const takeover = useTakeover();
  const closed = closeState === "closed";
  const title = item.taskTitle ?? `Task ${item.taskId}`;
  const page = [item.host ?? (item.lastUrl === null ? "No page yet" : hostPath(item.lastUrl)), item.lastTitle]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");
  const pages = plural(item.pages, "page");
  const duration = item.live
    ? formatBrowserDuration(durationMs)
    : `${nearDay(localDate(item.openedAt, timeZone), today, "past")} · ${formatBrowserDuration(durationMs)}`;
  const pill = item.live ? (
    <span className="browser-live">
      <span className="center-pulse" aria-hidden="true" />
      Live
    </span>
  ) : null;
  return (
    <li className={item.live ? "browser-card card-flat live" : "browser-card card-flat"}>
      {tile === undefined ? null : (
        <div className="browser-thumb browser-thumb-live">
          {tile}
          {pill}
        </div>
      )}
      <AppLink className="browser-card-open" href={taskPath(item.taskId)} onFollow={onOpen}>
        {tile !== undefined ? null : (
          <div className="browser-thumb">
            <Thumbnail artifactId={item.thumbnail?.artifactId} host={item.host} />
            {item.live ? pill : item.inactive === true && !closed ? <span className="browser-live browser-ended">Ended</span> : null}
          </div>
        )}
        <span className="browser-card-body">
          <span className="browser-card-title">{title}</span>
          <span className="browser-card-page meta-base truncate">{page}</span>
        </span>
      </AppLink>
      <div className="browser-card-meta">
        <span>
          {pages} · {duration}
        </span>
        {person === undefined ? null : <span>{person}</span>}
        {/* A live session can be taken over from here: the host's own control. So can one its task's finished turn kept. */}
        {(item.live || (item.inactive === true && !closed)) && takeover !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => takeover.open({ taskId: item.taskId, sessionId: item.sessionId, ...(item.live ? {} : { kept: true as const }) })}
          >
            Take control
          </Button>
        ) : null}
        {/* Its task ended; the session is kept open (a browser in memory) until closed. */}
        {item.inactive === true && !closed ? (
          <Button variant="ghost" size="sm" disabled={closeState === "closing"} onClick={() => void close()}>
            {closeState === "closing" ? "Closing…" : "Close browser"}
          </Button>
        ) : null}
        {closeError === undefined ? null : <Failure as="span">{closeError}</Failure>}
      </div>
      <Visits key={item.sessionId} sessionId={item.sessionId} pages={item.pages} openedAt={item.openedAt} timeZone={timeZone} />
    </li>
  );
}

/**
 * A card's visits, read from the owner when first expanded, and again when
 * the session's page count moves while they are shown.
 */
function Visits({
  sessionId,
  pages,
  openedAt,
  timeZone,
}: {
  readonly sessionId: string;
  readonly pages: number;
  readonly openedAt: string;
  readonly timeZone: string | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const { open, loaded, error, loading, load, toggle } = useLazyLoad(() => loadBrowserVisits(client, workspaceId, sessionId), pages);
  if (pages === 0) return null;
  const day = localDate(openedAt, timeZone);
  return (
    <Disclosure
      className="browser-visits"
      id={`browser-visits-${sessionId}`}
      label={open ? "Hide visits" : "Show visits"}
      open={open}
      onToggle={toggle}
      loading={loading}
      loadingLabel="Loading visits…"
      error={error}
      reload={load}
    >
      {loaded === undefined ? null : (
        <ol className="browser-visits-list">
          {loaded.items.map((visit) => {
            const on = localDate(visit.at, timeZone);
            const where = hostPath(visit.url);
            return (
              <li key={visit.seq}>
                <time dateTime={visit.at}>
                  {on === day ? localTime(visit.at, timeZone) : `${shortDay(on)} ${localTime(visit.at, timeZone)}`}
                </time>
                <span className="truncate" title={visit.title === null ? where : `${where} — ${visit.title}`}>
                  {where}
                </span>
              </li>
            );
          })}
          {loaded.nextCursor === undefined ? null : <li className="muted">Later visits are in the chat.</li>}
        </ol>
      )}
    </Disclosure>
  );
}
