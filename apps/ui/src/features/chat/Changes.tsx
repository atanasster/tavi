import { useEffect, useState } from "react";
import type { ArtifactListRow } from "@tavi/contracts";
import { formatBytes } from "../../lib/format.js";
import { fileTitle, HeldFilePicture, ReviewBadge } from "./held-file.js";
import { mergeBy } from "../../lib/paging.js";
import { Failure, Pending } from "../../ui/Parts.js";
import { useT } from "../../lib/i18n.js";
import { ARTIFACTS_UNREADABLE, loadArtifacts } from "./tasks-api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
export function Changes({
  taskId,
  onInspect,
}: {
  readonly taskId: string | undefined;
  readonly onInspect: (row: ArtifactListRow) => void;
}) {
  const t = useT();
  const { client, workspaceId } = useWorkspace();
  const [rows, setRows] = useState<readonly ArtifactListRow[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    if (!taskId) return;
    setLoading(true);
    setError(undefined);
    void loadArtifacts(client, workspaceId, taskId, page || undefined, { timeoutMs: null, refused: t("chat.files.unavailable") }).then(
      (answer) => {
        if (!current) return;
        setLoading(false);
        // An unreadable answer already says to restart; a refusal gets the hint once.
        if (!answer.ok) {
          setError(answer.code === ARTIFACTS_UNREADABLE ? answer.message : t("chat.files.restartHint", { message: answer.message }));
          return;
        }
        const scoped = answer.value.rows.filter((row) => row.workspaceId === workspaceId && row.runId === taskId);
        setRows((before) => mergeBy([page ? before : [], scoped], (row) => row.artifactId));
        setCursor(answer.value.nextCursor);
      },
    );
    return () => {
      current = false;
    };
  }, [client, workspaceId, taskId, page, revision]);
  return (
    <section aria-label={t("chat.files.label")} className="held-files">
      <p className="held-files-intro">{t("chat.files.intro")}</p>
      {!taskId ? <p>{t("ui.parts.chatNotStarted")}</p> : null}
      {loading ? <Pending label={t("chat.files.loading")} className="notice" status /> : null}
      {error ? <Failure alert={false}>{error}</Failure> : null}
      {rows.length > 0 ? (
        <ul className="held-files-grid">
          {rows.map((row) => (
            <li key={row.artifactId}>
              <Button variant="bare" className="held-file" onClick={() => onInspect(row)} title={row.artifactId}>
                <HeldFilePicture row={row} alt={fileTitle(row)} className="held-file-picture" />
                <span className="held-file-body">
                  <span className="held-file-title">{fileTitle(row)}</span>
                  <span className="held-file-facts">{formatBytes(row.byteSize)}</span>
                  <ReviewBadge state={row.reviewState} />
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {!loading && !error && taskId && rows.length === 0 ? <p>{t("chat.files.empty")}</p> : null}
      <div className="held-files-actions">
        <Button
          disabled={loading || !taskId}
          onClick={() => {
            setPage(undefined);
            setRevision((value) => value + 1);
          }}
        >
          {t("chat.files.refresh")}
        </Button>
        {cursor ? (
          <Button disabled={loading} onClick={() => setPage(cursor)}>
            {t("chat.files.more")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
