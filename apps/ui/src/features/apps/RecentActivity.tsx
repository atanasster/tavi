import { useState } from "react";

import type { AppActivityRow } from "@tavi/contracts";

import { AppLink } from "../shell/AppLink.js";
import { whenLocalWithYear } from "../../lib/time.js";
import { Failure, LoadState } from "../../ui/Parts.js";
import { taskPath } from "../shell/route.js";
import { appActions } from "./apps-api.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { Empty } from "../../ui/Empty.js";
import { Button } from "../../ui/Button.js";

/**
 * An app's Recent activity: what its
 * tools changed or sent, and what you were asked about them, newest first,
 * each opening its chat. Reads are not recorded, and the page says so.
 */

const STATE_WORDS: Readonly<Record<string, { readonly text: string; readonly tone: "ok" | "warning" | "bad" | "muted" }>> = {
  accepted: { text: "Done", tone: "ok" },
  pending: { text: "In progress", tone: "muted" },
  rejected: { text: "Refused", tone: "bad" },
  uncertain: { text: "Outcome unknown", tone: "warning" },
  granted: { text: "You allowed it", tone: "ok" },
  denied: { text: "You declined it", tone: "bad" },
  expired: { text: "Not answered in time", tone: "warning" },
  cancelled: { text: "Cancelled", tone: "muted" },
  // A read-only tool's call, whatever came of it: one a hook refused, or that failed, is listed too.
  called: { text: "Called", tone: "muted" },
};

/** Said under every list: older calls were recorded without their tool. */
const READS_NOTE = "Calls that only read are listed from when Tavi began recording them; older ones are not.";

export function RecentActivity({
  appId,
  onOpenTask,
}: {
  readonly appId: string;
  readonly onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const timeZone = useTimeZone();
  const { data, error, loading, reload } = useLoaded(() => appActions.activity(client, workspaceId, appId));
  const [more, setMore] = useState<{ readonly rows: readonly AppActivityRow[]; readonly cursor: string | undefined }>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const first = data?.activity;
  const rows = [...(first?.rows ?? []), ...(more?.rows ?? [])];
  const cursor = more === undefined ? first?.cursor : more.cursor;
  const showMore = async (): Promise<void> => {
    if (cursor === undefined) return;
    setBusy(true);
    setFailure(undefined);
    const page = await appActions.activity(client, workspaceId, appId, cursor);
    setBusy(false);
    if (!page.ok) {
      setFailure(page.message);
      return;
    }
    setMore({ rows: [...(more?.rows ?? []), ...page.value.activity.rows], cursor: page.value.activity.cursor });
  };
  return (
    <>
      <LoadState error={error} reload={reload} loading={loading && data === undefined} />
      {first !== undefined && rows.length === 0 ? (
        <Empty>Nothing yet: its calls that read, what it changes and sends, and what you were asked about it, show here.</Empty>
      ) : null}
      {rows.length === 0 ? null : (
        <ul className="rows apps-activity">
          {rows.map((row) => {
            const words = STATE_WORDS[row.state] ?? { text: row.state, tone: "muted" as const };
            return (
              <li key={`${row.kind}:${row.id}`} className="row">
                <span className="apps-activity-info">
                  <span className="apps-title-line cluster">
                    <AppLink
                      href={taskPath(row.taskId)}
                      className="button-link"
                      onFollow={onOpenTask === undefined ? undefined : () => onOpenTask(row.taskId)}
                    >
                      {row.title}
                    </AppLink>
                  </span>
                  {/* What happened and when, on one line under the chat it happened in. */}
                  <span className="apps-activity-meta cluster meta-sm">
                    <span className={`badge badge-${words.tone}`}>{words.text}</span>
                    <time dateTime={row.at}>{whenLocalWithYear(row.at, timeZone)}</time>
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Failure message={failure} />
      {cursor === undefined ? null : (
        <Button size="sm" disabled={busy} onClick={() => void showMore()}>
          Show more
        </Button>
      )}
      {first === undefined ? null : <p className="meta-sm">{READS_NOTE}</p>}
    </>
  );
}
