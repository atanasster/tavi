import { useState } from "react";

import type { AppActivityRow } from "@tavi/contracts";

import { AppLink } from "../shell/AppLink.js";
import { useT } from "../../lib/i18n.js";
import type { UiKey } from "../../locales/en.js";
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

const STATE_WORDS: Readonly<Record<string, { readonly textKey: UiKey; readonly tone: "ok" | "warning" | "bad" | "muted" }>> = {
  accepted: { textKey: "apps.activity.accepted", tone: "ok" },
  pending: { textKey: "apps.activity.pending", tone: "muted" },
  rejected: { textKey: "apps.activity.rejected", tone: "bad" },
  uncertain: { textKey: "apps.activity.uncertain", tone: "warning" },
  granted: { textKey: "apps.activity.granted", tone: "ok" },
  denied: { textKey: "apps.activity.denied", tone: "bad" },
  expired: { textKey: "apps.activity.expired", tone: "warning" },
  cancelled: { textKey: "apps.activity.cancelled", tone: "muted" },
  // A read-only tool's call, whatever came of it: one a hook refused, or that failed, is listed too.
  called: { textKey: "apps.activity.called", tone: "muted" },
};

export function RecentActivity({
  appId,
  onOpenTask,
}: {
  readonly appId: string;
  readonly onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  const t = useT();
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
      {first !== undefined && rows.length === 0 ? <Empty>{t("apps.activity.empty")}</Empty> : null}
      {rows.length === 0 ? null : (
        <ul className="rows apps-activity">
          {rows.map((row) => {
            const known = STATE_WORDS[row.state];
            // A state this page has no words for is said as the owner wrote it.
            const words = known === undefined ? { text: row.state, tone: "muted" as const } : { text: t(known.textKey), tone: known.tone };
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
          {t("apps.activity.showMore")}
        </Button>
      )}
      {/* Said under every list: older calls were recorded without their tool. */}
      {first === undefined ? null : <p className="meta-sm">{t("apps.activity.readsNote")}</p>}
    </>
  );
}
