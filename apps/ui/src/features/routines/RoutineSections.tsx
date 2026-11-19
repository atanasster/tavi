import { Fragment } from "react";

import type { useLoaded } from "../../hooks/use-loaded.js";
import { firstLine } from "../../lib/format.js";
import { when } from "../../lib/time.js";
import { Button } from "../../ui/Button.js";
import { RowAction } from "../../ui/RowAction.js";
import { LoadError, LoadMore, Notice, Section, StatusBadge } from "../../ui/Parts.js";
import { runEffort, type RoutineOverviewData, type RunSummary } from "./api.js";
import { RoutineSettingsView } from "./RoutineSettings.js";

/** Text in which a span in backticks is code: shown as code, never with its backticks. */
export function CodeText({ text }: { readonly text: string }) {
  const parts = text.split(/`([^`]+)`/);
  return <>{parts.map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : <Fragment key={index}>{part}</Fragment>))}</>;
}

/** A routine's runs, newest first, each opening as a page of its own; older ones load on request. */
export function RoutineRuns({
  history,
  runs,
  busy,
  timeZone,
  onOpenRun,
  onLoadOlder,
}: {
  readonly history: ReturnType<typeof useLoaded<{ readonly runs: readonly RunSummary[] }>>;
  readonly runs: readonly RunSummary[];
  /** The page's action in flight, if any. */
  readonly busy: string | undefined;
  readonly timeZone: string | undefined;
  readonly onOpenRun: (runId: string) => void;
  readonly onLoadOlder: () => void;
}) {
  return (
    <Section title="Runs">
      {history.error ? <LoadError error={history.error} reload={history.reload} /> : null}
      {runs.length === 0 && history.data !== undefined ? <p className="muted">No runs yet.</p> : null}
      <ul className="item-list list-reset">
        {runs.map((item) => (
          <li key={item.runId} className="item-row">
            <div className="item-main">
              <Button variant="link" className="item-title" onClick={() => onOpenRun(item.runId)}>
                {when(item.startedAt ?? item.claimedAt, timeZone)}
              </Button>
              <span className="item-meta meta-sm">{[item.mode, `revision ${item.revision}`, ...runEffort(item)].join(" · ")}</span>
              {item.headline ? <span className="item-meta meta-sm">{firstLine(item.headline, 120)}</span> : null}
            </div>
            <StatusBadge status={item.status} />
            <RowAction
              aria-label={`Inspect the run of ${when(item.startedAt ?? item.claimedAt, timeZone)}`}
              onClick={() => onOpenRun(item.runId)}
            >
              Inspect
            </RowAction>
          </li>
        ))}
      </ul>
      {runs.length > 0 ? (
        <LoadMore
          className={null}
          buttonClassName="ghost button-sm"
          busy={busy !== undefined}
          label="Load older runs"
          busyLabel="Load older runs"
          onLoad={onLoadOlder}
        />
      ) : null}
    </Section>
  );
}

/** The routine's researcher, its pinned skills and its current settings; `preview` offers a preview run of the latest revision. */
export function RoutineResearcher({
  value,
  busy,
  preview,
  onPreview,
}: {
  readonly value: RoutineOverviewData;
  /** The page's action in flight, if any. */
  readonly busy: string | undefined;
  readonly preview: boolean;
  readonly onPreview: () => void;
}) {
  return (
    <Section
      title="Researcher and settings"
      actions={
        preview ? (
          <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={onPreview}>
            Preview latest revision
          </Button>
        ) : null
      }
    >
      <details open>
        <summary className="disclosure">
          Researcher instructions · {value.revision.snapshot.agent.name} · version {value.revision.snapshot.agent.revision}
        </summary>
        <pre>{value.revision.snapshot.agent.instructions}</pre>
      </details>
      <p className="muted">
        Skills are pinned separately:{" "}
        {(value.revision.snapshot.skills ?? []).map((skill) => `${skill.skillId} (version ${skill.version})`).join(", ") || "None"}
      </p>
      {value.foreignSkills?.length ? (
        <Notice className="routine-foreign-skills">
          {value.foreignSkills
            .map(
              (skill) =>
                `${skill.skillId} (version ${skill.version}, ${skill.source === "chat" ? "proposed in a chat" : "imported from an archive"})`,
            )
            .join(", ")}{" "}
          {value.foreignSkills.length === 1 ? "was" : "were"} written by someone other than you, so each run starts as one that read
          untrusted content: a tool call that would ask you first is refused, since nobody is there to answer.
        </Notice>
      ) : null}
      <details>
        <summary className="disclosure">Current models, permissions, report and delivery settings</summary>
        <RoutineSettingsView snapshot={value.revision.snapshot} state={value.state} />
      </details>
    </Section>
  );
}
