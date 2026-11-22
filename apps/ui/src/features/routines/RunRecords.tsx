import { useState } from "react";

import { approvalChannelLabel, type RoutineLedgerEvent, type RoutineNewsSource } from "@tavi/contracts";

import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { mergeBy } from "../../lib/paging.js";
import { translateNow, useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
import { when } from "../../lib/time.js";
import { Modal } from "../../ui/Modal.js";
import { ActionNote, LoadError, LoadMore, Section, StatusBadge } from "../../ui/Parts.js";
import { useChannelNames } from "../shell/ChannelNames.js";
import { requestList, routineStep, type LedgerDetail } from "./api.js";
import { SourceLink } from "./RunReport.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/** The ledger's page size: a full page means there may be more. */
const EVENTS_PAGE = 100;
type SourcePage = { readonly sources: readonly RoutineNewsSource[]; readonly nextAfterSourceId: string | null };
/** The run's timeline (with retained prompt details) and the evidence it fetched, each paged; read again as `revision` moves. */
export function RunRecords({
  routineId,
  runId,
  revision = 0,
  timeZone,
}: {
  readonly routineId: string;
  /** Moves while the run is live: the first pages are read again in place. */
  readonly revision?: number;
  readonly runId: string;
  readonly timeZone: string | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const t = useT();
  const channels = useChannelNames();
  const timeline = useLoaded(
    () =>
      requestList<{ readonly events: readonly RoutineLedgerEvent[] }>(
        client,
        workspaceId,
        { action: "ledger", routineId, runId, limit: EVENTS_PAGE },
        "events",
        t("routines.records.timelineWhat"),
      ),
    [revision],
    { serial: true },
  );
  const sources = useLoaded(
    () => requestList<SourcePage>(client, workspaceId, { action: "sources", runId }, "sources", t("routines.records.evidenceWhat")),
    [revision],
    { serial: true },
  );
  const [olderEvents, setOlderEvents] = useState<readonly RoutineLedgerEvent[]>([]);
  // Whether the last page read was full: only then can there be more.
  const [moreEvents, setMoreEvents] = useState<boolean>();
  const [moreSources, setMoreSources] = useState<readonly RoutineNewsSource[]>([]);
  const [sourceCursor, setSourceCursor] = useState<string | null>();
  const [detail, setDetail] = useState<LedgerDetail>();
  const { note, tone, run } = useAction(() => {});

  const events = mergeBy([timeline.data?.events, olderEvents], (event) => event.sequence);
  const hasMoreEvents = moreEvents ?? (timeline.data?.events.length ?? 0) >= EVENTS_PAGE;
  const evidence = mergeBy([sources.data?.sources, moreSources], (source) => source.sourceId);
  const nextSource = sourceCursor === undefined ? sources.data?.nextAfterSourceId : sourceCursor;

  const inspect = (detailId: string) =>
    run("detail", () =>
      routineStep<LedgerDetail>(client, workspaceId, { action: "detail", routineId, detailId }, (answer) => {
        setDetail(answer);
        return undefined;
      }),
    );
  const loadEvents = (afterSequence: number) =>
    run("events", () =>
      routineStep<{ readonly events?: readonly RoutineLedgerEvent[] }>(
        client,
        workspaceId,
        { action: "ledger", routineId, runId, afterSequence, limit: EVENTS_PAGE },
        (page) => {
          const next = page.events ?? [];
          setOlderEvents((before) => [...before, ...next]);
          setMoreEvents(next.length >= EVENTS_PAGE);
          return next.length > 0 ? undefined : t("routines.records.noMoreEvents");
        },
      ),
    );
  const loadSources = (afterSourceId: string) =>
    run("sources", () =>
      routineStep<SourcePage>(client, workspaceId, { action: "sources", runId, afterSourceId }, (page) => {
        setMoreSources((before) => [...before, ...(page.sources ?? [])]);
        setSourceCursor(page.nextAfterSourceId);
        return undefined;
      }),
    );

  return (
    <>
      <Section title={t("routines.records.timeline")}>
        {timeline.error ? <LoadError error={timeline.error} reload={timeline.reload} /> : null}
        <ActionNote note={note || undefined} tone={tone} announce={false} />
        {timeline.data !== undefined && events.length === 0 ? <p className="muted">{t("routines.records.nothing")}</p> : null}
        <ol className="item-list list-reset">
          {events.map((event) => (
            <li key={event.sequence} className="item-row">
              <div className="item-main">
                <span className="item-title-text">
                  {event.envelope.step ?? t("routines.records.stepRun")} ·{" "}
                  {checkpointLine(event.envelope, channels.connection) ?? t(EVENT_WORDS[event.envelope.code])}
                </span>
                <span className="item-meta meta-sm">
                  {when(event.at, timeZone)}
                  {(event.envelope.model ?? event.envelope.tool) ? ` · ${event.envelope.model ?? event.envelope.tool}` : ""}
                </span>
              </div>
              {event.detailId ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (event.detailId) void inspect(event.detailId);
                  }}
                >
                  {t("routines.records.inspectDetail", { sequence: String(event.sequence) })}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
        {hasMoreEvents && events.length > 0 ? (
          <LoadMore
            className={null}
            buttonClassName="ghost button-sm"
            busy={false}
            label={t("routines.records.loadMore")}
            onLoad={() => {
              const last = events.at(-1);
              if (last !== undefined) void loadEvents(last.sequence);
            }}
          />
        ) : null}
        {detail ? (
          <Modal title={t("routines.records.detail")} wide onClose={() => setDetail(undefined)}>
            {detail.payload === null ? (
              <p>
                {t("routines.records.detailExpired", {
                  at: detail.prunedAt === null ? t("routines.records.unknownTime") : when(detail.prunedAt, timeZone),
                })}
              </p>
            ) : (
              <pre>{detail.payload}</pre>
            )}
          </Modal>
        ) : null}
      </Section>
      <Section title={t("routines.records.evidence")}>
        {sources.error ? <LoadError error={sources.error} reload={sources.reload} /> : null}
        {sources.data !== undefined && evidence.length === 0 ? <p className="muted">{t("routines.records.noEvidence")}</p> : null}
        <ul className="item-list list-reset">
          {evidence.map((source) => (
            <li key={source.sourceId} className="item-row evidence-row">
              <div className="item-main">
                <span className="item-title-text">
                  <SourceLink url={source.canonicalUrl} label={source.publisher} />
                </span>
                <span className="item-meta meta-sm">
                  {t("routines.records.sourceMeta", {
                    published: when(source.publishedAt, timeZone, t("routines.records.unknown")),
                    fetched: when(source.retrievedAt, timeZone),
                    hash: source.contentHash ?? t("routines.records.notFetched"),
                  })}
                </span>
                {source.prunedAt ? (
                  <span className="item-meta meta-sm">
                    {t("routines.records.evidenceExpired", { at: when(source.prunedAt, timeZone) })}
                  </span>
                ) : (
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable excerpt must take focus so a keyboard can scroll it.
                  <pre tabIndex={0} role="region" aria-label={t("routines.records.excerpt", { publisher: source.publisher })}>
                    {source.excerpt}
                  </pre>
                )}
              </div>
              <StatusBadge status={source.state} />
            </li>
          ))}
        </ul>
        {nextSource ? (
          <LoadMore
            className={null}
            buttonClassName="ghost button-sm"
            busy={false}
            label={t("routines.records.loadSources")}
            onLoad={() => void loadSources(nextSource)}
          />
        ) : null}
      </Section>
    </>
  );
}
/** A run's timeline event, in words: never its machine code. */
const EVENT_WORDS: Readonly<Record<RoutineLedgerEvent["envelope"]["code"], UiKey>> = {
  "model-retired": "routines.event.modelRetired",
  transient: "routines.event.transient",
  "setup-needed": "routines.event.setupNeeded",
  "auto-paused": "routines.event.autoPaused",
  claimed: "routines.event.claimed",
  started: "routines.event.started",
  recovered: "routines.event.recovered",
  completed: "routines.event.completed",
  failed: "routines.event.failed",
  cancelled: "routines.event.cancelled",
  missed: "routines.event.missed",
  overlap: "routines.event.overlap",
  "daily-budget": "routines.event.dailyBudget",
  budget: "routines.event.budget",
  expired: "routines.event.expired",
  credentials: "routines.event.credentials",
  revoked: "routines.event.revoked",
  model: "routines.event.model",
  tool: "routines.event.tool",
  heartbeat: "routines.event.heartbeat",
  published: "routines.event.published",
  delivery: "routines.event.delivery",
  pruned: "routines.event.pruned",
  grant: "routines.event.grant",
  unsupported: "routines.event.unsupported",
  asked: "routines.event.asked",
  answered: "routines.event.answered",
};

/** A checkpoint in the run's timeline, said as its receipt; `undefined` for any other event. */
export function checkpointLine(
  envelope: RoutineLedgerEvent["envelope"],
  connectionName?: (connectionId: string) => string | undefined,
): string | undefined {
  const checkpoint = envelope.checkpoint;
  if (checkpoint === undefined || (envelope.code !== "asked" && envelope.code !== "answered")) return undefined;
  if (envelope.code === "asked")
    return translateNow("routines.checkpoint.asked", { question: checkpoint.question ?? translateNow("routines.checkpoint.aQuestion") });
  const answer = checkpoint.answers?.join(", ") ?? "";
  switch (checkpoint.outcome) {
    case "defaulted":
      return answer === "" ? translateNow("routines.checkpoint.defaultedNone") : translateNow("routines.checkpoint.defaulted", { answer });
    case "undelivered":
      return translateNow("routines.checkpoint.undelivered");
    case "withdrawn":
      return translateNow("routines.checkpoint.withdrawn");
    default:
      if (checkpoint.via === "standing-answer")
        return checkpoint.question === undefined
          ? translateNow("routines.checkpoint.standing", { answer })
          : translateNow("routines.checkpoint.standingQuestion", { answer, question: checkpoint.question });
      return checkpoint.via === undefined
        ? translateNow("routines.checkpoint.answered", { answer })
        : translateNow("routines.checkpoint.answeredVia", { answer, channel: approvalChannelLabel(checkpoint.via, connectionName) });
  }
}
