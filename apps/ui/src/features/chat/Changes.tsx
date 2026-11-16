import { useEffect, useState } from "react";
import type { ArtifactListRow } from "@tavi/contracts";
import { artifactMeta } from "../../lib/format.js";
import { mergeBy } from "../../lib/paging.js";
import { CHAT_NOT_STARTED, Failure, Pending } from "../../ui/Parts.js";
import { unreadable } from "../../lib/ipc.js";
import { loadArtifacts } from "./tasks-api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";
export function Changes({
  taskId,
  onInspect,
}: {
  readonly taskId: string | undefined;
  readonly onInspect: (row: ArtifactListRow) => void;
}) {
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
    void loadArtifacts(client, workspaceId, taskId, page || undefined, { timeoutMs: null, refused: "Artifact list unavailable" }).then(
      (answer) => {
        if (!current) return;
        setLoading(false);
        // An unreadable answer already says to restart; a refusal gets the hint once.
        if (!answer.ok) {
          setError(
            answer.message === unreadable("artifacts") ? answer.message : `${answer.message}. Restart the owner if it predates this page.`,
          );
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
    <section aria-label="Held files">
      <p>
        The files this chat's tools held back for you to review — downloads, saved outputs, screenshots — approved or not: {rows.length}
        {cursor ? "+" : ""} loaded.
      </p>
      {!taskId ? <p>{CHAT_NOT_STARTED}</p> : null}
      {loading ? <Pending label="Loading artifact metadata…" className="notice" status /> : null}
      {error ? <Failure alert={false}>{error}</Failure> : null}
      <ul>
        {rows.map((row) => (
          <li key={row.artifactId}>
            <Button onClick={() => onInspect(row)}>
              {row.artifactId} — {artifactMeta(row)}
            </Button>
          </li>
        ))}
      </ul>
      {!loading && !error && taskId && rows.length === 0 ? <p>No file was held back in this chat.</p> : null}
      <Button
        disabled={loading || !taskId}
        onClick={() => {
          setPage(undefined);
          setRevision((value) => value + 1);
        }}
      >
        Refresh
      </Button>
      {cursor ? (
        <Button disabled={loading} onClick={() => setPage(cursor)}>
          Load more
        </Button>
      ) : null}
    </section>
  );
}
