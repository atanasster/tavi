import { Fragment } from "react";

import type { useLoaded } from "../../hooks/use-loaded.js";
import { firstLine } from "../../lib/format.js";
import { useT } from "../../lib/i18n.js";
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
  const t = useT();
  return (
    <Section title={t("routines.runs.title")} anchor="runs">
      {history.error ? <LoadError error={history.error} reload={history.reload} /> : null}
      {runs.length === 0 && history.data !== undefined ? <p className="muted">{t("routines.runs.none")}</p> : null}
      <ul className="item-list list-reset">
        {runs.map((item) => (
          <li key={item.runId} className="item-row">
            <div className="item-main">
              <Button variant="link" className="item-title" onClick={() => onOpenRun(item.runId)}>
                {when(item.startedAt ?? item.claimedAt, timeZone)}
              </Button>
              <span className="item-meta meta-sm">
                {[item.mode, t("routines.runs.revision", { revision: item.revision }), ...runEffort(item)].join(" · ")}
              </span>
              {item.headline ? <span className="item-meta meta-sm">{firstLine(item.headline, 120)}</span> : null}
            </div>
            <StatusBadge status={item.status} />
            <RowAction
              aria-label={t("routines.runs.inspectLabel", { when: when(item.startedAt ?? item.claimedAt, timeZone) })}
              onClick={() => onOpenRun(item.runId)}
            >
              {t("routines.runs.inspect")}
            </RowAction>
          </li>
        ))}
      </ul>
      {runs.length > 0 ? (
        <LoadMore
          className={null}
          buttonClassName="ghost button-sm"
          busy={busy !== undefined}
          label={t("routines.runs.loadOlder")}
          busyLabel={t("routines.runs.loadOlder")}
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
  const t = useT();
  const foreign = value.foreignSkills ?? [];
  return (
    <Section
      title={t("routines.researcher.title")}
      actions={
        preview ? (
          <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={onPreview}>
            {t("routines.researcher.previewLatest")}
          </Button>
        ) : null
      }
    >
      <details open>
        <summary className="disclosure">
          {t("routines.researcher.instructions", {
            name: value.revision.snapshot.agent.name,
            version: value.revision.snapshot.agent.revision,
          })}
        </summary>
        <pre>{value.revision.snapshot.agent.instructions}</pre>
      </details>
      <p className="muted">
        {t("routines.researcher.skills", {
          skills:
            (value.revision.snapshot.skills ?? [])
              .map((skill) => t("routines.researcher.skill", { skill: skill.skillId, version: skill.version }))
              .join(", ") || t("routines.researcher.noSkills"),
        })}
      </p>
      {foreign.length > 0 ? (
        <Notice className="routine-foreign-skills">
          {t("routines.researcher.foreign", {
            count: foreign.length,
            skills: foreign
              .map((skill) =>
                t("routines.researcher.foreignSkill", {
                  skill: skill.skillId,
                  version: skill.version,
                  source: t(skill.source === "chat" ? "routines.researcher.fromChat" : "routines.researcher.fromArchive"),
                }),
              )
              .join(", "),
          })}
        </Notice>
      ) : null}
      <details>
        <summary className="disclosure">{t("routines.researcher.currentSettings")}</summary>
        <RoutineSettingsView snapshot={value.revision.snapshot} state={value.state} />
      </details>
    </Section>
  );
}
