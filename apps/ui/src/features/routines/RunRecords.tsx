import { useState } from "react";

import { approvalChannelLabel, type RoutineLedgerEvent, type RoutineNewsSource } from "@tavi/contracts";

import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { mergeBy } from "../../lib/paging.js";
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
  const channels = useChannelNames();
  const timeline = useLoaded(
    () =>
      requestList<{ readonly events: readonly RoutineLedgerEvent[] }>(
        client,
        workspaceId,
        { action: "ledger", routineId, runId, limit: EVENTS_PAGE },
        "events",
        "run timeline",
      ),
    [revision],
    { serial: true },
  );
  const sources = useLoaded(
    () => requestList<SourcePage>(client, workspaceId, { action: "sources", runId }, "sources", "fetched evidence"),
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
          return next.length > 0 ? undefined : "No more timeline events";
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
      <Section title="Timeline and actual prompts">
        {timeline.error ? <LoadError error={timeline.error} reload={timeline.reload} /> : null}
        <ActionNote note={note || undefined} tone={tone} announce={false} />
        {timeline.data !== undefined && events.length === 0 ? <p className="muted">Nothing recorded yet.</p> : null}
        <ol className="item-list list-reset">
          {events.map((event) => (
            <li key={event.sequence} className="item-row">
              <div className="item-main">
                <span className="item-title-text">
                  {event.envelope.step ?? "run"} · {checkpointLine(event.envelope, channels.connection) ?? EVENT_WORDS[event.envelope.code]}
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
                  Inspect retained detail {event.sequence}
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
            label="Load more timeline"
            onLoad={() => {
              const last = events.at(-1);
              if (last !== undefined) void loadEvents(last.sequence);
            }}
          />
        ) : null}
        {detail ? (
          <Modal title="Retained detail" wide onClose={() => setDetail(undefined)}>
            {detail.payload === null ? (
              <p>
                Detail expired {detail.prunedAt === null ? "at an unknown time" : when(detail.prunedAt, timeZone)}; the integrity envelope
                remains.
              </p>
            ) : (
              <pre>{detail.payload}</pre>
            )}
          </Modal>
        ) : null}
      </Section>
      <Section title="Fetched evidence">
        {sources.error ? <LoadError error={sources.error} reload={sources.reload} /> : null}
        {sources.data !== undefined && evidence.length === 0 ? <p className="muted">No evidence fetched.</p> : null}
        <ul className="item-list list-reset">
          {evidence.map((source) => (
            <li key={source.sourceId} className="item-row evidence-row">
              <div className="item-main">
                <span className="item-title-text">
                  <SourceLink url={source.canonicalUrl} label={source.publisher} />
                </span>
                <span className="item-meta meta-sm">
                  published {when(source.publishedAt, timeZone, "unknown")} · fetched {when(source.retrievedAt, timeZone)} · hash{" "}
                  {source.contentHash ?? "not fetched"}
                </span>
                {source.prunedAt ? (
                  <span className="item-meta meta-sm">Evidence expired at {when(source.prunedAt, timeZone)}</span>
                ) : (
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable excerpt must take focus so a keyboard can scroll it.
                  <pre tabIndex={0} role="region" aria-label={`Excerpt from ${source.publisher}`}>
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
            label="Load more sources"
            onLoad={() => void loadSources(nextSource)}
          />
        ) : null}
      </Section>
    </>
  );
}
/** A run's timeline event, in words: never its machine code. */
const EVENT_WORDS: Readonly<Record<RoutineLedgerEvent["envelope"]["code"], string>> = {
  "model-retired": "its model was retired",
  transient: "a provider hiccup; tried again",
  "setup-needed": "needs setup",
  "auto-paused": "paused itself",
  claimed: "picked up",
  started: "started",
  recovered: "carried on after a restart",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  missed: "missed",
  overlap: "skipped: the previous run was still going",
  "daily-budget": "skipped: the day's run limit was reached",
  budget: "stopped at its budget",
  expired: "expired",
  credentials: "a credential is missing or invalid",
  revoked: "a permission was revoked",
  model: "a model call",
  tool: "a tool call",
  heartbeat: "still working",
  published: "published its report",
  delivery: "a delivery changed state",
  pruned: "older records pruned",
  grant: "a permission was checked",
  unsupported: "not supported",
  asked: "asked a question",
  answered: "a question was answered",
};

/** A checkpoint in the run's timeline, said as its receipt; `undefined` for any other event. */
export function checkpointLine(
  envelope: RoutineLedgerEvent["envelope"],
  connectionName?: (connectionId: string) => string | undefined,
): string | undefined {
  const checkpoint = envelope.checkpoint;
  if (checkpoint === undefined || (envelope.code !== "asked" && envelope.code !== "answered")) return undefined;
  if (envelope.code === "asked") return `asked: ${checkpoint.question ?? "a question"}`;
  const answer = checkpoint.answers?.join(", ") ?? "";
  switch (checkpoint.outcome) {
    case "defaulted":
      return answer === "" ? "nobody answered; went on without one" : `nobody answered; the default ${answer} was taken`;
    case "undelivered":
      return "the question could not be sent; went on without asking";
    case "withdrawn":
      return "the question was withdrawn";
    default:
      return checkpoint.via === "standing-answer"
        ? `answered ${answer} by your standing answer${checkpoint.question === undefined ? "" : `: ${checkpoint.question}`}`
        : `answered ${answer}${checkpoint.via === undefined ? "" : ` via ${approvalChannelLabel(checkpoint.via, connectionName)}`}`;
  }
}
