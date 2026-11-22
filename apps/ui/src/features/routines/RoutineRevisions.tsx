import { useState } from "react";
import type { RoutineDetail, RoutineRevisionPage } from "@tavi/contracts";
import { Modal } from "../../ui/Modal.js";
import { useAction } from "../../hooks/use-action.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { requestList, ROUTINE_PAGE, routineStep } from "./api.js";
import { mergeBy } from "../../lib/paging.js";
import { Failure, LoadError, LoadMore, Section } from "../../ui/Parts.js";
import { useT } from "../../lib/i18n.js";
import { when } from "../../lib/time.js";
import { RevisionChanges } from "./RoutineSettings.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * The routine's revisions, newest first, paged. One opens in a dialog with
 * what restoring it would change against the newest, field by field (its raw
 * configuration behind a disclosure), and a way to restore it as a new revision. Viewing and
 * paging only read, so they run here without reloading the page.
 */
export function Revisions({
  routineId,
  busy,
  current,
  onRestore,
  timeZone,
}: {
  readonly routineId: string;
  /** The routine's newest revision: what a revision is compared with before it is restored. */
  readonly current: RoutineDetail["revision"];
  /** The page's action in flight, if any. */
  readonly busy: string | undefined;
  readonly timeZone: string | undefined;
  readonly onRestore: (revision: number) => Promise<void>;
}) {
  const { client, workspaceId } = useWorkspace();
  const t = useT();
  const { note, run } = useAction(() => {});
  const revisions = useLoaded(() =>
    requestList<RoutineRevisionPage>(
      client,
      workspaceId,
      { action: "revisions", routineId, limit: ROUTINE_PAGE },
      "items",
      t("routines.revisions.what"),
    ),
  );
  const [older, setOlder] = useState<RoutineRevisionPage["items"]>([]);
  const [cursor, setCursor] = useState<number | null>();
  const [historical, setHistorical] = useState<RoutineDetail>();
  const items = mergeBy([revisions.data?.items, older], (revision) => revision.revision);
  const next = cursor === undefined ? revisions.data?.nextBeforeRevision : cursor;

  const view = (revision: number) =>
    run("revision", () =>
      routineStep<RoutineDetail>(client, workspaceId, { action: "get", routineId, revision }, (detail) => {
        setHistorical(detail);
        return undefined;
      }),
    );
  const loadOlder = (beforeRevision: number) =>
    run("revisions", () =>
      routineStep<RoutineRevisionPage>(
        client,
        workspaceId,
        { action: "revisions", routineId, beforeRevision, limit: ROUTINE_PAGE },
        (page) => {
          setOlder((before) => [...before, ...(page.items ?? [])]);
          setCursor(page.nextBeforeRevision);
          return undefined;
        },
      ),
    );

  return (
    <Section title={t("routines.revisions.title")}>
      {revisions.error ? <LoadError error={revisions.error} reload={revisions.reload} /> : null}
      <Failure message={note || undefined} alert={false} />
      <ul className="item-list list-reset">
        {items.map((revision) => (
          <li key={revision.revision} className="item-row">
            <div className="item-main">
              <Button variant="link" className="item-title" onClick={() => void view(revision.revision)}>
                {t("routines.revisions.item", { revision: revision.revision, summary: revision.changeSummary })}
              </Button>
              <span className="item-meta meta-sm">{when(revision.createdAt, timeZone)}</span>
            </div>
          </li>
        ))}
      </ul>
      {next ? (
        <LoadMore
          className={null}
          buttonClassName="ghost button-sm"
          busy={false}
          label={t("routines.revisions.loadOlder")}
          onLoad={() => void loadOlder(next)}
        />
      ) : null}
      {historical ? (
        <Modal
          title={t("routines.revisions.historical", { revision: historical.revision.revision })}
          wide
          onClose={() => setHistorical(undefined)}
        >
          <RevisionChanges
            revision={historical.revision.revision}
            snapshot={historical.revision.snapshot}
            current={current.snapshot}
            currentRevision={current.revision}
          />
          <div className="actions">
            <Button variant="ghost" onClick={() => setHistorical(undefined)}>
              {t("routines.revisions.close")}
            </Button>
            <Button
              variant="primary"
              disabled={busy !== undefined || historical.revision.revision === current.revision}
              onClick={() => void onRestore(historical.revision.revision).then(() => setHistorical(undefined))}
            >
              {t("routines.revisions.restore")}
            </Button>
          </div>
        </Modal>
      ) : null}
    </Section>
  );
}
